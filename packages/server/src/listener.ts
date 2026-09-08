import type { ByteConnectionAcceptor } from "./connection.ts";

/** 在完成所需的传输认证后，提供已建立的字节连接。 */
export interface ServerListener {
	/** 开始监听，并将已授权连接传递给 accept。 */
	start(accept: ByteConnectionAcceptor): Promise<void>;
	close(): Promise<void>;
}
