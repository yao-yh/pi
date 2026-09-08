import type { Component } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

/**
 * 根据视口宽度进行调整的动态边框组件。
 *
 * 注意：通过 jiti 加载的扩展使用此组件时，全局 `theme` 可能为 undefined，
 * 因为 jiti 会创建独立的模块缓存。在为扩展导出的组件中使用 DynamicBorder 时，
 * 始终应显式传入颜色函数。
 */
export class DynamicBorder implements Component {
	private color: (str: string) => string;

	constructor(color: (str: string) => string = (str) => theme.fg("border", str)) {
		this.color = color;
	}

	invalidate(): void {
		// 当前没有需要失效的缓存状态
	}

	render(width: number): string[] {
		return [this.color("─".repeat(Math.max(1, width)))];
	}
}
