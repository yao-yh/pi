/**
 * Google Generative AI 和 Google Vertex 提供商的共享工具。
 */

import { type Content, FinishReason, FunctionCallingConfigMode, type Part } from "@google/genai";
import type {
	Context,
	ImageContent,
	Model,
	ModelThinkingLevel,
	StopReason,
	StreamOptions,
	TextContent,
	ThinkingLevel,
	Tool,
} from "../types.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { getJsonSchemaToolParameters, resolveJsonSchemaStrictSampling } from "./constrained-sampling.ts";
import { transformMessages } from "./transform-messages.ts";

type GoogleApiType = "google-generative-ai" | "google-vertex";

/**
 * Gemini 3 模型的思考级别。
 * 与 Google 的 ThinkingLevel 枚举值保持一致。
 */
export type GoogleApiThinkingLevel = "THINKING_LEVEL_UNSPECIFIED" | "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
export type ResolvedGoogleThinkingLevel = Exclude<ThinkingLevel, "xhigh" | "max">;

/** 将受支持的 pi 级别或模型专用 Google 映射解析为标准 Google 级别。 */
export function resolveGoogleThinkingLevel<T extends GoogleApiType>(
	model: Model<T>,
	level: ModelThinkingLevel,
): ResolvedGoogleThinkingLevel {
	if (level === "off") return "high";

	const mapped = model.thinkingLevelMap?.[level];
	const resolvedLevel = typeof mapped === "string" ? mapped.toLowerCase() : level;
	switch (resolvedLevel) {
		case "minimal":
		case "low":
		case "medium":
		case "high":
			return resolvedLevel;
		default:
			throw new Error(
				`Unsupported Google thinking level mapping for ${model.provider}/${model.id}: ${level} -> ${String(mapped)}`,
			);
	}
}

/**
 * 判断流式 Gemini `Part` 是否应视为“思考”内容。
 *
 * 协议说明（Gemini / Vertex AI 思考签名）：
 * - `thought: true` 是思考内容（思考摘要）的确定标记。
 * - `thoughtSignature` 是模型内部思考过程的加密表示，用于在多轮交互中保留推理上下文。
 * - `thoughtSignature` 可以出现在任意 Part 类型（text、functionCall 等）上，
 *   并不表示该 Part 本身是思考内容。
 * - 对于非 functionCall 响应，签名会出现在最后一个 Part 上，用于上下文重放。
 * - 持久化或重放模型输出时，必须原样保留带签名的 Part；不得跨 Part 合并或移动签名。
 *
 * 参见：https://ai.google.dev/gemini-api/docs/thought-signatures
 */
export function isThinkingPart(part: Pick<Part, "thought" | "thoughtSignature">): boolean {
	return part.thought === true;
}

/**
 * 在流式传输期间保留思考签名。
 *
 * 某些后端只在给定 Part/块的第一个增量中发送 `thoughtSignature`，后续增量可能省略。
 * 此辅助函数为当前块保留最后一个非空签名。
 *
 * 注意：此函数不会跨不同响应 Part 合并或移动签名，只会防止同一流式块内的签名被
 * `undefined` 覆盖。
 */
export function retainThoughtSignature(existing: string | undefined, incoming: string | undefined): string | undefined {
	if (typeof incoming === "string" && incoming.length > 0) return incoming;
	return existing;
}

// Google API 的思考签名必须是 base64（TYPE_BYTES）。
const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;

function isValidThoughtSignature(signature: string | undefined): boolean {
	if (!signature) return false;
	if (signature.length % 4 !== 0) return false;
	return base64SignaturePattern.test(signature);
}

/**
 * 只保留来自同一提供商/模型且 base64 有效的签名。
 */
function resolveThoughtSignature(isSameProviderAndModel: boolean, signature: string | undefined): string | undefined {
	return isSameProviderAndModel && isValidThoughtSignature(signature) ? signature : undefined;
}

/**
 * 通过 Google API 调用且要求在函数调用/响应中显式提供工具调用 ID 的模型。
 */
export function requiresToolCallId(modelId: string): boolean {
	const geminiMajorVersion = getGeminiMajorVersion(modelId);
	return (
		modelId.startsWith("claude-") ||
		modelId.startsWith("gpt-oss-") ||
		(geminiMajorVersion !== undefined && geminiMajorVersion >= 3)
	);
}

function getGeminiMajorVersion(modelId: string): number | undefined {
	const match = modelId.toLowerCase().match(/^gemini(?:-live)?-(\d+)/);
	if (!match) return undefined;
	return Number.parseInt(match[1], 10);
}

function supportsMultimodalFunctionResponse(modelId: string): boolean {
	const geminiMajorVersion = getGeminiMajorVersion(modelId);
	if (geminiMajorVersion !== undefined) {
		return geminiMajorVersion >= 3;
	}
	return true;
}

/**
 * 将内部消息转换为 Gemini Content[] 格式。
 */
export function convertMessages<T extends GoogleApiType>(model: Model<T>, context: Context): Content[] {
	const contents: Content[] = [];
	const normalizeToolCallId = (id: string): string => {
		if (!requiresToolCallId(model.id)) return id;
		return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
	};

	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);

	for (const msg of transformedMessages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				contents.push({
					role: "user",
					parts: [{ text: sanitizeSurrogates(msg.content) }],
				});
			} else {
				const parts: Part[] = msg.content.map((item) => {
					if (item.type === "text") {
						return { text: sanitizeSurrogates(item.text) };
					} else {
						return {
							inlineData: {
								mimeType: item.mimeType,
								data: item.data,
							},
						};
					}
				});
				if (parts.length === 0) continue;
				contents.push({
					role: "user",
					parts,
				});
			}
		} else if (msg.role === "assistant") {
			const parts: Part[] = [];
			// 检查消息是否来自同一提供商和模型，只有此时才保留思考块
			const isSameProviderAndModel = msg.provider === model.provider && msg.model === model.id;

			for (const block of msg.content) {
				if (block.type === "text") {
					const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.textSignature);
					// 跳过空文本块，除非它携带思考签名。Gemini 可以将签名附加到可见文本为空的
					// Part，并要求将其回传；丢弃它会破坏推理链，导致模型偶尔在任务进行中的轮次
					// 以仅含思考的 STOP 结束（补全为空且没有工具调用）。
					if ((!block.text || block.text.trim() === "") && !thoughtSignature) continue;
					parts.push({
						text: sanitizeSurrogates(block.text),
						...(thoughtSignature && { thoughtSignature }),
					});
				} else if (block.type === "thinking") {
					// 仅在提供商和模型都相同时保留为思考块
					// 否则转换为纯文本（不添加标签，以避免模型模仿）
					if (isSameProviderAndModel) {
						const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.thinkingSignature);
						// 规则与文本块相同：仅当空思考块不携带签名时才丢弃
						// （与 Anthropic 转换器的处理方式一致）。
						if ((!block.thinking || block.thinking.trim() === "") && !thoughtSignature) continue;
						parts.push({
							thought: true,
							text: sanitizeSurrogates(block.thinking),
							...(thoughtSignature && { thoughtSignature }),
						});
					} else {
						// 跨提供商/模型时签名不可用，仍丢弃空块。
						if (!block.thinking || block.thinking.trim() === "") continue;
						parts.push({
							text: sanitizeSurrogates(block.thinking),
						});
					}
				} else if (block.type === "toolCall") {
					const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.thoughtSignature);
					const part: Part = {
						functionCall: {
							name: block.name,
							args: block.arguments ?? {},
							...(requiresToolCallId(model.id) ? { id: block.id } : {}),
						},
						...(thoughtSignature && { thoughtSignature }),
					};
					parts.push(part);
				}
			}

			if (parts.length === 0) continue;
			contents.push({
				role: "model",
				parts,
			});
		} else if (msg.role === "toolResult") {
			// 提取文本和图像内容
			const textContent = msg.content.filter((c): c is TextContent => c.type === "text");
			const textResult = textContent.map((c) => c.text).join("\n");
			const imageContent = model.input.includes("image")
				? msg.content.filter((c): c is ImageContent => c.type === "image")
				: [];

			const hasText = textResult.length > 0;
			const hasImages = imageContent.length > 0;

			// Gemini 3+ 模型支持多模态函数响应，可将图像嵌套在 functionResponse.parts 中。
			// Cloud Code Assist 背后的 Claude 及其他非 Gemini 模型，以及 Gemini < 3，
			// 仍需要单独的用户图像轮次。
			const modelSupportsMultimodalFunctionResponse = supportsMultimodalFunctionResponse(model.id);

			// 按照 SDK 文档，成功时使用 "output" 键，出错时使用 "error" 键
			const responseValue = hasText ? sanitizeSurrogates(textResult) : hasImages ? "(see attached image)" : "";

			const imageParts: Part[] = imageContent.map((imageBlock) => ({
				inlineData: {
					mimeType: imageBlock.mimeType,
					data: imageBlock.data,
				},
			}));

			const includeId = requiresToolCallId(model.id);
			const functionResponsePart: Part = {
				functionResponse: {
					name: msg.toolName,
					response: msg.isError ? { error: responseValue } : { output: responseValue },
					...(hasImages && modelSupportsMultimodalFunctionResponse && { parts: imageParts }),
					...(includeId ? { id: msg.toolCallId } : {}),
				},
			};

			// Cloud Code Assist API 要求所有函数响应位于同一个用户轮次。
			// 检查最后一项内容是否已经是包含函数响应的用户轮次，如果是则合并。
			const lastContent = contents[contents.length - 1];
			if (lastContent?.role === "user" && lastContent.parts?.some((p) => p.functionResponse)) {
				lastContent.parts.push(functionResponsePart);
			} else {
				contents.push({
					role: "user",
					parts: [functionResponsePart],
				});
			}

			// 对于 Gemini < 3，在单独的用户消息中添加图像
			if (hasImages && !modelSupportsMultimodalFunctionResponse) {
				contents.push({
					role: "user",
					parts: [{ text: "Tool result image:" }, ...imageParts],
				});
			}
		}
	}

	return contents;
}

const JSON_SCHEMA_META_DECLARATIONS = new Set([
	"$schema",
	"$id",
	"$anchor",
	"$dynamicAnchor",
	"$vocabulary",
	"$comment",
	"$defs",
	"definitions", // draft-2019-09 之前与 $defs 等效的字段
]);

/**
 * 从 Schema 对象中移除元声明
 */
function sanitizeForOpenApi(schema: unknown): unknown {
	if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
		return schema;
	}

	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (JSON_SCHEMA_META_DECLARATIONS.has(key)) continue;
		result[key] = sanitizeForOpenApi(value);
	}
	return result;
}

/**
 * 将工具转换为 Gemini 函数声明格式。
 *
 * 默认使用支持完整 JSON Schema（包括 anyOf、oneOf、const 等）的 `parametersJsonSchema`。
 * 将 `useParameters` 设为 true 可改用旧版 `parameters` 字段（OpenAPI 3.03 Schema）。
 * Cloud Code Assist 搭配 Claude 模型时需要此设置，此时 API 会将 `parameters`
 * 转换为 Anthropic 的 `input_schema`。
 */
export function convertTools(
	tools: Tool[],
	useParameters = false,
	supportsStrictMode = true,
): { functionDeclarations: Record<string, unknown>[] }[] | undefined {
	if (tools.length === 0) return undefined;
	return [
		{
			functionDeclarations: tools.map((tool) => {
				const strict = resolveJsonSchemaStrictSampling(tool, supportsStrictMode);
				const parameters = getJsonSchemaToolParameters(tool, strict);
				return {
					name: tool.name,
					description: tool.description,
					...(useParameters
						? { parameters: sanitizeForOpenApi(parameters as unknown) }
						: { parametersJsonSchema: parameters }),
				};
			}),
		},
	];
}

/** Gemini 3+ 在经过验证的工具调用模式下强制要求必填函数参数。 */
export function supportsGoogleStrictToolSampling(modelId: string): boolean {
	const majorVersion = getGeminiMajorVersion(modelId);
	return majorVersion !== undefined && majorVersion >= 3;
}

/** 将工具选择字符串映射为 Gemini FunctionCallingConfigMode。 */
export function mapToolChoice(choice: string): FunctionCallingConfigMode {
	switch (choice) {
		case "auto":
			return FunctionCallingConfigMode.AUTO;
		case "none":
			return FunctionCallingConfigMode.NONE;
		case "any":
			return FunctionCallingConfigMode.ANY;
		default:
			return FunctionCallingConfigMode.AUTO;
	}
}

export function resolveGoogleFunctionCallingMode(
	tools: Tool[],
	toolChoice: string | undefined,
	supportsStrictMode: boolean,
): FunctionCallingConfigMode | undefined {
	const useStrictMode = tools.some((tool) => resolveJsonSchemaStrictSampling(tool, supportsStrictMode) === true);
	if (toolChoice === "none" || toolChoice === "any") {
		return mapToolChoice(toolChoice);
	}
	if (useStrictMode) {
		return FunctionCallingConfigMode.VALIDATED;
	}
	return toolChoice ? mapToolChoice(toolChoice) : undefined;
}

/**
 * 将 Gemini FinishReason 映射为内部 StopReason。
 */
export function mapStopReason(reason: FinishReason): StopReason {
	switch (reason) {
		case FinishReason.STOP:
			return "stop";
		case FinishReason.MAX_TOKENS:
			return "length";
		case FinishReason.BLOCKLIST:
		case FinishReason.PROHIBITED_CONTENT:
		case FinishReason.SPII:
		case FinishReason.SAFETY:
		case FinishReason.IMAGE_SAFETY:
		case FinishReason.IMAGE_PROHIBITED_CONTENT:
		case FinishReason.IMAGE_RECITATION:
		case FinishReason.IMAGE_OTHER:
		case FinishReason.RECITATION:
		case FinishReason.FINISH_REASON_UNSPECIFIED:
		case FinishReason.OTHER:
		case FinishReason.LANGUAGE:
		case FinishReason.MALFORMED_FUNCTION_CALL:
		case FinishReason.UNEXPECTED_TOOL_CALL:
		case FinishReason.NO_IMAGE:
			return "error";
		default: {
			const _exhaustive: never = reason;
			throw new Error(`Unhandled stop reason: ${_exhaustive}`);
		}
	}
}

/**
 * 将字符串形式的结束原因映射为内部 StopReason（用于原始 API 响应）。
 */
export function mapStopReasonString(reason: string): StopReason {
	switch (reason) {
		case "STOP":
			return "stop";
		case "MAX_TOKENS":
			return "length";
		default:
			return "error";
	}
}

/**
 * 使用共享的提供商重试策略运行 Google GenAI SDK 请求（对 408/409/429/5xx 执行退避，
 * 并遵循 retry-after），与 Anthropic 和 OpenAI 适配器使用 retryProviderRequest
 * 包装初始请求的方式一致。SDK 的 ApiError 有 `status` 属性但没有 `headers` 属性，
 * 而 retryProviderRequest 只重试同时具有两者的错误，因此在重新抛出前补充缺失的
 * `headers` 以规范化错误。
 */
export function retryGoogleRequest<T>(
	request: () => Promise<T>,
	options?: Pick<StreamOptions, "maxRetries" | "maxRetryDelayMs" | "signal">,
): Promise<T> {
	return retryProviderRequest(
		async () => {
			try {
				return await request();
			} catch (error) {
				if (error instanceof Error && "status" in error && !("headers" in error)) {
					(error as { headers?: Headers }).headers = undefined;
				}
				throw error;
			}
		},
		{
			maxRetries: options?.maxRetries,
			maxRetryDelayMs: options?.maxRetryDelayMs,
			signal: options?.signal,
		},
	);
}
