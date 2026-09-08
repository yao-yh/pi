/**
 * 会话的演示端：一个连接、按令牌访问的服务，以及一个复制快照。
 *
 * `Sessions` 由服务器响应，`Lane`/`Models` 由 worker 响应，但两者都通过同一个 peer 访问，
 * 因此视图无需了解各服务由哪个宿主提供。
 *
 * 对齐不由此文件负责。`lane.watch()` 在 worker 中捕获快照并缓冲该订阅的事件，
 * `lane.start()` 则排空这些事件。在本演示端持有快照并知道订阅 ID 之前，不会有任何事件到达，
 * 因此此处无需缓冲。
 *
 * 归并使用 harness 的 `reduceLaneSnapshot`：副本不得采用另一套判断逻辑。
 */

import { randomUUID } from "node:crypto";
import type { HarnessEvent } from "@earendil-works/pi-agent-core";
// 使用窄入口：归并逻辑只需一个文件，避免演示端求值整个 harness 桶文件。
import { reduceLaneSnapshot } from "@earendil-works/pi-agent-core/harness/runtime/reducer";
import {
	type AuthEventPayload,
	Lane,
	type LaneServiceApi,
	Models,
	type ModelsServiceApi,
	type Remote,
	type SessionSnapshot,
	type SessionSummary,
	Sessions,
} from "../shared/protocol.ts";
import { createPeer } from "../shared/rpc.ts";
import type { Transport } from "../shared/transport.ts";

export interface AttachedSession {
	state(): SessionSnapshot;
	subscribe(listener: () => void): () => void;
	onAuth(handler: (event: AuthEventPayload) => void): void;
	readonly lane: Remote<LaneServiceApi>;
	readonly models: Remote<ModelsServiceApi>;
	close(): void;
}

/** 附加时若没有 worker 在运行则生成一个；运行及其他 lane 调用不设时限。 */
const ATTACH_TIMEOUT_MS = 60_000;

export async function listSessions(transport: Transport): Promise<SessionSummary[]> {
	const peer = createPeer(await transport.connect());
	try {
		return await peer.use(Sessions).list();
	} finally {
		peer.close();
	}
}

/** 附加到 `sessionId`；其为 null 时附加到新会话。 */
export async function connect(transport: Transport, sessionId: string | null, cwd: string): Promise<AttachedSession> {
	const peer = createPeer(await transport.connect());
	const lane = peer.use(Lane);
	/** 本演示端的标识：服务器据此路由本端的 lane 事件。 */
	const presentationId = randomUUID();
	const listeners = new Set<() => void>();
	const authHandlers = new Set<(event: AuthEventPayload) => void>();
	const publish = (): void => {
		for (const listener of listeners) listener();
	};

	let snapshot: SessionSnapshot | undefined;
	let subscriptionId: string | undefined;

	const fold = (event: HarnessEvent): void => {
		if (!snapshot) return;
		if (reduceLaneSnapshot(snapshot.lane, event) === "rebase") {
			void resubscribe();
			return;
		}
		publish();
	};

	/** 首次附加和变基执行相同操作：获取新订阅并丢弃旧订阅。 */
	const resubscribe = async (): Promise<void> => {
		const previous = subscriptionId;
		const opened = await lane.watch(presentationId);
		snapshot = opened.snapshot;
		subscriptionId = opened.subscriptionId;
		publish();
		await lane.start(opened.subscriptionId);
		if (previous) void lane.unwatch(previous);
	};

	peer.on(Lane, (event) => {
		// 由服务器寻址到本端；ID 检查会在变基后丢弃已被取代的订阅。
		if (event.subscriptionId === subscriptionId) fold(event.event);
	});
	peer.on(Models, (event) => {
		if (event.type !== "state") {
			// 登录提示和通知不是状态，它们用于驱动对话框。
			for (const handler of authHandlers) handler(event);
			return;
		}
		if (!snapshot) return;
		snapshot = { ...snapshot, models: event.state };
		publish();
	});

	await peer.use(Sessions, { timeoutMs: ATTACH_TIMEOUT_MS }).attach(sessionId, cwd, presentationId);
	await resubscribe();

	return {
		state: () => snapshot as SessionSnapshot,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		onAuth: (handler) => authHandlers.add(handler),
		lane,
		models: peer.use(Models),
		close: () => peer.close(),
	};
}
