/**
 * 用于 Emacs 风格 kill/yank 操作的环形缓冲区。
 *
 * 跟踪被 kill（删除）的文本条目。连续 kill 可以累积到同一个条目中。
 * 支持 yank（粘贴最近条目）和 yank-pop（循环选择更早的条目）。
 */
export class KillRing {
	private ring: string[] = [];

	/**
	 * 向 kill ring 添加文本。
	 *
	 * @param text - 要添加的已删除文本
	 * @param opts - 入栈选项
	 * @param opts.prepend - 累积时，前置（向后删除）还是追加（向前删除）
	 * @param opts.accumulate - 与最近条目合并，而非创建新条目
	 */
	push(text: string, opts: { prepend: boolean; accumulate?: boolean }): void {
		if (!text) return;

		if (opts.accumulate && this.ring.length > 0) {
			const last = this.ring.pop()!;
			this.ring.push(opts.prepend ? text + last : last + text);
		} else {
			this.ring.push(text);
		}
	}

	/** 获取最近条目，但不修改环形缓冲区。 */
	peek(): string | undefined {
		return this.ring.length > 0 ? this.ring[this.ring.length - 1] : undefined;
	}

	/** 将最后一个条目移到最前面（用于 yank-pop 循环）。 */
	rotate(): void {
		if (this.ring.length > 1) {
			const last = this.ring.pop()!;
			this.ring.unshift(last);
		}
	}

	get length(): number {
		return this.ring.length;
	}
}
