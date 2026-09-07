import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	TextContent,
	Tool,
	ToolResultMessage,
	Usage,
} from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";

/**
 * 代理循环使用的流函数。`Models.streamSimple` 符合此类型。
 *
 * 约定：
 * - 遇到请求、模型或运行时失败时，不得抛出异常或返回被拒绝的 Promise。
 * - 必须返回 AssistantMessageEventStream。
 * - 失败必须通过协议事件编码到返回的流中，并以最终 AssistantMessage 收尾；
 *   该消息的 stopReason 为 "error" 或 "aborted"，且包含 errorMessage。
 */
export type StreamFn = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/**
 * 一条助手消息中的工具调用执行方式配置。
 *
 * - "sequential"：每个工具调用依次完成准备、执行和收尾，之后才启动下一个调用。
 * - "parallel"：工具调用按顺序准备，随后允许执行的工具并发运行。
 *   每个工具完成收尾后，按完成顺序发出 `tool_execution_end`；
 *   工具结果消息产物稍后按助手消息中的原始顺序发出。
 */
export type ToolExecutionMode = "sequential" | "parallel";

/**
 * 控制代理循环到达队列排出点时注入多少条已排队的用户消息。
 *
 * - "all"：在该排出点取出并注入全部已排队消息。
 * - "one-at-a-time"：只取出并注入最早的一条消息，其余消息留待后续排出点处理。
 */
export type QueueMode = "all" | "one-at-a-time";

/** 助手消息发出的单个工具调用内容块。 */
export type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

/**
 * `beforeToolCall` 返回的结果。
 *
 * 返回 `{ block: true }` 会阻止工具执行，循环将改为发出错误工具结果。
 * `reason` 会成为该错误结果中显示的文本；省略时使用默认的阻止消息。
 */
export interface BeforeToolCallResult {
	block?: boolean;
	reason?: string;
	/**
	 * 此调用被阻止时，提示代理应在当前工具批次结束后停止。
	 * 只有该批次中每个完成收尾的工具结果都将此值设为 true，才会提前终止。
	 */
	terminate?: boolean;
}

/**
 * `afterToolCall` 返回的部分覆盖值。
 *
 * 按字段合并：
 * - `content`：如果提供，则完整替换工具结果的内容数组
 * - `details`：如果提供，则完整替换工具结果的详细信息值
 * - `isError`：如果提供，则替换工具结果的错误标记
 * - `usage`：如果提供，则替换工具结果的用量信息
 * - `terminate`：如果提供，则替换提前终止提示
 *
 * 省略的字段保留工具执行结果的原始值。
 * `content`、`details` 和 `usage` 不会进行深度合并。
 */
export interface AfterToolCallResult {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	isError?: boolean;
	/** 最终工具执行本身的用量信息（如果可用），不计入主 LLM 上下文用量。 */
	usage?: Usage;
	/**
	 * 提示代理应在当前工具批次结束后停止。
	 * 只有该批次中每个完成收尾的工具结果都将此值设为 true，才会提前终止。
	 */
	terminate?: boolean;
}

/** 传递给 `beforeToolCall` 的上下文。 */
export interface BeforeToolCallContext {
	/** 请求该工具调用的助手消息。 */
	assistantMessage: AssistantMessage;
	/** 来自 `assistantMessage.content` 的原始工具调用块。 */
	toolCall: AgentToolCall;
	/** 已按目标工具模式校验的工具参数。 */
	args: unknown;
	/** 准备工具调用时的当前代理上下文。 */
	context: AgentContext;
}

/** 传递给 `afterToolCall` 的上下文。 */
export interface AfterToolCallContext {
	/** 请求该工具调用的助手消息。 */
	assistantMessage: AssistantMessage;
	/** 来自 `assistantMessage.content` 的原始工具调用块。 */
	toolCall: AgentToolCall;
	/** 已按目标工具模式校验的工具参数。 */
	args: unknown;
	/** 应用任何 `afterToolCall` 覆盖值之前的工具执行结果。 */
	result: AgentToolResult<any>;
	/** 当前是否将工具执行结果视为错误。 */
	isError: boolean;
	/** 工具调用完成收尾时的当前代理上下文。 */
	context: AgentContext;
}

/** 传递给 `shouldStopAfterTurn` 的上下文。 */
export interface ShouldStopAfterTurnContext {
	/** 完成本轮的助手消息。 */
	message: AssistantMessage;
	/** 传递给前一个 `turn_end` 事件的工具结果消息。 */
	toolResults: ToolResultMessage[];
	/** 追加本轮助手消息和工具结果后的当前代理上下文。 */
	context: AgentContext;
	/** 如果循环调用在此处退出，将返回的消息。提示运行包含初始提示消息；继续运行不包含原有上下文消息。 */
	newMessages: AgentMessage[];
}

/** 代理循环在发起下一次提供方请求前使用的替换运行时状态。 */
export interface AgentLoopTurnUpdate {
	/** 下一次提供方请求使用的上下文。 */
	context?: AgentContext;
	/** 下一次提供方请求使用的模型。 */
	model?: Model<any>;
	/** 下一次提供方请求使用的思考级别。 */
	thinkingLevel?: ThinkingLevel;
}

export interface PrepareNextTurnContext extends ShouldStopAfterTurnContext {}

export interface AgentLoopConfig extends SimpleStreamOptions {
	model: Model<any>;

	/**
	 * 每次调用 LLM 前，将 AgentMessage[] 转换为 LLM 兼容的 Message[]。
	 *
	 * 每个 AgentMessage 都必须转换为 LLM 能理解的 UserMessage、AssistantMessage
	 * 或 ToolResultMessage。无法转换的 AgentMessage（例如仅供 UI 使用的通知或状态消息）
	 * 应被过滤掉。
	 *
	 * 约定：不得抛出异常或拒绝 Promise，应返回安全的后备值。
	 * 抛出异常会中断底层代理循环，且不会生成正常的事件序列。
	 *
	 * @example
	 * ```typescript
	 * convertToLlm: (messages) => messages.flatMap(m => {
	 *   if (m.role === "custom") {
	 *     // 将自定义消息转换为用户消息
	 *     return [{ role: "user", content: m.content, timestamp: m.timestamp }];
	 *   }
	 *   if (m.role === "notification") {
	 *     // 过滤仅供 UI 使用的消息
	 *     return [];
	 *   }
	 *   // 直接传递标准 LLM 消息
	 *   return [m];
	 * })
	 * ```
	 */
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	/**
	 * 在 `convertToLlm` 之前应用于上下文的可选转换。
	 *
	 * 用于在 AgentMessage 层级执行的操作：
	 * - 管理上下文窗口（裁剪旧消息）
	 * - 注入来自外部来源的上下文
	 *
	 * 约定：不得抛出异常或拒绝 Promise，应返回原始消息或其他安全的后备值。
	 *
	 * @example
	 * ```typescript
	 * transformContext: async (messages) => {
	 *   if (estimateTokens(messages) > MAX_TOKENS) {
	 *     return pruneOldMessages(messages);
	 *   }
	 *   return messages;
	 * }
	 * ```
	 */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

	/**
	 * 为每次 LLM 调用动态解析 API 密钥。
	 *
	 * 适用于可能在长时间工具执行阶段过期的短期 OAuth 令牌（例如 GitHub Copilot）。
	 *
	 * 约定：不得抛出异常或拒绝 Promise；没有可用密钥时返回 undefined。
	 */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

	/**
	 * 每轮完全结束并发出 `turn_end` 后调用。
	 *
	 * 如果返回 true，循环会在轮询引导消息或后续消息队列之前发出 `agent_end` 并退出，
	 * 且不会启动下一次 LLM 调用。当前助手响应和所有工具执行仍会正常完成。
	 * 此回调可读取已完成轮次的上下文，并在 `prepareNextTurn` 之前运行。
	 *
	 * 可用它请求在当前轮次后正常停止，例如避免上下文过满。
	 *
	 * 约定：不得抛出异常或拒绝 Promise。抛出异常会中断底层代理循环，且不会生成正常事件序列。
	 */
	shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;

	/**
	 * 循环将继续时，在 `turn_end` 之后、下一轮开始前立即调用。
	 * 返回替换的上下文、模型或思考状态以影响下一轮；
	 * 返回 undefined 则继续使用当前上下文和配置。
	 */
	prepareNextTurn?: (
		context: PrepareNextTurnContext,
	) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;

	/**
	 * 返回要在运行中途注入对话的引导消息。
	 *
	 * 当前助手轮次执行完工具调用后调用，除非 `shouldStopAfterTurn` 已先行退出。
	 * 如果返回消息，它们会在下一次 LLM 调用前加入上下文。
	 * 当前助手消息中的工具调用不会因此跳过。
	 *
	 * 用于在代理工作期间对其进行“引导”。
	 *
	 * 约定：不得抛出异常或拒绝 Promise；没有可用引导消息时返回 []。
	 */
	getSteeringMessages?: () => Promise<AgentMessage[]>;

	/**
	 * 返回要在代理原本将停止后处理的后续消息。
	 *
	 * 当代理没有更多工具调用和引导消息时调用。
	 * 如果返回消息，它们会加入上下文，代理随后继续下一轮。
	 *
	 * 用于需要等待代理完成当前工作后再处理的后续消息。
	 *
	 * 约定：不得抛出异常或拒绝 Promise；没有可用后续消息时返回 []。
	 */
	getFollowUpMessages?: () => Promise<AgentMessage[]>;

	/**
	 * 工具执行模式。
	 * - "sequential"：逐个执行工具调用
	 * - "parallel"：按顺序预检工具调用，再并发执行允许的工具；
	 *   每个工具完成收尾后，按完成顺序发出 `tool_execution_end`，
	 *   随后按助手消息中的原始顺序发出工具结果消息产物
	 *
	 * 默认值："parallel"
	 */
	toolExecution?: ToolExecutionMode;

	/**
	 * 工具参数校验完成后、执行工具前调用。
	 *
	 * 返回 `{ block: true }` 可阻止执行，循环会改为发出错误工具结果。
	 * 被阻止的结果还可设置 `terminate: true`，参与批次提前终止规则。
	 * 该钩子会收到代理中止信号，并负责响应它。
	 */
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;

	/**
	 * 工具执行完成后、发出 `tool_execution_end` 和工具结果消息事件前调用。
	 *
	 * 返回 `AfterToolCallResult` 可覆盖工具执行结果的部分字段：
	 * - `content` 替换完整内容数组
	 * - `details` 替换完整详细信息负载
	 * - `isError` 替换错误标记
	 * - `usage` 替换工具结果用量
	 * - `terminate` 替换提前终止提示
	 *
	 * 省略的字段保留原值，不执行深度合并。
	 * 该钩子会收到代理中止信号，并负责响应它。
	 */
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
}

/**
 * 支持思考或推理的模型所使用的思考级别。
 * 注意：只有部分模型系列支持 "xhigh" 和 "max"。应使用
 * @earendil-works/pi-ai 的模型思考级别元数据判断具体模型是否支持。
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * 可扩展的应用自定义消息接口。
 * 应用可通过声明合并进行扩展：
 *
 * @example
 * ```typescript
 * declare module "@mariozechner/agent" {
 *   interface CustomAgentMessages {
 *     artifact: ArtifactMessage;
 *     notification: NotificationMessage;
 *   }
 * }
 * ```
 */
export interface CustomAgentMessages {
	// 默认为空，应用通过声明合并进行扩展
}

/**
 * AgentMessage：LLM 消息与自定义消息的联合类型。
 * 此抽象允许应用添加自定义消息类型，同时保持类型安全以及与基础 LLM 消息的兼容性。
 */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

/**
 * 公开的代理状态。
 *
 * `tools` 和 `messages` 使用访问器属性，使实现可以先复制传入的数组再保存。
 */
export interface AgentState {
	/** 随每次模型请求发送的系统提示。 */
	systemPrompt: string;
	/** 后续轮次使用的活动模型。 */
	model: Model<any>;
	/** 后续轮次请求的推理级别。 */
	thinkingLevel: ThinkingLevel;
	/** 可用工具。赋予新数组时会复制其顶层数组。 */
	set tools(tools: AgentTool<any>[]);
	get tools(): AgentTool<any>[];
	/** 对话记录。赋予新数组时会复制其顶层数组。 */
	set messages(messages: AgentMessage[]);
	get messages(): AgentMessage[];
	/**
	 * 代理正在处理提示或继续运行时为 true。
	 *
	 * 在所有待等待的 `agent_end` 监听器完成前，该值会一直保持 true。
	 */
	readonly isStreaming: boolean;
	/** 当前流式响应的部分助手消息（如果存在）。 */
	readonly streamingMessage?: AgentMessage;
	/** 当前正在执行的工具调用 ID。 */
	readonly pendingToolCalls: ReadonlySet<string>;
	/** 最近一次失败或中止的助手轮次所产生的错误消息（如果存在）。 */
	readonly errorMessage?: string;
}

/** 工具产生的最终结果或部分结果。 */
export interface AgentToolResult<T> {
	/** 返回给模型的文本或图像内容。 */
	content: (TextContent | ImageContent)[];
	/** 用于日志或 UI 渲染的任意结构化详细信息。 */
	details: T;
	/** 最终工具执行本身的用量信息（如果可用），不计入主 LLM 上下文用量。 */
	usage?: Usage;
	/** 此结果引入、并从对话记录当前位置起可用的工具名称。 */
	addedToolNames?: string[];
	/**
	 * 提示代理应在当前工具批次结束后停止。
	 * 只有该批次中每个完成收尾的工具结果都将此值设为 true，才会提前终止。
	 */
	terminate?: boolean;
}

/**
 * 工具用于流式发送部分执行更新的回调。
 *
 * 该回调仅在当前 `execute()` 调用范围内有效。工具 Promise 完成后的调用会被忽略。
 */
export type AgentToolUpdateCallback<T = any> = (partialResult: AgentToolResult<T>) => void;

/** 代理运行时使用的工具定义。 */
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> {
	/** 供 UI 显示的易读标签。 */
	label: string;
	/**
	 * 在模式校验前处理原始工具调用参数的可选兼容适配器。
	 * 必须返回符合 `TParameters` 的对象。
	 */
	prepareArguments?: (args: unknown) => Static<TParameters>;
	/** 执行工具调用。失败时应抛出异常，而不是将错误编码到 `content` 中。 */
	execute: (
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	) => Promise<AgentToolResult<TDetails>>;
	/** 已持久化执行意图、但结果未知的副作用所使用的恢复策略。 */
	replay?: "never" | "safe";
	/**
	 * 单个工具的执行模式覆盖值。
	 * - "sequential"：此工具必须与其他工具调用逐个执行。
	 * - "parallel"：此工具可与其他工具调用并发执行。
	 *
	 * 省略时应用默认执行模式。
	 */
	executionMode?: ToolExecutionMode;
}

/** 传入底层代理循环的上下文快照。 */
export interface AgentContext {
	/** 请求中包含的系统提示。 */
	systemPrompt: string;
	/** 模型可见的对话记录。 */
	messages: AgentMessage[];
	/** 本次运行可用的工具。 */
	tools?: AgentTool<any>[];
}

/**
 * Agent 为更新 UI 而发出的事件。
 *
 * `agent_end` 是一次运行发出的最后一个事件，但该事件中待等待的
 * `Agent.subscribe()` 监听器仍属于运行完成过程。只有这些监听器结束后，
 * 代理才会进入空闲状态。
 */
export type AgentEvent =
	// 代理生命周期
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	// 轮次生命周期：一轮包含一次助手响应及其所有工具调用和结果
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	// 消息生命周期：为用户消息、助手消息和工具结果消息发出
	| { type: "message_start"; message: AgentMessage }
	// 仅在助手消息流式生成期间发出
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	// 工具执行生命周期
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
