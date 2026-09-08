import type { Agent as HttpsAgent } from "node:https";
import {
	BedrockRuntimeClient,
	type BedrockRuntimeClientConfig,
	BedrockRuntimeServiceException,
	StopReason as BedrockStopReason,
	type Tool as BedrockTool,
	CachePointType,
	CacheTTL,
	type ContentBlock,
	type ContentBlockDeltaEvent,
	type ContentBlockStartEvent,
	type ContentBlockStopEvent,
	ConversationRole,
	ConverseStreamCommand,
	type ConverseStreamMetadataEvent,
	ImageFormat,
	type Message,
	type SystemContentBlock,
	type ToolChoice,
	type ToolConfiguration,
	type ToolResultContentBlock,
	ToolResultStatus,
} from "@aws-sdk/client-bedrock-runtime";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import type { BuildMiddleware, DeserializeMiddleware, DocumentType, HttpResponse, MetadataBearer } from "@smithy/types";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { calculateCost } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	Context,
	ImageContent,
	Model,
	ProviderEnv,
	ProviderResponse,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingBudgets,
	ThinkingContent,
	ThinkingLevel,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../types.ts";
import { appendAssistantMessageDiagnostic } from "../utils/diagnostics.ts";
import { normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";
import { parseStreamingJson } from "../utils/json-parse.ts";
import { resolveHttpProxyUrlForTarget } from "../utils/node-http-proxy.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { getJsonSchemaToolParameters, resolveJsonSchemaStrictSampling } from "./constrained-sampling.ts";
import {
	adjustMaxTokensForThinking,
	buildBaseOptions,
	clampMaxTokensToContext,
	clampReasoning,
} from "./simple-options.ts";
import { transformMessages } from "./transform-messages.ts";

export type BedrockThinkingDisplay = "summarized" | "omitted";

export interface BedrockOptions extends StreamOptions {
	region?: string;
	profile?: string;
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
	/* 支持的模型参见 https://docs.aws.amazon.com/bedrock/latest/userguide/inference-reasoning.html。 */
	reasoning?: ThinkingLevel;
	/* 各思考级别的自定义令牌预算，覆盖默认预算。 */
	thinkingBudgets?: ThinkingBudgets;
	/* 仅 Claude 4.x 模型支持，参见 https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-extended-thinking.html#claude-messages-extended-thinking-tool-use-interleaved */
	interleavedThinking?: boolean;
	/**
	 * 控制 Claude 的思考内容如何在响应中返回。
	 * - "summarized"：思考块包含思考摘要文本（此处默认值）。
	 * - "omitted"：思考内容被遮盖，但签名仍会回传以保持多轮连续性，
	 *   从而缩短首个文本令牌的等待时间。
	 *
	 * 注意：Anthropic API 对 Claude Opus 4.8 和 Mythos Preview 的默认值为 "omitted"。
	 * 此处默认为 "summarized"，以保持与较早 Claude 4 模型的行为一致。
	 * 仅适用于 Bedrock 上的 Claude 模型。
	 */
	thinkingDisplay?: BedrockThinkingDisplay;
	/** 附加到推理请求、用于成本分配标签的键值对。
	 * 键最多 64 个字符，且不能以 `aws:` 开头；值最多 256 个字符；最多 50 对。
	 * 标签会出现在 AWS Cost Explorer 的拆分成本分配数据中。
	 * @see https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html */
	requestMetadata?: Record<string, string>;
	/** 用于 Bedrock API 密钥身份验证的 Bearer 令牌。
	 * 设置后跳过 SigV4 签名，改为发送 Authorization: Bearer <token>。
	 * 令牌身份需要 `bedrock:CallWithBearerToken` IAM 权限。
	 * 可通过 AWS_BEARER_TOKEN_BEDROCK 环境变量设置或直接传入。
	 * @see https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonbedrock.html */
	bearerToken?: string;
}

type Block = (TextContent | ThinkingContent | ToolCall) & {
	index?: number;
	partialJson?: string;
	/** 加密推理增量的暂存缓冲区，最终合并到 `thinkingSignature`。 */
	redactedChunks?: Uint8Array[];
};

const EMPTY_TEXT_PLACEHOLDER = "<empty>";

/** 与 Anthropic API 路径用于已遮盖思考内容的占位符保持一致。 */
const REDACTED_THINKING_PLACEHOLDER = "[Reasoning redacted]";

export const stream: StreamFunction<"bedrock-converse-stream", BedrockOptions> = (
	model: Model<"bedrock-converse-stream">,
	context: Context,
	options: BedrockOptions = {},
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "bedrock-converse-stream" as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};

		const blocks = output.content as Block[];

		// 通过 pi 身份验证流程显式配置的配置文件（`profile` 选项，或存储凭据 env 中
		// 有范围限制的 `AWS_PROFILE`）必须优先于环境中的 AWS_ACCESS_KEY_ID/
		// AWS_SECRET_ACCESS_KEY。SDK 默认链已优先使用配置文件而不是环境密钥，
		// 但仅在客户端配置未设置 `credentials` 时如此。参见 #6957。
		const optionsProfile = options.profile || options.env?.AWS_PROFILE;
		const config: BedrockRuntimeClientConfig = {
			profile: optionsProfile || getProviderEnvValue("AWS_PROFILE", options.env),
		};
		const configuredRegion = getConfiguredBedrockRegion(options);
		const hasAmbientConfiguredProfile = Boolean(getProviderEnvValue("AWS_PROFILE"));
		const endpointRegion = getStandardBedrockEndpointRegion(model.baseUrl);
		const useExplicitEndpoint = shouldUseExplicitBedrockEndpoint(
			model.baseUrl,
			configuredRegion,
			hasAmbientConfiguredProfile,
		);

		// 仅在未配置区域或环境 AWS_PROFILE 时固定标准 AWS Bedrock 运行时端点。
		// 这样既保留 #3402 中的自定义端点（VPC/代理），也不会强制 us-east-1 等
		// 内置目录默认值覆盖 AWS_REGION/AWS_PROFILE。
		if (useExplicitEndpoint) {
			config.endpoint = model.baseUrl;
		}

		// 解析用于 Bedrock API 密钥身份验证的 Bearer 令牌。
		const skipAuth = getProviderEnvValue("AWS_BEDROCK_SKIP_AUTH", options.env) === "1";
		const bearerToken =
			options.bearerToken ||
			options.apiKey ||
			getProviderEnvValue("AWS_BEARER_TOKEN_BEDROCK", options.env) ||
			undefined;
		const useBearerToken = bearerToken !== undefined && !skipAuth;

		// 仅在 Node.js/Bun 环境中
		if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
			// 区域解析优先级：ARN 内嵌值 > 显式选项 > 环境变量 > SDK 默认链。
			// 模型 ID 为推理配置文件 ARN 时，从中提取区域。
			// 这样可避免与为其他服务设置的 AWS_REGION 冲突。
			const arnRegionMatch = model.id.match(/^arn:aws(?:-[a-z0-9-]+)?:bedrock:([a-z0-9-]+):/);
			if (arnRegionMatch) {
				config.region = arnRegionMatch[1];
			} else if (configuredRegion) {
				config.region = configuredRegion;
			} else if (endpointRegion && useExplicitEndpoint) {
				config.region = endpointRegion;
			} else if (!hasAmbientConfiguredProfile) {
				config.region = "us-east-1";
			}

			// 支持无需身份验证的代理
			if (skipAuth) {
				config.credentials = {
					accessKeyId: "dummy-access-key",
					secretAccessKey: "dummy-secret-key",
				};
			}

			const credentials = getConfiguredBedrockCredentials(options.env);
			if (!skipAuth && credentials && !optionsProfile) {
				config.credentials = credentials;
			}

			const proxyUrl = resolveHttpProxyUrlForTarget(model.baseUrl, options.env);
			if (proxyUrl) {
				// 从 v3.798.0 起，Bedrock 运行时默认使用基于 `http2` 模块且不支持 HTTP Agent 的
				// NodeHttp2Handler。改用 NodeHttpHandler 以支持 HTTP(S) 代理 Agent。
				config.requestHandler = new NodeHttpHandler({
					httpAgent: new HttpProxyAgent(proxyUrl),
					httpsAgent: new HttpsProxyAgent(proxyUrl) as unknown as HttpsAgent,
				});
			} else if (getProviderEnvValue("AWS_BEDROCK_FORCE_HTTP1", options.env) === "1") {
				// 某些自定义端点要求使用 HTTP/1.1 而非 HTTP/2
				config.requestHandler = new NodeHttpHandler();
			}
		} else {
			// 非 Node 环境（浏览器）无法解析配置文件，因此回退到 us-east-1。
			config.region =
				configuredRegion || (endpointRegion && useExplicitEndpoint ? endpointRegion : undefined) || "us-east-1";
		}

		if (useBearerToken) {
			config.token = { token: bearerToken };
			config.authSchemePreference = ["httpBearerAuth"];
		}

		// 保留在 try 外部，使 catch 仍能关联流中途失败：
		// 通过流事件传递的异常自身不携带 HTTP 元数据。
		let responseRequestId: string | undefined;

		try {
			const supportsStrictMode = model.compat?.supportsStrictMode ?? false;
			const client = new BedrockRuntimeClient(config);
			let observedRawResponse = false;
			if (options.onResponse) {
				addResponseHeadersMiddleware(client, options.onResponse, model, () => {
					observedRawResponse = true;
				});
			}
			const customHeaders = providerHeadersToRecord(options.headers);
			if (customHeaders) {
				addCustomHeadersMiddleware(client, customHeaders);
			}
			const cacheRetention = resolveCacheRetention(options.cacheRetention, options.env);
			const inferenceMaxTokens = options.maxTokens ?? (isAnthropicClaudeModel(model) ? model.maxTokens : undefined);
			let commandInput = {
				modelId: model.id,
				messages: convertMessages(context, model, cacheRetention, options.env),
				system: buildSystemPrompt(context.systemPrompt, model, cacheRetention, options.env),
				inferenceConfig: {
					...(inferenceMaxTokens !== undefined && { maxTokens: inferenceMaxTokens }),
					...(options.temperature !== undefined && { temperature: options.temperature }),
				},
				toolConfig: convertToolConfig(context.tools, options.toolChoice, supportsStrictMode),
				additionalModelRequestFields: buildAdditionalModelRequestFields(model, options),
				...(options.requestMetadata !== undefined && { requestMetadata: options.requestMetadata }),
			};
			const nextCommandInput = await options?.onPayload?.(commandInput, model);
			if (nextCommandInput !== undefined) {
				commandInput = nextCommandInput as typeof commandInput;
			}
			const command = new ConverseStreamCommand(commandInput);

			const response = await client.send(command, { abortSignal: options.signal });
			responseRequestId = normalizeDiagnosticValue(response.$metadata.requestId);
			if (!observedRawResponse && response.$metadata.httpStatusCode !== undefined) {
				const responseHeaders: Record<string, string> = {};
				if (response.$metadata.requestId) {
					responseHeaders["x-amzn-requestid"] = response.$metadata.requestId;
				}
				await options?.onResponse?.({ status: response.$metadata.httpStatusCode, headers: responseHeaders }, model);
			}

			for await (const item of response.stream!) {
				if (item.messageStart) {
					if (item.messageStart.role !== ConversationRole.ASSISTANT) {
						throw new Error("Unexpected assistant message start but got user message start instead");
					}
					stream.push({ type: "start", partial: output });
				} else if (item.contentBlockStart) {
					handleContentBlockStart(item.contentBlockStart, blocks, output, stream);
				} else if (item.contentBlockDelta) {
					handleContentBlockDelta(item.contentBlockDelta, blocks, output, stream);
				} else if (item.contentBlockStop) {
					handleContentBlockStop(item.contentBlockStop, blocks, output, stream);
				} else if (item.messageStop) {
					output.rawStopReason = item.messageStop.stopReason;
					const { stopReason, errorMessage } = mapStopReason(item.messageStop.stopReason);
					output.stopReason = stopReason;
					if (errorMessage) {
						output.errorMessage = errorMessage;
					}
				} else if (item.metadata) {
					handleMetadata(item.metadata, model, output);
				} else if (item.internalServerException) {
					throw item.internalServerException;
				} else if (item.modelStreamErrorException) {
					throw item.modelStreamErrorException;
				} else if (item.validationException) {
					throw item.validationException;
				} else if (item.throttlingException) {
					throw item.throttlingException;
				} else if (item.serviceUnavailableException) {
					throw item.serviceUnavailableException;
				}
			}

			if (options.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "pending") {
				throw new Error("Bedrock stream ended without a stop reason");
			}
			if (output.stopReason === "error" || output.stopReason === "aborted") {
				throw new Error(output.errorMessage || "An unknown error occurred");
			}

			// 流可能在未停止每个块的情况下结束，因此也在此处完成所有块。
			for (const block of output.content) finalizeStreamingBlock(block as Block);
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				finalizeStreamingBlock(block as Block);
			}
			output.stopReason = options.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatBedrockError(error);
			if (output.stopReason === "error") {
				appendBedrockFailureDiagnostic(output, error, responseRequestId);
			}
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

/**
 * Bedrock SDK 异常名称的可读前缀。
 * agent-session 中的下游重试逻辑会匹配 `server.?error` 和
 * `service.?unavailable` 等模式，因此保留旧版前缀格式，不直接使用 SDK 异常原名。
 */
const BEDROCK_ERROR_PREFIXES: Record<string, string> = {
	InternalServerException: "Internal server error",
	ModelStreamErrorException: "Model stream error",
	ValidationException: "Validation error",
	ThrottlingException: "Throttling error",
	ServiceUnavailableException: "Service unavailable",
};

/**
 * 某些模型会拒绝账户/配置文件中配置的 Bedrock 数据保留模式
 * （例如 "data retention mode 'default' is not available for this model"）。
 * 向用户提供说明如何配置受支持模式的 AWS 文档。
 */
const BEDROCK_DATA_RETENTION_DOCS_URL = "https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html";

/**
 * 使用可读前缀格式化 Bedrock 错误。
 * AWS SDK 异常（来自 `client.send()` 或流事件条目）均扩展
 * BedrockRuntimeServiceException。将 `.name` 映射为稳定的可读前缀，使下游使用方
 * （重试逻辑、上下文溢出检测）可通过简单字符串匹配区分错误类别。
 */
function formatBedrockError(error: unknown): string {
	const norm = normalizeProviderError(error);
	// SDK 未将原始 HTTP 正文合并到消息时，显示带状态的正文；否则回退到消息。
	// 这样可避免网关 403 被折叠为 `Unknown: UnknownError`。
	const core =
		!norm.messageCarriesBody && norm.status !== undefined && norm.body !== undefined
			? `${norm.status}: ${norm.body}`
			: norm.message;
	const dataRetentionHint = /data retention mode/i.test(core)
		? ` See ${BEDROCK_DATA_RETENTION_DOCS_URL} for supported data retention modes.`
		: "";
	if (error instanceof BedrockRuntimeServiceException) {
		const prefix = BEDROCK_ERROR_PREFIXES[error.name] ?? error.name;
		return `${prefix}: ${core}${dataRetentionHint}`;
	}
	return `${core}${dataRetentionHint}`;
}

type SdkErrorMetadata = { $metadata?: { httpStatusCode?: unknown; requestId?: unknown } };

/** 过长的请求头值会被丢弃而不是截断：截断后的请求 id 已不再是有效请求 id。 */
const MAX_BEDROCK_DIAGNOSTIC_VALUE_CHARS = 200;

function normalizeDiagnosticValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > MAX_BEDROCK_DIAGNOSTIC_VALUE_CHARS) return undefined;
	return trimmed;
}

/**
 * SDK 对服务异常和未建模流错误都将建模代码放在 `error.name` 上，因此不要缩小为
 * `BedrockRuntimeServiceException`。与 `TimeoutError` 等传输名称不同，已建模的
 * Bedrock 错误都以 `Exception` 结尾。
 */
function extractBedrockErrorCode(error: unknown): string | undefined {
	if (!(error instanceof Error) || !error.name.endsWith("Exception")) return undefined;
	return normalizeDiagnosticValue(error.name);
}

/**
 * 与 `errorMessage` 并列的结构化元数据。由于 `isRetryableAssistantError` 会匹配
 * `errorMessage`，因此其字节保持完全一致。省略未知字段，绝不猜测：已建模的流中途异常
 * 会以普通对象字面量到达，只留下 `fallbackRequestId`。只记录 `details`，因为抛出值
 * 不一定是 `Error`。
 */
function appendBedrockFailureDiagnostic(
	output: AssistantMessage,
	error: unknown,
	fallbackRequestId: string | undefined,
): void {
	const metadata = (error as SdkErrorMetadata)?.$metadata;
	const details: Record<string, unknown> = {};

	if (typeof metadata?.httpStatusCode === "number") details.status = metadata.httpStatusCode;

	const errorCode = extractBedrockErrorCode(error);
	if (errorCode !== undefined) details.errorCode = errorCode;

	const requestId = normalizeDiagnosticValue(metadata?.requestId) ?? fallbackRequestId;
	if (requestId !== undefined) details.requestId = requestId;

	if (Object.keys(details).length === 0) return;

	appendAssistantMessageDiagnostic(output, { type: "bedrock_response_failure", timestamp: Date.now(), details });
}

/**
 * 调用方提供的请求头绝不能覆盖的请求头键。
 * `host` 和 `x-amz-*` 参与 SigV4 规范请求；`authorization` 由 SigV4 或
 * Bearer 令牌路径（config.token + authSchemePreference）负责。
 * 比较时不区分大小写（查找前将调用方的键转为小写）。
 */
const RESERVED_HEADER_EXACT = new Set(["authorization", "host"]);

function isReservedHeader(key: string): boolean {
	const lower = key.toLowerCase();
	return lower.startsWith("x-amz-") || RESERVED_HEADER_EXACT.has(lower);
}

/**
 * 通过 Smithy `build` 阶段中间件将调用方提供的请求头附加到发出的 Bedrock 请求。
 * `build` 阶段在请求序列化之后、SigV4 签名之前运行，因此注入的请求头会纳入签名。
 * 静默跳过保留的 SigV4/身份验证请求头（`x-amz-*`、`authorization`、`host`）；
 * 其他调用方请求头会覆盖请求中已有的同名请求头。
 */
function addCustomHeadersMiddleware(client: BedrockRuntimeClient, headers: Record<string, string>): void {
	const middleware: BuildMiddleware<object, MetadataBearer> = (next) => async (args) => {
		const request = args.request;
		if (request && typeof request === "object" && "headers" in request) {
			const requestHeaders = (request as { headers: Record<string, string> }).headers;
			for (const [key, value] of Object.entries(headers)) {
				if (!isReservedHeader(key)) {
					requestHeaders[key] = value;
				}
			}
		}
		return next(args);
	};
	client.middlewareStack.add(middleware, { step: "build", name: "pi-ai-custom-headers", priority: "low" });
}

function isSmithyHttpResponse(response: unknown): response is HttpResponse {
	if (!response || typeof response !== "object") return false;
	const candidate = response as Partial<HttpResponse>;
	return typeof candidate.statusCode === "number" && !!candidate.headers && typeof candidate.headers === "object";
}

function toProviderResponse(response: unknown): ProviderResponse | undefined {
	if (!isSmithyHttpResponse(response)) return undefined;
	return { status: response.statusCode, headers: { ...response.headers } };
}

/**
 * Bedrock 建模的 `$metadata` 只保留选定的 HTTP 元数据（例如 requestId），否则自定义
 * 网关请求头会在调用方看到 `onResponse` 前丢失。在反序列化阶段捕获原始 Smithy HTTP
 * 响应，此时 SDK 已收到响应但尚未消费事件流。
 */
function addResponseHeadersMiddleware(
	client: BedrockRuntimeClient,
	onResponse: NonNullable<BedrockOptions["onResponse"]>,
	model: Model<"bedrock-converse-stream">,
	onObserved: () => void,
): void {
	const middleware: DeserializeMiddleware<object, MetadataBearer> = (next) => async (args) => {
		const result = await next(args);
		const providerResponse = toProviderResponse(result.response);
		if (providerResponse) {
			onObserved();
			await onResponse(providerResponse, model);
		}
		return result;
	};
	client.middlewareStack.add(middleware, { step: "deserialize", name: "pi-ai-response-headers" });
}

export const streamSimple: StreamFunction<"bedrock-converse-stream", SimpleStreamOptions> = (
	model: Model<"bedrock-converse-stream">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const base = {
		...buildBaseOptions(model, context, options, undefined),
		toolChoice: options?.toolChoice,
	} satisfies BedrockOptions;
	if (!options?.reasoning) {
		return stream(model, context, { ...base, reasoning: undefined } satisfies BedrockOptions);
	}

	if (isAnthropicClaudeModel(model)) {
		if (supportsAdaptiveThinking(model.id, model.name)) {
			return stream(model, context, {
				...base,
				reasoning: options.reasoning,
				thinkingBudgets: options.thinkingBudgets,
			} satisfies BedrockOptions);
		}

		// Undefined 表示调用方未要求输出上限；让辅助函数使用模型上限。
		// 此处不要强制转换为 0，否则思考预算会占据整个 maxTokens 值。
		const adjusted = adjustMaxTokensForThinking(
			base.maxTokens,
			model.maxTokens,
			options.reasoning,
			options.thinkingBudgets,
		);

		const maxTokens = clampMaxTokensToContext(model, context, adjusted.maxTokens);

		return stream(model, context, {
			...base,
			maxTokens,
			reasoning: options.reasoning,
			thinkingBudgets: {
				...(options.thinkingBudgets || {}),
				[clampReasoning(options.reasoning)!]: Math.min(adjusted.thinkingBudget, Math.max(0, maxTokens - 1024)),
			},
		} satisfies BedrockOptions);
	}

	return stream(model, context, {
		...base,
		reasoning: options.reasoning,
		thinkingBudgets: options.thinkingBudgets,
	} satisfies BedrockOptions);
};

function handleContentBlockStart(
	event: ContentBlockStartEvent,
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const index = event.contentBlockIndex!;
	const start = event.start;

	if (start?.toolUse) {
		const block: Block = {
			type: "toolCall",
			id: start.toolUse.toolUseId || "",
			name: start.toolUse.name || "",
			arguments: {},
			partialJson: "",
			index,
		};
		output.content.push(block);
		stream.push({ type: "toolcall_start", contentIndex: blocks.length - 1, partial: output });
	}
}

function handleContentBlockDelta(
	event: ContentBlockDeltaEvent,
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const contentBlockIndex = event.contentBlockIndex!;
	const delta = event.delta;
	let index = blocks.findIndex((b) => b.index === contentBlockIndex);
	let block = blocks[index];

	if (delta?.text !== undefined) {
		// 尚无文本块时创建一个，因为文本块不会发送 `handleContentBlockStart`
		if (!block) {
			const newBlock: Block = { type: "text", text: "", index: contentBlockIndex };
			output.content.push(newBlock);
			index = blocks.length - 1;
			block = blocks[index];
			stream.push({ type: "text_start", contentIndex: index, partial: output });
		}
		if (block.type === "text") {
			block.text += delta.text;
			stream.push({ type: "text_delta", contentIndex: index, delta: delta.text, partial: output });
		}
	} else if (delta?.toolUse && block?.type === "toolCall") {
		block.partialJson = (block.partialJson || "") + (delta.toolUse.input || "");
		block.arguments = parseStreamingJson(block.partialJson);
		stream.push({ type: "toolcall_delta", contentIndex: index, delta: delta.toolUse.input || "", partial: output });
	} else if (delta?.reasoningContent) {
		let thinkingBlock = block;
		let thinkingIndex = index;

		if (!thinkingBlock) {
			const newBlock: Block = { type: "thinking", thinking: "", thinkingSignature: "", index: contentBlockIndex };
			output.content.push(newBlock);
			thinkingIndex = blocks.length - 1;
			thinkingBlock = blocks[thinkingIndex];
			stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
		}

		if (thinkingBlock?.type === "thinking") {
			if (delta.reasoningContent.text) {
				thinkingBlock.thinking += delta.reasoningContent.text;
				stream.push({
					type: "thinking_delta",
					contentIndex: thinkingIndex,
					delta: delta.reasoningContent.text,
					partial: output,
				});
			}
			// `thinkingSignature` 只保存 Anthropic 签名或不透明的已遮盖载荷之一，
			// 绝不同时保存；混合会破坏先到达的内容。
			if (delta.reasoningContent.signature && !thinkingBlock.redacted) {
				thinkingBlock.thinkingSignature =
					(thinkingBlock.thinkingSignature || "") + delta.reasoningContent.signature;
			}
			if (delta.reasoningContent.redactedContent?.length) {
				// Bedrock 上非 Anthropic 模型的加密推理（例如 OpenAI GPT-5.6）。
				// 载荷不透明，因此像 Anthropic 路径存储已遮盖思考一样将其原样保存在
				// `thinkingSignature` 中，并在下一轮重放。
				if (!thinkingBlock.redacted) {
					thinkingBlock.redacted = true;
					thinkingBlock.thinkingSignature = "";
					thinkingBlock.thinking += REDACTED_THINKING_PLACEHOLDER;
					stream.push({
						type: "thinking_delta",
						contentIndex: thinkingIndex,
						delta: REDACTED_THINKING_PLACEHOLDER,
						partial: output,
					});
				}
				thinkingBlock.redactedChunks ??= [];
				thinkingBlock.redactedChunks.push(delta.reasoningContent.redactedContent);
			}
		}
	}
}

/**
 * 将缓冲的加密推理编码到 `thinkingSignature` 并丢弃暂存缓冲区；暂存缓冲区绝不能进入
 * 持久化消息，因为 `Uint8Array` 会序列化为以索引为键的对象，大小约为 base64 载荷的十倍。
 */
function flushRedactedContent(block: Block): void {
	if (block.type !== "thinking" || !block.redactedChunks) return;
	block.thinkingSignature = bytesToBase64(block.redactedChunks);
	delete block.redactedChunks;
}

/**
 * 移除所有流式暂存字段。除 `contentBlockStop` 外，终止路径也会调用，
 * 因为流可能在未停止每个块的情况下结束。
 */
function finalizeStreamingBlock(block: Block): void {
	delete block.index;
	// partialJson 仅作为流式暂存缓冲区，绝不持久化。
	delete block.partialJson;
	flushRedactedContent(block);
}

function handleMetadata(
	event: ConverseStreamMetadataEvent,
	model: Model<"bedrock-converse-stream">,
	output: AssistantMessage,
): void {
	if (event.usage) {
		output.usage.input = event.usage.inputTokens || 0;
		output.usage.output = event.usage.outputTokens || 0;
		output.usage.cacheRead = event.usage.cacheReadInputTokens || 0;
		output.usage.cacheWrite = event.usage.cacheWriteInputTokens || 0;
		output.usage.totalTokens = event.usage.totalTokens || output.usage.input + output.usage.output;
		calculateCost(model, output.usage);
	}
}

function handleContentBlockStop(
	event: ContentBlockStopEvent,
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const index = blocks.findIndex((b) => b.index === event.contentBlockIndex);
	const block = blocks[index];
	if (!block) return;
	delete (block as Block).index;

	switch (block.type) {
		case "text":
			stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
			break;
		case "thinking":
			flushRedactedContent(block);
			stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
			break;
		case "toolCall":
			block.arguments = parseStreamingJson(block.partialJson);
			// 就地完成并移除暂存缓冲区，使重放只携带已解析参数。
			delete (block as Block).partialJson;
			stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
			break;
	}
}

/**
 * 检查模型是否支持自适应思考（Opus 4.6+、Sonnet 4.6）。
 * 同时检查模型 ID 和模型名称，以支持 ARN 不含模型名称的应用推理配置文件。
 */
function getModelMatchCandidates(modelId: string, modelName?: string): string[] {
	const values = modelName ? [modelId, modelName] : [modelId];
	return values.flatMap((value) => {
		const lower = value.toLowerCase();
		return [lower, lower.replace(/[\s_.:]+/g, "-")];
	});
}

function supportsAdaptiveThinking(modelId: string, modelName?: string): boolean {
	const candidates = getModelMatchCandidates(modelId, modelName);
	return candidates.some(
		(s) =>
			s.includes("opus-4-6") ||
			s.includes("opus-4-7") ||
			s.includes("opus-4-8") ||
			s.includes("opus-5") ||
			s.includes("sonnet-4-6") ||
			s.includes("sonnet-5") ||
			s.includes("fable-5"),
	);
}

function supportsNativeXhighEffort(model: Model<"bedrock-converse-stream">): boolean {
	const candidates = getModelMatchCandidates(model.id, model.name);
	return candidates.some(
		(s) =>
			s.includes("opus-4-7") ||
			s.includes("opus-4-8") ||
			s.includes("opus-5") ||
			s.includes("sonnet-5") ||
			s.includes("fable-5"),
	);
}

function mapThinkingLevelToEffort(
	model: Model<"bedrock-converse-stream">,
	level: SimpleStreamOptions["reasoning"],
): "low" | "medium" | "high" | "xhigh" | "max" {
	if (level === "xhigh" && supportsNativeXhighEffort(model)) return "xhigh";

	const mapped = level ? model.thinkingLevelMap?.[level] : undefined;
	if (typeof mapped === "string") return mapped as "low" | "medium" | "high" | "xhigh" | "max";

	switch (level) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		default:
			return "high";
	}
}

/**
 * 解析缓存保留偏好。
 * 默认为 "short"，并使用 PI_CACHE_RETENTION 保持向后兼容。
 */
function resolveCacheRetention(cacheRetention?: CacheRetention, env?: ProviderEnv): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (getProviderEnvValue("PI_CACHE_RETENTION", env) === "long") {
		return "long";
	}
	return "short";
}

/**
 * 检查模型是否为 Bedrock 上的 Anthropic Claude 模型。
 * 同时检查模型 ID 和模型名称，以支持 ARN 不含模型名称的应用推理配置文件。
 */
function isAnthropicClaudeModel(model: Model<"bedrock-converse-stream">): boolean {
	const id = model.id.toLowerCase();
	const name = model.name?.toLowerCase() ?? "";
	return (
		id.includes("anthropic.claude") ||
		id.includes("anthropic/claude") ||
		name.includes("anthropic.claude") ||
		name.includes("anthropic/claude") ||
		name.includes("claude")
	);
}

/**
 * 检查模型是否支持提示词缓存。
 * 支持：Claude 3.5 Haiku、Claude 3.7 Sonnet、Claude 4.x 模型、Claude 5 模型
 *
 * 基础模型和系统定义的推理配置文件，其模型 ID/ARN 包含模型名称，因此可以在本地判断。
 *
 * 对于 ARN 不含模型名称的应用推理配置文件，还会检查由用户通过 models.json 或
 * registerProvider 控制的 model.name。最后可设置 AWS_BEDROCK_FORCE_CACHE=1 强制
 * 启用缓存点。Amazon Nova 模型具有自动缓存，不需要显式缓存点。
 */
function supportsPromptCaching(model: Model<"bedrock-converse-stream">, env?: ProviderEnv): boolean {
	const candidates = getModelMatchCandidates(model.id, model.name);

	const hasClaudeRef = candidates.some((s) => s.includes("claude"));
	if (!hasClaudeRef) {
		// 应用推理配置文件的 ARN 不包含模型名称。
		// 允许用户通过环境变量强制启用缓存点。
		if (getProviderEnvValue("AWS_BEDROCK_FORCE_CACHE", env) === "1") return true;
		return false;
	}
	// Claude 5 模型（fable-5、opus-5、sonnet-5）
	if (candidates.some((s) => s.includes("fable-5") || s.includes("opus-5") || s.includes("sonnet-5"))) return true;
	// Claude 4.x 模型（opus-4、sonnet-4、haiku-4）
	if (candidates.some((s) => s.includes("-4-"))) return true;
	// Claude 3.7 Sonnet
	if (candidates.some((s) => s.includes("claude-3-7-sonnet"))) return true;
	// Claude 3.5 Haiku
	if (candidates.some((s) => s.includes("claude-3-5-haiku"))) return true;
	return false;
}

/**
 * 检查模型是否支持 reasoningContent 中的思考签名。
 * 只有 Anthropic Claude 模型支持 signature 字段。
 * 其他模型（OpenAI、Qwen、Minimax、Moonshot 等）会拒绝该字段并返回：
 * "This model doesn't support the reasoningContent.reasoningText.signature field"
 *
 * 同时检查模型 ID 和模型名称，以支持应用推理配置文件。
 */
function supportsThinkingSignature(model: Model<"bedrock-converse-stream">): boolean {
	return isAnthropicClaudeModel(model);
}

function buildSystemPrompt(
	systemPrompt: string | undefined,
	model: Model<"bedrock-converse-stream">,
	cacheRetention: CacheRetention,
	env?: ProviderEnv,
): SystemContentBlock[] | undefined {
	if (!systemPrompt) return undefined;

	const blocks: SystemContentBlock[] = [{ text: sanitizeSurrogates(systemPrompt) }];

	// 启用缓存时，为支持的 Claude 模型添加缓存点
	if (cacheRetention !== "none" && supportsPromptCaching(model, env)) {
		blocks.push({
			cachePoint: { type: CachePointType.DEFAULT, ...(cacheRetention === "long" ? { ttl: CacheTTL.ONE_HOUR } : {}) },
		});
	}

	return blocks;
}

function normalizeToolCallId(id: string): string {
	const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "_");
	return sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
}

function createNonBlankTextBlock(text: string): ContentBlock.TextMember | undefined {
	const sanitized = sanitizeSurrogates(text);
	return sanitized.trim().length === 0 ? undefined : { text: sanitized };
}

function createRequiredTextBlock(text: string): ContentBlock.TextMember {
	return createNonBlankTextBlock(text) ?? { text: EMPTY_TEXT_PLACEHOLDER };
}

function sanitizeBedrockDocument(value: DocumentType): DocumentType {
	if (Array.isArray(value)) {
		return value.map(sanitizeBedrockDocument);
	}
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([key]) => key.length > 0)
				.map(([key, nestedValue]) => [key, sanitizeBedrockDocument(nestedValue)]),
		);
	}
	return value;
}

function convertToolResultContent(content: (TextContent | ImageContent)[]): ToolResultContentBlock[] {
	const result: ToolResultContentBlock[] = [];
	for (const c of content) {
		if (c.type === "image") {
			result.push({ image: createImageBlock(c.mimeType, c.data) });
		} else {
			const textBlock = createNonBlankTextBlock(c.text);
			if (textBlock) result.push(textBlock);
		}
	}
	if (result.length === 0) result.push({ text: EMPTY_TEXT_PLACEHOLDER });
	return result;
}

function convertMessages(
	context: Context,
	model: Model<"bedrock-converse-stream">,
	cacheRetention: CacheRetention,
	env?: ProviderEnv,
): Message[] {
	const result: Message[] = [];
	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);

	for (let i = 0; i < transformedMessages.length; i++) {
		const m = transformedMessages[i];

		switch (m.role) {
			case "user": {
				const content: ContentBlock[] = [];
				if (typeof m.content === "string") {
					content.push(createRequiredTextBlock(m.content));
				} else {
					for (const c of m.content) {
						switch (c.type) {
							case "text": {
								const textBlock = createNonBlankTextBlock(c.text);
								if (textBlock) content.push(textBlock);
								break;
							}
							case "image":
								content.push({ image: createImageBlock(c.mimeType, c.data) });
								break;
							default:
								continue;
						}
					}
					if (content.length === 0) content.push({ text: EMPTY_TEXT_PLACEHOLDER });
				}
				result.push({
					role: ConversationRole.USER,
					content,
				});
				break;
			}
			case "assistant": {
				// 跳过内容为空的助手消息（例如来自已中止的请求）
				// Bedrock 会拒绝内容数组为空的消息
				if (m.content.length === 0) {
					continue;
				}
				const contentBlocks: ContentBlock[] = [];
				for (const c of m.content) {
					switch (c.type) {
						case "text": {
							// 跳过空文本块
							const textBlock = createNonBlankTextBlock(c.text);
							if (!textBlock) continue;
							contentBlocks.push(textBlock);
							break;
						}
						case "toolCall":
							contentBlocks.push({
								toolUse: { toolUseId: c.id, name: c.name, input: sanitizeBedrockDocument(c.arguments) },
							});
							break;
						case "thinking": {
							// 加密推理是不透明内容：将存储的载荷作为 `redactedContent` 成员重放，
							// 而不是降级为推理文本。
							if (c.redacted) {
								const redactedContent = decodeRedactedContent(c.thinkingSignature);
								if (redactedContent?.length) {
									contentBlocks.push({ reasoningContent: { redactedContent } });
								}
								continue;
							}
							// 跳过空思考块
							const thinking = sanitizeSurrogates(c.thinking);
							if (thinking.trim().length === 0) continue;
							// 只有 Anthropic 模型支持 reasoningText 中的 signature 字段。
							// 对其他模型省略签名，以避免如下错误：
							// "This model doesn't support the reasoningContent.reasoningText.signature field"
							if (supportsThinkingSignature(model)) {
								// 签名在思考增量之后到达。如果部分消息或外部持久化消息缺少签名，
								// Bedrock 会拒绝重放的推理块。回退到纯文本，与 Anthropic 保持一致。
								if (!c.thinkingSignature || c.thinkingSignature.trim().length === 0) {
									contentBlocks.push({ text: thinking });
								} else {
									contentBlocks.push({
										reasoningContent: {
											reasoningText: {
												text: thinking,
												signature: c.thinkingSignature,
											},
										},
									});
								}
							} else {
								contentBlocks.push({
									reasoningContent: {
										reasoningText: { text: thinking },
									},
								});
							}
							break;
						}
						default:
							continue;
					}
				}
				// 如果所有内容块都被过滤，则跳过
				if (contentBlocks.length === 0) {
					continue;
				}
				result.push({
					role: ConversationRole.ASSISTANT,
					content: contentBlocks,
				});
				break;
			}
			case "toolResult": {
				// 将所有连续的 toolResult 消息收集到一条用户消息中
				// Bedrock 要求所有工具结果位于同一条消息中
				const toolResults: ContentBlock.ToolResultMember[] = [];

				// 添加当前工具结果，并合并所有内容块
				toolResults.push({
					toolResult: {
						toolUseId: m.toolCallId,
						content: convertToolResultContent(m.content),
						status: m.isError ? ToolResultStatus.ERROR : ToolResultStatus.SUCCESS,
					},
				});

				// 向前查找连续的 toolResult 消息
				let j = i + 1;
				while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
					const nextMsg = transformedMessages[j] as ToolResultMessage;
					toolResults.push({
						toolResult: {
							toolUseId: nextMsg.toolCallId,
							content: convertToolResultContent(nextMsg.content),
							status: nextMsg.isError ? ToolResultStatus.ERROR : ToolResultStatus.SUCCESS,
						},
					});
					j++;
				}

				// 跳过已经处理的消息
				i = j - 1;

				result.push({
					role: ConversationRole.USER,
					content: toolResults,
				});
				break;
			}
			default:
				continue;
		}
	}

	// 启用缓存时，在支持的 Claude 模型最后一条用户消息中添加缓存点
	if (cacheRetention !== "none" && supportsPromptCaching(model, env) && result.length > 0) {
		const lastMessage = result[result.length - 1];
		if (lastMessage.role === ConversationRole.USER && lastMessage.content) {
			(lastMessage.content as ContentBlock[]).push({
				cachePoint: {
					type: CachePointType.DEFAULT,
					...(cacheRetention === "long" ? { ttl: CacheTTL.ONE_HOUR } : {}),
				},
			});
		}
	}

	return result;
}

function convertToolConfig(
	tools: Tool[] | undefined,
	toolChoice: BedrockOptions["toolChoice"],
	supportsStrictMode: boolean,
): ToolConfiguration | undefined {
	if (!tools?.length) return undefined;
	if (toolChoice === "none") return undefined;

	const bedrockTools: BedrockTool[] = tools.map((tool) => {
		const strict = resolveJsonSchemaStrictSampling(tool, supportsStrictMode);
		return {
			toolSpec: {
				name: tool.name,
				description: tool.description,
				inputSchema: { json: getJsonSchemaToolParameters(tool, strict) as unknown as DocumentType },
				...(strict === true ? { strict: true } : {}),
			},
		};
	});

	let bedrockToolChoice: ToolChoice | undefined;
	switch (toolChoice) {
		case "auto":
			bedrockToolChoice = { auto: {} };
			break;
		case "any":
			bedrockToolChoice = { any: {} };
			break;
		default:
			if (toolChoice?.type === "tool") {
				bedrockToolChoice = { tool: { name: toolChoice.name } };
			}
	}

	return { tools: bedrockTools, toolChoice: bedrockToolChoice };
}

function mapStopReason(reason: string | undefined): { stopReason: StopReason; errorMessage?: string } {
	switch (reason) {
		case BedrockStopReason.END_TURN:
		case BedrockStopReason.STOP_SEQUENCE:
			return { stopReason: "stop" };
		case BedrockStopReason.MAX_TOKENS:
		case BedrockStopReason.MODEL_CONTEXT_WINDOW_EXCEEDED:
			return { stopReason: "length" };
		case BedrockStopReason.TOOL_USE:
			return { stopReason: "toolUse" };
		default:
			return reason
				? { stopReason: "error", errorMessage: `Provider stopped with: ${reason}` }
				: { stopReason: "error" };
	}
}

function getConfiguredBedrockRegion(options: BedrockOptions): string | undefined {
	return (
		options.region ||
		getProviderEnvValue("AWS_REGION", options.env) ||
		getProviderEnvValue("AWS_DEFAULT_REGION", options.env) ||
		undefined
	);
}

function getConfiguredBedrockCredentials(env?: ProviderEnv): BedrockRuntimeClientConfig["credentials"] | undefined {
	const accessKeyId = getProviderEnvValue("AWS_ACCESS_KEY_ID", env);
	const secretAccessKey = getProviderEnvValue("AWS_SECRET_ACCESS_KEY", env);
	if (!accessKeyId || !secretAccessKey) {
		return undefined;
	}
	const sessionToken = getProviderEnvValue("AWS_SESSION_TOKEN", env);
	return {
		accessKeyId,
		secretAccessKey,
		...(sessionToken ? { sessionToken } : {}),
	};
}

function getStandardBedrockEndpointRegion(baseUrl: string | undefined): string | undefined {
	if (!baseUrl) {
		return undefined;
	}

	try {
		const { hostname } = new URL(baseUrl);
		const match = hostname.toLowerCase().match(/^bedrock-runtime(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/);
		return match?.[1];
	} catch {
		return undefined;
	}
}

function shouldUseExplicitBedrockEndpoint(
	baseUrl: string,
	configuredRegion: string | undefined,
	hasAmbientConfiguredProfile: boolean,
): boolean {
	const endpointRegion = getStandardBedrockEndpointRegion(baseUrl);
	if (!endpointRegion) {
		return true;
	}

	return !configuredRegion && !hasAmbientConfiguredProfile;
}

function isGovCloudBedrockTarget(model: Model<"bedrock-converse-stream">, options: BedrockOptions): boolean {
	const region = getConfiguredBedrockRegion(options);
	if (region?.toLowerCase().startsWith("us-gov-")) {
		return true;
	}

	const modelId = model.id.toLowerCase();
	return modelId.startsWith("us-gov.") || modelId.startsWith("arn:aws-us-gov:");
}

function buildAdditionalModelRequestFields(
	model: Model<"bedrock-converse-stream">,
	options: BedrockOptions,
): Record<string, any> | undefined {
	if (!options.reasoning || !model.reasoning) {
		return undefined;
	}

	if (isAnthropicClaudeModel(model)) {
		// GovCloud Bedrock 当前会拒绝 Claude thinking.display 字段。
		// 在 GovCloud Converse Schema 支持前省略该字段。
		const display = isGovCloudBedrockTarget(model, options) ? undefined : (options.thinkingDisplay ?? "summarized");
		const result: Record<string, any> = supportsAdaptiveThinking(model.id, model.name)
			? {
					thinking: { type: "adaptive", ...(display !== undefined ? { display } : {}) },
					output_config: { effort: mapThinkingLevelToEffort(model, options.reasoning) },
				}
			: (() => {
					const defaultBudgets: Record<ThinkingLevel, number> = {
						minimal: 1024,
						low: 2048,
						medium: 8192,
						high: 16384,
						xhigh: 16384, // 基于预算的 Claude 会将扩展级别限制为 high
						max: 16384,
					};

					// 自定义预算只覆盖截至 high 的基于令牌级别。
					const level = options.reasoning === "xhigh" || options.reasoning === "max" ? "high" : options.reasoning;
					const budget = options.thinkingBudgets?.[level] ?? defaultBudgets[options.reasoning];

					return {
						thinking: {
							type: "enabled",
							budget_tokens: budget,
							...(display !== undefined ? { display } : {}),
						},
					};
				})();

		if (!supportsAdaptiveThinking(model.id, model.name) && (options.interleavedThinking ?? true)) {
			result.anthropic_beta = ["interleaved-thinking-2025-05-14"];
		}

		return result;
	}

	return undefined;
}

function createImageBlock(mimeType: string, data: string) {
	let format: ImageFormat;
	switch (mimeType) {
		case "image/jpeg":
		case "image/jpg":
			format = ImageFormat.JPEG;
			break;
		case "image/png":
			format = ImageFormat.PNG;
			break;
		case "image/gif":
			format = ImageFormat.GIF;
			break;
		case "image/webp":
			format = ImageFormat.WEBP;
			break;
		default:
			throw new Error(`Unknown image type: ${mimeType}`);
	}

	return { source: { bytes: base64ToBytes(data) }, format };
}

function base64ToBytes(data: string): Uint8Array {
	const binaryString = atob(data);
	const bytes = new Uint8Array(binaryString.length);
	for (let i = 0; i < binaryString.length; i++) {
		bytes[i] = binaryString.charCodeAt(i);
	}
	return bytes;
}

/**
 * 解码已存储的遮盖载荷。AWS SDK 以字节形式提供 Blob，但持久化会话以 base64 携带。
 * 手工编辑或外部生成的会话可能包含非 base64 签名；此时丢弃该块，而不是让整个请求失败。
 */
function decodeRedactedContent(signature: string | undefined): Uint8Array | undefined {
	if (!signature) return undefined;
	try {
		return base64ToBytes(signature);
	} catch {
		return undefined;
	}
}

function bytesToBase64(chunks: Uint8Array[]): string {
	// 加密推理可达数十 KB，因此分片构建二进制字符串，而不是逐字节连接。
	// 窗口大小保持在引擎对展开调用的参数数量限制以内。
	const WINDOW = 0x8000;
	let binary = "";
	for (const chunk of chunks) {
		for (let i = 0; i < chunk.length; i += WINDOW) {
			binary += String.fromCharCode(...chunk.subarray(i, i + WINDOW));
		}
	}
	return btoa(binary);
}
