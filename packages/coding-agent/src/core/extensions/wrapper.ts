/**
 * 扩展注册工具的包装器。
 *
 * 这些包装器仅调整工具执行方式，使扩展工具能够接收运行器上下文。
 * 工具调用和工具结果的拦截由 AgentSession 通过 agent-core 钩子处理。
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.ts";
import type { ExtensionRunner } from "./runner.ts";
import type { RegisteredTool } from "./types.ts";

/**
 * 将 RegisteredTool 包装为 AgentTool。
 * 使用运行器的 createContext()，确保工具和事件处理程序使用一致的上下文。
 */
export function wrapRegisteredTool(registeredTool: RegisteredTool, runner: ExtensionRunner): AgentTool {
	const tool = wrapToolDefinition(registeredTool.definition, () => runner.createContext());
	const execute = tool.execute;
	return {
		...tool,
		execute: async (toolCallId, params, signal, onUpdate) => {
			const activeBefore = runner.getActiveTools();
			const result = await execute(toolCallId, params, signal, onUpdate);
			const activeAfter = runner.getActiveTools();
			if (!activeBefore.every((name) => activeAfter.includes(name))) return result;

			const beforeNames = new Set(activeBefore);
			const addedToolNames = activeAfter.filter((name) => !beforeNames.has(name));
			if (addedToolNames.length === 0) return result;
			return {
				...result,
				addedToolNames: [...new Set([...(result.addedToolNames ?? []), ...addedToolNames])],
			};
		},
	};
}

/**
 * 将所有已注册工具包装为 AgentTool。
 * 使用运行器的 createContext()，确保工具和事件处理程序使用一致的上下文。
 */
export function wrapRegisteredTools(registeredTools: RegisteredTool[], runner: ExtensionRunner): AgentTool[] {
	return registeredTools.map((tool) => wrapRegisteredTool(tool, runner));
}
