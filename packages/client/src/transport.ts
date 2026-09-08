export interface ByteTransport {
	/** 发送一个字节块。各次调用必须按调用顺序投递。 */
	send(chunk: Uint8Array): Promise<void>;
	/** 关闭传输。实现必须确保重复调用无害。 */
	close(): void;
}

export interface ByteTransportHandlers {
	/** 投递任意传入字节块。 */
	onData(chunk: Uint8Array): void;
	/** 报告正常的最终关闭。 */
	onClose(): void;
	/** 报告导致传输终止的故障。 */
	onError(error: Error): void;
}

/** 创建全新的已连接且已认证传输。预期只会调用一个终止处理器。 */
export type ByteTransportFactory = (handlers: ByteTransportHandlers) => ByteTransport | Promise<ByteTransport>;
