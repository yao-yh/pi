/** 服务契约以及所有通过线路传输的内容。 */

import type { HarnessEvent, LaneSnapshot } from "@earendil-works/pi-agent-core";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";

/** 命令始终以数据而非异常响应，与远程调用保持一致。 */
export type CommandResult = { ok: true } | { ok: false; error: string };

/** 持久模型身份。worker 外部不持有 `Model` 对象。 */
export interface ModelRef {
	provider: string;
	modelId: string;
}

export interface ModelSummary extends ModelRef {
	name: string;
}

export interface ProviderAccount {
	id: string;
	name: string;
	authType: "oauth" | "api_key";
	configured: boolean;
	/** 用于显示的凭据来源："stored"、"environment" 或环境变量名。 */
	source?: string;
	/** 对于 pi 无法自行收集的环境凭据（如 AWS 配置文件或环境变量）为 false。 */
	interactive: boolean;
	methodName?: string;
}

export interface ModelsState {
	readonly models: readonly ModelSummary[];
	readonly accounts: readonly ProviderAccount[];
	readonly refreshing: boolean;
}

/** 不含 `AbortSignal` 的认证提示，即可通过传输层传递的部分。 */
export type AuthPromptRequest = AuthPrompt extends infer Prompt
	? Prompt extends unknown
		? Omit<Prompt, "signal">
		: never
	: never;

/** 从连接另一端看到的服务：每个方法都返回 promise。 */
export type Remote<T> = {
	[K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
};

/** 命名一个服务，并携带其调用和事件类型。名称全局唯一。 */
export interface ServiceToken<TApi extends object, TEvent = never> {
	readonly name: string;
	/** 幻影字段，从不读取；用于将类型附加到令牌。 */
	readonly types?: (api: TApi, event: TEvent) => void;
}

export function defineService<TApi extends object, TEvent = never>(name: string): ServiceToken<TApi, TEvent> {
	return { name };
}

export interface SessionSummary {
	id: string;
	path: string;
	cwd: string;
	createdAt: number;
}

export interface SessionSnapshot {
	sessionId: string;
	cwd: string;
	sessionPath: string;
	/** 携带 lane 配置、队列和统计信息，不通过旁路复制。 */
	lane: LaneSnapshot;
	models: ModelsState;
}

/** `Models` 服务发布的所有内容。 */
export type ModelsEvent =
	| { type: "state"; state: ModelsState }
	// 登录流程方向相反：请求是事件，回答是普通调用。
	| { type: "prompt"; requestId: string; request: AuthPromptRequest }
	| { type: "notice"; notice: AuthEvent };

/** 登录流程的一端，供驱动对话框的组件使用。 */
export type AuthEventPayload = Exclude<ModelsEvent, { type: "state" }>;

/** 单个演示端的订阅：worker 中的 `lane.watch()`，通过命名使其事件可被过滤。 */
export interface LaneSubscription {
	subscriptionId: string;
	snapshot: SessionSnapshot;
}

/** Lane 事件寻址到生成这些事件的观察订阅。 */
export interface LaneEvent {
	subscriptionId: string;
	event: HarnessEvent;
}

export interface LaneServiceApi {
	/**
	 * 为一个演示端捕获快照并打开订阅。其事件寻址到 `presentationId`，
	 * 因此服务器会对其进行路由而非广播。事件会缓冲至调用 `start`。
	 */
	watch(presentationId: string): Promise<LaneSubscription>;
	/** 开始投递，并排空快照之后缓冲的所有内容。 */
	start(subscriptionId: string): Promise<void>;
	unwatch(subscriptionId: string): Promise<void>;
	prompt(text: string): Promise<CommandResult>;
	steer(text: string): Promise<CommandResult>;
	followUp(text: string): Promise<CommandResult>;
	compact(): Promise<CommandResult>;
	abort(): Promise<CommandResult>;
	setModel(ref: ModelRef): Promise<CommandResult>;
}

export interface ModelsServiceApi {
	refresh(): Promise<CommandResult>;
	login(providerId: string, authType: "oauth" | "api_key"): Promise<CommandResult>;
	authReply(requestId: string, answer: string | null): Promise<void>;
}

/** 由 worker 提供，使服务器无需调用 lane 方法即可识别其打开的会话。 */
export interface WorkerServiceApi {
	describe(): Promise<{ sessionId: string }>;
}

export interface SessionsServiceApi {
	list(): Promise<SessionSummary[]>;
	attach(sessionId: string | null, cwd: string, presentationId: string): Promise<string>;
}

/** 由 worker 提供。每个演示端对应一个订阅；再次调用 `watch` 以变基。 */
export const Lane = defineService<LaneServiceApi, LaneEvent>("lane");
/** 由 worker 提供。体量足够小，可整体发布。 */
export const Models = defineService<ModelsServiceApi, ModelsEvent>("models");
/** 由 worker 提供，仅供服务器使用。 */
export const Worker = defineService<WorkerServiceApi>("worker");
/** 由服务器提供。 */
export const Sessions = defineService<SessionsServiceApi>("sessions");
