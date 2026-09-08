import { Editor, type EditorOptions, type EditorTheme, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.ts";
import type { WorkingStatusIndicator } from "./status-indicator.ts";

export type CustomEditorOptions = EditorOptions & {
	/** 在编辑器上边框中渲染流式工作状态。 */
	embedWorkingStatus?: boolean;
};

/**
 * 处理 coding-agent 应用级按键绑定的自定义编辑器。
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	private workingStatusIndicator: WorkingStatusIndicator | undefined;
	public readonly embedWorkingStatus: boolean;
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();

	// 可动态替换的特殊处理程序
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	/** 扩展注册快捷键的处理程序。已处理时返回 true。 */
	public onExtensionShortcut?: (data: string) => boolean;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: CustomEditorOptions) {
		super(tui, theme, options);
		this.keybindings = keybindings;
		this.embedWorkingStatus = options?.embedWorkingStatus ?? false;
	}

	setWorkingStatusIndicator(indicator: WorkingStatusIndicator | undefined): void {
		this.workingStatusIndicator = indicator;
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		if (!this.embedWorkingStatus || !this.workingStatusIndicator || width <= 0) {
			return super.renderTopBorder(width, hiddenLineCount);
		}

		let status = this.workingStatusIndicator.renderInBorder(Math.max(1, width - 5));
		let statusWidth = visibleWidth(status);
		if (statusWidth === 0) return super.renderTopBorder(width, hiddenLineCount);

		const overflowLabel = hiddenLineCount > 0 ? ` ↑ ${hiddenLineCount} more ` : undefined;
		const overflowLabelWidth = overflowLabel ? visibleWidth(overflowLabel) : 0;
		const overflowStart = Math.floor((width - overflowLabelWidth) / 2);
		const canFitOverflow = () =>
			overflowLabel !== undefined && overflowLabelWidth + 2 <= width && overflowStart - (3 + statusWidth + 1) >= 1;

		if (overflowLabel && !canFitOverflow()) {
			status = this.workingStatusIndicator.renderSpinnerInBorder(width);
			statusWidth = visibleWidth(status);
		}

		if (canFitOverflow()) {
			const leftBlockWidth = 3 + statusWidth + 1;
			return (
				this.borderColor("── ") +
				status +
				this.borderColor(
					` ${"─".repeat(overflowStart - leftBlockWidth)}${overflowLabel}${"─".repeat(width - overflowStart - overflowLabelWidth)}`,
				)
			);
		}

		if (width >= statusWidth + 5) {
			return this.borderColor("── ") + status + this.borderColor(` ${"─".repeat(width - statusWidth - 4)}`);
		}

		status = this.workingStatusIndicator.renderSpinnerInBorder(width);
		statusWidth = visibleWidth(status);
		const prefixWidth = Math.min(3, Math.max(0, width - statusWidth));
		return (
			this.borderColor("─".repeat(prefixWidth)) +
			status +
			this.borderColor("─".repeat(Math.max(0, width - prefixWidth - statusWidth)))
		);
	}

	/**
	 * 为应用操作注册处理程序。
	 */
	onAction(action: AppKeybinding, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}

	handleInput(data: string): void {
		// 优先检查扩展注册的快捷键
		if (this.onExtensionShortcut?.(data)) {
			return;
		}

		// 检查剪贴板粘贴按键绑定
		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return;
		}

		// 优先检查应用按键绑定

		// Escape/中断：仅在自动补全未激活时处理
		if (this.keybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				// 如果设置了动态 onEscape 则使用它，否则使用已注册的处理程序
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return;
				}
			}
			// 由父类处理 Escape，以取消自动补全
			super.handleInput(data);
			return;
		}

		// 退出（Ctrl+D）：仅在编辑器为空时处理
		if (this.keybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return;
			}
			// 非空时继续交给编辑器处理向前删除字符
		}

		// 编辑器获得焦点时，显式历史记录绑定优先于应用操作。
		// 即使 Ctrl+P 默认用于循环切换模型，用户仍可将其绑定到历史记录。
		if (
			this.keybindings.matches(data, "tui.editor.historyPrevious") ||
			this.keybindings.matches(data, "tui.editor.historyNext")
		) {
			super.handleInput(data);
			return;
		}

		// 检查其他所有应用操作
		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				handler();
				return;
			}
		}

		// 传递给父类进行编辑器处理
		super.handleInput(data);
	}
}
