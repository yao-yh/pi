/** 取消请求先于副作用准入时使用的预期内部控制流异常。 */
export class AbortRequested extends Error {
	readonly cancellation: Promise<void>;

	constructor(cancellation: Promise<void>) {
		super("Abort requested");
		this.name = "AbortRequested";
		this.cancellation = cancellation;
	}
}

/** 单次驱动过程中面向执行过程的同步准入能力。 */
export interface Gate {
	readonly signal: AbortSignal;
	admit<T>(invoke: () => T): T;
}

/** 单次驱动过程中面向所有者的生命周期控制能力。 */
export interface GateControl {
	beginAbort(cancellation: Promise<void>): void;
	signalAbort(): void;
	close(error: Error): void;
}

type GateState =
	| { status: "open" }
	| { status: "aborting"; cancellation: Promise<void> }
	| { status: "closed"; error: Error };

/**
 * 为同一个副作用门创建相互分离的执行过程视图和所有者视图。
 * 执行过程只能申请准入，所有者负责开始取消、发出中止信号以及关闭门。
 */
export function createGate(): { gate: Gate; control: GateControl } {
	let state: GateState = { status: "open" };
	const controller = new AbortController();

	const check = (): void => {
		if (state.status === "aborting") throw new AbortRequested(state.cancellation);
		if (state.status === "closed") throw state.error;
	};

	return {
		gate: {
			admit<T>(invoke: () => T): T {
				check();
				return invoke();
			},
			signal: controller.signal,
		},
		control: {
			beginAbort(cancellation) {
				if (state.status !== "open") return;
				state = { status: "aborting", cancellation };
			},
			signalAbort() {
				if (state.status !== "aborting" || controller.signal.aborted) return;
				controller.abort(new AbortRequested(state.cancellation));
			},
			close(error) {
				if (state.status === "closed") return;
				state = { status: "closed", error };
				if (!controller.signal.aborted) controller.abort(error);
			},
		},
	};
}
