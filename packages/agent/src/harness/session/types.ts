import type { JsonValue } from "@earendil-works/chord";
import type { AssistantMessage, StopReason, Usage } from "@earendil-works/pi-ai";
import type { AgentMessage, QueueMode, ThinkingLevel } from "../../types.ts";
import type { BranchPreparation } from "../compaction/branch-summarization.ts";
import type { CompactionPreparation, CompactionSettings } from "../compaction/compaction.ts";
import type { Context } from "../context.ts";
import type { AgentHarnessStreamOptions } from "../types.ts";
import type { ListElement, ListReadOptions, ListWrite, StoredValue, Value, ValueList, ValueWrite } from "./values.ts";

export type { JsonValue } from "@earendil-works/chord";

export type SettledAssistantMessage = AssistantMessage & {
	stopReason: Exclude<StopReason, "pending">;
};

export type EntryType = "message" | "compaction" | "branch_summary" | "custom";

export interface EntryBase {
	id: string;
	parentId: string | null;
	seq: number;
	timestamp: number;
	type: EntryType;
	customType?: string;
}

export interface MessageEntry extends EntryBase {
	type: "message";
	message: AgentMessage;
	terminate?: true;
}

export interface CompactionEntry extends EntryBase {
	type: "compaction";
	summary: string;
	retainedTail: AgentMessage[];
	tokensBefore: number;
	details?: JsonValue;
	usage?: Usage;
	fromHook: boolean;
}

export interface BranchSummaryEntry extends EntryBase {
	type: "branch_summary";
	fromId: string | null;
	summary: string;
	details?: JsonValue;
	usage?: Usage;
	fromHook: boolean;
}

export interface CustomEntry extends EntryBase {
	type: "custom";
	customType: string;
	data?: JsonValue;
}

/** 将应用程序定义的自定义条目转换为模型上下文。 */
export type EntryProjector = (
	entry: CustomEntry,
	context: Context,
) => AgentMessage[] | undefined | Promise<AgentMessage[] | undefined>;

export type Entry = MessageEntry | CompactionEntry | BranchSummaryEntry | CustomEntry;

/** 存储分配序号和时间戳之前提供给事务的条目。 */
export type NewEntry<TEntry extends Entry = Entry> = TEntry extends Entry ? Omit<TEntry, "seq" | "timestamp"> : never;

export interface LaneConfiguration {
	model: { provider: string; modelId: string };
	thinkingLevel: ThinkingLevel;
	activeToolNames: string[];
}

export interface OperationMeta {
	operationId: string;
	lane: string;
	sourceTipId: string | null;
	startedAt: number;
	intent:
		| { kind: "run"; promptEntryIds: string[] }
		| { kind: "compaction"; customInstructions?: string }
		| {
				kind: "navigation";
				targetId: string | null;
				summarize: boolean;
				label?: string;
				customInstructions?: string;
		  };
}

export type Control =
	| { status: "running" }
	| {
			status: "cancel_requested";
			requestedAt: number;
	  };

export interface OperationError {
	code: string;
	message: string;
	details?: JsonValue;
}

export type TerminalStatus = "completed" | "declined" | "aborted" | "failed";

/** 由一次终止事务写入、在分支通道生命周期内保持不变的观测记录。 */
export interface OperationResultRecord {
	operationId: string;
	kind: OperationMeta["intent"]["kind"];
	status: TerminalStatus;
	error?: OperationError;
	fromTipId: string | null;
	tipId: string | null;
	startedAt: number;
	endedAt: number;
}

export type Continuation =
	| { kind: "need_assistant"; overflowRecoveryUsed: boolean }
	| { kind: "may_finish"; includeFinalAssistant: boolean };

/** 检查点载荷；扁平的叶级字面量取代了旧的嵌套阶段标签。 */
export interface CheckpointData {
	continuation: Continuation;
	triggerEntryId: string;
}

export type InboxItemKind = "steer" | "followUp" | "nextRun" | "write";

export interface InboxItem {
	entryId: string;
	kind: InboxItemKind;
}

export interface NormalizedRetryPolicy {
	maxAttempts: number;
	baseDelayMs: number;
}

export interface GenerationContext {
	stepId: string;
	triggerEntryId: string;
	configuration: LaneConfiguration;
	streamOptions: AgentHarnessStreamOptions;
	retryPolicy: NormalizedRetryPolicy;
	overflowRecoveryUsed: boolean;
}

interface ToolCallSource {
	/** 助手消息完整内容数组中的从零开始索引，并非筛选后的工具调用序号。 */
	sourceIndex: number;
	resultEntryId: string;
}

export type ToolCall = ToolCallSource &
	(
		| { status: "planned" }
		| { status: "effect_pending"; replay: "never" | "safe" }
		| { status: "outcome_ready"; terminate: boolean }
		| { status: "completed"; terminate: boolean }
	);

export interface ToolBatch {
	assistantEntryId: string;
	configuration: LaneConfiguration;
	turnId: string;
	calls: ToolCall[];
}

export interface SummaryContext {
	resultEntryId: string;
	configuration: LaneConfiguration;
	streamOptions: AgentHarnessStreamOptions;
	retryPolicy: NormalizedRetryPolicy;
}

/*
 * 持久操作状态是一个扁平联合类型，每个分发器叶节点都使用与操作类别无关的判别字段。
 * ToolBatch/ToolCall 仍是嵌套的子集合状态机，取消操作则通过 Control 保持正交。
 */

export interface Cancellable {
	control: Control;
}

export interface RunSettings {
	compaction: CompactionSettings;
	steeringMode: QueueMode;
	followUpMode: QueueMode;
	toolExecution: "sequential" | "parallel";
}

/** 每个操作叶节点携带的统一作用域。 */
export interface OperationScope extends Cancellable {
	settings: RunSettings;
	latestAssistantEntryId: string | null;
}

/** 每个重试等待叶节点共用的退避数据。 */
export interface RetryWait {
	nextAttempt: number;
	notBefore: number;
	errorMessage: string;
}

export interface AssistantGenerationScope {
	generationContext: GenerationContext;
}

export type ResultBoundary =
	| { kind: "resume_checkpoint"; resumeAfter: CheckpointData }
	| { kind: "finish" }
	| { kind: "commit_navigation"; targetId: string; label?: string };

export interface SummaryTask {
	taskId: string;
	reason?: "manual" | "threshold" | "overflow";
	customInstructions?: string;
	boundary: ResultBoundary;
}

export interface SummaryGenerationScope {
	task: SummaryTask;
	summaryContext: SummaryContext;
}

export interface SummaryGenerationReady extends SummaryGenerationScope {
	nextAttempt: number;
}

export interface SummaryGenerationEffectPending extends SummaryGenerationScope {
	attempt: number;
	request?: { index: number; usageId: string };
	usageIds: string[];
}

export interface SummaryGenerationRetryWait extends SummaryGenerationScope, RetryWait {}

export interface DeferredScope extends OperationScope {
	stepId: string;
	sourceEntryId: string;
	poll: number;
	configuration: LaneConfiguration;
	streamOptions: AgentHarnessStreamOptions;
}

export interface StartingOperation extends OperationScope {
	at: "starting";
}

export interface CheckpointOperation extends OperationScope, CheckpointData {
	at: "checkpoint";
}

export interface AssistantReadyOperation extends OperationScope, AssistantGenerationScope {
	at: "assistant.ready";
	nextAttempt: number;
}

export interface AssistantEffectPendingOperation extends OperationScope, AssistantGenerationScope {
	at: "assistant.effect_pending";
	attempt: number;
	responseEntryId: string;
	usageId: string;
	intendedOutputLimit: number;
	contextWindow: number;
}

export interface AssistantRetryWaitOperation extends OperationScope, AssistantGenerationScope, RetryWait {
	at: "assistant.retry_wait";
}

export interface ToolsOperation extends OperationScope {
	at: "tools";
	batch: ToolBatch;
}

export interface DeferredSuspendedOperation extends DeferredScope {
	at: "deferred.suspended";
}

export interface DeferredEffectPendingOperation extends DeferredScope {
	at: "deferred.effect_pending";
	responseEntryId: string;
	usageId: string;
}

export interface SummaryDecidingOperation extends OperationScope {
	at: "summary.deciding";
	task: SummaryTask;
}

export interface SummaryReadyOperation extends OperationScope, SummaryGenerationReady {
	at: "summary.ready";
}

export interface SummaryEffectPendingOperation extends OperationScope, SummaryGenerationEffectPending {
	at: "summary.effect_pending";
}

export interface SummaryRetryWaitOperation extends OperationScope, SummaryGenerationRetryWait {
	at: "summary.retry_wait";
}

export interface NavigationReadyToCommitOperation extends OperationScope {
	at: "navigation.ready_to_commit";
	/** 未经摘要的导航可以指向分支根节点（null）。 */
	targetId: string | null;
	label?: string;
}

/** 扁平的持久操作状态：恰好包含 13 个与操作类别无关的分发器叶节点。 */
export type OperationState =
	| StartingOperation
	| CheckpointOperation
	| AssistantReadyOperation
	| AssistantEffectPendingOperation
	| AssistantRetryWaitOperation
	| ToolsOperation
	| DeferredSuspendedOperation
	| DeferredEffectPendingOperation
	| SummaryDecidingOperation
	| SummaryReadyOperation
	| SummaryEffectPendingOperation
	| SummaryRetryWaitOperation
	| NavigationReadyToCommitOperation;

export type OperationAt = OperationState["at"];

/** 构造后继叶节点时只复制统一操作作用域。 */
export function operationScopeOf(state: OperationState): OperationScope {
	return {
		control: state.control,
		settings: state.settings,
		latestAssistantEntryId: state.latestAssistantEntryId,
	};
}

export type Operation = { meta: OperationMeta; state: OperationState };

export interface LaneState {
	currentOperationId: string | null;
	lastOperationId: string | null;
	inbox: InboxItem[];
}

export type PendingEntry =
	| { type: "message"; payload: AgentMessage }
	| { type: "custom"; customType: string; payload?: JsonValue };

export interface DurableFileOperations {
	read: string[];
	written: string[];
	edited: string[];
}

export type DurableStructuralPreparation =
	| {
			kind: "compaction";
			messagesToSummarize: CompactionPreparation["messagesToSummarize"];
			turnPrefixMessages: CompactionPreparation["turnPrefixMessages"];
			retainedTail: CompactionPreparation["retainedTail"];
			isSplitTurn: boolean;
			tokensBefore: number;
			previousSummary?: string;
			fileOps: DurableFileOperations;
			settings: CompactionSettings;
	  }
	| {
			kind: "branch_summary";
			messages: BranchPreparation["messages"];
			fileOps: DurableFileOperations;
			totalTokens: number;
	  };

export interface UsageRow {
	id: string;
	seq: number;
	usage: Usage;
	entryId?: string;
	adjustment: boolean;
	details?: JsonValue;
}

export interface EntryWrite {
	kind: "entry";
	entry: NewEntry;
}

export interface UsageWrite {
	kind: "usage";
	row: Omit<UsageRow, "seq">;
}

export type Write = EntryWrite | UsageWrite | ValueWrite | ListWrite;

export interface CommitResult {
	firstSeq: number;
	seqs: number[];
	timestamp: number;
	/** 应用本次提交后立即得到的会话汇总数据。 */
	stats: SessionStats;
}

export interface EntryStructure {
	id: string;
	parentId: string | null;
	seq: number;
	timestamp: number;
	type: EntryType;
	customType?: string;
}

export interface EntryCursor {
	seq: number;
}

export interface BranchScan {
	start?: string;
	stopAtType?: EntryType;
	stopAtId?: string;
	type?: EntryType;
	customType?: string;
	order?: "newestFirst" | "oldestFirst";
	limit?: number;
	cursor?: EntryCursor;
}

export type StorageBranchScan = BranchScan & { start: string };

export interface EntryScan {
	type?: EntryType;
	customType?: string;
	fromSeq?: number;
	toSeq?: number;
	order?: "asc" | "desc";
	limit?: number;
}

export interface UsageScan {
	fromSeq?: number;
	toSeq?: number;
	order?: "asc" | "desc";
	limit?: number;
}

export interface SessionStats {
	messageCount: number;
	usage: Usage;
}

export interface Storage {
	commit(writes: Write[], context: Context): Promise<CommitResult>;
	getEntries(ids: string[], context: Context): Promise<Map<string, Entry>>;
	getValue<T>(address: Value<T>, context: Context): Promise<StoredValue<T> | undefined>;
	scanValues<T>(prefix: Value<T>, context: Context): Promise<StoredValue<T>[]>;
	readList<T>(
		address: ValueList<T>,
		options: ListReadOptions | undefined,
		context: Context,
	): Promise<ListElement<T>[]>;
	scanBranch(query: StorageBranchScan, context: Context): Promise<Entry[]>;
	scanBranchStructure(query: StorageBranchScan, context: Context): Promise<EntryStructure[]>;
	scanEntries(query: EntryScan, context: Context): Promise<Entry[]>;
	scanUsage(query: UsageScan, context: Context): Promise<UsageRow[]>;
	getStats(context: Context): Promise<SessionStats>;
	close(context: Context): Promise<void>;
}

export interface SessionMetadata {
	id: string;
	createdAt: number;
	storageVersion: number;
	cwd?: string;
	parentSessionId?: string;
	legacyParentSessionPath?: string;
}

export interface IdGenerator {
	next(timestampMs?: number): string;
}

export interface EntryQuery {
	type?: EntryType;
	customType?: string;
	order?: "asc" | "desc";
	limit?: number;
	cursor?: EntryCursor;
}

export interface SessionReader {
	getEntries(ids: string[], context: Context): Promise<Map<string, Entry>>;
	getStats(context: Context): Promise<SessionStats>;
	getValue<T>(address: Value<T>, context: Context): Promise<StoredValue<T> | undefined>;
	scanValues<T>(prefix: Value<T>, context: Context): Promise<StoredValue<T>[]>;
	readList<T>(
		address: ValueList<T>,
		options: ListReadOptions | undefined,
		context: Context,
	): Promise<ListElement<T>[]>;
	/** 在此读取器能力仍有效时，从明确指定的条目开始扫描分支。 */
	scanBranch(query: StorageBranchScan, context: Context): Promise<Entry[]>;
}

/** 单个会话使用的无键独占变更屏障。 */
export interface SessionMutation extends SessionReader {
	/** 只允许零次或一次提交尝试；第二次尝试会被拒绝。 */
	commit(writes: Write[], context: Context): Promise<CommitResult>;
	/** 等待提交尝试完成、使此能力失效并释放屏障。 */
	end(context: Context): Promise<void>;
}

/** 作用域限于回调且无权释放会话屏障的变更能力。 */
export type SessionMutator = Omit<SessionMutation, "end">;

export type SessionMutationCallback<T> = (mutator: SessionMutator, context: Context) => T | Promise<T>;

export interface Branch {
	readonly name: string;
	getTipId(context: Context): Promise<string | null>;
	findEntries(query: BranchScan | undefined, context: Context): Promise<Entry[]>;
	findEntry(query: BranchScan | undefined, context: Context): Promise<Entry | undefined>;
	appendMessage(message: AgentMessage, context: Context): Promise<string>;
	appendCustomEntry(customType: string, data: JsonValue | undefined, context: Context): Promise<string>;
}

export interface Session<TMetadata extends SessionMetadata = SessionMetadata> extends SessionReader {
	readonly metadata: TMetadata;
	readonly idGenerator: IdGenerator;
	getEntry(id: string, context: Context): Promise<Entry | undefined>;
	getStats(context: Context): Promise<SessionStats>;
	getName(context: Context): Promise<string | undefined>;
	getLabel(targetId: string, context: Context): Promise<string | undefined>;
	findEntries(query: EntryQuery | undefined, context: Context): Promise<Entry[]>;
	findEntry(query: EntryQuery | undefined, context: Context): Promise<Entry | undefined>;
	branch(name: string, context: Context): Promise<Branch | undefined>;
	createBranch(name: string, at: string | null, context: Context): Promise<Branch>;
	beginMutation(context: Context): Promise<SessionMutation>;
	/**
	 * 在会话变更队列上运行的可信独占回调。从该回调调用会话的公开写入方法时，
	 * 写入会排在回调之后，因此等待这个嵌套写入会造成死锁。
	 * 请使用提供的变更器执行回调中唯一的一次提交。
	 */
	mutate<T>(mutation: SessionMutationCallback<T>, context: Context): Promise<T>;
	setValue<T>(address: Value<T>, next: NoInfer<T>, context: Context): Promise<void>;
	deleteValue<T>(address: Value<T>, context: Context): Promise<void>;
	appendList<T>(address: ValueList<T>, element: NoInfer<T>, context: Context): Promise<void>;
	deleteList<T>(address: ValueList<T>, context: Context): Promise<void>;
	setName(name: string | undefined, context: Context): Promise<void>;
	setLabel(targetId: string, label: string | undefined, context: Context): Promise<void>;
	close(context: Context): Promise<void>;
}

export interface SessionCreateOptions {
	id?: string;
	parentSessionId?: string;
}

export type ForkOptions =
	| {
			/**
			 * 使用相同分支名称，从配置完整的源 AgentLane 复制一条路径，
			 * 同时复制配置并创建全新的空闲通道状态。
			 */
			scope: "branch";
			/** 要复制的源分支。 */
			branch: string;
			/** 源分支当前末端的祖先链上的条目，默认为当前末端。 */
			entryId?: string;
			/**
			 * 派生结果是包含所选条目，还是停在其父条目处。
			 * 默认包含所选条目。
			 */
			position?: "before" | "at";
			/** 可选的目标会话 ID。 */
			id?: string;
	  }
	| {
			/**
			 * 复制整棵对话树和每个分支末端。每个已配置的 AgentLane 都会复制配置并创建全新的空闲状态；
			 * 仅含数据的分支仍只包含数据。操作、待处理、结果和用量状态均不复制。
			 */
			scope: "tree";
			/** 可选的目标会话 ID。 */
			id?: string;
	  };

export interface SessionRepo<
	TMetadata extends SessionMetadata = SessionMetadata,
	TCreateOptions extends { id?: string; parentSessionId?: string } = SessionCreateOptions,
	TListOptions = void,
> {
	create(options: TCreateOptions, context: Context): Promise<Session<TMetadata>>;
	open(metadata: TMetadata, context: Context): Promise<Session<TMetadata>>;
	list(options: TListOptions | undefined, context: Context): Promise<TMetadata[]>;
	delete(metadata: TMetadata, context: Context): Promise<void>;
	fork(source: TMetadata, options: ForkOptions, context: Context): Promise<Session<TMetadata>>;
}
