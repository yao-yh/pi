import type { Op } from "./delta/index.ts";
import type { RemoteServiceProvider } from "./services/provider.ts";

export type { RemoteServiceError } from "./services/errors.ts";
export type { RemoteServiceProvider } from "./services/provider.ts";

/** {@link Context} 所携带某个值的类型化标识。 */
export interface ContextKey<T> {
	readonly token: symbol;
	/** 仅用于类型检查的标记，防止不同值类型的键相互替换。 */
	readonly valueType?: (value: T) => T;
}

/** 在操作间显式传递、作用域限定于调用且不可变的值。 */
export interface Context {
	readonly abortSignal: AbortSignal | undefined;
	value<T>(key: ContextKey<T>): T | undefined;
	toString(): string;
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type IsAny<T> = 0 extends 1 & T ? true : false;

/** 应用数据类型的严格 JSON 表示；未知载荷会转换为 JsonValue。 */
export type JsonRepresentation<T> = IsAny<T> extends true
	? JsonValue
	: unknown extends T
		? JsonValue
		: T extends null | boolean | number | string
			? T
			: T extends readonly (infer TItem)[]
				? JsonRepresentation<TItem>[]
				: T extends object
					? { [TKey in keyof T]: JsonRepresentation<T[TKey]> }
					: never;

export interface ReplicatedStateDelivery {
	readonly kind: "hydrate" | "update";
	readonly sequence: number;
}

export interface ReplicatedState<T> {
	/** 不可变值；水合完成前为 undefined。后续更新不会改变此前返回的值。 */
	readonly value: T | undefined;
	/** 监听器收到的值不可变，并且可与其他修订版本共享未变化的数据结构。 */
	subscribe(listener: (value: T, context: Context, delivery: ReplicatedStateDelivery) => void): () => void;
}

export interface MutableReplicatedState<T extends object> extends ReplicatedState<T> {
	readonly value: T;
	/** 受跟踪的可变状态。所有写入都必须经过此代理。 */
	readonly state: T;
	/** 发布自上次发布以来通过 {@link state} 完成的变更。 */
	publish(context: Context): void;
}

declare const SERVICE_TYPE: unique symbol;

export type ServiceMode = "singleton" | "keyed";

/** 共享 TypeScript 服务契约的稳定标识。 */
export interface Service<T> {
	readonly id: string;
	/** 进程本地服务接受不受限制的对象契约，且绝不会发布到远端。 */
	readonly local: boolean;
	readonly [SERVICE_TYPE]?: (value: T) => T;
}

type InvalidJsonPart<T> = IsAny<T> extends true
	? T
	: unknown extends T
		? never
		: [T] extends [JsonValue]
			? [JsonValue] extends [T]
				? never
				: InvalidJsonStructure<T>
			: InvalidJsonStructure<T>;

type InvalidJsonProperty<T> = [Exclude<T, undefined>] extends [never] ? T : InvalidJsonPart<Exclude<T, undefined>>;

type InvalidJsonStructure<T> = T extends null | boolean | number | string
	? never
	: T extends readonly (infer TItem)[]
		? InvalidJsonPart<TItem>
		: T extends (...args: never[]) => unknown
			? T
			: T extends object
				? { [TKey in keyof T]-?: InvalidJsonProperty<T[TKey]> }[keyof T]
				: T;

type InvalidRemoteMember<T> = T extends ReplicatedState<infer TValue>
	? InvalidJsonPart<TValue> extends never
		? never
		: "state value is not JSON"
	: T extends (...args: [...infer TArgs, Context]) => Promise<infer TResult>
		? InvalidJsonPart<TArgs[number]> extends never
			? TResult extends void
				? never
				: InvalidJsonPart<TResult> extends never
					? never
					: "method result is not JSON or void"
			: "method argument is not JSON"
		: "member is not a remote method or ReplicatedState";

type InvalidRemoteMemberNames<T> = {
	[TKey in keyof T]-?: InvalidRemoteMember<T[TKey]> extends never ? never : TKey;
}[keyof T];

export type RemoteServiceContract<T> = InvalidRemoteMemberNames<T> extends never ? T : never;

export interface ServiceSpawner<T> {
	spawn(key: string, implementation: T): () => void;
}

export interface RemoteServices {
	use<T>(service: Service<T>): T;
	observe<T>(service: Service<T>, handler: (service: T, context: Context) => void | Promise<void>): () => void;
	/** 等待当前已获取的所有服务完成初始快照安装。 */
	ready(context: Context): Promise<void>;
	dispose(context: Context): Promise<void>;
}

export type ServiceCatalogueEntry = {
	readonly serviceId: string;
	readonly mode: ServiceMode;
};

export type ServiceInstanceAddress = {
	readonly key: string;
	readonly generation: number;
};

export type ServiceMemberSnapshot =
	| { readonly name: string; readonly kind: "method" }
	| { readonly name: string; readonly kind: "state"; readonly sequence: number; readonly ops: readonly Op[] };

export type ServiceInstanceSnapshot = {
	readonly instance?: ServiceInstanceAddress;
	readonly members: readonly ServiceMemberSnapshot[];
};

export type ServiceSubscriptionSnapshot = {
	readonly serviceId: string;
	readonly mode: ServiceMode;
	readonly instances: readonly ServiceInstanceSnapshot[];
};

export type ServiceProviderUpdate =
	| {
			readonly type: "state";
			readonly instance?: ServiceInstanceAddress;
			readonly member: string;
			readonly sequence: number;
			readonly ops: readonly Op[];
	  }
	| { readonly type: "unavailable" }
	| { readonly type: "replaced"; readonly snapshot: ServiceInstanceSnapshot }
	| { readonly type: "spawned"; readonly instance: ServiceInstanceSnapshot }
	| { readonly type: "closed"; readonly instance: ServiceInstanceAddress };

export type ServiceCall = {
	readonly serviceId: string;
	readonly instance?: ServiceInstanceAddress;
	readonly member: string;
	/** 借用的不可变值。Chord 会验证这些值，但不会克隆。 */
	readonly args: readonly JsonValue[];
};

export interface ServiceSubscription {
	readonly snapshot: ServiceSubscriptionSnapshot;
	activate(): void;
	close(context?: Context): void | Promise<void>;
}

/**
 * 供远程服务绑定使用的可插拔线路边界。
 *
 * 实现方负责选择传输、分帧、路由和信封编码。跨越此边界的值必须保持为严格 JSON。
 * Chord 不克隆值，也不要求特定的应用线路协议；适配器负责序列化及自身所需的隔离副本。
 *
 */
export interface RemoteServiceTransport {
	invoke(call: ServiceCall, context: Context): Promise<JsonValue | undefined>;
	subscribe(
		serviceId: string,
		mode: ServiceMode,
		listener: (update: ServiceProviderUpdate, context: Context) => void,
		context: Context,
	): Promise<ServiceSubscription>;
}

export interface RemoteServiceBindingOptions {
	readonly services: readonly { readonly id: string }[];
	readonly transport: RemoteServiceTransport;
	readonly bound?: boolean;
	readonly onError?: (error: Error) => void;
	readonly assertAccess?: () => void;
}

export interface RemoteServiceBinding extends RemoteServices {
	rebind(bound: boolean, context: Context): Promise<void>;
}

export interface FacetEnvironment {
	/** 声明对某个单例服务的强依赖，并返回其稳定句柄。 */
	use<T>(service: Service<T>): T;
	/** 声明对某个键控服务的强依赖，并观察每个活动实例。 */
	observe<T>(service: Service<T>, handler: (service: T, context: Context) => void | Promise<void>): void;
	/** 声明并安装当前切面对某个服务的单例实现。 */
	provide<T>(service: Service<T>, implementation: NoInfer<T>): void;
	/** 声明对多实例服务的所有权，并返回其延迟创建能力。 */
	provideMany<T>(service: Service<T>): ServiceSpawner<T>;
	/** 创建已初始化的可变状态，以便通过服务实现对外公开。 */
	replicatedState<T extends object>(initial: T): MutableReplicatedState<T>;
	/** 将资源清理函数的所有权交给当前切面。 */
	own(disposal: () => void | Promise<void>): void;
	/** 注册在依赖已绑定并就绪后执行的异步初始化。 */
	onActivate(callback: () => void | Promise<void>): void;
	/** 注册切面的最终拆除逻辑。 */
	onDeactivate(callback: () => void | Promise<void>): void;
}

export interface Facet {
	readonly id: string;
	setup(env: FacetEnvironment): void;
}

export interface RemoteServiceSource {
	/** 当前不可用的来源是否可以暂时承接缺失的依赖要求。 */
	readonly acceptsUnavailableServices: boolean;
	catalogue(context: Context): Promise<readonly ServiceCatalogueEntry[]>;
	open(options: {
		readonly services: readonly { readonly id: string }[];
		assertAccess(): void;
		onError(error: Error): void;
	}): RemoteServices;
}

export interface FacetOptions {
	readonly facets: readonly Facet[];
	readonly serviceSources?: readonly RemoteServiceSource[];
	readonly onError?: (error: Error) => void;
}

export interface FacetHost {
	readonly services: RemoteServiceProvider;
	/** 激活并替换 ID 匹配的切面，同时不切断消费方的服务句柄。 */
	reload(facets: readonly Facet[]): Promise<void>;
	dispose(): Promise<void>;
}

export interface LoadedFacets {
	readonly facets: readonly Facet[];
	dispose(): Promise<void>;
}

export interface FacetLoader {
	load(): Promise<LoadedFacets>;
}
