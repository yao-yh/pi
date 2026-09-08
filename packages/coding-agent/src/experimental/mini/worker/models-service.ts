/**
 * `Models` 服务的 worker 端实现。
 *
 * `ModelRuntime`、`Model` 和提供商对象均保留在此处。对外仅传递可序列化的目录、
 * 账户列表，以及作为数据的登录提示和通知。
 */

import { randomUUID } from "node:crypto";
import type { ModelRuntime } from "../../../core/model-runtime.ts";
import { refreshModelCatalogs } from "../../../modes/interactive/model-catalog-refresh.ts";
import type {
	AuthPromptRequest,
	CommandResult,
	ModelsEvent,
	ModelsServiceApi,
	ModelsState,
	ProviderAccount,
} from "../shared/protocol.ts";

const CATALOG_REFRESH_TIMEOUT_MS = 15_000;

export class ModelsService implements ModelsServiceApi {
	readonly #runtime: ModelRuntime;
	readonly #publish: (event: ModelsEvent) => void;
	/** 已发送给演示端、正在等待 `authReply` 的提示。 */
	readonly #pendingAuth = new Map<string, (answer: string | null) => void>();
	#state: ModelsState;

	constructor(runtime: ModelRuntime, publish: (event: ModelsEvent) => void) {
		this.#runtime = runtime;
		this.#publish = publish;
		this.#state = readState(runtime, false);
	}

	get state(): ModelsState {
		return this.#state;
	}

	async refresh(): Promise<CommandResult> {
		this.#update(true);
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), CATALOG_REFRESH_TIMEOUT_MS);
		try {
			const result = await refreshModelCatalogs(this.#runtime, controller.signal);
			return result.errors.size === 0
				? { ok: true }
				: { ok: false, error: `Some catalogs could not be refreshed: ${[...result.errors.keys()].join(", ")}` };
		} catch (error) {
			return { ok: false, error: message(error) };
		} finally {
			clearTimeout(timeout);
			this.#update(false);
		}
	}

	/** 提示和通知以事件形式发送到演示端，回答则通过 `authReply` 返回。 */
	async login(providerId: string, authType: ProviderAccount["authType"]): Promise<CommandResult> {
		try {
			await this.#runtime.login(providerId, authType, {
				prompt: (prompt) => {
					const { signal, ...request } = prompt;
					return this.#ask(request, signal);
				},
				notify: (notice) => this.#publish({ type: "notice", notice }),
			});
			return { ok: true };
		} catch (error) {
			return { ok: false, error: message(error) };
		} finally {
			this.#update(false);
		}
	}

	async authReply(requestId: string, answer: string | null): Promise<void> {
		const waiter = this.#pendingAuth.get(requestId);
		this.#pendingAuth.delete(requestId);
		waiter?.(answer);
	}

	/** 向演示端提出一个问题，并遵守提供商给出的截止时间。 */
	#ask(request: AuthPromptRequest, signal: AbortSignal | undefined): Promise<string> {
		if (signal?.aborted) return Promise.reject(new Error("Login cancelled"));
		return new Promise<string>((resolve, reject) => {
			const requestId = randomUUID();
			const settle = (answer: string | null): void => {
				signal?.removeEventListener("abort", onAbort);
				if (answer === null) reject(new Error("Login cancelled"));
				else resolve(answer);
			};
			const onAbort = (): void => {
				this.#pendingAuth.delete(requestId);
				reject(new Error("Login cancelled"));
			};
			this.#pendingAuth.set(requestId, settle);
			signal?.addEventListener("abort", onAbort, { once: true });
			this.#publish({ type: "prompt", requestId, request });
		});
	}

	async logout(providerId: string): Promise<CommandResult> {
		try {
			await this.#runtime.logout(providerId);
			return { ok: true };
		} catch (error) {
			return { ok: false, error: message(error) };
		} finally {
			this.#update(false);
		}
	}

	#update(refreshing: boolean): void {
		this.#state = readState(this.#runtime, refreshing);
		this.#publish({ type: "state", state: this.#state });
	}
}

function readState(runtime: ModelRuntime, refreshing: boolean): ModelsState {
	const models = runtime
		.getAvailableSnapshot()
		.map((model) => ({ provider: model.provider, modelId: model.id, name: model.name }));
	const accounts: ProviderAccount[] = [];
	for (const provider of runtime.getProviders()) {
		const status = runtime.getProviderAuthStatus(provider.id);
		const shared = {
			id: provider.id,
			name: provider.name,
			configured: status.configured,
			...((status.label ?? status.source === undefined) ? {} : { source: status.label ?? status.source }),
		};
		if (provider.auth.oauth) {
			accounts.push({ ...shared, authType: "oauth", interactive: true, methodName: provider.auth.oauth.name });
		}
		if (provider.auth.apiKey) {
			accounts.push({
				...shared,
				authType: "api_key",
				interactive: provider.auth.apiKey.login !== undefined,
				methodName: provider.auth.apiKey.name,
			});
		}
	}
	accounts.sort((left, right) => left.name.localeCompare(right.name));
	return { models, accounts, refreshing };
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
