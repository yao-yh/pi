import * as Diff from "diff";
import { theme } from "../theme/theme.ts";

/**
 * 解析差异行，提取前缀、行号和内容。
 * 格式："+123 content"、"-123 content"、" 123 content" 或 "     ..."
 */
function parseDiffLine(line: string): { prefix: string; lineNum: string; content: string } | null {
	const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
	if (!match) return null;
	return { prefix: match[1], lineNum: match[2], content: match[3] };
}

/**
 * 将制表符替换为空格，以保持渲染一致。
 */
function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

/**
 * 计算单词级差异，并以反色渲染变更部分。
 * 使用 diffWords 将空白与相邻单词分组，使高亮更整洁。
 * 从反色内容中移除前导空白，避免高亮缩进。
 */
function renderIntraLineDiff(oldContent: string, newContent: string): { removedLine: string; addedLine: string } {
	const wordDiff = Diff.diffWords(oldContent, newContent);

	let removedLine = "";
	let addedLine = "";
	let isFirstRemoved = true;
	let isFirstAdded = true;

	for (const part of wordDiff) {
		if (part.removed) {
			let value = part.value;
			// 从第一个删除部分移除前导空白
			if (isFirstRemoved) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				removedLine += leadingWs;
				isFirstRemoved = false;
			}
			if (value) {
				removedLine += theme.inverse(value);
			}
		} else if (part.added) {
			let value = part.value;
			// 从第一个新增部分移除前导空白
			if (isFirstAdded) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				addedLine += leadingWs;
				isFirstAdded = false;
			}
			if (value) {
				addedLine += theme.inverse(value);
			}
		} else {
			removedLine += part.value;
			addedLine += part.value;
		}
	}

	return { removedLine, addedLine };
}

export interface RenderDiffOptions {
	/** 文件路径（未使用，为保持 API 兼容性而保留） */
	filePath?: string;
}

/**
 * 渲染带行颜色和行内变更高亮的差异字符串。
 * - 上下文行：暗色/灰色
 * - 删除行：红色，变更令牌使用反色
 * - 新增行：绿色，变更令牌使用反色
 */
export function renderDiff(diffText: string, _options: RenderDiffOptions = {}): string {
	const lines = diffText.split("\n");
	const result: string[] = [];

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const parsed = parseDiffLine(line);

		if (!parsed) {
			result.push(theme.fg("toolDiffContext", line));
			i++;
			continue;
		}

		if (parsed.prefix === "-") {
			// 收集连续的删除行
			const removedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (!p || p.prefix !== "-") break;
				removedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}

			// 收集连续的新增行
			const addedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (!p || p.prefix !== "+") break;
				addedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}

			// 仅在恰好有一个删除行和一个新增行时执行行内差异比较
			// （表示单行修改）。否则按原样显示各行。
			if (removedLines.length === 1 && addedLines.length === 1) {
				const removed = removedLines[0];
				const added = addedLines[0];

				const { removedLine, addedLine } = renderIntraLineDiff(
					replaceTabs(removed.content),
					replaceTabs(added.content),
				);

				result.push(theme.fg("toolDiffRemoved", `-${removed.lineNum} ${removedLine}`));
				result.push(theme.fg("toolDiffAdded", `+${added.lineNum} ${addedLine}`));
			} else {
				// 先显示所有删除行，再显示所有新增行
				for (const removed of removedLines) {
					result.push(theme.fg("toolDiffRemoved", `-${removed.lineNum} ${replaceTabs(removed.content)}`));
				}
				for (const added of addedLines) {
					result.push(theme.fg("toolDiffAdded", `+${added.lineNum} ${replaceTabs(added.content)}`));
				}
			}
		} else if (parsed.prefix === "+") {
			// 独立新增行
			result.push(theme.fg("toolDiffAdded", `+${parsed.lineNum} ${replaceTabs(parsed.content)}`));
			i++;
		} else {
			// 上下文行
			result.push(theme.fg("toolDiffContext", ` ${parsed.lineNum} ${replaceTabs(parsed.content)}`));
			i++;
		}
	}

	return result.join("\n");
}
