import OpenAI from "openai";
import type {
	ChatCompletionAssistantMessageParam,
	ChatCompletionChunk,
	ChatCompletionContentPart,
	ChatCompletionContentPartImage,
	ChatCompletionContentPartText,
	ChatCompletionDeveloperMessageParam,
	ChatCompletionMessageParam,
	ChatCompletionMessageToolCall,
	ChatCompletionSystemMessageParam,
	ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions.js";
import { calculateCost, clampThinkingLevel } from "../models.ts";
import type {
	AssistantMessage,
	CacheRetention,
	ChatTemplateKwargValue,
	Context,
	ImageContent,
	JsonValue,
	Message,
	Model,
	OpenAICompletionsCompat,
	ProviderEnv,
	ProviderHeaders,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingBudgets,
	ThinkingContent,
	ThinkingTokenBudgetField,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { shortHash } from "../utils/hash.ts";
import { headersToRecord } from "../utils/headers.ts";
import { parseStreamingJson } from "../utils/json-parse.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import {
	appendGrammarToolInputJsonDelta,
	createGrammarToolInputProperties,
	type GrammarToolInputJsonBuffer,
	getGrammarToolInput,
	getJsonSchemaToolParameters,
	resolveGrammarConstrainedSampling,
	resolveJsonSchemaStrictSampling,
} from "./constrained-sampling.ts";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import { buildBaseOptions, clampThinkingBudgetToAnswerRoom, thinkingBudgetForLevel } from "./simple-options.ts";
import { transformMessages } from "./transform-messages.ts";

/**
 * 检查对话消息是否包含工具调用或工具结果。
 * 这是因为通过代理访问 Anthropic 时，消息包含 tool_calls 或 tool 角色消息，
 * 必须同时提供 tools 参数。
 */
function hasHeader(headers: ProviderHeaders | undefined, name: string): boolean {
	if (!headers) return false;
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === expected && value !== null && value.trim().length > 0) return true;
	}
	return false;
}

function getClientApiKey(provider: string, apiKey: string | undefined, headers: ProviderHeaders | undefined): string {
	if (apiKey) return apiKey;
	if (hasHeader(headers, "authorization") || hasHeader(headers, "cf-aig-authorization")) return "unused";
	throw new Error(`No API key for provider: ${provider}`);
}

function hasToolHistory(messages: Message[]): boolean {
	for (const msg of messages) {
		if (msg.role === "toolResult") {
			return true;
		}
		if (msg.role === "assistant") {
			if (msg.content.some((block) => block.type === "toolCall")) {
				return true;
			}
		}
	}
	return false;
}

function getDeferredToolNames(messages: Message[]): Set<string> {
	const names = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult") {
			for (const name of message.addedToolNames ?? []) {
				names.add(name);
			}
		}
	}
	return names;
}

function getToolsByName(tools: Tool[] | undefined, names: Iterable<string>): Tool[] {
	if (!tools) return [];
	const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
	return Array.from(names)
		.map((name) => toolsByName.get(name))
		.filter((tool): tool is Tool => tool !== undefined);
}

function isTextContentBlock(block: { type: string }): block is TextContent {
	return block.type === "text";
}

function isThinkingContentBlock(block: { type: string }): block is ThinkingContent {
	return block.type === "thinking";
}

function isToolCallBlock(block: { type: string }): block is ToolCall {
	return block.type === "toolCall";
}

function isImageContentBlock(block: { type: string }): block is ImageContent {
	return block.type === "image";
}

function isReasoningDetailObject(detail: unknown): detail is Record<string, unknown> {
	return typeof detail === "object" && detail !== null && !Array.isArray(detail);
}

function hasValidCommonReasoningDetailFields(candidate: Record<string, unknown>): boolean {
	return (
		(candidate.id === undefined || candidate.id === null || typeof candidate.id === "string") &&
		(candidate.format === undefined || typeof candidate.format === "string") &&
		(candidate.index === undefined || typeof candidate.index === "number")
	);
}

function isOpenAIReasoningDetail(detail: unknown): detail is OpenAIReasoningDetail {
	if (!isReasoningDetailObject(detail) || !hasValidCommonReasoningDetailFields(detail)) {
		return false;
	}
	switch (detail.type) {
		case "reasoning.summary":
			return typeof detail.summary === "string";
		case "reasoning.encrypted":
			return typeof detail.data === "string";
		case "reasoning.text":
			return (
				typeof detail.text === "string" &&
				(detail.signature === undefined || detail.signature === null || typeof detail.signature === "string")
			);
		default:
			return false;
	}
}

export interface OpenAICompletionsOptions extends StreamOptions {
	toolChoice?: OpenAI.Chat.Completions.ChatCompletionToolChoiceOption;
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	/** 各思考级别的令牌预算。在设置 `compat.thinkingTokenBudgetField` 或 `compat.supportsThinkingTokenBudget` 时使用，也可由 `{ "$var": "thinking.budget" }` 使用。 */
	thinkingBudgets?: ThinkingBudgets;
}

export interface ConvertCompletionsMessagesOptions {
	grammarToolInputProperties?: ReadonlyMap<string, string>;
}

interface OpenAICompatCacheControl {
	type: "ephemeral";
	ttl?: string;
}

type ResolvedOpenAICompletionsCompat = Omit<
	Required<OpenAICompletionsCompat>,
	| "cacheControlFormat"
	| "deferredToolsMode"
	| "supportsThinkingTokenBudget"
	| "thinkingTokenBudgetField"
	| "vllmPriority"
> & {
	cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
	deferredToolsMode?: OpenAICompletionsCompat["deferredToolsMode"];
	supportsThinkingTokenBudget?: OpenAICompletionsCompat["supportsThinkingTokenBudget"];
	thinkingTokenBudgetField?: OpenAICompletionsCompat["thinkingTokenBudgetField"];
	vllmPriority?: OpenAICompletionsCompat["vllmPriority"];
};

type ResolvedChatTemplateKwargValue = string | number | boolean | null;

type ChatCompletionInstructionMessageParam = ChatCompletionDeveloperMessageParam | ChatCompletionSystemMessageParam;

type KimiToolSystemMessageParam = {
	role: "system";
	tools: OpenAI.Chat.Completions.ChatCompletionTool[];
};

type OpenAIReasoningDetailBase = Record<string, JsonValue> & {
	id?: string | null;
	format?: string;
	index?: number;
};

type OpenAIReasoningSummaryDetail = OpenAIReasoningDetailBase & {
	type: "reasoning.summary";
	summary: string;
};

type OpenAIEncryptedReasoningDetail = OpenAIReasoningDetailBase & {
	type: "reasoning.encrypted";
	data: string;
};

type OpenAIReasoningTextDetail = OpenAIReasoningDetailBase & {
	type: "reasoning.text";
	text: string;
	signature?: string | null;
};

type OpenAIReasoningDetail = OpenAIReasoningSummaryDetail | OpenAIEncryptedReasoningDetail | OpenAIReasoningTextDetail;

function parseOpenAIReasoningDetails(signature: string | undefined): OpenAIReasoningDetail[] | undefined {
	if (!signature) return undefined;
	try {
		const parsed = JSON.parse(signature) as unknown;
		return Array.isArray(parsed) && parsed.length > 0 && parsed.every(isOpenAIReasoningDetail) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function parseLegacyEncryptedReasoningDetail(
	signature: string | undefined,
): OpenAIEncryptedReasoningDetail | undefined {
	if (!signature) return undefined;
	try {
		const parsed = JSON.parse(signature) as unknown;
		return isOpenAIReasoningDetail(parsed) &&
			parsed.type === "reasoning.encrypted" &&
			typeof parsed.id === "string" &&
			parsed.id.length > 0 &&
			parsed.data.length > 0
			? parsed
			: undefined;
	} catch {
		return undefined;
	}
}

function fillMissingCommonReasoningDetailFields(
	target: OpenAIReasoningDetailBase,
	source: OpenAIReasoningDetail,
): void {
	target.id ??= source.id;
	target.format ||= source.format;
	target.index ??= source.index;
}

function appendOpenAIReasoningDetail(details: OpenAIReasoningDetail[], detail: OpenAIReasoningDetail): void {
	const lastDetail = details[details.length - 1];
	if (detail.type === "reasoning.text" && lastDetail?.type === "reasoning.text") {
		lastDetail.text += detail.text;
		lastDetail.signature ||= detail.signature;
		fillMissingCommonReasoningDetailFields(lastDetail, detail);
		return;
	}
	if (detail.type === "reasoning.summary" && lastDetail?.type === "reasoning.summary") {
		lastDetail.summary += detail.summary;
		fillMissingCommonReasoningDetailFields(lastDetail, detail);
		return;
	}
	details.push({ ...detail });
}

const OPENAI_COMPLETIONS_REASONING_FIELDS = ["reasoning", "reasoning_content", "reasoning_text"] as const;

type OpenAICompletionsReasoningField = (typeof OPENAI_COMPLETIONS_REASONING_FIELDS)[number];

function isOpenAICompletionsReasoningField(field: string): field is OpenAICompletionsReasoningField {
	return OPENAI_COMPLETIONS_REASONING_FIELDS.includes(field as OpenAICompletionsReasoningField);
}

type ChatCompletionAssistantMessageParamWithReasoning = ChatCompletionAssistantMessageParam &
	Partial<Record<OpenAICompletionsReasoningField, string>> & {
		reasoning_details?: JsonValue[];
	};

type ChatCompletionTextPartWithCacheControl = ChatCompletionContentPartText & {
	cache_control?: OpenAICompatCacheControl;
};

type ChatCompletionToolWithCacheControl = OpenAI.Chat.Completions.ChatCompletionTool & {
	cache_control?: OpenAICompatCacheControl;
};

function resolveCacheRetention(cacheRetention?: CacheRetention, env?: ProviderEnv): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (getProviderEnvValue("PI_CACHE_RETENTION", env) === "long") {
		return "long";
	}
	return "short";
}

export const stream: StreamFunction<"openai-completions", OpenAICompletionsOptions> = (
	model: Model<"openai-completions">,
	context: Context,
	options?: OpenAICompletionsOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
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

		// `reasoning_details` 是重放元数据，不是用户可见的流增量。
		// 流式传输期间将其保留在内存中，并在块完成时统一序列化。
		let streamedReasoningDetails: OpenAIReasoningDetail[] | undefined;
		const applyStreamedReasoningDetails = (block: ThinkingContent): void => {
			if (streamedReasoningDetails !== undefined) {
				block.thinkingSignature = JSON.stringify(streamedReasoningDetails);
			}
		};

		try {
			const apiKey = getClientApiKey(model.provider, options?.apiKey, options?.headers);
			const compat = getCompat(model);
			const grammarToolInputProperties = createGrammarToolInputProperties(
				context.tools,
				compat.supportsOpenAIGrammarTools,
			);
			const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
			const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
			const client = createClient(model, context, apiKey, options?.headers, options?.fetch, cacheSessionId, compat);
			let params = buildParams(model, context, options, compat, cacheRetention, grammarToolInputProperties);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
			}
			const requestOptions = {
				...(options?.signal ? { signal: options.signal } : {}),
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				maxRetries: 0,
			};
			const { data: openaiStream, response } = await retryProviderRequest(
				() => client.chat.completions.create(params, requestOptions).withResponse(),
				{
					maxRetries: options?.maxRetries,
					maxRetryDelayMs: options?.maxRetryDelayMs,
					signal: options?.signal,
				},
			);
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			stream.push({ type: "start", partial: output });

			interface StreamingToolCallBlock extends ToolCall {
				partialArgs?: string;
				customInput?: {
					property: string;
					jsonBuffer: GrammarToolInputJsonBuffer;
				};
				streamIndex?: number;
			}
			type StreamingBlock = TextContent | ThinkingContent | StreamingToolCallBlock;
			type StreamingToolCallDelta = {
				index?: number;
				id?: string;
				type?: string;
				function?: { name?: string; arguments?: string };
				custom?: { name?: string; input?: string };
			};

			let textBlock: TextContent | null = null;
			let thinkingBlock: ThinkingContent | null = null;
			let hasFinishReason = false;
			const toolCallBlocksByIndex = new Map<number, StreamingToolCallBlock>();
			const toolCallBlocksById = new Map<string, StreamingToolCallBlock>();
			const blocks = output.content as StreamingBlock[];
			const getContentIndex = (block: StreamingBlock) => blocks.indexOf(block);
			const getCustomToolCallInput = (block: StreamingToolCallBlock): string => {
				const property = block.customInput?.property;
				if (property === undefined) return "";
				const value = block.arguments[property];
				return typeof value === "string" ? value : "";
			};
			const appendCustomToolCallInput = (
				block: StreamingToolCallBlock,
				nextInput: string,
				close: boolean,
			): string | undefined => {
				const customInput = block.customInput;
				if (!customInput) return undefined;
				const delta = appendGrammarToolInputJsonDelta(
					customInput.jsonBuffer,
					customInput.property,
					nextInput,
					close,
				);
				block.arguments = { [customInput.property]: nextInput };
				return delta;
			};
			const finishBlock = (block: StreamingBlock) => {
				const contentIndex = getContentIndex(block);
				if (contentIndex === -1) {
					return;
				}
				if (block.type === "text") {
					stream.push({
						type: "text_end",
						contentIndex,
						content: block.text,
						partial: output,
					});
				} else if (block.type === "thinking") {
					applyStreamedReasoningDetails(block);
					stream.push({
						type: "thinking_end",
						contentIndex,
						content: block.thinking,
						partial: output,
					});
				} else if (block.type === "toolCall") {
					if (block.customInput) {
						const delta = appendCustomToolCallInput(block, getCustomToolCallInput(block), true);
						if (delta !== undefined) {
							stream.push({
								type: "toolcall_delta",
								contentIndex,
								delta,
								partial: output,
							});
						}
					} else {
						block.arguments = parseStreamingJson(block.partialArgs);
					}
					// 就地完成并移除暂存缓冲区，使重放只携带已解析参数。
					delete block.partialArgs;
					delete block.customInput;
					delete block.streamIndex;
					stream.push({
						type: "toolcall_end",
						contentIndex,
						toolCall: block,
						partial: output,
					});
				}
			};
			const ensureTextBlock = () => {
				if (!textBlock) {
					textBlock = { type: "text", text: "" };
					blocks.push(textBlock);
					stream.push({ type: "text_start", contentIndex: getContentIndex(textBlock), partial: output });
				}
				return textBlock;
			};
			const ensureThinkingBlock = (thinkingSignature: string) => {
				if (!thinkingBlock) {
					thinkingBlock = {
						type: "thinking",
						thinking: "",
						thinkingSignature,
					};
					blocks.push(thinkingBlock);
					stream.push({ type: "thinking_start", contentIndex: getContentIndex(thinkingBlock), partial: output });
				}
				return thinkingBlock;
			};
			const ensureToolCallBlock = (toolCall: StreamingToolCallDelta) => {
				const streamIndex = typeof toolCall.index === "number" ? toolCall.index : undefined;
				const name = toolCall.function?.name ?? toolCall.custom?.name ?? "";
				let block = streamIndex !== undefined ? toolCallBlocksByIndex.get(streamIndex) : undefined;
				if (!block && toolCall.id) {
					block = toolCallBlocksById.get(toolCall.id);
				}
				if (!block) {
					// 注意：正常情况下不应采用此处的 "input" 回退。如果 LLM 虚构了未知工具，
					// 至少仍有位置暂存相关内容。
					const customInputProperty =
						toolCall.custom && !toolCall.function ? (grammarToolInputProperties.get(name) ?? "input") : undefined;
					const hasCustomInput = customInputProperty !== undefined;
					block = {
						type: "toolCall",
						id: toolCall.id || "",
						name,
						arguments: hasCustomInput ? { [customInputProperty]: "" } : {},
						partialArgs: hasCustomInput ? undefined : "",
						customInput: hasCustomInput
							? { property: customInputProperty, jsonBuffer: { input: "", started: false, closed: false } }
							: undefined,
						streamIndex,
					};
					if (streamIndex !== undefined) {
						toolCallBlocksByIndex.set(streamIndex, block);
					}
					if (toolCall.id) {
						toolCallBlocksById.set(toolCall.id, block);
					}
					blocks.push(block);
					stream.push({
						type: "toolcall_start",
						contentIndex: getContentIndex(block),
						partial: output,
					});
				}
				if (streamIndex !== undefined && block.streamIndex === undefined) {
					block.streamIndex = streamIndex;
					toolCallBlocksByIndex.set(streamIndex, block);
				}
				if (toolCall.id) {
					toolCallBlocksById.set(toolCall.id, block);
				}
				if (!block.name && name) {
					block.name = name;
				}
				if (toolCall.custom && !toolCall.function && !block.customInput) {
					const customInputProperty = grammarToolInputProperties.get(block.name) ?? "input";
					block.arguments = { [customInputProperty]: "" };
					block.customInput = {
						property: customInputProperty,
						jsonBuffer: { input: "", started: false, closed: false },
					};
					delete block.partialArgs;
				}
				return block;
			};

			for await (const chunk of openaiStream) {
				if (!chunk || typeof chunk !== "object") continue;

				// OpenAI 将 ChatCompletionChunk.id 定义为唯一聊天补全标识符，
				// 流式补全中的每个块都携带相同 id。
				output.responseId ||= chunk.id;
				if (typeof chunk.model === "string" && chunk.model.length > 0 && chunk.model !== model.id) {
					output.responseModel ||= chunk.model;
				}
				if (chunk.usage) {
					output.usage = parseChunkUsage(chunk.usage, model);
				}

				const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
				if (!choice) continue;

				// 回退：部分提供商（例如 Moonshot）在 choice.usage 而不是标准
				// chunk.usage 中返回用量
				if (!chunk.usage && (choice as any).usage) {
					output.usage = parseChunkUsage((choice as any).usage, model);
				}

				if (choice.finish_reason) {
					output.rawStopReason = choice.finish_reason;
					const finishReasonResult = mapStopReason(choice.finish_reason);
					output.stopReason = finishReasonResult.stopReason;
					if (finishReasonResult.errorMessage) {
						output.errorMessage = finishReasonResult.errorMessage;
					}
					hasFinishReason = true;
				}

				if (choice.delta) {
					if (
						choice.delta.content !== null &&
						choice.delta.content !== undefined &&
						choice.delta.content.length > 0
					) {
						const block = ensureTextBlock();
						block.text += choice.delta.content;
						stream.push({
							type: "text_delta",
							contentIndex: getContentIndex(block),
							delta: choice.delta.content,
							partial: output,
						});
					}

					// 部分端点在 reasoning_content（llama.cpp）或 reasoning
					// （其他 OpenAI 兼容端点）中返回推理内容。
					// 使用第一个非空推理字段以避免重复（例如 chutes.ai 会在
					// reasoning_content 和 reasoning 中返回相同内容）。
					const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"];
					const deltaFields = choice.delta as Record<string, unknown>;
					let foundReasoningField: string | null = null;
					for (const field of reasoningFields) {
						const value = deltaFields[field];
						if (typeof value === "string" && value.length > 0) {
							foundReasoningField = field;
							break;
						}
					}

					if (foundReasoningField) {
						const delta = deltaFields[foundReasoningField];
						if (typeof delta === "string" && delta.length > 0) {
							const thinkingSignature =
								model.provider === "opencode-go" && foundReasoningField === "reasoning"
									? "reasoning_content"
									: foundReasoningField;
							const block = ensureThinkingBlock(thinkingSignature);
							block.thinking += delta;
							stream.push({
								type: "thinking_delta",
								contentIndex: getContentIndex(block),
								delta,
								partial: output,
							});
						}
					}

					if (choice?.delta?.tool_calls) {
						for (const toolCall of choice.delta.tool_calls as StreamingToolCallDelta[]) {
							const block = ensureToolCallBlock(toolCall);
							if (!block.id && toolCall.id) {
								block.id = toolCall.id;
								toolCallBlocksById.set(toolCall.id, block);
							}
							const name = toolCall.function?.name ?? toolCall.custom?.name;
							if (!block.name && name) {
								block.name = name;
							}

							let delta = "";
							if (toolCall.function?.arguments) {
								delta = toolCall.function.arguments;
								block.partialArgs = (block.partialArgs ?? "") + toolCall.function.arguments;
								block.arguments = parseStreamingJson(block.partialArgs);
							} else if (toolCall.custom?.input) {
								const nextInput = getCustomToolCallInput(block) + toolCall.custom.input;
								delta = appendCustomToolCallInput(block, nextInput, false) ?? "";
							}
							stream.push({
								type: "toolcall_delta",
								contentIndex: getContentIndex(block),
								delta,
								partial: output,
							});
						}
					}

					const reasoningDetails = (choice.delta as { reasoning_details?: unknown }).reasoning_details;
					if (Array.isArray(reasoningDetails)) {
						for (const detail of reasoningDetails) {
							if (!isOpenAIReasoningDetail(detail)) continue;
							ensureThinkingBlock("");
							streamedReasoningDetails ??= [];
							// 将提供商重放数据保存在现有签名位置。OpenRouter 以增量方式流式返回
							// reasoning_details：连续的文本/摘要增量合并为逻辑条目，
							// 加密条目则保持不透明且相互独立。
							appendOpenAIReasoningDetail(streamedReasoningDetails, detail);
						}
					}
				}
			}

			for (const block of blocks) {
				finishBlock(block);
			}
			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "aborted") {
				throw new Error("Request was aborted");
			}
			if (!hasFinishReason && !compat.supportsFinishReason) {
				output.stopReason = output.content.some((block) => block.type === "toolCall") ? "toolUse" : "stop";
			}
			if (output.stopReason === "error") {
				throw new Error(output.errorMessage || "Provider returned an error stop reason");
			}
			if ((compat.supportsFinishReason && !hasFinishReason) || output.stopReason === "pending") {
				throw new Error("Stream ended without finish_reason");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				if (block.type === "thinking") {
					applyStreamedReasoningDetails(block);
				}
				delete (block as { index?: number }).index;
				// 流式暂存缓冲区仅在解析期间使用，绝不持久化。
				delete (block as { partialArgs?: string }).partialArgs;
				delete (block as { customInput?: unknown }).customInput;
				delete (block as { streamIndex?: number }).streamIndex;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatProviderError(normalizeProviderError(error));
			// 部分通过 OpenRouter 访问的提供商会在此字段中提供额外信息。
			// normalizeProviderError 已将解析后的正文（error.error）序列化到
			// errorMessage，因此仅在原始元数据尚未出现时追加，避免重复输出。
			const rawMetadata = (error as any)?.error?.metadata?.raw;
			if (rawMetadata && !output.errorMessage.includes(String(rawMetadata))) {
				output.errorMessage += `\n${rawMetadata}`;
			}
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimple: StreamFunction<"openai-completions", SimpleStreamOptions> = (
	model: Model<"openai-completions">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	getClientApiKey(model.provider, options?.apiKey, options?.headers);

	const base = {
		...buildBaseOptions(model, context, options, options?.apiKey),
		toolChoice: options?.toolChoice,
	} satisfies OpenAICompletionsOptions;
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

	return stream(model, context, {
		...base,
		reasoningEffort,
		thinkingBudgets: options?.thinkingBudgets,
	} satisfies OpenAICompletionsOptions);
};

function createClient(
	model: Model<"openai-completions">,
	context: Context,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
	fetch?: typeof globalThis.fetch,
	sessionId?: string,
	compat: ResolvedOpenAICompletionsCompat = getCompat(model),
) {
	const headers: ProviderHeaders = { "User-Agent": getPiUserAgent(), ...model.headers };
	if (model.provider === "github-copilot") {
		const hasImages = hasCopilotVisionInput(context.messages);
		const copilotHeaders = buildCopilotDynamicHeaders({
			messages: context.messages,
			hasImages,
		});
		Object.assign(headers, copilotHeaders);
	}

	if (sessionId && compat.sendSessionAffinityHeaders) {
		if (compat.sessionAffinityFormat === "openrouter") {
			headers["x-session-id"] = sessionId;
		} else {
			if (compat.sessionAffinityFormat === "openai") {
				headers.session_id = sessionId;
			}
			headers["x-client-request-id"] = sessionId;
			headers["x-session-affinity"] = sessionId;
		}
	}

	// 最后合并选项请求头，使其可以覆盖默认值
	if (optionsHeaders) {
		Object.assign(headers, optionsHeaders);
	}

	return new OpenAI({
		apiKey,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		fetch,
		defaultHeaders: headers,
	});
}

function buildParams(
	model: Model<"openai-completions">,
	context: Context,
	options?: OpenAICompletionsOptions,
	compat: ResolvedOpenAICompletionsCompat = getCompat(model),
	cacheRetention: CacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env),
	grammarToolInputProperties: ReadonlyMap<string, string> = createGrammarToolInputProperties(
		context.tools,
		compat.supportsOpenAIGrammarTools,
	),
) {
	const messages = convertMessages(model, context, compat, { grammarToolInputProperties });
	const cacheControl = getCompatCacheControl(compat, cacheRetention);

	const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
		model: model.id,
		messages,
		stream: true,
		prompt_cache_key:
			(model.baseUrl.includes("api.openai.com") && cacheRetention !== "none") ||
			(cacheRetention === "long" && compat.supportsLongCacheRetention)
				? clampOpenAIPromptCacheKey(options?.sessionId)
				: undefined,
		prompt_cache_retention: cacheRetention === "long" && compat.supportsLongCacheRetention ? "24h" : undefined,
	};

	if (compat.supportsUsageInStreaming !== false) {
		(params as any).stream_options = { include_usage: true };
	}

	if (compat.supportsStore) {
		params.store = false;
	}

	if (options?.maxTokens) {
		if (compat.maxTokensField === "max_tokens") {
			(params as any).max_tokens = options.maxTokens;
		} else {
			params.max_completion_tokens = options.maxTokens;
		}
	}

	if (options?.temperature !== undefined) {
		params.temperature = options.temperature;
	}

	const deferredToolNames =
		compat.deferredToolsMode === "kimi" ? getDeferredToolNames(context.messages) : new Set<string>();
	const activeTools = context.tools?.filter((tool) => !deferredToolNames.has(tool.name));
	if (activeTools && activeTools.length > 0) {
		params.tools = convertTools(activeTools, compat);
		if (compat.zaiToolStream) {
			(params as any).tool_stream = true;
		}
	} else if (hasToolHistory(context.messages)) {
		// 通过 LiteLLM/代理访问 Anthropic 时，对话包含 tool_calls/tool_results 就必须提供 tools 参数
		params.tools = [];
	}

	if (cacheControl) {
		applyAnthropicCacheControl(messages, params.tools, cacheControl);
	}

	if (options?.toolChoice) {
		params.tool_choice = options.toolChoice;
	}

	if (compat.vllmPriority !== undefined) {
		(params as any).priority = compat.vllmPriority;
	}

	const thinkingTokenBudgetField = resolveThinkingTokenBudgetField(compat);
	const thinkingBudget = resolveClampedThinkingBudget(model, options, params);

	if (compat.thinkingFormat === "zai" && model.reasoning) {
		const zaiParams = params as Omit<typeof params, "reasoning_effort"> & {
			thinking?: { type: "enabled" | "disabled"; clear_thinking?: boolean };
			reasoning_effort?: string;
		};
		zaiParams.thinking = options?.reasoningEffort ? { type: "enabled", clear_thinking: false } : { type: "disabled" };
		if (options?.reasoningEffort && compat.supportsReasoningEffort) {
			const mappedEffort = model.thinkingLevelMap?.[options.reasoningEffort];
			const effort = mappedEffort === undefined ? options.reasoningEffort : mappedEffort;
			if (typeof effort === "string") {
				zaiParams.reasoning_effort = effort;
			}
		}
	} else if (compat.thinkingFormat === "qwen" && model.reasoning) {
		(params as any).enable_thinking = !!options?.reasoningEffort;
		if (options?.reasoningEffort && compat.supportsReasoningEffort) {
			const effort = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
			if (typeof effort === "string") {
				(params as any).reasoning_effort = effort;
			}
		}
	} else if (compat.thinkingFormat === "qwen-chat-template" && model.reasoning) {
		(params as any).chat_template_kwargs = {
			enable_thinking: !!options?.reasoningEffort,
			preserve_thinking: true,
		};
	} else if (compat.thinkingFormat === "chat-template" && model.reasoning) {
		const chatTemplateKwargs = buildChatTemplateValues(model, options, compat.chatTemplateKwargs, thinkingBudget);
		if (chatTemplateKwargs) {
			(params as any).chat_template_kwargs = chatTemplateKwargs;
		}
	} else if (compat.thinkingFormat === "baseten" && model.reasoning) {
		const basetenParams = params as Omit<typeof params, "reasoning_effort"> & {
			chat_template_args?: Record<string, ResolvedChatTemplateKwargValue>;
			reasoning_effort?: string;
		};
		const chatTemplateArgs = buildChatTemplateValues(model, options, compat.chatTemplateArgs, thinkingBudget);
		if (chatTemplateArgs) {
			basetenParams.chat_template_args = chatTemplateArgs;
		}
		if (compat.supportsReasoningEffort) {
			const requestedEffort = options?.reasoningEffort;
			const mappedEffort = requestedEffort ? model.thinkingLevelMap?.[requestedEffort] : model.thinkingLevelMap?.off;
			const effort = mappedEffort === undefined ? requestedEffort : mappedEffort;
			if (typeof effort === "string") {
				basetenParams.reasoning_effort = effort;
			}
		}
	} else if (compat.thinkingFormat === "deepseek" && model.reasoning) {
		if (options?.reasoningEffort) {
			(params as any).thinking = { type: "enabled" };
		} else if (model.thinkingLevelMap?.off !== null) {
			(params as any).thinking = { type: "disabled" };
		}
		if (options?.reasoningEffort && compat.supportsReasoningEffort) {
			(params as any).reasoning_effort =
				model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
		}
	} else if (compat.thinkingFormat === "openrouter" && model.reasoning) {
		// OpenRouter 通过嵌套 reasoning 对象规范化各提供商的推理设置。
		const openRouterParams = params as typeof params & { reasoning?: { effort?: string } };
		if (options?.reasoningEffort) {
			openRouterParams.reasoning = {
				effort: model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort,
			};
		} else if (model.thinkingLevelMap?.off !== null) {
			openRouterParams.reasoning = { effort: model.thinkingLevelMap?.off ?? "none" };
		}
	} else if (compat.thinkingFormat === "ant-ling" && model.reasoning && options?.reasoningEffort) {
		const effort = model.thinkingLevelMap?.[options.reasoningEffort];
		if (typeof effort === "string") {
			(params as typeof params & { reasoning?: { effort: string } }).reasoning = { effort };
		}
	} else if (compat.thinkingFormat === "together" && model.reasoning) {
		const togetherParams = params as Omit<typeof params, "reasoning_effort"> & {
			reasoning?: { enabled: boolean };
			reasoning_effort?: string;
		};
		togetherParams.reasoning = { enabled: !!options?.reasoningEffort };
		if (options?.reasoningEffort && compat.supportsReasoningEffort) {
			togetherParams.reasoning_effort = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
		}
	} else if (compat.thinkingFormat === "string-thinking" && model.reasoning) {
		const stringThinkingParams = params as typeof params & { thinking?: string };
		if (options?.reasoningEffort) {
			stringThinkingParams.thinking = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
		} else if (model.thinkingLevelMap?.off !== null) {
			stringThinkingParams.thinking = model.thinkingLevelMap?.off ?? "none";
		}
	} else if (options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort) {
		// OpenAI 风格的 reasoning_effort
		(params as any).reasoning_effort = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
	} else if (!options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort) {
		const offValue = model.thinkingLevelMap?.off;
		if (typeof offValue === "string") {
			(params as any).reasoning_effort = offValue;
		}
	}

	// 使用顶层预算字段限制推理。此行为独立于 thinkingFormat：同一服务器可承载 zai、qwen
	// 或 chat-template 模型。推理和答案在此共享 max_tokens，因此不受限制的推理阶段可能
	// 消耗整个响应，导致没有答案和工具调用。
	if (thinkingTokenBudgetField && thinkingBudget !== undefined) {
		Object.assign(params, { [thinkingTokenBudgetField]: thinkingBudget });
	}

	// OpenRouter 提供商路由偏好
	if (model.compat?.openRouterRouting) {
		(params as any).provider = model.compat.openRouterRouting;
	}

	// Vercel AI Gateway 提供商路由偏好
	if (model.compat?.vercelGatewayRouting) {
		const routing = model.compat.vercelGatewayRouting;
		if (routing.only || routing.order) {
			const gatewayOptions: Record<string, string[]> = {};
			if (routing.only) gatewayOptions.only = routing.only;
			if (routing.order) gatewayOptions.order = routing.order;
			(params as any).providerOptions = { gateway: gatewayOptions };
		}
	}

	// 最后处理，使自定义键可以覆盖具名请求字段。
	if (options?.samplingParams) {
		Object.assign(params, options.samplingParams);
	}

	return params;
}

function resolveThinkingTokenBudgetField(
	compat: Pick<OpenAICompletionsCompat, "thinkingTokenBudgetField" | "supportsThinkingTokenBudget">,
): ThinkingTokenBudgetField | undefined {
	if (compat.thinkingTokenBudgetField) return compat.thinkingTokenBudgetField;
	if (compat.supportsThinkingTokenBudget) return "thinking_token_budget";
	return undefined;
}

function resolveClampedThinkingBudget(
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
	params: { max_tokens?: number | null; max_completion_tokens?: number | null },
): number | undefined {
	if (!options?.reasoningEffort || !model.reasoning) return undefined;
	const ceiling = params.max_tokens ?? params.max_completion_tokens ?? model.maxTokens;
	const budget = clampThinkingBudgetToAnswerRoom(
		thinkingBudgetForLevel(options.reasoningEffort, options.thinkingBudgets),
		ceiling,
	);
	return budget > 0 ? budget : undefined;
}

function buildChatTemplateValues(
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
	values: Record<string, ChatTemplateKwargValue>,
	thinkingBudget?: number,
): Record<string, ResolvedChatTemplateKwargValue> | undefined {
	const resolvedValues: Record<string, ResolvedChatTemplateKwargValue> = {};

	for (const [key, value] of Object.entries(values)) {
		const resolved = resolveChatTemplateKwargValue(model, options, value, thinkingBudget);
		if (resolved !== undefined) {
			resolvedValues[key] = resolved;
		}
	}

	return Object.keys(resolvedValues).length > 0 ? resolvedValues : undefined;
}

function resolveChatTemplateKwargValue(
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
	value: ChatTemplateKwargValue,
	thinkingBudget?: number,
): ResolvedChatTemplateKwargValue | undefined {
	if (typeof value !== "object" || value === null) {
		return value;
	}

	const reasoningEffort = options?.reasoningEffort;
	if (!reasoningEffort && value.omitWhenOff) {
		return undefined;
	}
	if (value.$var === "thinking.enabled") {
		return !!reasoningEffort;
	}
	if (value.$var === "thinking.budget") {
		return thinkingBudget;
	}

	const mappedValue = reasoningEffort ? model.thinkingLevelMap?.[reasoningEffort] : model.thinkingLevelMap?.off;
	return mappedValue === undefined ? reasoningEffort : typeof mappedValue === "string" ? mappedValue : undefined;
}

function getCompatCacheControl(
	compat: ResolvedOpenAICompletionsCompat,
	cacheRetention: CacheRetention,
): OpenAICompatCacheControl | undefined {
	if (compat.cacheControlFormat !== "anthropic" || cacheRetention === "none") {
		return undefined;
	}

	const ttl = cacheRetention === "long" && compat.supportsLongCacheRetention ? "1h" : undefined;
	return { type: "ephemeral", ...(ttl ? { ttl } : {}) };
}

function applyAnthropicCacheControl(
	messages: ChatCompletionMessageParam[],
	tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
	cacheControl: OpenAICompatCacheControl,
): void {
	addCacheControlToSystemPrompt(messages, cacheControl);
	addCacheControlToLastTool(tools, cacheControl);
	addCacheControlToLastConversationMessage(messages, cacheControl);
}

function addCacheControlToSystemPrompt(
	messages: ChatCompletionMessageParam[],
	cacheControl: OpenAICompatCacheControl,
): void {
	for (const message of messages) {
		if (message.role === "system" || message.role === "developer") {
			addCacheControlToInstructionMessage(message, cacheControl);
			return;
		}
	}
}

function addCacheControlToLastConversationMessage(
	messages: ChatCompletionMessageParam[],
	cacheControl: OpenAICompatCacheControl,
): void {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "user" || message.role === "assistant" || message.role === "tool") {
			if (addCacheControlToMessage(message, cacheControl)) {
				return;
			}
		}
	}
}

function addCacheControlToLastTool(
	tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
	cacheControl: OpenAICompatCacheControl,
): void {
	if (!tools || tools.length === 0) {
		return;
	}

	const lastTool = tools[tools.length - 1] as ChatCompletionToolWithCacheControl;
	lastTool.cache_control = cacheControl;
}

function addCacheControlToInstructionMessage(
	message: ChatCompletionInstructionMessageParam,
	cacheControl: OpenAICompatCacheControl,
): boolean {
	return addCacheControlToTextContent(message, cacheControl);
}

function addCacheControlToMessage(
	message: ChatCompletionMessageParam,
	cacheControl: OpenAICompatCacheControl,
): boolean {
	if (message.role === "user" || message.role === "assistant" || message.role === "tool") {
		return addCacheControlToTextContent(message, cacheControl);
	}
	return false;
}

function addCacheControlToTextContent(
	message:
		| ChatCompletionInstructionMessageParam
		| ChatCompletionAssistantMessageParam
		| ChatCompletionToolMessageParam
		| Extract<ChatCompletionMessageParam, { role: "user" }>,
	cacheControl: OpenAICompatCacheControl,
): boolean {
	const content = message.content;
	if (typeof content === "string") {
		if (content.length === 0) {
			return false;
		}
		message.content = [
			{
				type: "text",
				text: content,
				cache_control: cacheControl,
			},
		] as ChatCompletionTextPartWithCacheControl[];
		return true;
	}

	if (!Array.isArray(content)) {
		return false;
	}

	for (let i = content.length - 1; i >= 0; i--) {
		const part = content[i];
		if (part?.type === "text") {
			const textPart = part as ChatCompletionTextPartWithCacheControl;
			textPart.cache_control = cacheControl;
			return true;
		}
	}

	return false;
}

export function convertMessages(
	model: Model<"openai-completions">,
	context: Context,
	compat: ResolvedOpenAICompletionsCompat,
	options?: ConvertCompletionsMessagesOptions,
): ChatCompletionMessageParam[] {
	const params: ChatCompletionMessageParam[] = [];

	const normalizeToolCallId = (id: string): string => {
		// 处理 OpenAI Responses API 中以竖线分隔的 ID
		// 格式：{call_id}|{id}，其中 {id} 可超过 400 个字符并包含特殊字符（+、/、=）
		// 这些 ID 来自 github-copilot、openai-codex、opencode 等提供商
		// 只提取 call_id 部分并进行规范化
		// 同一轮中的多个工具调用可能共享 call_id，但 item_id 不同。
		// 重放到要求工具调用 id 各不相同的 Chat Completions 时，保留条目级唯一性。
		if (id.includes("|")) {
			// 清理为允许的字符并截断到 40 个字符（OpenAI 限制）
			const separatorIndex = id.indexOf("|");
			const callId = id.slice(0, separatorIndex).replace(/[^a-zA-Z0-9_-]/g, "_");
			const itemId = id.slice(separatorIndex + 1).replace(/[^a-zA-Z0-9_-]/g, "_");
			const combinedId = itemId.length > 0 ? `${callId}_${itemId}` : callId;
			if (combinedId.length <= 40) {
				return combinedId;
			}
			const hash = shortHash(id).slice(0, 8);
			const prefix = callId.slice(0, Math.max(1, 40 - hash.length - 1));
			return `${prefix}_${hash}`;
		}

		if (model.provider === "openai") return id.length > 40 ? id.slice(0, 40) : id;
		return id;
	};

	const transformedMessages = transformMessages(context.messages, model, (id) => normalizeToolCallId(id));

	if (context.systemPrompt) {
		const useDeveloperRole = model.reasoning && compat.supportsDeveloperRole;
		const role = useDeveloperRole ? "developer" : "system";
		params.push({ role: role, content: sanitizeSurrogates(context.systemPrompt) });
	}

	let lastRole: string | null = null;

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];
		// 部分提供商不允许用户消息紧跟在工具结果之后
		// 插入一条合成助手消息以衔接两者
		if (compat.requiresAssistantAfterToolResult && lastRole === "toolResult" && msg.role === "user") {
			params.push({
				role: "assistant",
				content: "I have processed the tool results.",
			});
		}

		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				params.push({
					role: "user",
					content: sanitizeSurrogates(msg.content),
				});
			} else {
				const content: ChatCompletionContentPart[] = msg.content.map((item): ChatCompletionContentPart => {
					if (item.type === "text") {
						return {
							type: "text",
							text: sanitizeSurrogates(item.text),
						} satisfies ChatCompletionContentPartText;
					} else {
						return {
							type: "image_url",
							image_url: {
								url: `data:${item.mimeType};base64,${item.data}`,
							},
						} satisfies ChatCompletionContentPartImage;
					}
				});
				if (content.length === 0) continue;
				params.push({
					role: "user",
					content,
				});
			}
		} else if (msg.role === "assistant") {
			// 部分提供商不接受 null 内容，改用空字符串
			const assistantMsg: ChatCompletionAssistantMessageParamWithReasoning = {
				role: "assistant",
				content: compat.requiresAssistantAfterToolResult ? "" : null,
			};

			const assistantTextParts = msg.content
				.filter(isTextContentBlock)
				.filter((block) => block.text.trim().length > 0)
				.map(
					(block) =>
						({
							type: "text",
							text: sanitizeSurrogates(block.text),
						}) satisfies ChatCompletionContentPartText,
				);
			const assistantText = assistantTextParts.map((part) => part.text).join("");

			const thinkingBlocks = msg.content.filter(isThinkingContentBlock);
			const toolCalls = msg.content.filter(isToolCallBlock);
			const signedReasoningDetails = thinkingBlocks
				.map((block) => parseOpenAIReasoningDetails(block.thinkingSignature))
				.find((details) => details !== undefined);
			const legacyReasoningDetails = toolCalls
				.map((toolCall) => parseLegacyEncryptedReasoningDetail(toolCall.thoughtSignature))
				.filter((detail): detail is OpenAIEncryptedReasoningDetail => detail !== undefined);
			const preservedReasoningDetails =
				signedReasoningDetails ?? (legacyReasoningDetails.length > 0 ? legacyReasoningDetails : undefined);

			const nonEmptyThinkingBlocks = thinkingBlocks.filter((block) => block.thinking.trim().length > 0);
			if (nonEmptyThinkingBlocks.length > 0) {
				if (compat.requiresThinkingAsText) {
					// 将思考块转换为纯文本（不添加标签，以避免模型模仿）
					const thinkingText = nonEmptyThinkingBlocks
						.map((block) => sanitizeSurrogates(block.thinking))
						.join("\n\n");
					assistantMsg.content = [{ type: "text", text: thinkingText }, ...assistantTextParts];
				} else {
					// 始终以纯字符串发送助手内容（OpenAI Chat Completions API 标准格式）。
					// 以 {type:"text", text:"..."} 对象数组发送并不标准，会导致部分模型
					// （例如通过 NVIDIA NIM 使用的 DeepSeek V3.2）在输出中逐字模仿内容块结构，
					// 产生类似 [{'type':'text','text':'[{...}]'}] 的递归嵌套。
					if (assistantText.length > 0) {
						assistantMsg.content = assistantText;
					}

					// reasoning_details 是原始 reasoning 字段的结构化替代形式。
					if (!preservedReasoningDetails) {
						// 如果可用，使用第一个思考块的签名（适用于 llama.cpp 服务器和 gpt-oss）
						let signature = nonEmptyThinkingBlocks[0].thinkingSignature;
						if (model.provider === "opencode-go" && signature === "reasoning") {
							signature = "reasoning_content";
						}
						if (signature && isOpenAICompletionsReasoningField(signature)) {
							assistantMsg[signature] = nonEmptyThinkingBlocks.map((block) => block.thinking).join("\n");
						}
					}
				}
			} else if (assistantText.length > 0) {
				// 始终以纯字符串发送助手内容（OpenAI Chat Completions API 标准格式）。
				// 以 {type:"text", text:"..."} 对象数组发送并不标准，会导致部分模型
				// （例如通过 NVIDIA NIM 使用的 DeepSeek V3.2）在输出中逐字模仿内容块结构，
				// 产生类似 [{'type':'text','text':'[{...}]'}] 的递归嵌套。
				assistantMsg.content = assistantText;
			}

			if (toolCalls.length > 0) {
				assistantMsg.tool_calls = toolCalls.map((tc): ChatCompletionMessageToolCall => {
					const customInputProperty = options?.grammarToolInputProperties?.get(tc.name);
					if (customInputProperty !== undefined) {
						return {
							id: tc.id,
							type: "custom",
							custom: {
								name: tc.name,
								input: sanitizeSurrogates(getGrammarToolInput(tc.name, tc.arguments, customInputProperty)),
							},
						};
					}
					return {
						id: tc.id,
						type: "function",
						function: {
							name: tc.name,
							arguments: JSON.stringify(tc.arguments),
						},
					};
				});
			}
			if (preservedReasoningDetails) {
				assistantMsg.reasoning_details = preservedReasoningDetails;
			}
			if (
				compat.requiresReasoningContentOnAssistantMessages &&
				model.reasoning &&
				assistantMsg.reasoning_content === undefined
			) {
				assistantMsg.reasoning_content = "";
			}
			// 跳过既无内容也无工具调用的助手消息。
			// 部分提供商要求“content 或 tool_calls 至少存在一个”。
			// 其他提供商也不接受空助手消息。
			// 此逻辑用于处理未产生内容的已中止助手响应。
			const content = assistantMsg.content;
			const hasContent =
				content !== null &&
				content !== undefined &&
				(typeof content === "string" ? content.length > 0 : content.length > 0);
			if (!hasContent && !assistantMsg.tool_calls) {
				continue;
			}
			params.push(assistantMsg);
		} else if (msg.role === "toolResult") {
			const imageBlocks: Array<{ type: "image_url"; image_url: { url: string } }> = [];
			const deferredToolNames = new Set<string>();
			let j = i;

			for (; j < transformedMessages.length && transformedMessages[j].role === "toolResult"; j++) {
				const toolMsg = transformedMessages[j] as ToolResultMessage;

				// 提取文本和图像内容
				const textResult = toolMsg.content
					.filter(isTextContentBlock)
					.map((block) => block.text)
					.join("\n");
				const hasImages = toolMsg.content.some((c) => c.type === "image");

				// 始终以文本发送工具结果（只有图像时使用占位符）
				const hasText = textResult.length > 0;
				const toolResultText = hasText ? textResult : hasImages ? "(see attached image)" : "(no tool output)";
				// 部分提供商要求工具结果包含 'name' 字段
				const toolResultMsg: ChatCompletionToolMessageParam = {
					role: "tool",
					content: sanitizeSurrogates(toolResultText),
					tool_call_id: toolMsg.toolCallId,
				};
				if (compat.requiresToolResultName && toolMsg.toolName) {
					(toolResultMsg as any).name = toolMsg.toolName;
				}
				params.push(toolResultMsg);

				if (compat.deferredToolsMode === "kimi") {
					for (const name of toolMsg.addedToolNames ?? []) {
						deferredToolNames.add(name);
					}
				}

				if (hasImages && model.input.includes("image")) {
					for (const block of toolMsg.content) {
						if (isImageContentBlock(block)) {
							imageBlocks.push({
								type: "image_url",
								image_url: {
									url: `data:${block.mimeType};base64,${block.data}`,
								},
							});
						}
					}
				}
			}

			i = j - 1;

			if (imageBlocks.length > 0) {
				if (compat.requiresAssistantAfterToolResult) {
					params.push({
						role: "assistant",
						content: "I have processed the tool results.",
					});
				}

				params.push({
					role: "user",
					content: [
						{
							type: "text",
							text: "Attached image(s) from tool result:",
						},
						...imageBlocks,
					],
				});
				lastRole = "user";
			} else {
				lastRole = "toolResult";
			}

			if (deferredToolNames.size > 0) {
				const deferredTools = getToolsByName(context.tools, deferredToolNames);
				if (deferredTools.length > 0) {
					const kimiToolMessage: KimiToolSystemMessageParam = {
						role: "system",
						tools: convertTools(deferredTools, compat),
					};
					// Kimi 接受包含工具但省略标准 content 字段的系统消息。
					params.push(kimiToolMessage as unknown as ChatCompletionMessageParam);
				}
			}
			continue;
		}

		lastRole = msg.role;
	}

	return params;
}

function convertTools(
	tools: Tool[],
	compat: ResolvedOpenAICompletionsCompat,
): OpenAI.Chat.Completions.ChatCompletionTool[] {
	return tools.map((tool) => {
		const grammar = resolveGrammarConstrainedSampling(tool, compat.supportsOpenAIGrammarTools);
		if (grammar) {
			return {
				type: "custom",
				custom: {
					name: tool.name,
					description: tool.description,
					format: {
						type: "grammar",
						grammar: {
							syntax: grammar.format,
							definition: grammar.definition,
						},
					},
				},
			};
		}

		const strict = resolveJsonSchemaStrictSampling(tool, compat.supportsStrictMode !== false);
		return {
			type: "function",
			function: {
				name: tool.name,
				description: tool.description,
				parameters: getJsonSchemaToolParameters(tool, strict) as Record<string, unknown>,
				// 仅在提供商支持时包含 strict；部分提供商会拒绝未知字段。
				...(compat.supportsStrictMode !== false && { strict: strict ?? false }),
			},
		};
	});
}

function parseChunkUsage(
	rawUsage: {
		prompt_tokens?: number;
		completion_tokens?: number;
		cached_tokens?: number;
		prompt_cache_hit_tokens?: number;
		prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
		completion_tokens_details?: { reasoning_tokens?: number };
	},
	model: Model<"openai-completions">,
): AssistantMessage["usage"] {
	const promptTokens = rawUsage.prompt_tokens || 0;
	const cacheReadTokens =
		rawUsage.prompt_tokens_details?.cached_tokens ?? rawUsage.prompt_cache_hit_tokens ?? rawUsage.cached_tokens ?? 0;
	const cacheWriteTokens = rawUsage.prompt_tokens_details?.cache_write_tokens || 0;

	// 遵循 OpenAI/OpenRouter 文档语义：cached_tokens 是缓存读取令牌（命中）。
	// 各提供商的字段位置不同：OpenAI/OpenRouter 使用 prompt_tokens_details.cached_tokens，
	// DeepSeek 使用 prompt_cache_hit_tokens，Kimi 文档则在最终用量块的顶层
	// usage.cached_tokens 中记录。OpenAI 不记录也不发送 cache_write_tokens，
	// 但 OpenRouter 兼容提供商可将其作为独立写入计数提供。
	// OpenRouter 自身的提供商实现/测试确认了此独立映射：
	// https://github.com/OpenRouterTeam/ai-sdk-provider/pull/409
	// 不要从 cached_tokens 中减去写入量，否则符合规范的提供商用量会被低报。
	// DS4 也遵循此契约：
	// https://github.com/antirez/ds4/pull/29
	const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
	// OpenAI completion_tokens 已包含 reasoning_tokens。
	const outputTokens = rawUsage.completion_tokens || 0;
	const usage: AssistantMessage["usage"] = {
		input,
		output: outputTokens,
		cacheRead: cacheReadTokens,
		cacheWrite: cacheWriteTokens,
		reasoning: rawUsage.completion_tokens_details?.reasoning_tokens || 0,
		totalTokens: input + outputTokens + cacheReadTokens + cacheWriteTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	return usage;
}

function mapStopReason(reason: ChatCompletionChunk.Choice["finish_reason"] | string): {
	stopReason: StopReason;
	errorMessage?: string;
} {
	if (reason === null) return { stopReason: "stop" };
	switch (reason) {
		case "stop":
		case "end":
			return { stopReason: "stop" };
		case "length":
			return { stopReason: "length" };
		case "function_call":
		case "tool_calls":
			return { stopReason: "toolUse" };
		case "content_filter":
			return { stopReason: "error", errorMessage: "Provider finish_reason: content_filter" };
		case "network_error":
			return { stopReason: "error", errorMessage: "Provider finish_reason: network_error" };
		default:
			return {
				stopReason: "error",
				errorMessage: `Provider finish_reason: ${reason}`,
			};
	}
}

/**
 * 根据提供商名称和 baseUrl 自动检测兼容性设置。
 * 未设置 model.compat 时作为基础值；显式 model.compat 条目会覆盖检测值。
 */
function detectCompat(model: Model<"openai-completions">): ResolvedOpenAICompletionsCompat {
	const provider = model.provider;
	const baseUrl = model.baseUrl;

	const isZai =
		provider === "zai" ||
		provider === "zai-coding-cn" ||
		baseUrl.includes("api.z.ai") ||
		baseUrl.includes("open.bigmodel.cn");
	const isTogether =
		provider === "together" || baseUrl.includes("api.together.ai") || baseUrl.includes("api.together.xyz");
	const isMoonshot = provider === "moonshotai" || provider === "moonshotai-cn" || baseUrl.includes("api.moonshot.");
	const isOpenRouter = provider === "openrouter" || baseUrl.includes("openrouter.ai");
	const isCloudflareWorkersAI = provider === "cloudflare-workers-ai" || baseUrl.includes("api.cloudflare.com");
	const isCloudflareAiGateway = provider === "cloudflare-ai-gateway" || baseUrl.includes("gateway.ai.cloudflare.com");
	const isNvidia = provider === "nvidia" || baseUrl.includes("integrate.api.nvidia.com");
	const isAntLing = provider === "ant-ling" || baseUrl.includes("api.ant-ling.com");
	const isDeepSeek = provider === "deepseek" || baseUrl.toLowerCase().includes("deepseek.com");

	const isNonStandard =
		isNvidia ||
		provider === "cerebras" ||
		baseUrl.includes("cerebras.ai") ||
		provider === "xai" ||
		baseUrl.includes("api.x.ai") ||
		isTogether ||
		baseUrl.includes("chutes.ai") ||
		isDeepSeek ||
		isZai ||
		isMoonshot ||
		provider === "opencode" ||
		baseUrl.includes("opencode.ai") ||
		isCloudflareWorkersAI ||
		isCloudflareAiGateway ||
		isAntLing;

	const useMaxTokens =
		baseUrl.includes("chutes.ai") ||
		isDeepSeek ||
		isMoonshot ||
		isCloudflareAiGateway ||
		isTogether ||
		isNvidia ||
		isAntLing ||
		isZai;

	const isGrok = provider === "xai" || baseUrl.includes("api.x.ai");
	const isOpenRouterDeveloperRoleModel =
		isOpenRouter && (model.id.startsWith("anthropic/") || model.id.startsWith("openai/"));
	const cacheControlFormat = provider === "openrouter" && model.id.startsWith("anthropic/") ? "anthropic" : undefined;

	return {
		supportsStore: !isNonStandard,
		supportsDeveloperRole: isOpenRouterDeveloperRoleModel || (!isNonStandard && !isOpenRouter),
		supportsReasoningEffort:
			!isGrok && !isZai && !isMoonshot && !isTogether && !isCloudflareAiGateway && !isNvidia && !isAntLing,
		supportsUsageInStreaming: true,
		supportsFinishReason: true,
		maxTokensField: useMaxTokens ? "max_tokens" : "max_completion_tokens",
		requiresToolResultName: false,
		requiresAssistantAfterToolResult: false,
		requiresThinkingAsText: false,
		requiresReasoningContentOnAssistantMessages: isDeepSeek,
		thinkingFormat: isDeepSeek
			? "deepseek"
			: isZai
				? "zai"
				: isTogether
					? "together"
					: isAntLing
						? "ant-ling"
						: isOpenRouter
							? "openrouter"
							: "openai",
		openRouterRouting: {},
		vercelGatewayRouting: {},
		chatTemplateKwargs: {},
		chatTemplateArgs: {},
		zaiToolStream: false,
		supportsThinkingTokenBudget: false,
		thinkingTokenBudgetField: undefined,
		supportsStrictMode: !isMoonshot && !isTogether && !isCloudflareAiGateway && !isNvidia,
		supportsOpenAIGrammarTools: false,
		cacheControlFormat,
		sendSessionAffinityHeaders: false,
		deferredToolsMode: undefined,
		sessionAffinityFormat: isOpenRouter ? "openrouter" : "openai",
		supportsLongCacheRetention: !(
			isTogether ||
			isCloudflareWorkersAI ||
			isCloudflareAiGateway ||
			isNvidia ||
			isAntLing
		),
	};
}

/**
 * 获取模型解析后的兼容性设置。
 * 先根据提供商/URL 自动检测，再使用显式 model.compat 覆盖。
 */
function getCompat(model: Model<"openai-completions">): ResolvedOpenAICompletionsCompat {
	const detected = detectCompat(model);
	if (!model.compat) return detected;

	return {
		supportsStore: model.compat.supportsStore ?? detected.supportsStore,
		supportsDeveloperRole: model.compat.supportsDeveloperRole ?? detected.supportsDeveloperRole,
		supportsReasoningEffort: model.compat.supportsReasoningEffort ?? detected.supportsReasoningEffort,
		supportsUsageInStreaming: model.compat.supportsUsageInStreaming ?? detected.supportsUsageInStreaming,
		supportsFinishReason: model.compat.supportsFinishReason ?? detected.supportsFinishReason,
		maxTokensField: model.compat.maxTokensField ?? detected.maxTokensField,
		requiresToolResultName: model.compat.requiresToolResultName ?? detected.requiresToolResultName,
		requiresAssistantAfterToolResult:
			model.compat.requiresAssistantAfterToolResult ?? detected.requiresAssistantAfterToolResult,
		requiresThinkingAsText: model.compat.requiresThinkingAsText ?? detected.requiresThinkingAsText,
		requiresReasoningContentOnAssistantMessages:
			model.compat.requiresReasoningContentOnAssistantMessages ??
			detected.requiresReasoningContentOnAssistantMessages,
		thinkingFormat: model.compat.thinkingFormat ?? detected.thinkingFormat,
		openRouterRouting: model.compat.openRouterRouting ?? {},
		vercelGatewayRouting: model.compat.vercelGatewayRouting ?? detected.vercelGatewayRouting,
		chatTemplateKwargs: model.compat.chatTemplateKwargs ?? detected.chatTemplateKwargs,
		chatTemplateArgs: model.compat.chatTemplateArgs ?? detected.chatTemplateArgs,
		zaiToolStream: model.compat.zaiToolStream ?? detected.zaiToolStream,
		supportsThinkingTokenBudget: model.compat.supportsThinkingTokenBudget ?? detected.supportsThinkingTokenBudget,
		thinkingTokenBudgetField: model.compat.thinkingTokenBudgetField ?? detected.thinkingTokenBudgetField,
		supportsStrictMode: model.compat.supportsStrictMode ?? detected.supportsStrictMode,
		supportsOpenAIGrammarTools: model.compat.supportsOpenAIGrammarTools ?? detected.supportsOpenAIGrammarTools,
		cacheControlFormat: model.compat.cacheControlFormat ?? detected.cacheControlFormat,
		sendSessionAffinityHeaders: model.compat.sendSessionAffinityHeaders ?? detected.sendSessionAffinityHeaders,
		deferredToolsMode: model.compat.deferredToolsMode ?? detected.deferredToolsMode,
		sessionAffinityFormat: model.compat.sessionAffinityFormat ?? detected.sessionAffinityFormat,
		supportsLongCacheRetention: model.compat.supportsLongCacheRetention ?? detected.supportsLongCacheRetention,
		vllmPriority: model.compat.vllmPriority,
	};
}
