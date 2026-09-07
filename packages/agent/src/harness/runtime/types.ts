import type { RetryPolicy } from "@earendil-works/pi-ai";
import type { QueueMode } from "../../types.ts";
import type { AgentHarnessOptions, DriveOptions, DriveOutcome, HarnessEvent, Resources } from "../agent-harness.ts";
import type { CompactionSettings } from "../compaction/compaction.ts";
import { type Context, withoutAbortSignal } from "../context.ts";
import { createGate, type Gate, type GateControl } from "../execution/effect-gate.ts";
import type {
	CommitResult,
	InboxItem,
	LaneConfiguration,
	Operation,
	OperationResultRecord,
	OperationState,
	Write,
} from "../session/types.ts";
import type { AgentHarnessStreamOptions, AgentHarnessTool } from "../types.ts";

export class SliceNotImplemented extends Error {
	constructor(operation: string) {
		super(`${operation} is not implemented until its later AgentHarness slice`);
		this.name = "SliceNotImplemented";
	}
}

/** 当前进程内的控制器配置。 */
export interface Config<TContext extends object | undefined> {
	readonly tools: AgentHarnessTool<TContext>[];
	readonly resources: Resources;
	readonly streamOptions: AgentHarnessStreamOptions;
	readonly retryPolicy: RetryPolicy;
	readonly compaction: CompactionSettings;
	readonly steeringMode: QueueMode;
	readonly followUpMode: QueueMode;
	readonly toolExecution: "sequential" | "parallel";
	readonly toolContext: AgentHarnessOptions<TContext>["toolContext"];
	readonly systemPrompt: AgentHarnessOptions<TContext>["systemPrompt"];
	readonly toProviderMessages: NonNullable<AgentHarnessOptions<TContext>["toProviderMessages"]>;
	readonly entryProjectors: Readonly<NonNullable<AgentHarnessOptions<TContext>["entryProjectors"]>>;
}

/** 一个分支通道拥有的当前持久状态。 */
export interface LaneState {
	readonly tipId: string | null;
	readonly configuration: LaneConfiguration;
	readonly inbox: InboxItem[];
	readonly lastOperationId: string | null;
	readonly operation: Operation | null;
}

type Synchronous<TResult> = TResult extends PromiseLike<unknown> ? never : TResult;

interface CommitDecision<TResult> {
	kind: "commit";
	writes: Write[];
	materialize(commit: CommitResult): Synchronous<TResult>;
	events?(commit: CommitResult): HarnessEvent[];
}

/** 在分支通道的串行变更队列上作出的一次无副作用决策。 */
export type LaneCommand<TResult> =
	| (CommitDecision<TResult> & { next: LaneState })
	| { kind: "return"; result: TResult }
	| { kind: "reject"; error: Error };

export type ContinueOperationResult<TResult> = { kind: "cancel_requested" } | { kind: "result"; value: TResult };

/** 一次持久操作转换。分支通道会将状态写入与投影发布配对。 */
type LanePatch = Partial<Pick<LaneState, "tipId" | "configuration" | "inbox">>;

interface FinishDecision<TResult> {
	kind: "finish";
	writes: Write[];
	record: OperationResultRecord;
	lane?: LanePatch;
	materialize(commit: CommitResult): Synchronous<TResult>;
	events?(commit: CommitResult): HarnessEvent[];
}

export type OperationCommand<TResult> =
	| (CommitDecision<TResult> & { operationState: OperationState; lane?: LanePatch })
	| FinishDecision<TResult>
	| { kind: "return"; result: TResult };

/** 一次已安装的进程内推进过程。 */
export class Drive {
	readonly operationId: string;
	readonly completion: Promise<DriveOutcome>;
	readonly gate: Gate;
	readonly context: Context;
	readonly waitForRetry: boolean;
	readonly closeSignal: AbortSignal;
	deferredPermits: number;

	private readonly control: GateControl;
	private readonly closeController: AbortController;
	private readonly resolveCompletion: (outcome: DriveOutcome) => void;
	private readonly rejectCompletion: (error: unknown) => void;

	constructor(options: DriveOptions, context: Context) {
		this.operationId = options.operationId;
		this.context = withoutAbortSignal(context);
		this.waitForRetry = options.waitForRetry ?? false;
		this.deferredPermits = options.pollDeferred === true ? 1 : 0;
		let resolveCompletion!: (outcome: DriveOutcome) => void;
		let rejectCompletion!: (error: unknown) => void;
		this.completion = new Promise<DriveOutcome>((resolve, reject) => {
			resolveCompletion = resolve;
			rejectCompletion = reject;
		});
		this.resolveCompletion = resolveCompletion;
		this.rejectCompletion = rejectCompletion;
		void this.completion.catch(() => {});
		const { gate, control } = createGate();
		this.gate = gate;
		this.control = control;
		this.closeController = new AbortController();
		this.closeSignal = this.closeController.signal;
	}

	settle(outcome: DriveOutcome): void {
		this.resolveCompletion(outcome);
	}

	fail(error: unknown): void {
		this.rejectCompletion(error);
	}

	beginAbort(cancellation: Promise<void>): void {
		this.control.beginAbort(cancellation);
	}

	signalAbort(): void {
		this.control.signalAbort();
	}

	closeGate(error: Error): void {
		this.control.close(error);
		if (!this.closeSignal.aborted) this.closeController.abort(error);
		this.rejectCompletion(error);
	}
}

export type ProcedureResult =
	| { kind: "continue" }
	| { kind: "waiting"; outcome: DriveOutcome }
	| { kind: "settled"; outcome: OperationResultRecord };
