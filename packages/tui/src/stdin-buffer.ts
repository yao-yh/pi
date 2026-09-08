/**
 * StdinBuffer 缓冲输入并发出完整序列。
 *
 * stdin 数据事件可能分块到达，鼠标事件等转义序列尤其如此，因此必须进行缓冲。
 * 如果不缓冲，残缺序列可能被误解为普通按键。
 *
 * 例如，鼠标 SGR 序列 `\x1b[<35;20;5m` 可能按以下方式到达：
 * - 事件 1：`\x1b`
 * - 事件 2：`[<35`
 * - 事件 3：`;20;5m`
 *
 * 缓冲区会持续累积，直到检测到完整序列。
 * 调用 `process()` 方法输入数据。
 *
 * 基于 OpenTUI（https://github.com/anomalyco/opentui）的代码。
 * MIT 许可证 - Copyright (c) 2025 opentui
 */

import { EventEmitter } from "events";

const ESC = "\x1b";
const DEFAULT_SEQUENCE_TIMEOUT_MS = 50;
const DEFAULT_ESCAPE_TIMEOUT_MS = 10;
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

/**
 * 检查字符串是完整转义序列，还是仍需更多数据。
 */
function isCompleteSequence(data: string): "complete" | "incomplete" | "not-escape" {
	if (!data.startsWith(ESC)) {
		return "not-escape";
	}

	if (data.length === 1) {
		return "incomplete";
	}

	const afterEsc = data.slice(1);

	// CSI 序列：ESC [
	if (afterEsc.startsWith("[")) {
		// 检查旧式鼠标序列：ESC[M + 3 字节。
		if (afterEsc.startsWith("[M")) {
			// 旧式鼠标序列需要 ESC[M + 3 字节，共 6 字节。
			return data.length >= 6 ? "complete" : "incomplete";
		}
		return isCompleteCsiSequence(data);
	}

	// OSC 序列：ESC ]
	if (afterEsc.startsWith("]")) {
		return isCompleteOscSequence(data);
	}

	// DCS 序列：ESC P ... ESC \（包括 XTVersion 响应）。
	if (afterEsc.startsWith("P")) {
		return isCompleteDcsSequence(data);
	}

	// APC 序列：ESC _ ... ESC \（包括 Kitty 图形响应）。
	if (afterEsc.startsWith("_")) {
		return isCompleteApcSequence(data);
	}

	// SS3 序列：ESC O
	if (afterEsc.startsWith("O")) {
		// ESC O 后跟单个字符。
		return afterEsc.length >= 2 ? "complete" : "incomplete";
	}

	// Meta 键序列：ESC 后跟单个字符。
	if (afterEsc.length === 1) {
		return "complete";
	}

	// 未知转义序列按完整序列处理。
	return "complete";
}

/**
 * 检查 CSI 序列是否完整。
 * CSI 序列：ESC [ ... 后跟结束字节（0x40-0x7E）。
 */
function isCompleteCsiSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}[`)) {
		return "complete";
	}

	// 至少需要 ESC [ 和另一个字符。
	if (data.length < 3) {
		return "incomplete";
	}

	const payload = data.slice(2);

	// CSI 序列以 0x40-0x7E（@-~）范围内的字节结尾，
	// 其中包括所有字母和若干特殊字符。
	const lastChar = payload[payload.length - 1];
	const lastCharCode = lastChar.charCodeAt(0);

	if (lastCharCode >= 0x40 && lastCharCode <= 0x7e) {
		// 对 SGR 鼠标序列进行特殊处理。
		// 格式：ESC[<B;X;Ym 或 ESC[<B;X;YM。
		if (payload.startsWith("<")) {
			// 必须采用格式：<数字;数字;数字[Mm]。
			const mouseMatch = /^<\d+;\d+;\d+[Mm]$/.test(payload);
			if (mouseMatch) {
				return "complete";
			}
			// 如果以 M 或 m 结尾但不匹配该模式，仍视为不完整。
			if (lastChar === "M" || lastChar === "m") {
				// 检查结构是否正确。
				const parts = payload.slice(1, -1).split(";");
				if (parts.length === 3 && parts.every((p) => /^\d+$/.test(p))) {
					return "complete";
				}
			}

			return "incomplete";
		}

		return "complete";
	}

	return "incomplete";
}

/**
 * 检查 OSC 序列是否完整。
 * OSC 序列：ESC ] ... ST（其中 ST 为 ESC \ 或 BEL）。
 */
function isCompleteOscSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}]`)) {
		return "complete";
	}

	// OSC 序列以 ST（ESC \）或 BEL（\x07）结尾。
	if (data.endsWith(`${ESC}\\`) || data.endsWith("\x07")) {
		return "complete";
	}

	return "incomplete";
}

/**
 * 检查 DCS（设备控制字符串）序列是否完整。
 * DCS 序列：ESC P ... ST（其中 ST 为 ESC \）。
 * 用于 ESC P >| ... ESC \ 等 XTVersion 响应。
 */
function isCompleteDcsSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}P`)) {
		return "complete";
	}

	// DCS 序列以 ST（ESC \）结尾。
	if (data.endsWith(`${ESC}\\`)) {
		return "complete";
	}

	return "incomplete";
}

/**
 * 检查 APC（应用程序命令）序列是否完整。
 * APC 序列：ESC _ ... ST（其中 ST 为 ESC \）。
 * 用于 ESC _ G ... ESC \ 等 Kitty 图形响应。
 */
function isCompleteApcSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}_`)) {
		return "complete";
	}

	// APC 序列以 ST（ESC \）结尾。
	if (data.endsWith(`${ESC}\\`)) {
		return "complete";
	}

	return "incomplete";
}

/**
 * 将累积的缓冲区拆分为完整序列。
 */
function parseUnmodifiedKittyPrintableCodepoint(sequence: string): number | undefined {
	const match = sequence.match(/^\x1b\[(\d+)(?::\d*)?(?::\d+)?u$/);
	if (!match) return undefined;

	const codepoint = parseInt(match[1]!, 10);
	return codepoint >= 32 ? codepoint : undefined;
}

function extractCompleteSequences(buffer: string): { sequences: string[]; remainder: string } {
	const sequences: string[] = [];
	let pos = 0;

	while (pos < buffer.length) {
		const remaining = buffer.slice(pos);

		// 尝试提取从当前位置开始的序列。
		if (remaining.startsWith(ESC)) {
			// 查找当前转义序列的末尾。
			let seqEnd = 1;
			while (seqEnd <= remaining.length) {
				const candidate = remaining.slice(0, seqEnd);
				const status = isCompleteSequence(candidate);

				if (status === "complete") {
					// 启用 enable_kitty_keyboard 的 WezTerm 会将 Escape 按下事件作为原始 '\x1b' 字节发送
					//（encode_kitty 中忽略 DISAMBIGUATE_ESCAPE_CODES 的简单文本路径），
					// 并将释放事件作为完整 Kitty CSI-u 序列发送。两者会连接为 '\x1b\x1b[27;...u' 到达。
					// 缓冲区通常会把 '\x1b\x1b' 当作完整 Meta 键序列（ESC + 单字符），
					// 导致余下的 '[27;...u' 被作为普通文本输入。如果紧跟 '\x1b\x1b' 的字符会开始新转义序列，
					// 则只发出第一个 ESC，并从第二个 ESC 重新开始。
					if (candidate === "\x1b\x1b") {
						const nextChar = remaining[seqEnd];
						if (
							nextChar === "[" || // CSI 序列
							nextChar === "]" || // OSC 序列
							nextChar === "O" || // SS3 序列
							nextChar === "P" || // DCS 序列
							nextChar === "_" // APC 序列
						) {
							sequences.push(ESC);
							pos += 1;
							break;
						}
					}
					sequences.push(candidate);
					pos += seqEnd;
					break;
				} else if (status === "incomplete") {
					seqEnd++;
				} else {
					// 以 ESC 开头时不应发生。
					sequences.push(candidate);
					pos += seqEnd;
					break;
				}
			}

			if (seqEnd > remaining.length) {
				return { sequences, remainder: remaining };
			}
		} else {
			// 不是转义序列，读取单个字符。
			sequences.push(remaining[0]!);
			pos++;
		}
	}

	return { sequences, remainder: "" };
}

export type StdinBufferOptions = {
	/**
	 * 等待 CSI 或鼠标序列等不完整序列的最长时间（默认：50ms）。
	 */
	timeout?: number;
	/**
	 * 收到单独 ESC 后，将其视为 Escape 前的最长等待时间（默认：10ms）。
	 * 对高延迟 Alt+键输入（SSH）可增大该值。
	 */
	escapeTimeout?: number;
};

export type StdinBufferEventMap = {
	data: [string];
	paste: [string];
};

/**
 * 缓冲 stdin 输入，并通过 'data' 事件发出完整序列。
 * 处理跨多个数据块到达的残缺转义序列。
 */
export class StdinBuffer extends EventEmitter<StdinBufferEventMap> {
	private buffer: string = "";
	private timeout: ReturnType<typeof setTimeout> | null = null;
	private readonly timeoutMs: number;
	private readonly escapeTimeoutMs: number;
	private pasteMode: boolean = false;
	private pasteBuffer: string = "";
	private pendingKittyPrintableCodepoint: number | undefined;

	constructor(options: StdinBufferOptions = {}) {
		super();
		this.timeoutMs = options.timeout ?? DEFAULT_SEQUENCE_TIMEOUT_MS;
		this.escapeTimeoutMs = options.escapeTimeout ?? DEFAULT_ESCAPE_TIMEOUT_MS;
	}

	public process(data: string | Buffer): void {
		// 清除待处理的超时。
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = null;
		}

		// 处理高位字节转换，以兼容 parseKeypress。
		// 如果缓冲区只有一个大于 127 的字节，则转换为 ESC +（字节 - 128）。
		let str: string;
		if (Buffer.isBuffer(data)) {
			if (data.length === 1 && data[0]! > 127) {
				const byte = data[0]! - 128;
				str = `\x1b${String.fromCharCode(byte)}`;
			} else {
				str = data.toString();
			}
		} else {
			str = data;
		}

		if (str.length === 0 && this.buffer.length === 0) {
			this.emitDataSequence("");
			return;
		}

		this.buffer += str;

		if (this.pasteMode) {
			this.pasteBuffer += this.buffer;
			this.buffer = "";

			const endIndex = this.pasteBuffer.indexOf(BRACKETED_PASTE_END);
			if (endIndex !== -1) {
				const pastedContent = this.pasteBuffer.slice(0, endIndex);
				const remaining = this.pasteBuffer.slice(endIndex + BRACKETED_PASTE_END.length);

				this.pasteMode = false;
				this.pasteBuffer = "";
				this.pendingKittyPrintableCodepoint = undefined;

				this.emit("paste", pastedContent);

				if (remaining.length > 0) {
					this.process(remaining);
				}
			}
			return;
		}

		const startIndex = this.buffer.indexOf(BRACKETED_PASTE_START);
		if (startIndex !== -1) {
			if (startIndex > 0) {
				const beforePaste = this.buffer.slice(0, startIndex);
				const result = extractCompleteSequences(beforePaste);
				for (const sequence of result.sequences) {
					this.emitDataSequence(sequence);
				}
			}

			this.pendingKittyPrintableCodepoint = undefined;
			this.buffer = this.buffer.slice(startIndex + BRACKETED_PASTE_START.length);
			this.pasteMode = true;
			this.pasteBuffer = this.buffer;
			this.buffer = "";

			const endIndex = this.pasteBuffer.indexOf(BRACKETED_PASTE_END);
			if (endIndex !== -1) {
				const pastedContent = this.pasteBuffer.slice(0, endIndex);
				const remaining = this.pasteBuffer.slice(endIndex + BRACKETED_PASTE_END.length);

				this.pasteMode = false;
				this.pasteBuffer = "";
				this.pendingKittyPrintableCodepoint = undefined;

				this.emit("paste", pastedContent);

				if (remaining.length > 0) {
					this.process(remaining);
				}
			}
			return;
		}

		const result = extractCompleteSequences(this.buffer);
		this.buffer = result.remainder;

		for (const sequence of result.sequences) {
			this.emitDataSequence(sequence);
		}

		if (this.buffer.length > 0) {
			const timeoutMs = this.buffer === ESC ? this.escapeTimeoutMs : this.timeoutMs;
			this.timeout = setTimeout(() => {
				const flushed = this.flush();

				for (const sequence of flushed) {
					this.emitDataSequence(sequence);
				}
			}, timeoutMs);
		}
	}

	private emitDataSequence(sequence: string): void {
		const rawCodepoint = sequence.length === 1 ? sequence.codePointAt(0) : undefined;
		if (rawCodepoint !== undefined && rawCodepoint === this.pendingKittyPrintableCodepoint) {
			this.pendingKittyPrintableCodepoint = undefined;
			return;
		}

		this.pendingKittyPrintableCodepoint = parseUnmodifiedKittyPrintableCodepoint(sequence);
		this.emit("data", sequence);
	}

	flush(): string[] {
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = null;
		}

		if (this.buffer.length === 0) {
			return [];
		}

		const sequences = [this.buffer];
		this.buffer = "";
		this.pendingKittyPrintableCodepoint = undefined;
		return sequences;
	}

	clear(): void {
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = null;
		}
		this.buffer = "";
		this.pasteMode = false;
		this.pasteBuffer = "";
		this.pendingKittyPrintableCodepoint = undefined;
	}

	getBuffer(): string {
		return this.buffer;
	}

	destroy(): void {
		this.clear();
	}
}
