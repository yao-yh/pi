// 提供商 HTTP 错误对象的共享规范化。
//
// 代理/网关后的端点可能返回非 2xx 响应，其正文无法由提供商 SDK 合并到
// `error.message`。SDK 错误对象仍携带 HTTP 状态和原始/解析后正文，但使用
// SDK 专用字段名。因此只读取 `error.message` 的提供商 catch 块会丢弃正文，
// 显示 `"403 status code (no body)"` 等不透明消息，或折叠为 `"Unknown: UnknownError"`。
//
// `normalizeProviderError` 探测已知 SDK 字段结构（Mistral、`openai`、
// `@google/genai`、AWS Bedrock），并返回供各提供商组合为显示字符串的结构。
// `messageCarriesBody` 标志表示 Anthropic / `@google/genai` 的正常路径：SDK 已将
// 正文合并到消息，因此提供商可以保留它而不重复输出。

export const MAX_PROVIDER_ERROR_BODY_CHARS = 4000;

export interface NormalizedProviderError {
	/** 可以从 SDK 错误对象提取时的 HTTP 状态码。 */
	status?: number;
	/** 原始 HTTP 正文原因，已经去除首尾空白并截断到上限。 */
	body?: string;
	/** `error.message`；抛出值不是 `Error` 时为 `safeJsonStringify(error)`。 */
	message: string;
	/** `message` 已包含正文时为 true（无需另行添加正文）。 */
	messageCarriesBody: boolean;
}

type SdkErrorShape = Error & {
	statusCode?: unknown;
	status?: unknown;
	body?: unknown;
	error?: unknown;
	$metadata?: { httpStatusCode?: unknown };
	$response?: { statusCode?: unknown; body?: unknown };
};

export function normalizeProviderError(error: unknown): NormalizedProviderError {
	if (!(error instanceof Error)) {
		return { message: safeJsonStringify(error), messageCarriesBody: false };
	}

	const sdkError = error as SdkErrorShape;
	const status = extractStatus(sdkError);
	const body = extractBody(sdkError);
	const messageCarriesBody = body === undefined || error.message.includes(body);

	return {
		status,
		body,
		message: error.message,
		messageCarriesBody,
	} satisfies NormalizedProviderError;
}

/**
 * 按 SDK 字段顺序探测 HTTP 状态，使用第一个数字值：
 * `statusCode` (Mistral) → `status` (`openai`, `@google/genai`) →
 * `$metadata.httpStatusCode` (Bedrock) → `$response.statusCode` (Bedrock).
 */
function extractStatus(error: SdkErrorShape): number | undefined {
	if (typeof error.statusCode === "number") return error.statusCode;
	if (typeof error.status === "number") return error.status;
	if (typeof error.$metadata?.httpStatusCode === "number") return error.$metadata.httpStatusCode;
	if (typeof error.$response?.statusCode === "number") return error.$response.statusCode;
	return undefined;
}

/**
 * 按 SDK 字段顺序探测原始正文原因，使用第一个可用值：`body` 字符串（Mistral）→
 * `error` 解析后的 JSON 正文对象（`openai` SDK 的 `this.error`）→
 * `$response.body`（Bedrock）。空对象和未读取响应流视为没有正文，避免显示为
 * `"{}"` 或序列化的流内部结构。选中的正文会截断到上限。
 */
function extractBody(error: SdkErrorShape): string | undefined {
	const bodyText = pickBodyText(error);
	if (bodyText === undefined) return undefined;
	const trimmed = bodyText.trim();
	if (trimmed.length === 0) return undefined;
	return truncateErrorText(trimmed, MAX_PROVIDER_ERROR_BODY_CHARS);
}

function pickBodyText(error: SdkErrorShape): string | undefined {
	if (typeof error.body === "string") return error.body;
	if (isPlainNonEmptyObject(error.error)) return safeJsonStringify(error.error);
	const responseBody = error.$response?.body;
	if (typeof responseBody === "string") return responseBody;
	if (isReadableStreamLike(responseBody)) return undefined;
	if (isPlainNonEmptyObject(responseBody)) return safeJsonStringify(responseBody);
	return undefined;
}

function isReadableStreamLike(value: unknown): boolean {
	return typeof value === "object" && value !== null && "pipe" in value && typeof value.pipe === "function";
}

/**
 * 只有普通对象才算作 HTTP 正文。SDK 错误字段可能保存类实例而非解析后的正文——
 * AWS SDK v3 的 `$response.body` 是 HTTP 流/响应包装对象，将其字符串化会产生
 * `{"_events":...}` 等无效“正文”，进而在组合显示字符串中替换 `error.message`。
 * SDK 会把真实反序列化异常文本（"Input is too long..."、Schema 验证详情等）放在
 * `error.message` 中，结果唯一有用的字符串被噪声丢弃。类实例不产生正文，
 * `messageCarriesBody` 保持 true，真实消息得以保留。此检查补充上面的 `pipe` 探测：
 * Web ReadableStream（有 pipeTo/pipeThrough、没有 `pipe`）和非流 SDK 包装类无法通过
 * 原型检查，而解析后的 JSON 正文（构造上是普通对象）仍可通过。
 */
function isPlainNonEmptyObject(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return false;
	return Object.keys(value).length > 0;
}

/**
 * 根据规范化错误组合显示字符串。当消息已携带正文（Anthropic / `@google/genai`
 * 正常路径），或未提取到正文/状态时，原样返回消息。否则显示状态和正文，
 * 并可添加提供商前缀。
 *
 * - 无前缀：`"<status>: <body>"`
 * - 有前缀：`"<prefix> (<status>): <body>"`
 */
export function formatProviderError(norm: NormalizedProviderError, prefix?: string): string {
	if (norm.messageCarriesBody || norm.status === undefined || norm.body === undefined) {
		return prefix !== undefined && norm.status !== undefined
			? `${prefix} (${norm.status}): ${norm.message}`
			: norm.message;
	}
	return prefix !== undefined ? `${prefix} (${norm.status}): ${norm.body}` : `${norm.status}: ${norm.body}`;
}

export function truncateErrorText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

export function safeJsonStringify(value: unknown): string {
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? String(value) : serialized;
	} catch {
		return String(value);
	}
}
