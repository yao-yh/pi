/**
 * 完整协议：调用、结果、错误、取消、事件、ping，以及命名服务和一条路由规则。
 *
 * peer 可以提供任意数量的服务，并使用另一端的服务。调用本 peer 未提供的服务时会进入
 * `forward`，从而使服务器保持透明：TUI 使用 `lane.prompt`，而服务器不提供 `lane`，
 * 因此会将调用交给已附加的 worker。同一规则也允许 worker 通过服务器反向使用 `sessions.list`。
 */

import type { Remote, ServiceToken } from "./protocol.ts";
import type { Connection } from "./transport.ts";

type Frame =
	| { kind: "call"; id: number; method: string; args: unknown[] }
	| { kind: "result"; id: number; result: unknown }
	| { kind: "error"; id: number; error: string }
	| { kind: "cancel"; id: number }
	| { kind: "event"; service: string; payload: unknown; to?: string }
	| { kind: "announce"; services: string[] }
	| { kind: "ping" };

export type Forward = (method: string, args: unknown[]) => Promise<unknown>;

export interface CallOptions {
	/** 放弃调用并通知 peer 停止。 */
	signal?: AbortSignal;
	/** peer 未及时响应时拒绝。无时限调用应省略此项。 */
	timeoutMs?: number;
}

export interface PeerOptions {
	/** 处理对本 peer 未提供服务的调用。 */
	forward?: Forward;
	/** 宣告 peer 已断开前允许的静默时间。默认 15 秒；设为 0 时禁用存活检测。 */
	deadMs?: number;
}

const DEFAULT_DEAD_MS = 15_000;

export interface RpcPeer {
	/** 注册实现并向另一端声明名称。 */
	provide<TApi extends object, TEvent>(token: ServiceToken<TApi, TEvent>, implementation: TApi): void;
	/** 本 peer 提供的服务。 */
	readonly provided: ReadonlySet<string>;
	/** 另一端声明的服务。 */
	readonly announced: ReadonlySet<string>;
	/** 使用服务，无论它由本 peer 的另一端还是下一跃点提供。 */
	use<TApi extends object, TEvent>(token: ServiceToken<TApi, TEvent>, options?: CallOptions): Remote<TApi>;
	/** 发布给另一端的所有监听方。 */
	emit<TApi extends object, TEvent>(token: ServiceToken<TApi, TEvent>, event: TEvent): void;
	/** 发布给一个目标。路由器会将其投递到该目标，而不是广播。 */
	emitTo<TApi extends object, TEvent>(token: ServiceToken<TApi, TEvent>, event: TEvent, to: string): void;
	on<TApi extends object, TEvent>(token: ServiceToken<TApi, TEvent>, handler: (event: TEvent) => void): void;
	/** 事件通道的路由器端：无需了解服务即可观察并重新发布。 */
	onEvent(handler: (service: string, payload: unknown, to: string | undefined) => void): void;
	emitRaw(service: string, payload: unknown, to?: string): void;
	call(method: string, ...args: unknown[]): Promise<unknown>;
	callWith(options: CallOptions, method: string, ...args: unknown[]): Promise<unknown>;
	onClose(handler: () => void): void;
	close(): void;
}

/** 单个连接上的双向 peer。 */
export function createPeer(connection: Connection, options: PeerOptions = {}): RpcPeer {
	const services = new Map<string, object>();
	const provided = new Set<string>();
	/** 另一端声明其提供的服务，使路由通过查找而非猜测完成。 */
	const announced = new Set<string>();
	const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	/** 本 peer 当前正在响应的调用控制器，使 `cancel` 帧可以停止这些调用。 */
	const inflight = new Map<number, AbortController>();
	const eventHandlers: ((service: string, payload: unknown, to: string | undefined) => void)[] = [];
	let nextId = 1;
	let lastFrameAt = Date.now();

	// 每次处理程序调用都会在末尾附加 signal：需要它的服务声明尾随 `AbortSignal` 参数，
	// 其余服务忽略这个额外参数。
	const dispatch = async (method: string, args: unknown[], signal: AbortSignal): Promise<unknown> => {
		const dot = method.indexOf(".");
		const local = dot === -1 ? undefined : services.get(method.slice(0, dot));
		if (!local) {
			if (!options.forward) throw new Error(`No service provides ${method}`);
			return options.forward(method, args);
		}
		const handler = (local as Record<string, unknown>)[method.slice(dot + 1)];
		if (typeof handler !== "function") throw new Error(`Unknown method: ${method}`);
		return (handler as (...args: unknown[]) => unknown).apply(local, [...args, signal]);
	};

	connection.onMessage((frameValue) => {
		const frame = frameValue as Frame;
		lastFrameAt = Date.now();
		switch (frame.kind) {
			case "event": {
				for (const handler of eventHandlers) handler(frame.service, frame.payload, frame.to);
				return;
			}
			case "call": {
				const controller = new AbortController();
				inflight.set(frame.id, controller);
				void dispatch(frame.method, frame.args, controller.signal)
					.then(
						// `undefined` 经过 JSON 后会消失，因此缺失的结果以 null 发送。
						(result) => connection.send({ kind: "result", id: frame.id, result: result ?? null }),
						(error: unknown) => connection.send({ kind: "error", id: frame.id, error: message(error) }),
					)
					.finally(() => inflight.delete(frame.id));
				return;
			}
			case "cancel": {
				inflight.get(frame.id)?.abort(new Error("Cancelled by caller"));
				inflight.delete(frame.id);
				return;
			}
			case "result":
			case "error": {
				const waiter = pending.get(frame.id);
				pending.delete(frame.id);
				if (frame.kind === "error") waiter?.reject(new Error(frame.error));
				else waiter?.resolve(frame.result);
				return;
			}
			case "announce": {
				announced.clear();
				for (const service of frame.services) announced.add(service);
				return;
			}
			case "ping":
				return;
			default: {
				const unknownFrame: never = frame;
				throw new Error(`Unknown frame: ${JSON.stringify(unknownFrame)}`);
			}
		}
	});

	connection.onClose(() => {
		if (liveness) clearInterval(liveness);
		for (const waiter of pending.values()) waiter.reject(new Error("Connection closed"));
		pending.clear();
		for (const controller of inflight.values()) controller.abort(new Error("Connection closed"));
		inflight.clear();
	});

	/**
	 * peer 可能在未关闭连接的情况下消失，例如机器被关闭或事件循环卡死。
	 * 任意帧都可作为存活证明，ping 则让空闲连接持续证明其仍然存活。
	 */
	const deadMs = options.deadMs ?? DEFAULT_DEAD_MS;
	const liveness =
		deadMs > 0
			? setInterval(
					() => {
						if (Date.now() - lastFrameAt > deadMs) connection.close();
						else connection.send({ kind: "ping" });
					},
					Math.floor(deadMs / 3),
				)
			: undefined;
	liveness?.unref();

	const callWith = (callOptions: CallOptions, method: string, ...args: unknown[]): Promise<unknown> =>
		new Promise((resolve, reject) => {
			const id = nextId++;
			let timer: NodeJS.Timeout | undefined;
			const abandon = (error: Error): void => {
				if (!pending.delete(id)) return;
				if (timer) clearTimeout(timer);
				callOptions.signal?.removeEventListener("abort", onAbort);
				// 通知 peer 停止；它可能已经消失，此时该操作无效果。
				connection.send({ kind: "cancel", id });
				reject(error);
			};
			const onAbort = (): void => abandon(new Error("Call cancelled"));
			const settle =
				<T>(handler: (value: T) => void) =>
				(value: T) => {
					if (timer) clearTimeout(timer);
					callOptions.signal?.removeEventListener("abort", onAbort);
					handler(value);
				};
			if (callOptions.signal?.aborted) {
				reject(new Error("Call cancelled"));
				return;
			}
			pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
			callOptions.signal?.addEventListener("abort", onAbort, { once: true });
			if (callOptions.timeoutMs !== undefined) {
				timer = setTimeout(
					() => abandon(new Error(`${method} timed out after ${callOptions.timeoutMs}ms`)),
					callOptions.timeoutMs,
				);
				timer.unref();
			}
			connection.send({ kind: "call", id, method, args });
		});

	const peer: RpcPeer = {
		provide: (token, implementation) => {
			services.set(token.name, implementation);
			provided.add(token.name);
			connection.send({ kind: "announce", services: [...provided] });
		},
		provided,
		announced,
		use: (token, callOptions = {}) =>
			new Proxy({} as Remote<typeof token extends ServiceToken<infer TApi, never> ? TApi : never>, {
				get:
					(_target, method) =>
					(...args: unknown[]) =>
						callWith(callOptions, `${token.name}.${String(method)}`, ...args),
			}) as never,
		emit: (token, event) => connection.send({ kind: "event", service: token.name, payload: event }),
		emitTo: (token, event, to) => connection.send({ kind: "event", service: token.name, payload: event, to }),
		emitRaw: (service, payload, to) =>
			connection.send({ kind: "event", service, payload, ...(to === undefined ? {} : { to }) }),
		on: (token, handler) =>
			eventHandlers.push((name, payload) => {
				if (name === token.name) handler(payload as never);
			}),
		onEvent: (handler) => eventHandlers.push(handler),
		call: (method, ...args) => callWith({}, method, ...args),
		callWith,
		onClose: (handler) => connection.onClose(handler),
		close: () => connection.close(),
	};
	return peer;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
