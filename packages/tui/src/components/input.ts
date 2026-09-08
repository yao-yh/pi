import { getKeybindings } from "../keybindings.ts";
import { decodeKittyPrintable } from "../keys.ts";
import { KillRing } from "../kill-ring.ts";
import { type Component, CURSOR_MARKER, type Focusable, type TuiMouseEvent, type TuiMouseEventResult } from "../tui.ts";
import { UndoStack } from "../undo-stack.ts";
import { getGraphemeSegmenter, isWhitespaceChar, sliceByColumn, truncateToWidth, visibleWidth } from "../utils.ts";
import { findWordBackward, findWordForward } from "../word-navigation.ts";

const segmenter = getGraphemeSegmenter();

interface InputState {
	value: string;
	cursor: number;
}

export interface InputOptions {
	prompt?: string;
	placeholder?: string;
	placeholderStyle?: (text: string) => string;
}

/**
 * Input 组件——支持水平滚动的单行文本输入。
 */
export class Input implements Component, Focusable {
	private value: string = "";
	private cursor: number = 0; // 光标在值中的位置
	private readonly prompt: string;
	private readonly placeholder: string;
	private readonly placeholderStyle: (text: string) => string;
	private renderedStartColumn = 0;
	public onSubmit?: (value: string) => void;
	public onEscape?: () => void;

	/** Focusable 接口——焦点变化时由 TUI 设置。 */
	focused: boolean = false;

	// 括号粘贴模式缓冲
	private pasteBuffer: string = "";
	private isInPaste: boolean = false;

	// 用于 Emacs 风格 kill/yank 操作的 kill ring
	private killRing = new KillRing();
	private lastAction: "kill" | "yank" | "type-word" | null = null;

	// 撤销支持
	private undoStack = new UndoStack<InputState>();

	constructor(options: InputOptions = {}) {
		this.prompt = options.prompt ?? "> ";
		this.placeholder = options.placeholder ?? "";
		this.placeholderStyle = options.placeholderStyle ?? ((text) => text);
	}

	getValue(): string {
		return this.value;
	}

	setValue(value: string): void {
		this.value = value;
		this.cursor = Math.min(this.cursor, value.length);
	}

	handleInput(data: string): void {
		// 处理括号粘贴模式。
		// 粘贴开始：\x1b[200~
		// 粘贴结束：\x1b[201~

		// 检查是否开始括号粘贴。
		if (data.includes("\x1b[200~")) {
			this.isInPaste = true;
			this.pasteBuffer = "";
			data = data.replace("\x1b[200~", "");
		}

		// 处于粘贴状态时缓冲数据。
		if (this.isInPaste) {
			// 检查当前数据块是否包含结束标记。
			this.pasteBuffer += data;

			const endIndex = this.pasteBuffer.indexOf("\x1b[201~");
			if (endIndex !== -1) {
				// 提取粘贴内容。
				const pasteContent = this.pasteBuffer.substring(0, endIndex);

				// 处理完整粘贴内容。
				this.handlePaste(pasteContent);

				// 重置粘贴状态。
				this.isInPaste = false;

				// 处理粘贴标记之后的剩余输入。
				const remaining = this.pasteBuffer.substring(endIndex + 6); // 6 是 \x1b[201~ 的长度
				this.pasteBuffer = "";
				if (remaining) {
					this.handleInput(remaining);
				}
			}
			return;
		}

		const kb = getKeybindings();

		// Escape/取消
		if (kb.matches(data, "tui.select.cancel")) {
			if (this.onEscape) this.onEscape();
			return;
		}

		// 撤销
		if (kb.matches(data, "tui.editor.undo")) {
			this.undo();
			return;
		}

		// 提交
		if (kb.matches(data, "tui.input.submit") || data === "\n") {
			if (this.onSubmit) this.onSubmit(this.value);
			return;
		}

		// 删除
		if (kb.matches(data, "tui.editor.deleteCharBackward")) {
			this.handleBackspace();
			return;
		}

		if (kb.matches(data, "tui.editor.deleteCharForward")) {
			this.handleForwardDelete();
			return;
		}

		if (kb.matches(data, "tui.editor.deleteWordBackward")) {
			this.deleteWordBackwards();
			return;
		}

		if (kb.matches(data, "tui.editor.deleteWordForward")) {
			this.deleteWordForward();
			return;
		}

		if (kb.matches(data, "tui.editor.deleteToLineStart")) {
			this.deleteToLineStart();
			return;
		}

		if (kb.matches(data, "tui.editor.deleteToLineEnd")) {
			this.deleteToLineEnd();
			return;
		}

		// Kill ring 操作
		if (kb.matches(data, "tui.editor.yank")) {
			this.yank();
			return;
		}
		if (kb.matches(data, "tui.editor.yankPop")) {
			this.yankPop();
			return;
		}

		// 光标移动
		if (kb.matches(data, "tui.editor.cursorLeft")) {
			this.lastAction = null;
			if (this.cursor > 0) {
				const beforeCursor = this.value.slice(0, this.cursor);
				const graphemes = [...segmenter.segment(beforeCursor)];
				const lastGrapheme = graphemes[graphemes.length - 1];
				this.cursor -= lastGrapheme ? lastGrapheme.segment.length : 1;
			}
			return;
		}

		if (kb.matches(data, "tui.editor.cursorRight")) {
			this.lastAction = null;
			if (this.cursor < this.value.length) {
				const afterCursor = this.value.slice(this.cursor);
				const graphemes = [...segmenter.segment(afterCursor)];
				const firstGrapheme = graphemes[0];
				this.cursor += firstGrapheme ? firstGrapheme.segment.length : 1;
			}
			return;
		}

		if (kb.matches(data, "tui.editor.cursorLineStart")) {
			this.lastAction = null;
			this.cursor = 0;
			return;
		}

		if (kb.matches(data, "tui.editor.cursorLineEnd")) {
			this.lastAction = null;
			this.cursor = this.value.length;
			return;
		}

		if (kb.matches(data, "tui.editor.cursorWordLeft")) {
			this.moveWordBackwards();
			return;
		}

		if (kb.matches(data, "tui.editor.cursorWordRight")) {
			this.moveWordForwards();
			return;
		}

		// Kitty CSI-u 可打印字符（例如表示 'a' 的 \x1b[97u）。
		// 启用 Kitty 协议标志 1（disambiguate）的终端会为所有按键发送 CSI-u，
		// 包括普通可打印字符。CSI-u 序列包含会被拒绝的 \x1b，因此需在控制字符检查前解码。
		const kittyPrintable = decodeKittyPrintable(data);
		if (kittyPrintable !== undefined) {
			this.insertCharacter(kittyPrintable);
			return;
		}

		// 普通字符输入：接受包括 Unicode 在内的可打印字符，
		// 但拒绝控制字符（C0：0x00-0x1F，DEL：0x7F，C1：0x80-0x9F）。
		const hasControlChars = [...data].some((ch) => {
			const code = ch.charCodeAt(0);
			return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
		});
		if (!hasControlChars) {
			this.insertCharacter(data);
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "press" || event.button !== "left" || event.y !== 0) return undefined;
		const visibleColumn = Math.max(0, event.x - 2);
		const targetColumn = this.renderedStartColumn + visibleColumn;
		let currentColumn = 0;
		this.cursor = this.value.length;
		for (const grapheme of segmenter.segment(this.value)) {
			const nextColumn = currentColumn + visibleWidth(grapheme.segment);
			if (targetColumn < nextColumn) {
				this.cursor = grapheme.index;
				break;
			}
			currentColumn = nextColumn;
		}
		this.lastAction = null;
		return { handled: true, focus: true };
	}

	private insertCharacter(char: string): void {
		// 撤销合并：连续单词字符合并为一个撤销单元。
		if (isWhitespaceChar(char) || this.lastAction !== "type-word") {
			this.pushUndo();
		}
		this.lastAction = "type-word";

		this.value = this.value.slice(0, this.cursor) + char + this.value.slice(this.cursor);
		this.cursor += char.length;
	}

	private handleBackspace(): void {
		this.lastAction = null;
		if (this.cursor > 0) {
			this.pushUndo();
			const beforeCursor = this.value.slice(0, this.cursor);
			const graphemes = [...segmenter.segment(beforeCursor)];
			const lastGrapheme = graphemes[graphemes.length - 1];
			const graphemeLength = lastGrapheme ? lastGrapheme.segment.length : 1;
			this.value = this.value.slice(0, this.cursor - graphemeLength) + this.value.slice(this.cursor);
			this.cursor -= graphemeLength;
		}
	}

	private handleForwardDelete(): void {
		this.lastAction = null;
		if (this.cursor < this.value.length) {
			this.pushUndo();
			const afterCursor = this.value.slice(this.cursor);
			const graphemes = [...segmenter.segment(afterCursor)];
			const firstGrapheme = graphemes[0];
			const graphemeLength = firstGrapheme ? firstGrapheme.segment.length : 1;
			this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + graphemeLength);
		}
	}

	private deleteToLineStart(): void {
		if (this.cursor === 0) return;
		this.pushUndo();
		const deletedText = this.value.slice(0, this.cursor);
		this.killRing.push(deletedText, { prepend: true, accumulate: this.lastAction === "kill" });
		this.lastAction = "kill";
		this.value = this.value.slice(this.cursor);
		this.cursor = 0;
	}

	private deleteToLineEnd(): void {
		if (this.cursor >= this.value.length) return;
		this.pushUndo();
		const deletedText = this.value.slice(this.cursor);
		this.killRing.push(deletedText, { prepend: false, accumulate: this.lastAction === "kill" });
		this.lastAction = "kill";
		this.value = this.value.slice(0, this.cursor);
	}

	private deleteWordBackwards(): void {
		if (this.cursor === 0) return;

		// 在移动光标前保存 lastAction，因为 moveWordBackwards 会将其重置。
		const wasKill = this.lastAction === "kill";

		this.pushUndo();

		const oldCursor = this.cursor;
		this.moveWordBackwards();
		const deleteFrom = this.cursor;
		this.cursor = oldCursor;

		const deletedText = this.value.slice(deleteFrom, this.cursor);
		this.killRing.push(deletedText, { prepend: true, accumulate: wasKill });
		this.lastAction = "kill";

		this.value = this.value.slice(0, deleteFrom) + this.value.slice(this.cursor);
		this.cursor = deleteFrom;
	}

	private deleteWordForward(): void {
		if (this.cursor >= this.value.length) return;

		// 在移动光标前保存 lastAction，因为 moveWordForwards 会将其重置。
		const wasKill = this.lastAction === "kill";

		this.pushUndo();

		const oldCursor = this.cursor;
		this.moveWordForwards();
		const deleteTo = this.cursor;
		this.cursor = oldCursor;

		const deletedText = this.value.slice(this.cursor, deleteTo);
		this.killRing.push(deletedText, { prepend: false, accumulate: wasKill });
		this.lastAction = "kill";

		this.value = this.value.slice(0, this.cursor) + this.value.slice(deleteTo);
	}

	private yank(): void {
		const text = this.killRing.peek();
		if (!text) return;

		this.pushUndo();

		this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
		this.cursor += text.length;
		this.lastAction = "yank";
	}

	private yankPop(): void {
		if (this.lastAction !== "yank" || this.killRing.length <= 1) return;

		this.pushUndo();

		// 删除此前 yank 的文本；旋转前该文本仍位于 ring 末尾。
		const prevText = this.killRing.peek() || "";
		this.value = this.value.slice(0, this.cursor - prevText.length) + this.value.slice(this.cursor);
		this.cursor -= prevText.length;

		// 旋转并插入新条目。
		this.killRing.rotate();
		const text = this.killRing.peek() || "";
		this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
		this.cursor += text.length;
		this.lastAction = "yank";
	}

	private pushUndo(): void {
		this.undoStack.push({ value: this.value, cursor: this.cursor });
	}

	private undo(): void {
		const snapshot = this.undoStack.pop();
		if (!snapshot) return;
		this.value = snapshot.value;
		this.cursor = snapshot.cursor;
		this.lastAction = null;
	}

	private moveWordBackwards(): void {
		if (this.cursor === 0) return;
		this.lastAction = null;
		this.cursor = findWordBackward(this.value, this.cursor);
	}

	private moveWordForwards(): void {
		if (this.cursor >= this.value.length) return;
		this.lastAction = null;
		this.cursor = findWordForward(this.value, this.cursor);
	}

	private handlePaste(pastedText: string): void {
		this.lastAction = null;
		this.pushUndo();

		// 清理粘贴文本：移除换行符和回车符。
		const cleanText = pastedText.replace(/\r\n/g, "").replace(/\r/g, "").replace(/\n/g, "").replace(/\t/g, "    ");

		// 在光标位置插入。
		this.value = this.value.slice(0, this.cursor) + cleanText + this.value.slice(this.cursor);
		this.cursor += cleanText.length;
	}

	invalidate(): void {
		// 当前没有需要失效的缓存状态。
	}

	render(width: number): string[] {
		// 计算可见窗口。
		const availableWidth = width - visibleWidth(this.prompt);

		if (availableWidth <= 0) {
			return [truncateToWidth(this.prompt, width, "")];
		}

		if (this.value.length === 0 && this.placeholder) {
			const placeholder = truncateToWidth(this.placeholder, availableWidth, "");
			const graphemes = [...segmenter.segment(placeholder)];
			const atCursor = graphemes[0]?.segment ?? " ";
			const afterCursor = placeholder.slice(atCursor.length);
			const marker = this.focused ? CURSOR_MARKER : "";
			const cursorChar = `\x1b[7m${this.placeholderStyle(atCursor)}\x1b[27m`;
			const textWithCursor = marker + cursorChar + this.placeholderStyle(afterCursor);
			const padding = " ".repeat(Math.max(0, availableWidth - visibleWidth(textWithCursor)));
			return [this.prompt + textWithCursor + padding];
		}

		let visibleText = "";
		let cursorDisplay = this.cursor;
		this.renderedStartColumn = 0;
		const totalWidth = visibleWidth(this.value);

		if (totalWidth < availableWidth) {
			// 全部内容均可容纳，并为末尾光标留出空间。
			visibleText = this.value;
		} else {
			// 需要水平滚动。
			// 光标位于末尾时为其保留一列。
			const scrollWidth = this.cursor === this.value.length ? availableWidth - 1 : availableWidth;
			const cursorCol = visibleWidth(this.value.slice(0, this.cursor));

			if (scrollWidth > 0) {
				const halfWidth = Math.floor(scrollWidth / 2);
				let startCol = 0;

				if (cursorCol < halfWidth) {
					// 光标靠近开头。
					startCol = 0;
				} else if (cursorCol > totalWidth - halfWidth) {
					// 光标靠近末尾。
					startCol = Math.max(0, totalWidth - scrollWidth);
				} else {
					// 光标位于中间。
					startCol = Math.max(0, cursorCol - halfWidth);
				}

				this.renderedStartColumn = startCol;
				visibleText = sliceByColumn(this.value, startCol, scrollWidth, true);
				const beforeCursor = sliceByColumn(this.value, startCol, Math.max(0, cursorCol - startCol), true);
				cursorDisplay = beforeCursor.length;
			} else {
				visibleText = "";
				cursorDisplay = 0;
			}
		}

		// 构建带模拟光标的行。
		// 在光标位置插入光标字符。
		const graphemes = [...segmenter.segment(visibleText.slice(cursorDisplay))];
		const cursorGrapheme = graphemes[0];

		const beforeCursor = visibleText.slice(0, cursorDisplay);
		const atCursor = cursorGrapheme?.segment ?? " "; // 光标处的字符，位于末尾时为空格
		const afterCursor = visibleText.slice(cursorDisplay + atCursor.length);

		// 硬件光标标记（零宽，在模拟光标前发出，用于 IME 定位）。
		const marker = this.focused ? CURSOR_MARKER : "";

		// 使用反显显示光标。
		const cursorChar = `\x1b[7m${atCursor}\x1b[27m`; // ESC[7m 表示反显，ESC[27m 表示正常显示
		const textWithCursor = beforeCursor + marker + cursorChar + afterCursor;

		// 计算可视宽度。
		const visualLength = visibleWidth(textWithCursor);
		const padding = " ".repeat(Math.max(0, availableWidth - visualLength));
		const line = this.prompt + textWithCursor + padding;

		return [line];
	}
}
