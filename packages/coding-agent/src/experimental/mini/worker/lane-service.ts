/**
 * `Lane` 服务的 worker 端实现。
 *
 * lane、harness 和模型注册表均保留在此处。每个演示端都有自己的 `lane.watch()`；
 * harness 已将其快照和事件流配对，既无间隙也无重复，因此此处无需重新实现该对齐逻辑：
 * 订阅只是一个观察句柄和一个 ID。
 */

import { randomUUID } from "node:crypto";
import type { AgentLane, Context, HarnessEvent, LaneSnapshot, WatchHandle } from "@earendil-works/pi-agent-core";
import type { Models } from "@earendil-works/pi-ai";
import type {
	CommandResult,
	LaneServiceApi,
	LaneSubscription,
	ModelRef,
	ModelsState,
	SessionSnapshot,
} from "../shared/protocol.ts";

export interface LaneServiceOptions {
	lane: AgentLane;
	models: Models;
	context: Context;
	session: { id: string; cwd: string; path: string };
	/** 模型目录状态属于 `Models` 服务；快照携带其副本。 */
	modelsState: () => ModelsState;
	publish: (subscriptionId: string, to: string, event: HarnessEvent) => void;
}

export class LaneService implements LaneServiceApi {
	readonly #options: LaneServiceOptions;
	readonly #watches = new Map<string, { handle: WatchHandle<LaneSnapshot>; to: string }>();

	constructor(options: LaneServiceOptions) {
		this.#options = options;
	}

	/** 捕获快照。harness 会缓冲此订阅的事件，直至调用 `start`。 */
	async watch(presentationId: string): Promise<LaneSubscription> {
		const { lane, context, session } = this.#options;
		const subscriptionId = randomUUID();
		const handle = await lane.watch(context);
		try {
			this.#watches.set(subscriptionId, { handle, to: presentationId });
			const snapshot: SessionSnapshot = {
				sessionId: session.id,
				cwd: session.cwd,
				sessionPath: session.path,
				lane: handle.snapshot,
				models: this.#options.modelsState(),
			};
			return { subscriptionId, snapshot };
		} catch (error) {
			// 从未启动的观察器会无限缓冲。
			handle.unsubscribe();
			throw error;
		}
	}

	/** 开始投递，并排空快照之后缓冲的内容。 */
	async start(subscriptionId: string): Promise<void> {
		const watch = this.#watches.get(subscriptionId);
		if (!watch) throw new Error(`Unknown subscription: ${subscriptionId}`);
		watch.handle.start((event) => this.#options.publish(subscriptionId, watch.to, event));
	}

	async unwatch(subscriptionId: string): Promise<void> {
		this.#watches.get(subscriptionId)?.handle.unsubscribe();
		this.#watches.delete(subscriptionId);
	}

	prompt(text: string): Promise<CommandResult> {
		return this.#command(() => this.#options.lane.prompt(text, undefined, this.#options.context));
	}

	steer(text: string): Promise<CommandResult> {
		return this.#command(() => this.#options.lane.steer(text, undefined, this.#options.context));
	}

	followUp(text: string): Promise<CommandResult> {
		return this.#command(() => this.#options.lane.followUp(text, undefined, this.#options.context));
	}

	compact(): Promise<CommandResult> {
		return this.#command(() => this.#options.lane.compact(undefined, this.#options.context));
	}

	abort(): Promise<CommandResult> {
		return this.#command(() => this.#options.lane.abort(this.#options.context));
	}

	/**
	 * lane 存储持久身份，因此 ref 可直接传递。注册表查找只是提前提供便利：
	 * 否则，此 worker 无法服务的身份会在生成阶段失败。
	 */
	async setModel(ref: ModelRef): Promise<CommandResult> {
		if (!this.#options.models.getModel(ref.provider, ref.modelId)) {
			return { ok: false, error: `Unknown model: ${ref.provider}/${ref.modelId}` };
		}
		try {
			await this.#options.lane.setModel(ref, this.#options.context);
			return { ok: true };
		} catch (error) {
			return { ok: false, error: message(error) };
		}
	}

	close(): void {
		for (const watch of this.#watches.values()) watch.handle.unsubscribe();
		this.#watches.clear();
	}

	async #command(run: () => Promise<{ ok: boolean; error?: { message: string } }>): Promise<CommandResult> {
		try {
			const result = await run();
			return result.ok ? { ok: true } : { ok: false, error: result.error?.message ?? "Command failed" };
		} catch (error) {
			return { ok: false, error: message(error) };
		}
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
