/**
 * 会话服务器：接受客户端连接、为每个会话生成一个 worker 进程并执行路由。
 *
 * 它提供 `Sessions`，但不持有 agent 状态。其他服务名称都会转发到调用客户端所附加的 worker，
 * 每个 worker 事件也会推送回该 worker 的客户端。路由规则是对称的，
 * 因此 worker 通过同一个 peer 访问 `Sessions`。
 */

import { spawn } from "node:child_process";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
// 使用窄入口：服务器仅路由和列出会话，从不运行 agent。
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/harness/env/nodejs";
import { JsonlSessionRepo } from "@earendil-works/pi-agent-core/harness/session";
import { type SessionSummary, Sessions, type SessionsServiceApi, Worker } from "../shared/protocol.ts";
import { createPeer, type RpcPeer } from "../shared/rpc.ts";
import { childConnection, type Transport } from "../shared/transport.ts";

const SELF_EXTENSION = extname(fileURLToPath(import.meta.url));
const WORKER_ENTRY = fileURLToPath(new URL(`../worker/entry${SELF_EXTENSION}`, import.meta.url));
const WORKER_START_TIMEOUT_MS = 30_000;
/** 空闲服务器退出前的宽限期，防止正在重新连接的演示端与其发生竞争。 */
const IDLE_SHUTDOWN_MS = 10_000;

/** 服务器为单个会话 worker 进程维护的路由条目。worker 不知道这些信息。 */
interface Route {
	sessionId: string;
	/** 通往 worker 进程的 peer。 */
	worker: RpcPeer;
	/** 按 ID 保存已附加的演示端，使定址事件恰好发送到其中一个。 */
	subscribers: Map<string, RpcPeer>;
	stop(): void;
}

async function listSessions(sessionsRoot: string): Promise<SessionSummary[]> {
	const executionEnv = new NodeExecutionEnv({ cwd: process.cwd() });
	const repo = new JsonlSessionRepo({ fileSystem: executionEnv, sessionsRoot });
	try {
		return (await repo.list(undefined, BACKGROUND_CONTEXT)).map((metadata) => ({
			id: metadata.id,
			path: metadata.path,
			cwd: metadata.cwd,
			createdAt: metadata.createdAt,
		}));
	} finally {
		await repo.close(BACKGROUND_CONTEXT);
		await executionEnv.cleanup(BACKGROUND_CONTEXT);
	}
}

export async function runServer(options: { transport: Transport; sessionsRoot: string }): Promise<void> {
	const routes = new Map<string, Route>();
	let presentations = 0;
	let retire = (): void => {};
	const retired = new Promise<void>((resolve) => {
		retire = resolve;
	});
	let idleTimer: NodeJS.Timeout | undefined;
	/** 没有服务对象且没有运行任务时退出，确保下次启动始终使用当前代码。 */
	const considerRetiring = (): void => {
		if (idleTimer) clearTimeout(idleTimer);
		if (presentations > 0 || routes.size > 0) return;
		idleTimer = setTimeout(() => {
			if (presentations === 0 && routes.size === 0) retire();
		}, IDLE_SHUTDOWN_MS);
		idleTimer.unref();
	};
	/** 并发附加到同一会话时必须共享 worker：两个写入方会损坏会话。 */
	const spawning = new Map<string, Promise<Route>>();

	const spawnWorker = async (sessionId: string | undefined, cwd: string): Promise<Route> => {
		const args = [...process.execArgv, WORKER_ENTRY, options.sessionsRoot, cwd, ...(sessionId ? [sessionId] : [])];
		const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "inherit"] });
		const connection = childConnection(child);
		const peer = createPeer(connection);
		// worker 通过同一个 peer 使用 `Sessions`。
		peer.provide(Sessions, { list, attach: attachUnsupported });
		// 无响应的 worker 不得阻塞生成它的附加操作。
		const described = await peer.use(Worker, { timeoutMs: WORKER_START_TIMEOUT_MS }).describe();
		const route: Route = {
			sessionId: described.sessionId,
			worker: peer,
			subscribers: new Map(),
			stop: () => child.kill(),
		};
		// 路由由服务器负责。定址事件只到达一个演示端，其余事件则共享。
		peer.onEvent((service, payload, to) => {
			if (to !== undefined) {
				route.subscribers.get(to)?.emitRaw(service, payload);
				return;
			}
			for (const subscriber of route.subscribers.values()) subscriber.emitRaw(service, payload);
		});
		peer.onClose(() => {
			routes.delete(route.sessionId);
			considerRetiring();
		});
		routes.set(route.sessionId, route);
		return route;
	};

	const ensureRoute = (sessionId: string | null, cwd: string): Promise<Route> => {
		if (sessionId === null) return spawnWorker(undefined, cwd);
		const existing = routes.get(sessionId);
		if (existing) return Promise.resolve(existing);
		const pending = spawning.get(sessionId);
		if (pending) return pending;
		const started = spawnWorker(sessionId, cwd).finally(() => spawning.delete(sessionId));
		spawning.set(sessionId, started);
		return started;
	};

	const list = (): Promise<SessionSummary[]> => listSessions(options.sessionsRoot);
	const attachUnsupported = async (): Promise<string> => {
		throw new Error("Only presentations attach to sessions");
	};

	const listener = await options.transport.listen((connection) => {
		presentations += 1;
		let route: Route | undefined;
		let attachedAs: string | undefined;
		const sessions: SessionsServiceApi = {
			list,
			attach: async (sessionId, cwd, presentationId) => {
				route?.subscribers.delete(attachedAs ?? "");
				attachedAs = presentationId;
				route = await ensureRoute(sessionId, cwd);
				route.subscribers.set(presentationId, presentation);
				return route.sessionId;
			},
		};
		const presentation: RpcPeer = createPeer(connection, {
			forward: (method, args) => {
				if (!route) throw new Error("Not attached to a session");
				const service = method.slice(0, method.indexOf("."));
				if (!route.worker.announced.has(service)) {
					throw new Error(
						`No host provides ${service}: server has [${[...presentation.provided]}], worker has [${[...route.worker.announced]}]`,
					);
				}
				return route.worker.call(method, ...args);
			},
		});
		presentation.provide(Sessions, sessions);
		connection.onClose(() => {
			presentations -= 1;
			if (route && attachedAs !== undefined) {
				route.subscribers.delete(attachedAs);
				// 每个会话一个 worker，仅在有演示端查看时保持活动。
				if (route.subscribers.size === 0) route.stop();
			}
			considerRetiring();
		});
	});

	considerRetiring();
	await retired;
	await listener.close();
}
