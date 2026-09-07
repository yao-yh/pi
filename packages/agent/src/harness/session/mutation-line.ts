/** 串行执行单个会话上的完整“读取—修改—写入”任务。 */
export class MutationLine {
	private tail: Promise<void> = Promise.resolve();
	private sealedError: Error | undefined;

	run<T>(operation: () => T | Promise<T>): Promise<T> {
		if (this.sealedError !== undefined) return Promise.reject(this.sealedError);
		const result = this.tail.then(() => {
			if (this.sealedError !== undefined) throw this.sealedError;
			return operation();
		});
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	seal(error: Error): Promise<void> {
		this.sealedError ??= error;
		return this.tail;
	}
}
