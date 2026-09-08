type FetchInput = Parameters<typeof fetch>[0];

const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface FetchRetryOptions {
	/** 初始请求后的额外尝试次数。默认两次。 */
	maxRetries?: number;
	/** 除传输故障外，是否也重试暂时性 HTTP 响应。默认值为 true。 */
	retryOnStatus?: boolean;
	/** 所有尝试共享的总时间预算。 */
	timeoutMs?: number;
	/** 单次尝试的超时时间。每次尝试都会创建新的超时计时器。 */
	attemptTimeoutMs?: number;
}

/**
 * 获取管理类 HTTP 资源，并进行次数受限的立即重试。
 *
 * 此工具有意定位为传输层辅助函数，用于幂等的管理请求（版本检查、目录和下载）。
 * 不得用于 agent 或模型操作：这类操作可能在 HTTP 请求开始后失败，应由理解其语义的调用方重试。
 *
 * 调用方取消和 timeoutMs 超时会终止整个流程。attemptTimeoutMs 只中止当前尝试，
 * 从而允许重试挂起的连接。
 */
export async function fetchWithRetry(
	input: FetchInput,
	init: RequestInit | undefined = undefined,
	options: FetchRetryOptions = {},
): Promise<Response> {
	const maxRetries =
		options.maxRetries === undefined || !Number.isFinite(options.maxRetries)
			? 2
			: Math.max(0, Math.floor(options.maxRetries));
	const retryOnStatus = options.retryOnStatus ?? true;
	const parentSignal = init?.signal ?? undefined;
	const timeoutSignal =
		options.timeoutMs !== undefined && options.timeoutMs > 0 ? AbortSignal.timeout(options.timeoutMs) : undefined;
	const attemptTimeoutMs =
		options.attemptTimeoutMs !== undefined && options.attemptTimeoutMs > 0 ? options.attemptTimeoutMs : undefined;

	for (let attempt = 0; ; attempt++) {
		parentSignal?.throwIfAborted();
		timeoutSignal?.throwIfAborted();
		const attemptTimeoutSignal = attemptTimeoutMs ? AbortSignal.timeout(attemptTimeoutMs) : undefined;
		const signals = [parentSignal, timeoutSignal, attemptTimeoutSignal].filter(
			(signal): signal is AbortSignal => signal !== undefined,
		);
		const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

		try {
			const response = await fetch(input, signal ? { ...init, signal } : init);
			const shouldRetry = retryOnStatus && RETRYABLE_STATUS_CODES.has(response.status) && attempt < maxRetries;
			if (!shouldRetry) return response;
			try {
				await response.body?.cancel();
			} catch {
				// 响应会在重试前被丢弃；如果取消响应正文也失败，则无需再做处理。
			}
		} catch (error) {
			const attemptTimedOut =
				attemptTimeoutSignal?.aborted === true && !parentSignal?.aborted && !timeoutSignal?.aborted;
			if (
				parentSignal?.aborted ||
				timeoutSignal?.aborted ||
				(error instanceof Error &&
					error.name === "AbortError" &&
					!attemptTimedOut &&
					timeoutSignal === undefined) ||
				attempt >= maxRetries
			) {
				throw error;
			}
		}
	}
}
