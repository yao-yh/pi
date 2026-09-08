import type { AssistantMessage } from "../types.ts";

function buildProviderErrorPattern(patterns: readonly string[]): RegExp {
	return new RegExp(patterns.join("|"), "i");
}

const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
	// OpenCode Zen API 将 OpenCode Go/免费层限制作为 429 JSON 错误类型返回。
	// 这些是订阅/账户限制，不是瞬时限流。
	"GoUsageLimitError",
	"FreeUsageLimitError",

	// 达到滚动/每周/每月限制后，OpenCode Go 订阅限制文本会要求用户启用可用余额用量。
	"Monthly usage limit reached",
	"available balance",

	// 通用配额/预算/账单耗尽。`insufficient_quota` 是 OpenAI 配额/账单错误码；
	// 其他字符串涵盖常见网关措辞。
	"insufficient_quota",
	"out of budget",
	"quota exceeded",
	"billing",
]);

const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
	// 通用提供商负载、HTTP 状态和服务端瞬时故障。
	"overloaded",
	"rate.?limit",
	"too many requests",
	"429",
	"500",
	"502",
	"503",
	"504",
	"524",
	"service.?unavailable",
	"server.?error",
	"internal.?error",

	// 瞬时上游故障的包装器/提供商文本，包括 OpenRouter
	// "Provider returned error" 响应（#2264）。
	"provider.?returned.?error",
	"exceeded request buffer limit while retrying upstream",

	// 网络、代理和 fetch 传输故障。包括 OpenAI Codex 的原始 fetch 故障，例如
	// "upstream connect"、"connection refused"、"reset before headers"（#733），
	// 以及 OpenRouter 连接断开（#3317）。
	"network.?error",
	"connection.?error",
	"connection.?refused",
	"connection.?lost",
	"other side closed",
	"fetch failed",
	"getaddrinfo",
	"ENOTFOUND",
	"EAI_AGAIN",
	"upstream.?connect",
	"reset before headers",
	"socket hang up",
	"socket connection was closed",
	"timed? out",
	"timeout",
	"terminated",

	// WebSocket 传输可能报告关闭/错误文本，而不是 HTTP/fetch 文本。
	"websocket.?closed",
	"websocket.?error",

	// SDK 和传输过早结束流。Anthropic 可能抛出 "stream ended without ..." 和
	// "Anthropic stream ended before message_stop"（#4433）；Bedrock/Smithy 可能抛出
	// HTTP/2 无响应错误（#3594）。
	"ended without",
	"stream ended before message_stop",
	"stream ended before a terminal response event",
	"http2 request did not get a response",

	// 提供商要求的重试延迟超过上限时，应交由外层重试策略处理，
	// 使调用方可以显示/中止退避（#1123）。
	"retry delay",

	// OpenAI Responses 和 Bedrock 流异常在流中途发出的显式重试指引（#6019）。
	"you can retry your request",
	"try your request again",
	"please retry your request",

	// 基于 gRPC 的提供商（例如 NVIDIA NIM）
	"ResourceExhausted",
]);

/**
 * 重试策略：使用指数退避（`baseDelayMs * 2^(attempt-1)`）的有界尝试。
 * 与 coding-agent 中的 `settings.retry`（`enabled`、`maxRetries`、`baseDelayMs`）匹配；
 * 放在此处使分类器和策略驱动的重试循环保持在一起，并可由 SDK 和其他调用方复用。
 */
export interface RetryPolicy {
	enabled: boolean;
	/** 最大重试次数（0 表示不重试）。初始调用不计为重试。 */
	maxRetries: number;
	/** 基础延迟，单位为毫秒。加入抖动前，每次尝试的延迟为 `baseDelayMs * 2^(attempt-1)`。 */
	baseDelayMs: number;
}

/** {@link retryAssistantCall} 在每次重试前后发出的可选回调。 */
export interface RetryCallbacks {
	/** 每次重试（从 1 开始计数）的退避等待前发出。 */
	onRetryScheduled?: (
		attempt: number,
		maxAttempts: number,
		delayMs: number,
		errorMessage: string,
	) => void | Promise<void>;
	/** 退避等待后、重试调用即将开始前发出。 */
	onRetryAttemptStart?: () => void | Promise<void>;
	/** 循环结束时发出一次；后续调用正常完成时 success 为 true。 */
	onRetryFinished?: (success: boolean, attempt: number, finalError?: string) => void | Promise<void>;
}

class RetrySleepAbortError extends Error {
	constructor() {
		super("Aborted");
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new RetrySleepAbortError());
			return;
		}
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(new RetrySleepAbortError());
			},
			{ once: true },
		);
	});
}

/**
 * 运行单次生成助手消息的调用，并对瞬时错误进行有界重试。
 *
 * 行为：
 * - 成功响应立即返回。中止是终止状态，绝不重试；如果发生在已安排重试后，则报告失败。
 *   退避等待期间的中止也规范化为已中止的 `AssistantMessage`，调用方无需关心取消发生的时机。
 * - 不可重试错误（由 {@link isRetryableAssistantError} 判断，包括配额/账单耗尽）立即返回，
 *   使确定性错误快速失败。
 * - 其他情况使用指数退避最多重试 `maxRetries` 次；每次等待前发出 `onRetryScheduled`，
 *   等待后、重试调用开始前发出 `onRetryAttemptStart`，结束时发出一次 `onRetryFinished`
 *   （无论循环以成功、重试耗尽还是退避中止结束）。
 *
 * `policy` 为 undefined 或已禁用时，原样返回首次响应（等同于直接调用 `produce()`）。
 */
export async function retryAssistantCall(
	produce: () => Promise<AssistantMessage>,
	policy: RetryPolicy | undefined,
	signal: AbortSignal | undefined,
	callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
	const maxAttempts = policy?.enabled ? policy.maxRetries : 0;

	let attempt = 0;
	let lastRetry: { attempt: number; errorMessage: string } | undefined;
	for (;;) {
		const response = await produce();

		// 中止：终止但不成功。绝不重试已中止消息。
		if (response.stopReason === "aborted") {
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt);
			return response;
		}

		// 成功：非错误、非中止响应原样返回。
		if (response.stopReason !== "error") {
			if (lastRetry) await callbacks?.onRetryFinished?.(true, lastRetry.attempt);
			return response;
		}

		// 不可重试或预算耗尽：返回最终错误消息。
		if (attempt >= maxAttempts || !isRetryableAssistantError(response)) {
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt, response.errorMessage);
			return response;
		}

		attempt++;
		lastRetry = { attempt, errorMessage: response.errorMessage || "Unknown error" };
		const delayMs = policy!.baseDelayMs * 2 ** (attempt - 1);
		await callbacks?.onRetryScheduled?.(attempt, maxAttempts, delayMs, lastRetry.errorMessage);

		// 将重试退避期间的中止规范化为与提供商流中止相同的 AssistantMessage 结构，
		// 使调用方无需关心取消发生的时机。
		try {
			await sleep(delayMs, signal);
		} catch (error) {
			await callbacks?.onRetryFinished?.(false, attempt, lastRetry.errorMessage);
			if (error instanceof RetrySleepAbortError) {
				const { errorMessage: _errorMessage, ...rest } = response;
				return { ...rest, stopReason: "aborted" };
			}
			throw error;
		}
		await callbacks?.onRetryAttemptStart?.();
	}
}

/**
 * 判断失败的助手消息是否类似提供商或传输瞬时错误，
 * 使调用方可以决定是否重启最后一个助手轮次。
 *
 * 此函数不实现重试策略。调用方应先单独处理上下文溢出，再应用自身的重试预算、
 * 退避和报告逻辑，然后重启助手轮次。
 */
export function isRetryableAssistantError(message: AssistantMessage): boolean {
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	const errorMessage = message.errorMessage;
	if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage)) return false;
	return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);
}
