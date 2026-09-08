/**
 * 采用入栈时克隆语义的通用撤销栈。
 *
 * 存储状态快照的深层克隆。弹出的快照已经与原状态分离，
 * 因此会直接返回而不再次克隆。
 */
export class UndoStack<S> {
	private stack: S[] = [];

	/** 将给定状态的深层克隆压入栈中。 */
	push(state: S): void {
		this.stack.push(structuredClone(state));
	}

	/** 弹出并返回最近的快照；栈为空时返回 undefined。 */
	pop(): S | undefined {
		return this.stack.pop();
	}

	/** 移除所有快照。 */
	clear(): void {
		this.stack.length = 0;
	}

	get length(): number {
		return this.stack.length;
	}
}
