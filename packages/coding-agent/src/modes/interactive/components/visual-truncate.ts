/**
 * 将文本截断为可视行的共享工具函数（考虑自动换行）。
 * tool-execution.ts 和 bash-execution.ts 均使用此函数，以保持行为一致。
 */

import { Text } from "@earendil-works/pi-tui";

export interface VisualTruncateResult {
	/** 要显示的可视行 */
	visualLines: string[];
	/** 已跳过（隐藏）的可视行数 */
	skippedCount: number;
}

/**
 * 从末尾截断文本，使其不超过最大可视行数。
 * 此过程会考虑基于终端宽度的自动换行。
 *
 * @param text - 文本内容（可包含换行符）
 * @param maxVisualLines - 要显示的最大可视行数
 * @param width - 终端或渲染宽度
 * @param paddingX - Text 组件的水平内边距（默认为 0）。
 *                   结果将放入 Box 时使用 0（Box 会添加自己的内边距）。
 *                   结果将放入普通 Container 时使用 1。
 * @returns 截断后的可视行及跳过的行数
 */
export function truncateToVisualLines(
	text: string,
	maxVisualLines: number,
	width: number,
	paddingX: number = 0,
): VisualTruncateResult {
	if (!text) {
		return { visualLines: [], skippedCount: 0 };
	}

	// 创建临时 Text 组件进行渲染并获取可视行
	const tempText = new Text(text, paddingX, 0);
	const allVisualLines = tempText.render(width);

	if (allVisualLines.length <= maxVisualLines) {
		return { visualLines: allVisualLines, skippedCount: 0 };
	}

	// 取最后 N 个可视行
	const truncatedLines = allVisualLines.slice(-maxVisualLines);
	const skippedCount = allVisualLines.length - maxVisualLines;

	return { visualLines: truncatedLines, skippedCount };
}
