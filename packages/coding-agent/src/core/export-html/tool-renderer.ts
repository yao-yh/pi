/**
 * HTML 导出中自定义工具的 HTML 渲染器。
 *
 * 调用自定义工具的 TUI 渲染器，并将 ANSI 输出转换为 HTML，
 * 从而将工具调用和结果渲染为 HTML。
 */

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderContext } from "../extensions/types.ts";
import { ansiLinesToHtml } from "./ansi-to-html.ts";

export interface ToolHtmlRendererDeps {
	/** 按名称查找工具定义的函数 */
	getToolDefinition: (name: string) => ToolDefinition | undefined;
	/** 用于设置样式的主题 */
	theme: Theme;
	/** 渲染上下文的工作目录 */
	cwd: string;
	/** 渲染使用的终端宽度（默认值：100） */
	width?: number;
}

export interface ToolHtmlRenderer {
	/** 将工具调用渲染为 HTML；工具没有自定义渲染器时返回 undefined。 */
	renderCall(toolCallId: string, toolName: string, args: unknown): string | undefined;
	/** 将工具结果渲染为折叠/展开 HTML；工具没有自定义渲染器时返回 undefined。 */
	renderResult(
		toolCallId: string,
		toolName: string,
		result: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
		details: unknown,
		isError: boolean,
	): { collapsed?: string; expanded?: string } | undefined;
}

/**
 * 创建工具 HTML 渲染器。
 *
 * 渲染器查找工具定义并调用其 renderCall/renderResult 方法，
 * 将生成的 TUI Component 输出（ANSI）转换为 HTML。
 */
const ANSI_ESCAPE_REGEX = /\x1b\[[\d;]*m/g;

function isBlankRenderedLine(line: string): boolean {
	return line.replace(ANSI_ESCAPE_REGEX, "").trim().length === 0;
}

function trimRenderedResultLines(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && isBlankRenderedLine(lines[start])) start++;
	while (end > start && isBlankRenderedLine(lines[end - 1])) end--;
	return lines.slice(start, end);
}

export function createToolHtmlRenderer(deps: ToolHtmlRendererDeps): ToolHtmlRenderer {
	const { getToolDefinition, theme, cwd, width = 100 } = deps;

	const renderedCallComponents = new Map<string, Component>();
	const renderedResultComponents = new Map<string, Component>();
	const renderedStates = new Map<string, any>();
	const renderedArgs = new Map<string, unknown>();

	const getState = (toolCallId: string): any => {
		let state = renderedStates.get(toolCallId);
		if (!state) {
			state = {};
			renderedStates.set(toolCallId, state);
		}
		return state;
	};

	const createRenderContext = (
		toolCallId: string,
		lastComponent: Component | undefined,
		expanded: boolean,
		isPartial: boolean,
		isError: boolean,
	): ToolRenderContext => {
		return {
			args: renderedArgs.get(toolCallId),
			toolCallId,
			invalidate: () => {},
			lastComponent,
			state: getState(toolCallId),
			cwd,
			executionStarted: true,
			argsComplete: true,
			isPartial,
			expanded,
			showImages: false,
			isError,
		};
	};

	return {
		renderCall(toolCallId: string, toolName: string, args: unknown): string | undefined {
			try {
				renderedArgs.set(toolCallId, args);
				const toolDef = getToolDefinition(toolName);
				if (!toolDef?.renderCall) {
					return undefined;
				}

				const component = toolDef.renderCall(
					args,
					theme,
					createRenderContext(toolCallId, renderedCallComponents.get(toolCallId), false, true, false),
				);
				renderedCallComponents.set(toolCallId, component);
				const lines = component.render(width);
				return ansiLinesToHtml(lines);
			} catch {
				// 出错时返回 undefined，使 HTML 导出能够回退到结构化结果渲染
				return undefined;
			}
		},

		renderResult(
			toolCallId: string,
			toolName: string,
			result: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
			details: unknown,
			isError: boolean,
		): { collapsed?: string; expanded?: string } | undefined {
			try {
				const toolDef = getToolDefinition(toolName);
				if (!toolDef?.renderResult) {
					return undefined;
				}

				// 根据内容数组构建 AgentToolResult
				// 会话存储使用通用对象类型，因此转换 content 类型
				const agentToolResult = {
					content: result as (TextContent | ImageContent)[],
					details,
					isError,
				};

				// 渲染折叠状态
				const collapsedComponent = toolDef.renderResult(
					agentToolResult,
					{ expanded: false, isPartial: false },
					theme,
					createRenderContext(toolCallId, renderedResultComponents.get(toolCallId), false, false, isError),
				);
				renderedResultComponents.set(toolCallId, collapsedComponent);
				const collapsed = ansiLinesToHtml(trimRenderedResultLines(collapsedComponent.render(width)));

				// 渲染展开状态
				const expandedComponent = toolDef.renderResult(
					agentToolResult,
					{ expanded: true, isPartial: false },
					theme,
					createRenderContext(toolCallId, renderedResultComponents.get(toolCallId), true, false, isError),
				);
				renderedResultComponents.set(toolCallId, expandedComponent);
				const expanded = ansiLinesToHtml(trimRenderedResultLines(expandedComponent.render(width)));

				return {
					...(collapsed && collapsed !== expanded ? { collapsed } : {}),
					expanded,
				};
			} catch {
				// 出错时返回 undefined，使 HTML 导出能够回退到结构化结果渲染
				return undefined;
			}
		},
	};
}
