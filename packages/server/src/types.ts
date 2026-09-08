import type { JsonValue, ServiceCall, ServiceProviderUpdate } from "@earendil-works/chord";
import type { Context, SessionMetadata } from "@earendil-works/pi-agent-core";
import type { ServerListener } from "./listener.ts";

export interface ServerOptions {
	listeners: readonly ServerListener[];
	/** 由安装或配置档提供的稳定逻辑服务器标识。 */
	serverId: string;
	maxFrameLength?: number;
	handshakeTimeoutMs?: number;
	onConnectionCountChanged?: (count: number) => void;
	onError?: (error: Error) => void;
}

export type MaybePromise<T> = T | Promise<T>;

/** 某个呈现层连接访问托管 Session 的活动能力。 */
export interface RoutedSessionAttachment {
	/** 将一次与契约无关的服务操作路由到已连接的 Session 端点。 */
	invokeService(
		call: ServiceCall,
		publish: (subscriptionId: string, update: ServiceProviderUpdate, context: Context) => MaybePromise<void>,
		context: Context,
	): Promise<JsonValue | undefined>;
	release(context: Context): MaybePromise<void>;
}

/** 服务器服务实现可用的呈现层作用域路由能力。 */
export interface RoutedServerPresentation {
	attachSession(sessionId: string, context: Context): Promise<void>;
	detachSession(context: Context): Promise<void>;
	/** 在应用删除持久元数据前，释放已路由的连接和句柄。 */
	prepareSessionRemoval(sessionId: string, context: Context): Promise<void>;
}

/** 单个连接的服务器作用域服务端点。 */
export interface RoutedServerServiceAttachment {
	invokeService(
		call: ServiceCall,
		publish: (subscriptionId: string, update: ServiceProviderUpdate, context: Context) => MaybePromise<void>,
		context: Context,
	): Promise<JsonValue | undefined>;
	release(context: Context): MaybePromise<void>;
}

export interface RoutedServerServiceHost {
	attachClient(presentation: RoutedServerPresentation, context: Context): MaybePromise<RoutedServerServiceAttachment>;
}

/** 用于获取呈现层作用域 Session 能力的进程安全句柄。 */
export interface RoutedSessionHandle {
	attachClient(context: Context): MaybePromise<RoutedSessionAttachment>;
	/** 意外终止时以错误完成；按预期关闭后以 undefined 完成。 */
	readonly terminated?: Promise<Error | undefined>;
	close(context: Context): Promise<void>;
}

/** 供服务器范围管理和 Session 路由使用的应用能力。 */
export interface ServerHost<TMetadata extends SessionMetadata = SessionMetadata> {
	readonly serverServices: RoutedServerServiceHost;
	/** 解析一个持久 Session ID，失败时抛出边界明确的路由错误。 */
	resolveSession(sessionId: string, context: Context): Promise<TMetadata>;
	openSession(metadata: TMetadata, context: Context): Promise<RoutedSessionHandle>;
}
