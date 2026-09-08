import type { AssistantMessage } from "../types.ts";

/**
 * 检测不同提供商上下文溢出错误的正则表达式模式。
 *
 * 这些模式匹配输入超过模型上下文窗口时返回的错误消息。
 *
 * 提供商专用模式（附错误消息示例）：
 *
 * - Anthropic: "prompt is too long: 213462 tokens > 200000 maximum"
 * - Anthropic: "413 {\"error\":{\"type\":\"request_too_large\",\"message\":\"Request exceeds the maximum size\"}}"
 * - OpenAI: "Your input exceeds the context window of this model"
 * - OpenAI/LiteLLM: "Requested token count exceeds the model's maximum context length of 131072 tokens"
 * - OpenAI-compatible: "Input length (265330) exceeds model's maximum context length (262144)."
 * - Google: "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)"
 * - xAI: "This model's maximum prompt length is 131072 but the request contains 537812 tokens"
 * - Groq: "Please reduce the length of the messages or completion"
 * - OpenRouter: "This endpoint's maximum context length is X tokens. However, you requested about Y tokens"
 * - OpenRouter/Poolside: "Input length X exceeds the maximum allowed input length of Y tokens."
 * - Together AI: "The input (X tokens) is longer than the model's context length (Y tokens)."
 * - llama.cpp: "the request exceeds the available context size, try increasing it"
 * - LM Studio: "tokens to keep from the initial prompt is greater than the context length"
 * - GitHub Copilot: "prompt token count of X exceeds the limit of Y"
 * - MiniMax: "invalid params, context window exceeds limit"
 * - Kimi For Coding: "Your request exceeded model token limit: X (requested: Y)"
 * - DS4: "Prompt has X tokens, but the configured context size is Y tokens"
 * - Cerebras: "400/413 status code (no body)"
 * - Mistral: "Prompt contains X tokens ... too large for model with Y maximum context length"
 * - z.ai：不会报错，会静默接受溢出——通过 usage.input > contextWindow 处理
 * - Xiaomi MiMo：截断输入以恰好填满 contextWindow，然后返回 finish_reason "length"，
 *   且 output=0（没有剩余生成空间）。通过 stopReason "length" + 零输出 + 输入填满
 *   上下文窗口来检测。
 * - DashScope/Qwen: "Range of input length should be [1, X]" (HTTP 400 invalid_parameter_error)
 * - Ollama：部分部署会静默截断，其他部署返回类似 "prompt too long; exceeded max context length by X tokens" 的错误
 */
const OVERFLOW_PATTERNS = [
	/prompt is too long/i, // Anthropic 令牌溢出
	/request_too_large/i, // Anthropic 请求字节大小溢出（HTTP 413）
	/input is too long for requested model/i, // Amazon Bedrock
	/exceeds the context window/i, // OpenAI（Completions 和 Responses API）
	/exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i, // OpenAI 兼容代理（LiteLLM）
	/input token count.*exceeds the maximum/i, // Google（Gemini）
	/maximum prompt length is \d+/i, // xAI（Grok）
	/reduce the length of the messages/i, // Groq
	/maximum context length is \d+ tokens/i, // OpenRouter（大多数后端）
	/exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i, // OpenRouter/Poolside
	/input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i, // Together AI
	/exceeds the limit of \d+/i, // GitHub Copilot
	/exceeds the available context size/i, // llama.cpp 服务器
	/greater than the context length/i, // LM Studio
	/context window exceeds limit/i, // MiniMax
	/exceeded model token limit/i, // Kimi For Coding
	/too large for model with \d+ maximum context length/i, // Mistral
	/prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i, // DS4 服务器
	/model_context_window_exceeded/i, // 作为错误文本显示的 z.ai 非标准 finish_reason
	/prompt too long; exceeded (?:max )?context length/i, // Ollama 显式溢出错误
	/range of input length should be/i, // DashScope / Qwen Token Plan
	/context[_ ]length[_ ]exceeded/i, // 通用回退
	/too many tokens/i, // 通用回退
	/token limit exceeded/i, // 通用回退
	/^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i, // Cerebras：无正文的 400/413
];

/**
 * 表示非溢出错误（例如速率限制、服务器错误）的模式。
 * 匹配任一模式的错误消息会从溢出检测中排除，即使它们也匹配 OVERFLOW_PATTERN。
 *
 * 示例：Bedrock 将限流错误格式化为 "ThrottlingException: Too many tokens,
 * please wait before trying again."；如果没有此排除项，它会匹配 /too many tokens/i
 * 溢出模式。
 */
const NON_OVERFLOW_PATTERNS = [
	/^(Throttling error|Service unavailable):/i, // AWS Bedrock 非溢出错误（来自 formatBedrockError 的可读前缀）
	/rate limit/i, // 通用速率限制
	/too many requests/i, // 通用 HTTP 429 形式
];

/**
 * 检查助手消息是否表示上下文溢出错误。
 *
 * 此函数处理三种情况：
 * 1. 基于错误的溢出：大多数提供商返回 stopReason "error" 和特定错误消息模式。
 * 2. 静默溢出：部分提供商接受溢出请求并成功返回。对此检查 usage.input 是否超过上下文窗口。
 * 3. 长度停止溢出：输入填满上下文窗口时，Xiaomi MiMo 可能以零输出返回 "length"。
 *
 * ## 各提供商检测可靠性
 *
 * **可靠检测（返回带可检测消息的错误）：**
 * - Anthropic："prompt is too long: X tokens > Y maximum" 或 "request_too_large"
 * - OpenAI（Completions 和 Responses）："exceeds the context window"、"exceeds the model's maximum context length of X tokens"，或 "exceeds model's maximum context length (X)"
 * - Google Gemini："input token count exceeds the maximum"
 * - xAI（Grok）："maximum prompt length is X but request contains Y"
 * - Groq："reduce the length of the messages"
 * - Cerebras："400/413 status code (no body)"
 * - Mistral："Prompt contains X tokens ... too large for model with Y maximum context length"
 * - OpenRouter（大多数后端）："maximum context length is X tokens"
 * - OpenRouter/Poolside："Input length X exceeds the maximum allowed input length of Y tokens."
 * - Together AI："The input (X tokens) is longer than the model's context length (Y tokens)."
 * - llama.cpp："exceeds the available context size"
 * - LM Studio："greater than the context length"
 * - Kimi For Coding："exceeded model token limit: X (requested: Y)"
 * - DS4："Prompt has X tokens, but the configured context size is Y tokens"
 * - DashScope/Qwen："Range of input length should be [1, X]"
 *
 * **不可靠检测：**
 * - z.ai：有时静默接受溢出（可通过 usage.input > contextWindow 检测），有时返回速率限制错误。
 *   传入 contextWindow 参数以检测静默溢出。
 * - Xiaomi MiMo：截断输入以适配 contextWindow，然后以 output=0 返回 stopReason "length"。
 *   传入 contextWindow 参数，通过“上下文填满 + 零输出”信号检测。
 * - Ollama：部分配置可能静默截断输入，也可能返回匹配上述模式的显式溢出错误。
 *   由于不知道预期令牌数，此处仍无法检测静默截断。
 *
 * ## 自定义提供商
 *
 * 如果通过 settings.json 添加了自定义模型，此函数可能无法检测这些提供商的溢出错误。
 * 添加支持的方法：
 *
 * 1. 发送超过模型上下文窗口的请求
 * 2. 检查响应中的 errorMessage
 * 3. 创建匹配该错误的正则表达式模式
 * 4. 将模式添加到本文件的 OVERFLOW_PATTERNS，或在调用此函数前自行检查 errorMessage
 *
 * @param message - 要检查的助手消息
 * @param contextWindow - 用于检测静默溢出（z.ai）的可选上下文窗口大小
 * @returns 消息表示上下文溢出时返回 true
 */
export function isContextOverflow(message: AssistantMessage, contextWindow?: number): boolean {
	// 情况 1：检查错误消息模式
	if (message.stopReason === "error" && message.errorMessage) {
		// 跳过匹配已知非溢出模式（例如限流/速率限制）的消息
		const isNonOverflow = NON_OVERFLOW_PATTERNS.some((p) => p.test(message.errorMessage!));
		if (!isNonOverflow && OVERFLOW_PATTERNS.some((p) => p.test(message.errorMessage!))) {
			return true;
		}
	}

	// 情况 2：静默溢出（z.ai 风格）——请求成功，但用量超过上下文
	if (contextWindow && message.stopReason === "stop") {
		const inputTokens = message.usage.input + message.usage.cacheRead;
		if (inputTokens > contextWindow) {
			return true;
		}
	}

	// 情况 3：长度停止溢出（Xiaomi MiMo 风格）——服务器截断过大输入以适配上下文窗口，
	// 不留下输出空间。返回 stopReason "length" 且 output=0，input+cacheRead 填满上下文窗口。
	if (contextWindow && message.stopReason === "length" && message.usage.output === 0) {
		const inputTokens = message.usage.input + message.usage.cacheRead;
		if (inputTokens >= contextWindow * 0.99) {
			return true;
		}
	}

	return false;
}

/**
 * 检查长度停止是否在调用方或模型预期输出限制之前结束。
 * 此类响应可能由上下文压力或提供商侧截断导致，因此调用方可以进行一次有界的压缩重试。
 * `desiredMaxOutput` 必须是应用任何基于上下文的限制之前的原始上限。
 */
export function isRecoverableLength(message: AssistantMessage, desiredMaxOutput: number): boolean {
	return message.stopReason === "length" && desiredMaxOutput > 0 && message.usage.output < desiredMaxOutput;
}

/**
 * 获取用于测试的溢出模式。
 */
export function getOverflowPatterns(): RegExp[] {
	return [...OVERFLOW_PATTERNS];
}
