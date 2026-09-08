/**
 * 内置工具渲染器，不包含工具本身。
 *
 * 展示层只显示工具调用和结果，既不执行工具，也不需要其 typebox 参数 schema。
 * 导入此模块而非 `core/tools/index.ts`，可避免仅负责渲染的进程引入约 17 MB 的模块图。
 */

import type { ToolDefinition } from "../../extensions/types.ts";
import type { ToolName } from "../index.ts";
import { createShellRenderers } from "./bash.ts";
import { editRenderers } from "./edit.ts";
import { findRenderers } from "./find.ts";
import { grepRenderers } from "./grep.ts";
import { lsRenderers } from "./ls.ts";
import { readRenderers } from "./read.ts";
import { writeRenderers } from "./write.ts";

export type ToolRenderers = Pick<ToolDefinition<any, any>, "renderCall" | "renderResult">;

export {
	createShellRenderers,
	editRenderers,
	findRenderers,
	grepRenderers,
	lsRenderers,
	readRenderers,
	writeRenderers,
};

/** 所有内置工具的渲染器，以工具名称为键。 */
export function createAllToolRenderers(): Record<ToolName, ToolRenderers> {
	return {
		read: readRenderers,
		bash: createShellRenderers("$"),
		powershell: createShellRenderers("PS>"),
		edit: editRenderers,
		write: writeRenderers,
		grep: grepRenderers,
		find: findRenderers,
		ls: lsRenderers,
	};
}

/**
 * 将内置渲染器合并到未提供自定义渲染器的工具定义中。
 *
 * 过去由 `ToolExecutionComponent` 自行查找，导致每个展示层都必须导入工具实现。
 * 现在改由调用方处理，使渲染进程可以只导入渲染器。
 */
export function withBuiltInRenderers<TDefinition extends ToolRenderers>(
	toolName: string,
	definition: TDefinition | undefined,
): TDefinition | ToolRenderers | undefined {
	const builtIn = createAllToolRenderers()[toolName as ToolName];
	if (!definition) return builtIn;
	if (!builtIn) return definition;
	return {
		...definition,
		renderCall: definition.renderCall ?? builtIn.renderCall,
		renderResult: definition.renderResult ?? builtIn.renderResult,
	};
}
