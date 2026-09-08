/**
 * 可插拔传输：通过任意双工通道传输以换行符分隔的 JSON。
 *
 * `Connection` 是所有宿主共同使用的抽象。`Transport` 仅用于需要协商地址的跃点：
 * 即演示端与服务器之间的 Unix 套接字。生成的 worker 不需要它，因为管道在 worker 之前已存在。
 */

import { rm } from "node:fs/promises";
import { createConnection as connectSocket, createServer, type Socket } from "node:net";

export interface Connection {
	send(message: unknown): void;
	onMessage(handler: (message: unknown) => void): void;
	onClose(handler: () => void): void;
	close(): void;
}

export interface Listener {
	close(): Promise<void>;
}

export interface Transport {
	listen(onConnection: (connection: Connection) => void): Promise<Listener>;
	connect(): Promise<Connection>;
}

/** 在可读写通道对上，将每条 JSON 消息封装为一行。 */
export function jsonConnection(
	input: NodeJS.ReadableStream,
	output: NodeJS.WritableStream,
	close: () => void,
): Connection {
	const messageHandlers: ((message: unknown) => void)[] = [];
	const closeHandlers: (() => void)[] = [];
	let buffered = "";
	let closed = false;
	const notifyClosed = (): void => {
		if (closed) return;
		closed = true;
		for (const handler of closeHandlers) handler();
	};
	input.setEncoding("utf8");
	input.on("data", (chunk: string) => {
		buffered += chunk;
		let newline = buffered.indexOf("\n");
		while (newline !== -1) {
			const line = buffered.slice(0, newline);
			buffered = buffered.slice(newline + 1);
			if (line.length > 0) {
				const message: unknown = JSON.parse(line);
				for (const handler of messageHandlers) handler(message);
			}
			newline = buffered.indexOf("\n");
		}
	});
	input.on("end", notifyClosed);
	input.on("error", notifyClosed);
	output.on("error", notifyClosed);
	return {
		send: (message) => {
			if (!closed) output.write(`${JSON.stringify(message)}\n`);
		},
		onMessage: (handler) => messageHandlers.push(handler),
		onClose: (handler) => closeHandlers.push(handler),
		close: () => {
			notifyClosed();
			close();
		},
	};
}

function socketConnection(socket: Socket): Connection {
	return jsonConnection(socket, socket, () => socket.destroy());
}

/**
 * 生成的子进程在创建时已连接，因此无需拨号地址，也无需 `Transport`：
 * 父进程读取子进程的 stdout 并写入其 stdin，子进程则以相反方向看到同一组管道。
 */
export function childConnection(child: {
	stdin: NodeJS.WritableStream | null;
	stdout: NodeJS.ReadableStream | null;
	kill(): unknown;
}): Connection {
	if (!child.stdin || !child.stdout) throw new Error("Child process was spawned without pipes");
	return jsonConnection(child.stdout, child.stdin, () => child.kill());
}

/** 子进程自身对父进程所创建管道的视图。 */
export function parentConnection(): Connection {
	return jsonConnection(process.stdin, process.stdout, () => process.stdin.pause());
}

export function socketTransport(path: string): Transport {
	return {
		async listen(onConnection) {
			await rm(path, { force: true });
			const server = createServer((socket) => onConnection(socketConnection(socket)));
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(path, resolve);
			});
			return {
				close: () =>
					new Promise<void>((resolve) => {
						server.close(() => resolve());
					}),
			};
		},
		connect() {
			return new Promise<Connection>((resolve, reject) => {
				const socket = connectSocket(path);
				socket.once("connect", () => resolve(socketConnection(socket)));
				socket.once("error", reject);
			});
		},
	};
}
