import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deleteKittyImage, isImageLine } from "./terminal-image.ts";
import { type TUI, TuiBase, type TuiStopOptions } from "./tui.ts";
import { visibleWidth } from "./utils.ts";

const KITTY_SEQUENCE_PREFIX = "\x1b_G";
const MAX_RENDER_WRITE_CHARS = 1024 * 1024;

/**
 * 以 1 MiB 分块流式写入终端输出，避免完整渲染形成超过 V8 限制的单个字符串。
 *
 * `append()` 填充当前块，并在块满时刷新。过大输入会在块边界拆分，同时保留代理项对，
 * 以确保每次写入都是有效 UTF-16。调用方自行追加同步输出的开始/结束序列；
 * 最后的 `flush()` 会写入包括结束序列在内的所有剩余内容。
 */
class BoundedTerminalWriter {
	private buffer = "";
	private writtenChars = 0;
	private readonly write: (data: string) => void;

	constructor(write: (data: string) => void) {
		this.write = write;
	}

	/**
	 * 追加终端数据，并按需刷新已满的数据块。调用方必须在最后一次追加后调用 `flush()`。
	 * @param value 按顺序写入的终端数据；过大值会拆分，但不会拆开代理项对。
	 */
	append(value: string): void {
		let offset = 0;
		while (offset < value.length) {
			const capacity = MAX_RENDER_WRITE_CHARS - this.buffer.length;
			if (capacity === 0) {
				this.flush();
				continue;
			}

			let end = Math.min(value.length, offset + capacity);
			if (
				end < value.length &&
				value.charCodeAt(end - 1) >= 0xd800 &&
				value.charCodeAt(end - 1) <= 0xdbff &&
				value.charCodeAt(end) >= 0xdc00 &&
				value.charCodeAt(end) <= 0xdfff
			) {
				end--;
			}
			if (end === offset) {
				this.flush();
				continue;
			}

			this.buffer += value.slice(offset, end);
			offset = end;
			if (this.buffer.length === MAX_RENDER_WRITE_CHARS) {
				this.flush();
			}
		}
	}

	/** 写入当前数据块（如果有），仅保留字符数用于调试输出。 */
	flush(): void {
		if (!this.buffer) return;
		this.write(this.buffer);
		this.writtenChars += this.buffer.length;
		this.buffer = "";
	}

	get length(): number {
		return this.writtenChars + this.buffer.length;
	}
}

interface KittyImageHeader {
	ids: number[];
	rows: number;
}

function parseKittyImageHeader(line: string): KittyImageHeader | undefined {
	const sequenceStart = line.indexOf(KITTY_SEQUENCE_PREFIX);
	if (sequenceStart === -1) return undefined;
	const paramsStart = sequenceStart + KITTY_SEQUENCE_PREFIX.length;
	const paramsEnd = line.indexOf(";", paramsStart);
	if (paramsEnd === -1) return undefined;

	const ids: number[] = [];
	let rows = 1;
	for (const param of line.slice(paramsStart, paramsEnd).split(",")) {
		const [key, value] = param.split("=", 2);
		if (value === undefined) continue;
		const numberValue = Number(value);
		if (!Number.isInteger(numberValue) || numberValue <= 0 || numberValue > 0xffffffff) continue;
		if (key === "i") ids.push(numberValue);
		else if (key === "r") rows = numberValue;
	}
	return { ids, rows };
}

function extractKittyImageIds(line: string): number[] {
	return parseKittyImageHeader(line)?.ids ?? [];
}

function extractKittyImageRows(line: string): number {
	return parseKittyImageHeader(line)?.rows ?? 1;
}

function isTermuxSession(): boolean {
	return Boolean(process.env.TERMUX_VERSION);
}

export interface TuiMainScreenRenderState {
	previousLines: string[];
	previousWidth: number;
	previousHeight: number;
	cursorRow: number;
	hardwareCursorRow: number;
	maxLinesRendered: number;
	previousViewportTop: number;
}

/** 渲染到终端主屏幕和回滚区的 TUI 实现。 */
export class TuiMainScreen extends TuiBase implements TUI {
	readonly mode = "regular" as const;
	private previousLines: string[] = [];
	private previousKittyImageIds = new Set<number>();
	private previousWidth = 0;
	private previousHeight = 0;
	private cursorRow = 0;
	private hardwareCursorRow = 0;
	private maxLinesRendered = 0;
	private previousViewportTop = 0;

	captureRenderState(): TuiMainScreenRenderState {
		return {
			previousLines: [...this.previousLines],
			previousWidth: this.previousWidth,
			previousHeight: this.previousHeight,
			cursorRow: this.cursorRow,
			hardwareCursorRow: this.hardwareCursorRow,
			maxLinesRendered: this.maxLinesRendered,
			previousViewportTop: this.previousViewportTop,
		};
	}

	restoreRenderState(state: TuiMainScreenRenderState): void {
		this.previousLines = state.previousLines.map((line) => (isImageLine(line) ? "" : line));
		this.previousKittyImageIds = new Set();
		this.previousWidth = state.previousWidth;
		this.previousHeight = state.previousHeight;
		this.cursorRow = state.cursorRow;
		this.hardwareCursorRow = state.hardwareCursorRow;
		this.maxLinesRendered = state.maxLinesRendered;
		this.previousViewportTop = state.previousViewportTop;
	}

	protected override resetRenderState(): void {
		this.previousLines = [];
		this.previousWidth = -1;
		this.previousHeight = -1;
		this.cursorRow = 0;
		this.hardwareCursorRow = 0;
		this.maxLinesRendered = 0;
		this.previousViewportTop = 0;
	}

	protected override beforeTerminalStop(options: TuiStopOptions): void {
		if (options.preserveScreen || this.previousLines.length === 0) return;
		this.terminal.write(" ");
		const targetRow = this.previousLines.length;
		const lineDiff = targetRow - this.hardwareCursorRow;
		if (lineDiff > 0) this.terminal.write(`\x1b[${lineDiff}B`);
		else if (lineDiff < 0) this.terminal.write(`\x1b[${-lineDiff}A`);
		this.terminal.write("\r\n");
	}

	private collectKittyImageIds(lines: string[]): Set<number> {
		const ids = new Set<number>();
		for (const line of lines) {
			for (const id of extractKittyImageIds(line)) {
				ids.add(id);
			}
		}
		return ids;
	}

	private deleteKittyImages(ids: Iterable<number>): string {
		let buffer = "";
		for (const id of ids) {
			buffer += deleteKittyImage(id);
		}
		return buffer;
	}

	private getKittyImageReservedRows(lines: string[], index: number, maxIndex = lines.length - 1): number {
		const rows = extractKittyImageRows(lines[index] ?? "");
		if (rows <= 1) return 1;

		const maxRows = Math.min(rows, maxIndex - index + 1, lines.length - index);
		let reservedRows = 1;
		while (reservedRows < maxRows) {
			const line = lines[index + reservedRows] ?? "";
			if (isImageLine(line) || visibleWidth(line) > 0) break;
			reservedRows++;
		}
		return reservedRows;
	}

	private expandChangedRangeForKittyImages(
		firstChanged: number,
		lastChanged: number,
		newLines: string[],
	): { firstChanged: number; lastChanged: number } {
		let expandedFirstChanged = firstChanged;
		let expandedLastChanged = lastChanged;
		const expandForLines = (lines: string[]): void => {
			for (let i = 0; i < lines.length; i++) {
				if (extractKittyImageIds(lines[i]).length === 0) continue;
				const blockEnd = i + this.getKittyImageReservedRows(lines, i) - 1;
				if (i >= firstChanged || (i <= lastChanged && blockEnd >= firstChanged)) {
					expandedFirstChanged = Math.min(expandedFirstChanged, i);
					expandedLastChanged = Math.max(expandedLastChanged, blockEnd);
				}
			}
		};

		expandForLines(this.previousLines);
		expandForLines(newLines);
		return { firstChanged: expandedFirstChanged, lastChanged: expandedLastChanged };
	}

	private deleteChangedKittyImages(firstChanged: number, lastChanged: number): string {
		if (firstChanged < 0 || lastChanged < firstChanged) return "";

		const ids = new Set<number>();
		const maxLine = Math.min(lastChanged, this.previousLines.length - 1);
		for (let i = firstChanged; i <= maxLine; i++) {
			for (const id of extractKittyImageIds(this.previousLines[i] ?? "")) {
				ids.add(id);
			}
		}

		return this.deleteKittyImages(ids);
	}

	protected doRender(): void {
		if (this.stopped) return;
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		const widthChanged = this.previousWidth !== 0 && this.previousWidth !== width;
		const heightChanged = this.previousHeight !== 0 && this.previousHeight !== height;
		const previousBufferLength = this.previousHeight > 0 ? this.previousViewportTop + this.previousHeight : height;
		let prevViewportTop = heightChanged ? Math.max(0, previousBufferLength - height) : this.previousViewportTop;
		let viewportTop = prevViewportTop;
		let hardwareCursorRow = this.hardwareCursorRow;
		const computeLineDiff = (targetRow: number): number => {
			const currentScreenRow = hardwareCursorRow - prevViewportTop;
			const targetScreenRow = targetRow - viewportTop;
			return targetScreenRow - currentScreenRow;
		};

		// 渲染所有组件以获得新行。
		let newLines = this.render(width);

		// 在差异比较前，将覆盖层合成到渲染行中。
		if (this.hasOverlayEntries) {
			newLines = this.compositeOverlays(newLines, width, height);
		}

		// 应用行重置前提取光标位置，必须先找到标记。
		const cursorPos = this.extractCursorPosition(newLines, height);

		newLines = this.applyLineResets(newLines);

		// 用于清除回滚区和视口并渲染全部新行的辅助函数。
		const fullRender = (clear: boolean): void => {
			this.fullRedrawCount += 1;
			const output = new BoundedTerminalWriter((data) => this.terminal.write(data));
			output.append("\x1b[?2026h"); // 开始同步输出
			if (clear) {
				output.append(this.deleteKittyImages(this.previousKittyImageIds));
				output.append("\x1b[2J\x1b[H\x1b[3J"); // 清除屏幕、返回起始位置，然后清除回滚区
			}
			for (let i = 0; i < newLines.length; i++) {
				if (i > 0) output.append("\r\n");
				const line = newLines[i];
				const isImage = isImageLine(line);
				const imageReservedRows = isImage ? this.getKittyImageReservedRows(newLines, i) : 1;
				if (imageReservedRows > 1 && imageReservedRows <= height) {
					for (let row = 1; row < imageReservedRows; row++) {
						output.append("\r\n");
					}
					output.append(`\x1b[${imageReservedRows - 1}A`);
					output.append(line);
					output.append(`\x1b[${imageReservedRows - 1}B`);
					i += imageReservedRows - 1;
					continue;
				}
				output.append(line);
			}
			output.append("\x1b[?2026l"); // 结束同步输出
			output.flush();
			this.cursorRow = Math.max(0, newLines.length - 1);
			this.hardwareCursorRow = this.cursorRow;
			// 清除时重置最大行数，否则跟踪增长。
			if (clear) {
				this.maxLinesRendered = newLines.length;
			} else {
				this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
			}
			const bufferLength = Math.max(height, newLines.length);
			this.previousViewportTop = Math.max(0, bufferLength - height);
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousLines = newLines;
			this.previousKittyImageIds = this.collectKittyImageIds(newLines);
			this.previousWidth = width;
			this.previousHeight = height;
		};

		const redrawLogDirectory = process.env.PI_TUI_DEBUG_REDRAW === "1" ? this.logDirectory : undefined;
		const logRedraw = (reason: string): void => {
			if (redrawLogDirectory === undefined) return;
			const logPath = path.join(redrawLogDirectory, "pi-tui-debug.log");
			const msg = `[${new Date().toISOString()}] fullRender: ${reason} (prev=${this.previousLines.length}, new=${newLines.length}, height=${height})\n`;
			fs.mkdirSync(path.dirname(logPath), { recursive: true });
			fs.appendFileSync(logPath, msg);
		};

		// 首次渲染：假设屏幕干净，不清除并直接输出全部内容。
		if (this.previousLines.length === 0 && !widthChanged && !heightChanged) {
			logRedraw("first render");
			fullRender(false);
			return;
		}

		// 宽度变化会改变换行，因此始终需要完整重绘。
		if (widthChanged) {
			logRedraw(`terminal width changed (${this.previousWidth} -> ${width})`);
			fullRender(true);
			return;
		}

		// 高度变化通常需要完整重绘，以保持可见视口对齐；
		// 但 Termux 会在软键盘显示或隐藏时改变高度，在该环境中完整重绘会导致每次切换都重放全部历史。
		if (heightChanged && !isTermuxSession()) {
			logRedraw(`terminal height changed (${this.previousHeight} -> ${height})`);
			fullRender(true);
			return;
		}

		// 内容缩小到工作区以内且没有覆盖层时，重新渲染以清除空行。
		// 覆盖层需要这些填充，因此仅在没有活动覆盖层时执行。可通过 setClearOnShrink() 配置。
		if (this.getClearOnShrink() && newLines.length < this.maxLinesRendered && !this.hasOverlayEntries) {
			logRedraw(`clearOnShrink (maxLinesRendered=${this.maxLinesRendered})`);
			fullRender(true);
			return;
		}

		// 查找第一行和最后一行变更。
		let firstChanged = -1;
		let lastChanged = -1;
		const maxLines = Math.max(newLines.length, this.previousLines.length);
		for (let i = 0; i < maxLines; i++) {
			const oldLine = i < this.previousLines.length ? this.previousLines[i] : "";
			const newLine = i < newLines.length ? newLines[i] : "";

			if (oldLine !== newLine) {
				if (firstChanged === -1) {
					firstChanged = i;
				}
				lastChanged = i;
			}
		}
		const appendedLines = newLines.length > this.previousLines.length;
		if (appendedLines) {
			if (firstChanged === -1) {
				firstChanged = this.previousLines.length;
			}
			lastChanged = newLines.length - 1;
		}
		if (firstChanged !== -1) {
			const expandedRange = this.expandChangedRangeForKittyImages(firstChanged, lastChanged, newLines);
			firstChanged = expandedRange.firstChanged;
			lastChanged = expandedRange.lastChanged;
		}
		const appendStart = appendedLines && firstChanged === this.previousLines.length && firstChanged > 0;

		// 内容没有变化，但硬件光标移动时仍需更新其位置。
		if (firstChanged === -1) {
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousViewportTop = prevViewportTop;
			this.previousHeight = height;
			return;
		}

		// 所有变化都位于已删除行中，无需渲染，只需清除。
		if (firstChanged >= newLines.length) {
			if (this.previousLines.length > newLines.length) {
				const output = new BoundedTerminalWriter((data) => this.terminal.write(data));
				output.append("\x1b[?2026h");
				output.append(this.deleteChangedKittyImages(firstChanged, lastChanged));
				// 移动到新内容末尾；内容为空时限制为 0。
				const targetRow = Math.max(0, newLines.length - 1);
				if (targetRow < prevViewportTop) {
					logRedraw(`deleted lines moved viewport up (${targetRow} < ${prevViewportTop})`);
					fullRender(true);
					return;
				}
				const lineDiff = computeLineDiff(targetRow);
				if (lineDiff > 0) output.append(`\x1b[${lineDiff}B`);
				else if (lineDiff < 0) output.append(`\x1b[${-lineDiff}A`);
				output.append("\r");
				// 清除多余行，但不滚动。
				const extraLines = this.previousLines.length - newLines.length;
				if (extraLines > height) {
					logRedraw(`extraLines > height (${extraLines} > ${height})`);
					fullRender(true);
					return;
				}
				const clearStartOffset = newLines.length === 0 ? 0 : 1;
				if (extraLines > 0 && clearStartOffset > 0) {
					output.append(`\x1b[${clearStartOffset}B`);
				}
				for (let i = 0; i < extraLines; i++) {
					output.append("\r\x1b[2K");
					if (i < extraLines - 1) output.append("\x1b[1B");
				}
				const moveBack = Math.max(0, extraLines - 1 + clearStartOffset);
				if (moveBack > 0) {
					output.append(`\x1b[${moveBack}A`);
				}
				output.append("\x1b[?2026l");
				output.flush();
				this.cursorRow = targetRow;
				this.hardwareCursorRow = targetRow;
			}
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousLines = newLines;
			this.previousKittyImageIds = this.collectKittyImageIds(newLines);
			this.previousWidth = width;
			this.previousHeight = height;
			this.previousViewportTop = prevViewportTop;
			return;
		}

		// 差异渲染只能修改实际可见的内容。
		// 如果第一处变更位于先前视口上方，则需要完整重绘。
		if (firstChanged < prevViewportTop) {
			logRedraw(`firstChanged < viewportTop (${firstChanged} < ${prevViewportTop})`);
			fullRender(true);
			return;
		}

		// 从第一处变更行开始渲染。
		// 写入有界数据块时，始终用同步输出包裹更新。
		const output = new BoundedTerminalWriter((data) => this.terminal.write(data));
		output.append("\x1b[?2026h"); // 开始同步输出
		output.append(this.deleteChangedKittyImages(firstChanged, lastChanged));
		const prevViewportBottom = prevViewportTop + height - 1;
		const moveTargetRow = appendStart ? firstChanged - 1 : firstChanged;
		if (moveTargetRow > prevViewportBottom) {
			const currentScreenRow = Math.max(0, Math.min(height - 1, hardwareCursorRow - prevViewportTop));
			const moveToBottom = height - 1 - currentScreenRow;
			if (moveToBottom > 0) {
				output.append(`\x1b[${moveToBottom}B`);
			}
			const scroll = moveTargetRow - prevViewportBottom;
			output.append("\r\n".repeat(scroll));
			prevViewportTop += scroll;
			viewportTop += scroll;
			hardwareCursorRow = moveTargetRow;
		}

		// 将光标移到第一处变更行，并用 hardwareCursorRow 表示实际位置。
		const lineDiff = computeLineDiff(moveTargetRow);
		if (lineDiff > 0) {
			output.append(`\x1b[${lineDiff}B`); // 向下移动
		} else if (lineDiff < 0) {
			output.append(`\x1b[${-lineDiff}A`); // 向上移动
		}

		output.append(appendStart ? "\r\n" : "\r"); // 移到第 0 列

		// 只渲染变更行（firstChanged 到 lastChanged），而不是一直渲染到末尾。
		// 这样可减少仅有单行变化时的闪烁，例如旋转动画。
		const renderEnd = Math.min(lastChanged, newLines.length - 1);
		for (let i = firstChanged; i <= renderEnd; i++) {
			if (i > firstChanged) output.append("\r\n");
			const line = newLines[i];
			const isImage = isImageLine(line);
			const imageReservedRows = isImage ? this.getKittyImageReservedRows(newLines, i, renderEnd) : 1;
			if (imageReservedRows > 1) {
				const imageStartScreenRow = i - viewportTop;
				if (imageStartScreenRow < 0 || imageStartScreenRow + imageReservedRows > height) {
					logRedraw(
						`kitty image pre-clear would scroll (${imageStartScreenRow} + ${imageReservedRows} > ${height})`,
					);
					fullRender(true);
					return;
				}

				output.append("\x1b[2K");
				for (let row = 1; row < imageReservedRows; row++) {
					output.append("\r\n\x1b[2K");
				}
				output.append(`\x1b[${imageReservedRows - 1}A`);
				output.append(line);
				output.append(`\x1b[${imageReservedRows - 1}B`);
				i += imageReservedRows - 1;
				continue;
			}

			output.append("\x1b[2K"); // 清除当前行
			if (!isImage && visibleWidth(line) > width) {
				// 将所有行记录到崩溃文件以便调试。
				const crashLogPath = path.join(this.logDirectory ?? os.tmpdir(), "pi-tui-crash.log");
				const crashData = [
					`Crash at ${new Date().toISOString()}`,
					`Terminal width: ${width}`,
					`Line ${i} visible width: ${visibleWidth(line)}`,
					"",
					"=== All rendered lines ===",
					...newLines.map((l, idx) => `[${idx}] (w=${visibleWidth(l)}) ${l}`),
					"",
				].join("\n");
				fs.mkdirSync(path.dirname(crashLogPath), { recursive: true });
				fs.writeFileSync(crashLogPath, crashData);

				// 抛出错误前清理终端状态。
				this.stop();

				const errorMsg = [
					`Rendered line ${i} exceeds terminal width (${visibleWidth(line)} > ${width}).`,
					"",
					"This is likely caused by a custom TUI component not truncating its output.",
					"Use visibleWidth() to measure and truncateToWidth() to truncate lines.",
					"",
					`Debug log written to: ${crashLogPath}`,
				].join("\n");
				throw new Error(errorMsg);
			}
			output.append(line);
		}

		// 跟踪渲染后光标的最终位置。
		let finalCursorRow = renderEnd;

		// 如果先前有更多行，则清除这些行并移回光标。
		if (this.previousLines.length > newLines.length) {
			// 如果渲染在新内容末尾前停止，则先移到新内容末尾。
			if (renderEnd < newLines.length - 1) {
				const moveDown = newLines.length - 1 - renderEnd;
				output.append(`\x1b[${moveDown}B`);
				finalCursorRow = newLines.length - 1;
			}
			const extraLines = this.previousLines.length - newLines.length;
			for (let i = newLines.length; i < this.previousLines.length; i++) {
				output.append("\r\n\x1b[2K");
			}
			// 将光标移回新内容末尾。
			output.append(`\x1b[${extraLines}A`);
		}

		output.append("\x1b[?2026l"); // 结束同步输出

		if (process.env.PI_TUI_DEBUG === "1") {
			const debugDir = "/tmp/tui";
			fs.mkdirSync(debugDir, { recursive: true });
			const debugPath = path.join(debugDir, `render-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
			const debugData = [
				`firstChanged: ${firstChanged}`,
				`viewportTop: ${viewportTop}`,
				`cursorRow: ${this.cursorRow}`,
				`height: ${height}`,
				`lineDiff: ${lineDiff}`,
				`hardwareCursorRow: ${hardwareCursorRow}`,
				`renderEnd: ${renderEnd}`,
				`finalCursorRow: ${finalCursorRow}`,
				`cursorPos: ${JSON.stringify(cursorPos)}`,
				`newLines.length: ${newLines.length}`,
				`previousLines.length: ${this.previousLines.length}`,
				"",
				"=== newLines ===",
				JSON.stringify(newLines, null, 2),
				"",
				"=== previousLines ===",
				JSON.stringify(this.previousLines, null, 2),
				"",
				"=== buffer ===",
				`[${output.length} chars written in bounded chunks]`,
			].join("\n");
			fs.writeFileSync(debugPath, debugData);
		}

		output.flush();

		// 为下一次渲染跟踪光标位置。
		// cursorRow 跟踪内容末尾，用于视口计算；
		// hardwareCursorRow 跟踪终端光标实际位置，用于移动。
		this.cursorRow = Math.max(0, newLines.length - 1);
		this.hardwareCursorRow = finalCursorRow;
		// 跟踪终端工作区；除非清除，否则只增长不缩小。
		this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
		this.previousViewportTop = Math.max(prevViewportTop, finalCursorRow - height + 1);

		// 为 IME 定位硬件光标。
		this.positionHardwareCursor(cursorPos, newLines.length);

		this.previousLines = newLines;
		this.previousKittyImageIds = this.collectKittyImageIds(newLines);
		this.previousWidth = width;
		this.previousHeight = height;
	}

	/**
	 * 为 IME 候选窗口定位硬件光标。
	 * @param cursorPos 从渲染输出中提取的光标位置，或 null
	 * @param totalLines 渲染行总数
	 */
	private positionHardwareCursor(cursorPos: { row: number; col: number } | null, totalLines: number): void {
		if (!cursorPos || totalLines <= 0) {
			this.terminal.hideCursor();
			return;
		}

		// 将光标位置限制在有效范围内。
		const targetRow = Math.max(0, Math.min(cursorPos.row, totalLines - 1));
		const targetCol = Math.max(0, cursorPos.col);

		// 将光标从当前位置移到目标位置。
		const rowDelta = targetRow - this.hardwareCursorRow;
		let buffer = "";
		if (rowDelta > 0) {
			buffer += `\x1b[${rowDelta}B`; // 向下移动
		} else if (rowDelta < 0) {
			buffer += `\x1b[${-rowDelta}A`; // 向上移动
		}
		// 移到绝对列位置（从 1 开始计数）。
		buffer += `\x1b[${targetCol + 1}G`;

		if (buffer) {
			this.terminal.write(buffer);
		}

		this.hardwareCursorRow = targetRow;
		if (this.getShowHardwareCursor()) {
			this.terminal.showCursor();
		} else {
			this.terminal.hideCursor();
		}
	}
}
