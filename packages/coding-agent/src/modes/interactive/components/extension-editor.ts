/**
 * 供扩展使用的多行编辑器组件。
 * 支持通过 Ctrl+G 打开外部编辑器。
 */

import {
	Container,
	Editor,
	type EditorOptions,
	type Focusable,
	getKeybindings,
	Spacer,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import { editInExternalEditor } from "../external-editor.ts";
import { getEditorTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";

export class ExtensionEditorComponent extends Container implements Focusable {
	private editor: Editor;
	private onSubmitCallback: (value: string) => void;
	private onCancelCallback: () => void;
	private tui: TUI;
	private keybindings: KeybindingsManager;
	private externalEditorCommand: string;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value;
	}

	constructor(
		tui: TUI,
		keybindings: KeybindingsManager,
		title: string,
		prefill: string | undefined,
		onSubmit: (value: string) => void,
		onCancel: () => void,
		options?: EditorOptions,
		externalEditorCommand?: string,
	) {
		super();

		this.tui = tui;
		this.keybindings = keybindings;
		this.externalEditorCommand =
			externalEditorCommand ||
			process.env.VISUAL ||
			process.env.EDITOR ||
			(process.platform === "win32" ? "notepad" : "nano");
		this.onSubmitCallback = onSubmit;
		this.onCancelCallback = onCancel;

		// 添加上边框
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// 添加标题
		this.addChild(new Text(theme.fg("accent", title), 1, 0));
		this.addChild(new Spacer(1));

		// 创建编辑器
		this.editor = new Editor(tui, getEditorTheme(), options);
		if (prefill) {
			this.editor.setText(prefill);
		}
		// 绑定 Enter 提交（Shift+Enter 换行，与主编辑器一致）
		this.editor.onSubmit = (text: string) => {
			this.onSubmitCallback(text);
		};
		this.addChild(this.editor);

		this.addChild(new Spacer(1));

		// 添加提示
		const hint =
			keyHint("tui.select.confirm", "submit") +
			"  " +
			keyHint("tui.input.newLine", "newline") +
			"  " +
			keyHint("tui.select.cancel", "cancel") +
			`  ${keyHint("app.editor.external", "external editor")}`;
		this.addChild(new Text(hint, 1, 0));

		this.addChild(new Spacer(1));

		// 添加下边框
		this.addChild(new DynamicBorder());
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		// 按 Escape 或 Ctrl+C 取消
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
			return;
		}

		// 外部编辑器（应用按键绑定）
		if (this.keybindings.matches(keyData, "app.editor.external")) {
			void this.handleOpenExternalEditor();
			return;
		}

		// 转发给编辑器
		this.editor.handleInput(keyData);
	}

	private async handleOpenExternalEditor(): Promise<void> {
		const content = this.editor.getText();
		this.tui.stop();
		try {
			const result = await editInExternalEditor({
				command: this.externalEditorCommand,
				content,
			});
			if (result.status === "complete") {
				this.editor.setText(result.content);
			}
		} finally {
			this.tui.start();
			this.tui.requestRender(true);
		}
	}
}
