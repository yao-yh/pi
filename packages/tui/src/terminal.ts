import * as fs from "node:fs";
import * as path from "node:path";
import { setKittyProtocolActive } from "./keys.ts";
import { isNativeModifierPressed } from "./native-modifiers.ts";
import { getNativePlatformHelper } from "./native-platform.ts";
import { StdinBuffer } from "./stdin-buffer.ts";

const TERMINAL_PROGRESS_KEEPALIVE_MS = 1000;
const TERMINAL_PROGRESS_ACTIVE_SEQUENCE = "\x1b]9;4;3\x07";
const TERMINAL_PROGRESS_CLEAR_SEQUENCE = "\x1b]9;4;0\x07";
const NATIVE_SHIFT_ENTER_SEQUENCE = "\x1b[13;2u";
const DESIRED_KITTY_KEYBOARD_PROTOCOL_FLAGS = 7;
const KEYBOARD_PROTOCOL_RESPONSE_FRAGMENT_TIMEOUT_MS = 150;
const KITTY_KEYBOARD_PROTOCOL_QUERY = `\x1b[>${DESIRED_KITTY_KEYBOARD_PROTOCOL_FLAGS}u\x1b[?u\x1b[c`;

export type KeyboardProtocolNegotiationSequence =
	| { type: "kitty-flags"; flags: number }
	| { type: "device-attributes" };

export function parseKeyboardProtocolNegotiationSequence(
	sequence: string,
): KeyboardProtocolNegotiationSequence | undefined {
	const kittyFlags = sequence.match(/^\x1b\[\?(\d+)u$/);
	if (kittyFlags) {
		return { type: "kitty-flags", flags: Number.parseInt(kittyFlags[1]!, 10) };
	}
	if (/^\x1b\[\?[\d;]*c$/.test(sequence)) {
		return { type: "device-attributes" };
	}
	return undefined;
}

function isKeyboardProtocolNegotiationSequencePrefix(sequence: string): boolean {
	return sequence === "\x1b[" || /^\x1b\[\?[\d;]*$/.test(sequence);
}

export function isAppleTerminalSession(): boolean {
	return process.platform === "darwin" && process.env.TERM_PROGRAM === "Apple_Terminal";
}

/**
 * 在 POSIX 平台上向当前进程发送 SIGWINCH，以刷新终端尺寸。
 * 此操作尽力而为：某些环境（受限的 seccomp 或 LSM 策略）会让 `kill(2)` 返回 EACCES；
 * 此时跳过尺寸刷新，而不是导致崩溃。
 */
export function refreshTerminalDimensions(): void {
	if (process.platform === "win32" || process.pid <= 0) return;
	try {
		process.kill(process.pid, "SIGWINCH");
	} catch {
		// 当前环境不允许发送信号，忽略即可。
	}
}

export function normalizeNativeShiftEnterInput(
	data: string,
	shouldDetectNativeShiftEnter: boolean,
	isShiftPressed: boolean,
): string {
	if (shouldDetectNativeShiftEnter && data === "\r" && isShiftPressed) return NATIVE_SHIFT_ENTER_SEQUENCE;
	return data;
}

export function normalizeAppleTerminalInput(data: string, isAppleTerminal: boolean, isShiftPressed: boolean): string {
	return normalizeNativeShiftEnterInput(data, isAppleTerminal, isShiftPressed);
}

/**
 * TUI 使用的最小终端接口。
 */
export interface Terminal {
	// 启动终端并安装输入和尺寸变化处理器。
	start(onInput: (data: string) => void, onResize: () => void): void;

	// 停止终端并恢复状态。
	stop(): void;

	/**
	 * 退出前排空 stdin，防止 Kitty 按键释放事件在缓慢的 SSH 连接中泄漏到父 shell。
	 * @param maxMs - 最长排空时间（默认：1000ms）
	 * @param idleMs - 此时间内没有输入时提前退出（默认：50ms）
	 */
	drainInput(maxMs?: number, idleMs?: number): Promise<void>;

	// 向终端写入输出。
	write(data: string): void;

	// 获取终端尺寸。
	get columns(): number;
	get rows(): number;

	// Kitty 键盘协议是否处于活动状态。
	get kittyProtocolActive(): boolean;

	// 光标定位（相对于当前位置）。
	moveBy(lines: number): void; // 将光标向上（负数）或向下（正数）移动 N 行

	// 光标可见性
	hideCursor(): void; // 隐藏光标
	showCursor(): void; // 显示光标

	// 清除操作
	clearLine(): void; // 清除当前行
	clearFromCursor(): void; // 从光标位置清除到屏幕末尾
	clearScreen(): void; // 清除整个屏幕并将光标移到 (0,0)

	// 标题操作
	setTitle(title: string): void; // 设置终端窗口标题

	// 进度指示器（OSC 9;4）
	setProgress(active: boolean): void;
}

const DEFAULT_ESCAPE_TIMEOUT_MS = 10;
const DEFAULT_SSH_ESCAPE_TIMEOUT_MS = 100;

/**
 * 确定等待转义序列剩余部分的时长，超时后将单独的 ESC 分派为 Escape 键。
 * 传统 Alt+键输入由 ESC 加另一个字节组成，因此高延迟传输需要更长的重组窗口。
 */
export function resolveEscapeTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const configured = Number(env.PI_TUI_ESC_TIMEOUT);
	if (Number.isFinite(configured) && configured > 0) {
		return configured;
	}
	if (env.SSH_CONNECTION || env.SSH_TTY) {
		return DEFAULT_SSH_ESCAPE_TIMEOUT_MS;
	}
	return DEFAULT_ESCAPE_TIMEOUT_MS;
}

/**
 * 使用 process.stdin/stdout 的真实终端。
 */
export class ProcessTerminal implements Terminal {
	private wasRaw = false;
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;
	private _kittyProtocolActive = false;
	private _modifyOtherKeysActive = false;
	private keyboardProtocolPushed = false;
	private keyboardProtocolNegotiationBuffer = "";
	private keyboardProtocolBufferFlushTimer?: ReturnType<typeof setTimeout>;
	private stdinBuffer?: StdinBuffer;
	private stdinDataHandler?: (data: string) => void;
	private progressInterval?: ReturnType<typeof setInterval>;
	private writeLogPath = (() => {
		const env = process.env.PI_TUI_WRITE_LOG || "";
		if (!env) return "";
		try {
			if (fs.statSync(env).isDirectory()) {
				const now = new Date();
				const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}-${String(now.getSeconds()).padStart(2, "0")}`;
				return path.join(env, `tui-${ts}-${process.pid}.log`);
			}
		} catch {
			// 不是现有目录，按原样作为文件路径使用。
		}
		return env;
	})();

	get kittyProtocolActive(): boolean {
		return this._kittyProtocolActive;
	}

	get modifyOtherKeysActive(): boolean {
		return this._modifyOtherKeysActive;
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;

		// 保存先前状态并启用原始模式。
		this.wasRaw = process.stdin.isRaw || false;
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(true);
		}
		process.stdin.setEncoding("utf8");
		process.stdin.resume();

		// 启用括号粘贴模式，终端会用 \x1b[200~ ... \x1b[201~ 包裹粘贴内容。
		process.stdout.write("\x1b[?2004h");

		// 立即安装尺寸变化处理器。
		process.stdout.on("resize", this.resizeHandler);

		// 刷新终端尺寸；挂起并恢复后尺寸可能已经过期（进程停止时会丢失 SIGWINCH）。
		// 仅适用于 Unix，并尽力执行。
		refreshTerminalDimensions();

		// 在 Windows 上启用 ENABLE_VIRTUAL_TERMINAL_INPUT，使控制台发送 VT 转义序列
		//（例如 Shift+Tab 对应的 \x1b[Z），而非丢失修饰键信息的原始控制台事件。
		// 必须在 setRawMode(true) 之后执行，因为该调用会重置控制台模式标志。
		this.enableWindowsVTInput();

		// 查询 Kitty 键盘协议；如果 DA 确认没有 Kitty 响应，则回退到 modifyOtherKeys。
		// 参见：https://sw.kovidgoyal.net/kitty/keyboard-protocol/
		this.queryAndEnableKittyProtocol();
	}

	/**
	 * 设置 StdinBuffer，将批量输入拆分为独立序列。
	 * 这样可确保组件接收单个事件，使 matchesKey/isKeyRelease 正常工作。
	 *
	 * 同时监听 Kitty 协议响应，并在检测到响应时启用该协议。
	 * 此操作在 stdinBuffer 解析后执行，而不是直接处理原始 stdin，
	 * 以支持响应被拆分到多个事件中的情况。
	 */
	private setupStdinBuffer(): void {
		this.stdinBuffer = new StdinBuffer({ escapeTimeout: resolveEscapeTimeoutMs() });

		// 将独立序列转发给输入处理器。
		this.stdinBuffer.on("data", (sequence) => {
			const negotiationSequence = this.readKeyboardProtocolNegotiationSequence(sequence);
			if (negotiationSequence === "pending") {
				this.scheduleKeyboardProtocolNegotiationBufferFlush();
				return; // 短暂等待已拆分 Kitty 响应的剩余部分。
			}
			if (this.handleKeyboardProtocolNegotiationSequence(negotiationSequence)) {
				return;
			}

			this.forwardInputSequence(sequence);
		});

		// 重新用括号粘贴标记包裹粘贴内容，以供现有编辑器处理。
		this.stdinBuffer.on("paste", (content) => {
			if (this.inputHandler) {
				this.inputHandler(`\x1b[200~${content}\x1b[201~`);
			}
		});

		// 通过缓冲区传递 stdin 数据的处理器。
		this.stdinDataHandler = (data: string) => {
			this.stdinBuffer!.process(data);
		};
	}

	/**
	 * 查询终端是否支持 Kitty 键盘协议，并在可用时启用。
	 *
	 * Kitty 的渐进增强检测要求先请求所需标志，再查询标志。末尾的 DA 查询是一个哨兵，
	 * 不识别 Kitty 键盘协议的终端也支持它；在 Kitty 响应前收到 DA，
	 * 即可启用 modifyOtherKeys 回退，而无需等待启动超时。
	 *
	 * 请求的标志如下：
	 * - 1 = 区分转义码
	 * - 2 = 报告事件类型（按下/重复/释放）
	 * - 4 = 报告替代按键（移位后的键、基础布局键）
	 */
	private queryAndEnableKittyProtocol(): void {
		this.setupStdinBuffer();
		process.stdin.on("data", this.stdinDataHandler!);
		this.keyboardProtocolPushed = true;
		this.clearKeyboardProtocolNegotiationBuffer();
		process.stdout.write(KITTY_KEYBOARD_PROTOCOL_QUERY);
	}

	private handleKeyboardProtocolNegotiationSequence(
		negotiationSequence: KeyboardProtocolNegotiationSequence | undefined,
	): boolean {
		if (!negotiationSequence) return false;
		this.clearKeyboardProtocolNegotiationBuffer();
		if (negotiationSequence.type === "kitty-flags") {
			if (negotiationSequence.flags !== 0) {
				this.disableModifyOtherKeys();
				if (!this._kittyProtocolActive) {
					this._kittyProtocolActive = true;
					setKittyProtocolActive(true);
				}
			} else {
				this.enableModifyOtherKeys();
			}
			return true;
		}

		if (!this._kittyProtocolActive) {
			this.enableModifyOtherKeys();
		}
		return true;
	}

	private readKeyboardProtocolNegotiationSequence(
		sequence: string,
	): KeyboardProtocolNegotiationSequence | "pending" | undefined {
		if (this.keyboardProtocolNegotiationBuffer) {
			const bufferedSequence = this.keyboardProtocolNegotiationBuffer + sequence;
			const negotiationSequence = parseKeyboardProtocolNegotiationSequence(bufferedSequence);
			if (negotiationSequence) {
				this.clearKeyboardProtocolNegotiationBuffer();
				return negotiationSequence;
			}
			if (isKeyboardProtocolNegotiationSequencePrefix(bufferedSequence)) {
				this.setKeyboardProtocolNegotiationBuffer(bufferedSequence);
				return "pending";
			}
			this.flushKeyboardProtocolNegotiationBufferAsInput();
		}

		const negotiationSequence = parseKeyboardProtocolNegotiationSequence(sequence);
		if (negotiationSequence) return negotiationSequence;
		if (isKeyboardProtocolNegotiationSequencePrefix(sequence)) {
			this.setKeyboardProtocolNegotiationBuffer(sequence);
			return "pending";
		}
		return undefined;
	}

	private setKeyboardProtocolNegotiationBuffer(sequence: string): void {
		this.clearKeyboardProtocolNegotiationBufferFlushTimer();
		this.keyboardProtocolNegotiationBuffer = sequence;
	}

	private clearKeyboardProtocolNegotiationBuffer(): void {
		this.clearKeyboardProtocolNegotiationBufferFlushTimer();
		this.keyboardProtocolNegotiationBuffer = "";
	}

	private flushKeyboardProtocolNegotiationBufferAsInput(): void {
		if (!this.keyboardProtocolNegotiationBuffer) return;
		const sequence = this.keyboardProtocolNegotiationBuffer;
		this.clearKeyboardProtocolNegotiationBuffer();
		this.forwardInputSequence(sequence);
	}

	private scheduleKeyboardProtocolNegotiationBufferFlush(): void {
		if (!this.keyboardProtocolNegotiationBuffer || this.keyboardProtocolBufferFlushTimer) return;
		this.keyboardProtocolBufferFlushTimer = setTimeout(() => {
			this.keyboardProtocolBufferFlushTimer = undefined;
			this.flushKeyboardProtocolNegotiationBufferAsInput();
		}, KEYBOARD_PROTOCOL_RESPONSE_FRAGMENT_TIMEOUT_MS);
	}

	private clearKeyboardProtocolNegotiationBufferFlushTimer(): void {
		if (!this.keyboardProtocolBufferFlushTimer) return;
		clearTimeout(this.keyboardProtocolBufferFlushTimer);
		this.keyboardProtocolBufferFlushTimer = undefined;
	}

	private forwardInputSequence(sequence: string): void {
		if (!this.inputHandler) return;
		const shouldDetectNativeShiftEnter =
			sequence === "\r" && (isAppleTerminalSession() || process.platform === "win32");
		const input = normalizeNativeShiftEnterInput(
			sequence,
			shouldDetectNativeShiftEnter,
			shouldDetectNativeShiftEnter && isNativeModifierPressed("shift"),
		);
		this.inputHandler(input);
	}

	private enableModifyOtherKeys(): void {
		if (this._kittyProtocolActive || this._modifyOtherKeysActive) return;
		process.stdout.write("\x1b[>4;2m");
		this._modifyOtherKeysActive = true;
	}

	private disableModifyOtherKeys(): void {
		if (!this._modifyOtherKeysActive) return;
		process.stdout.write("\x1b[>4;0m");
		this._modifyOtherKeysActive = false;
	}

	/**
	 * 在 Windows 上向 stdin 控制台句柄添加 ENABLE_VIRTUAL_TERMINAL_INPUT（0x0200），
	 * 使终端为带修饰键的按键发送 VT 序列（例如 Shift+Tab 对应的 \x1b[Z）。
	 * 否则 libuv 的 ReadConsoleInputW 会丢弃修饰键状态，Shift+Tab 将作为普通 \t 到达。
	 */
	private enableWindowsVTInput(): void {
		if (process.platform !== "win32") return;
		try {
			getNativePlatformHelper()?.enableVirtualTerminalInput?.();
		} catch {
			// 原生辅助程序不可用，Shift+Tab 将无法与 Tab 区分。
		}
	}

	async drainInput(maxMs = 1000, idleMs = 50): Promise<void> {
		const shouldDisableKittyProtocol = this.keyboardProtocolPushed || this._kittyProtocolActive;
		this.clearKeyboardProtocolNegotiationBuffer();
		if (shouldDisableKittyProtocol) {
			// 先禁用 Kitty 键盘协议，防止延迟到达的按键释放事件生成新的 Kitty 转义序列。
			process.stdout.write("\x1b[<u");
			this.keyboardProtocolPushed = false;
			this._kittyProtocolActive = false;
			setKittyProtocolActive(false);
		}
		this.disableModifyOtherKeys();

		const previousHandler = this.inputHandler;
		this.inputHandler = undefined;

		let lastDataTime = Date.now();
		const onData = () => {
			lastDataTime = Date.now();
		};

		process.stdin.on("data", onData);
		const endTime = Date.now() + maxMs;

		try {
			while (true) {
				const now = Date.now();
				const timeLeft = endTime - now;
				if (timeLeft <= 0) break;
				if (now - lastDataTime >= idleMs) break;
				await new Promise((resolve) => setTimeout(resolve, Math.min(idleMs, timeLeft)));
			}
		} finally {
			process.stdin.removeListener("data", onData);
			this.inputHandler = previousHandler;
		}
	}

	stop(): void {
		if (this.clearProgressInterval()) {
			process.stdout.write(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
		}

		// 禁用括号粘贴模式。
		process.stdout.write("\x1b[?2004l");

		const shouldDisableKittyProtocol = this.keyboardProtocolPushed || this._kittyProtocolActive;
		this.clearKeyboardProtocolNegotiationBuffer();

		// 如果 drainInput() 尚未禁用 Kitty 键盘协议，则在此禁用。
		if (shouldDisableKittyProtocol) {
			process.stdout.write("\x1b[<u");
			this.keyboardProtocolPushed = false;
			this._kittyProtocolActive = false;
			setKittyProtocolActive(false);
		}
		this.disableModifyOtherKeys();

		// 清理 StdinBuffer。
		if (this.stdinBuffer) {
			this.stdinBuffer.destroy();
			this.stdinBuffer = undefined;
		}

		// 移除事件处理器。
		if (this.stdinDataHandler) {
			process.stdin.removeListener("data", this.stdinDataHandler);
			this.stdinDataHandler = undefined;
		}
		this.inputHandler = undefined;
		if (this.resizeHandler) {
			process.stdout.removeListener("resize", this.resizeHandler);
			this.resizeHandler = undefined;
		}

		// 暂停 stdin，防止原始模式禁用后重新解释缓冲输入（例如 Ctrl+D）。
		// 这可修复 Ctrl+D 可能通过 SSH 关闭父 shell 的竞态条件。
		process.stdin.pause();

		// 恢复原始模式状态。
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(this.wasRaw);
		}
	}

	write(data: string): void {
		process.stdout.write(data);
		if (this.writeLogPath) {
			try {
				fs.appendFileSync(this.writeLogPath, data, { encoding: "utf8" });
			} catch {
				// 忽略日志记录错误。
			}
		}
	}

	get columns(): number {
		return process.stdout.columns || Number(process.env.COLUMNS) || 80;
	}

	get rows(): number {
		return process.stdout.rows || Number(process.env.LINES) || 24;
	}

	moveBy(lines: number): void {
		if (lines > 0) {
			// 向下移动。
			process.stdout.write(`\x1b[${lines}B`);
		} else if (lines < 0) {
			// 向上移动。
			process.stdout.write(`\x1b[${-lines}A`);
		}
		// lines === 0：不移动。
	}

	hideCursor(): void {
		process.stdout.write("\x1b[?25l");
	}

	showCursor(): void {
		process.stdout.write("\x1b[?25h");
	}

	clearLine(): void {
		process.stdout.write("\x1b[K");
	}

	clearFromCursor(): void {
		process.stdout.write("\x1b[J");
	}

	clearScreen(): void {
		process.stdout.write("\x1b[2J\x1b[H"); // 清除屏幕并移动到起始位置 (1,1)
	}

	setTitle(title: string): void {
		// OSC 0;title BEL：设置终端窗口标题。
		process.stdout.write(`\x1b]0;${title}\x07`);
	}

	setProgress(active: boolean): void {
		if (active) {
			// OSC 9;4;3：不确定进度。
			process.stdout.write(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);
			if (!this.progressInterval) {
				this.progressInterval = setInterval(() => {
					process.stdout.write(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);
				}, TERMINAL_PROGRESS_KEEPALIVE_MS);
			}
		} else {
			this.clearProgressInterval();
			// OSC 9;4;0：清除进度。
			process.stdout.write(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
		}
	}

	private clearProgressInterval(): boolean {
		if (!this.progressInterval) return false;
		clearInterval(this.progressInterval);
		this.progressInterval = undefined;
		return true;
	}
}
