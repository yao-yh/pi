/**
 * 显示带流式输出的 bash 命令执行组件。
 */

import { Container, Loader, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type TruncationResult,
	truncateTail,
} from "../../../core/tools/truncate.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, keyText } from "./keybinding-hints.ts";
import { truncateToVisualLines } from "./visual-truncate.ts";

// 未展开时的预览行数限制（与工具执行行为一致）
const PREVIEW_LINES = 20;

export class BashExecutionComponent extends Container {
	private command: string;
	private outputLines: string[] = [];
	private status: "running" | "complete" | "cancelled" | "error" = "running";
	private exitCode: number | undefined = undefined;
	private loader: Loader;
	private truncationResult?: TruncationResult;
	private fullOutputPath?: string;
	private expanded = false;
	private contentContainer: Container;

	constructor(command: string, ui: TUI, excludeFromContext = false) {
		super();
		this.command = command;

		// 对从上下文排除的命令（!! 前缀）使用暗色边框
		const colorKey = excludeFromContext ? "dim" : "bashMode";
		const borderColor = (str: string) => theme.fg(colorKey, str);

		// 添加间隔
		this.addChild(new Spacer(1));

		// 上边框
		this.addChild(new DynamicBorder(borderColor));

		// 内容容器（容纳边框之间的动态内容）
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		// 命令标题
		const header = new Text(theme.fg(colorKey, theme.bold(`$ ${command}`)), 1, 0);
		this.contentContainer.addChild(header);

		// 加载器
		this.loader = new Loader(
			ui,
			(spinner) => theme.fg(colorKey, spinner),
			(text) => theme.fg("muted", text),
			`Running... (${keyText("tui.select.cancel")} to cancel)`, // 加载器使用纯文本
		);
		this.contentContainer.addChild(this.loader);

		// 下边框
		this.addChild(new DynamicBorder(borderColor));
	}

	/**
	 * 设置输出是展开（显示完整输出）还是折叠（仅显示预览）。
	 */
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	appendOutput(chunk: string): void {
		// 移除 ANSI 代码并规范化行尾
		// 注意：二进制数据已在 tui-renderer.ts 的 executeBashCommand 中清理
		const clean = stripAnsi(chunk).replace(/\r\n/g, "\n").replace(/\r/g, "\n");

		// 追加到输出行
		const newLines = clean.split("\n");
		if (this.outputLines.length > 0 && newLines.length > 0) {
			// 将第一个数据块追加到最后一行（未完成行的延续内容）
			this.outputLines[this.outputLines.length - 1] += newLines[0];
			this.outputLines.push(...newLines.slice(1));
		} else {
			this.outputLines.push(...newLines);
		}

		this.updateDisplay();
	}

	setComplete(
		exitCode: number | undefined,
		cancelled: boolean,
		truncationResult?: TruncationResult,
		fullOutputPath?: string,
	): void {
		this.exitCode = exitCode;
		this.status = cancelled
			? "cancelled"
			: exitCode !== 0 && exitCode !== undefined && exitCode !== null
				? "error"
				: "complete";
		this.truncationResult = truncationResult;
		this.fullOutputPath = fullOutputPath;

		// 停止加载器
		this.loader.stop();

		this.updateDisplay();
	}

	private updateDisplay(): void {
		// 针对 LLM 上下文限制应用截断（与 bash 工具的限制相同）
		const fullOutput = this.outputLines.join("\n");
		const contextTruncation = truncateTail(fullOutput, {
			maxLines: DEFAULT_MAX_LINES,
			maxBytes: DEFAULT_MAX_BYTES,
		});

		// 获取可能显示的行（上下文截断后）
		const availableLines = contextTruncation.content ? contextTruncation.content.split("\n") : [];

		// 根据展开状态应用预览截断
		const previewLogicalLines = availableLines.slice(-PREVIEW_LINES);
		const hiddenLineCount = availableLines.length - previewLogicalLines.length;

		// 重建内容容器
		this.contentContainer.clear();

		// 命令标题
		const header = new Text(theme.fg("bashMode", theme.bold(`$ ${this.command}`)), 1, 0);
		this.contentContainer.addChild(header);

		// 输出
		if (availableLines.length > 0) {
			if (this.expanded) {
				// 显示所有行
				const displayText = availableLines.map((line) => theme.fg("muted", line)).join("\n");
				this.contentContainer.addChild(new Text(`\n${displayText}`, 1, 0));
			} else {
				// 使用带宽度感知缓存的共享可视截断工具
				const styledOutput = previewLogicalLines.map((line) => theme.fg("muted", line)).join("\n");
				const styledInput = `\n${styledOutput}`;
				let cachedWidth: number | undefined;
				let cachedLines: string[] | undefined;
				this.contentContainer.addChild({
					render: (width: number) => {
						if (cachedLines === undefined || cachedWidth !== width) {
							const result = truncateToVisualLines(styledInput, PREVIEW_LINES, width, 1);
							cachedLines = result.visualLines;
							cachedWidth = width;
						}
						return cachedLines ?? [];
					},
					invalidate: () => {
						cachedWidth = undefined;
						cachedLines = undefined;
					},
				});
			}
		}

		// 加载器或状态
		if (this.status === "running") {
			this.contentContainer.addChild(this.loader);
		} else {
			const statusParts: string[] = [];

			// 显示隐藏的行数（折叠预览）
			if (hiddenLineCount > 0) {
				if (this.expanded) {
					statusParts.push(
						`${theme.fg("muted", "(")}${keyHint("app.tools.expand", "to collapse")}${theme.fg("muted", ")")}`,
					);
				} else {
					statusParts.push(
						`${theme.fg("muted", `... ${hiddenLineCount} more lines (`)}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
					);
				}
			}

			if (this.status === "cancelled") {
				statusParts.push(theme.fg("warning", "(cancelled)"));
			} else if (this.status === "error") {
				statusParts.push(theme.fg("error", `(exit ${this.exitCode})`));
			}

			// 添加截断警告（上下文截断，而非预览截断）
			const wasTruncated = this.truncationResult?.truncated || contextTruncation.truncated;
			if (wasTruncated && this.fullOutputPath) {
				statusParts.push(theme.fg("warning", `Output truncated. Full output: ${this.fullOutputPath}`));
			}

			if (statusParts.length > 0) {
				this.contentContainer.addChild(new Text(`\n${statusParts.join("\n")}`, 1, 0));
			}
		}
	}

	/**
	 * 获取用于创建 BashExecutionMessage 的原始输出。
	 */
	getOutput(): string {
		return this.outputLines.join("\n");
	}

	/**
	 * 获取已执行的命令。
	 */
	getCommand(): string {
		return this.command;
	}
}
