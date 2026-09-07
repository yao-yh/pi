import { type ToolResultMessage, validateToolArguments } from "@earendil-works/pi-ai";
import type { AgentToolCall, AgentToolResult } from "../../types.ts";
import { type Context, withAbortSignal } from "../context.ts";
import type { JsonValue } from "../session/types.ts";
import type { AgentHarnessTool, AgentHarnessToolInvocation, AgentHarnessToolUpdateCallback } from "../types.ts";
import type { Gate } from "./effect-gate.ts";

/** 工具存在且准备后的参数已通过校验的工具调用。 */
export interface PreparedToolCall<TContext extends object | undefined> {
	toolCall: AgentToolCall;
	tool: AgentHarnessTool<TContext>;
	args: Record<string, JsonValue>;
}

/** 未跨越外部工具副作用边界而生成的合成结果。 */
export interface ImmediateToolOutcome {
	kind: "immediate";
	toolCall: AgentToolCall;
	result: AgentToolResult<unknown>;
	isError: true;
	terminate: boolean;
}

/** 工具执行前钩子流水线汇总出的决策。 */
export interface BeforeToolDecision {
	args?: Record<string, JsonValue>;
	block?: { reason: string; terminate?: boolean };
}

/** 已获准发布持久化意图并执行的准备后调用。 */
export interface ClearedToolCall<TContext extends object | undefined> {
	toolCall: AgentToolCall;
	tool: AgentHarnessTool<TContext>;
	args: Record<string, JsonValue>;
}

/** 应用工具执行后补丁之前的第二阶段原始工具输出。 */
export interface ExecutedToolCall {
	result: AgentToolResult<unknown>;
	isError: boolean;
}

/** 工具执行后钩子流水线汇总出的补丁。 */
export interface AfterToolPatch {
	content?: AgentToolResult<unknown>["content"];
	details?: JsonValue;
	isError?: boolean;
	usage?: AgentToolResult<unknown>["usage"];
	terminate?: boolean;
}

/** 已准备好转换为持久化工具结果消息的最终工具输出。 */
export interface FinalizedToolCall {
	toolCall: AgentToolCall;
	result: AgentToolResult<unknown>;
	isError: boolean;
	terminate: boolean;
}

function createErrorToolResult(message: string): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: message }],
		details: undefined,
	};
}

function immediateError(toolCall: AgentToolCall, message: string, terminate = false): ImmediateToolOutcome {
	return {
		kind: "immediate",
		toolCall,
		result: createErrorToolResult(message),
		isError: true,
		terminate,
	};
}

/** 解析工具、执行确定性的参数准备，并校验准备结果。 */
export function prepareToolCall<TContext extends object | undefined>(
	call: AgentToolCall,
	tools: AgentHarnessTool<TContext>[],
): PreparedToolCall<TContext> | ImmediateToolOutcome {
	const tool = tools.find((candidate) => candidate.name === call.name);
	if (!tool) {
		return immediateError(call, `Tool ${JSON.stringify(call.name)} is unavailable`);
	}

	try {
		const preparedArguments = tool.prepareArguments ? tool.prepareArguments(call.arguments) : call.arguments;
		const preparedCall: AgentToolCall =
			preparedArguments === call.arguments
				? call
				: { ...call, arguments: preparedArguments as Record<string, JsonValue> };
		const args = validateToolArguments(tool, preparedCall) as Record<string, JsonValue>;
		return { toolCall: call, tool, args };
	} catch (error) {
		return immediateError(call, error instanceof Error ? error.message : String(error));
	}
}

/** 应用显式钩子决策，并重新校验替换后的参数。 */
export function applyBeforeToolDecision<TContext extends object | undefined>(
	prepared: PreparedToolCall<TContext>,
	decision: BeforeToolDecision | undefined,
): ClearedToolCall<TContext> | ImmediateToolOutcome {
	if (decision?.block) {
		return immediateError(prepared.toolCall, decision.block.reason, decision.block.terminate === true);
	}

	if (!decision?.args) {
		return { toolCall: prepared.toolCall, tool: prepared.tool, args: prepared.args };
	}

	try {
		const validatedArgs = validateToolArguments(prepared.tool, {
			...prepared.toolCall,
			arguments: decision.args,
		}) as Record<string, JsonValue>;
		return { toolCall: prepared.toolCall, tool: prepared.tool, args: validatedArgs };
	} catch (error) {
		return immediateError(prepared.toolCall, error instanceof Error ? error.message : String(error));
	}
}

/**
 * 执行一个已获准的外部工具副作用，并将预期的工具异常转换为错误输出。
 *
 * 工具执行结束后会停止接收部分更新，避免迟到的回调污染已经完成的结果。
 */
export function executeToolCall<TContext extends object | undefined>(
	call: ClearedToolCall<TContext>,
	gate: Gate,
	onUpdate: AgentHarnessToolUpdateCallback<unknown>,
	toolContext: TContext,
	invocation: AgentHarnessToolInvocation,
	context: Context,
): Promise<ExecutedToolCall> {
	let acceptingUpdates = true;
	return gate.admit(async () => {
		const admittedContext = withAbortSignal(gate.signal, context);
		admittedContext.abortSignal?.throwIfAborted();
		try {
			const result = await call.tool.execute(
				call.toolCall.id,
				call.args,
				(partial, options) => {
					if (acceptingUpdates) onUpdate(partial, options);
				},
				toolContext,
				invocation,
				admittedContext,
			);
			return { result, isError: false };
		} catch (error) {
			return {
				result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
				isError: true,
			};
		} finally {
			acceptingUpdates = false;
		}
	});
}

/** 按字段应用工具执行后补丁。 */
export function finalizeToolCall<TContext extends object | undefined>(
	call: ClearedToolCall<TContext>,
	executed: ExecutedToolCall,
	patch: AfterToolPatch | undefined,
): FinalizedToolCall {
	const result: AgentToolResult<unknown> = patch
		? {
				...executed.result,
				content: patch.content === undefined ? executed.result.content : patch.content,
				details: patch.details === undefined ? executed.result.details : patch.details,
				usage: patch.usage === undefined ? executed.result.usage : patch.usage,
				terminate: patch.terminate === undefined ? executed.result.terminate : patch.terminate,
			}
		: executed.result;
	return {
		toolCall: call.toolCall,
		result,
		isError: patch?.isError ?? executed.isError,
		terminate: result.terminate === true,
	};
}

/** 根据已暂存的对话记录消息重建其表示的规范工具结果。 */
export function toolResultFromMessage(
	message: ToolResultMessage<unknown>,
	terminate: boolean,
): AgentToolResult<unknown> {
	return {
		content: message.content,
		details: message.details,
		...(message.usage === undefined ? {} : { usage: message.usage }),
		...(message.addedToolNames === undefined ? {} : { addedToolNames: message.addedToolNames }),
		...(terminate ? { terminate: true } : {}),
	};
}

/** 将完成收尾的工具输出转换为面向提供方的对话记录消息。 */
export function createToolResultMessage(call: FinalizedToolCall): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: call.toolCall.id,
		toolName: call.toolCall.name,
		content: call.result.content ?? [],
		...(call.result.details === undefined ? {} : { details: call.result.details }),
		...(call.result.usage === undefined ? {} : { usage: call.result.usage }),
		...(call.result.addedToolNames?.length ? { addedToolNames: call.result.addedToolNames } : {}),
		isError: call.isError,
		timestamp: Date.now(),
	};
}
