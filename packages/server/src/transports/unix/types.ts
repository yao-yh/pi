import type { ServerOptions } from "../../types.ts";

export interface UnixListenerOptions {
	path: string;
	/** 套接字文件系统权限。默认仅允许所有者读写（0o600）。 */
	mode?: number;
	/** 断开缓慢对端前，每个连接允许排队的最大分帧字节数。 */
	maxPendingBytes?: number;
	gracefulCloseTimeoutMs?: number;
	/** 用于派生并验证 maxPendingBytes。自定义时必须与服务器配置一致。 */
	maxFrameLength?: number;
	onError?: (error: Error) => void;
}

export interface UnixServerOptions extends Omit<ServerOptions, "listeners">, UnixListenerOptions {}
