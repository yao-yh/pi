import { defaultProviderAuthContext as defaultAuthContext } from "./auth/context.ts";
import { InMemoryCredentialStore } from "./auth/credential-store.ts";
import { type AuthResolutionOverrides, ModelsError, resolveProviderAuth } from "./auth/resolve.ts";
import type { AuthContext, AuthResult, CredentialStore, ProviderAuth } from "./auth/types.ts";
import type { CreateModelsOptions } from "./models.ts";
import type { AssistantImages, ImagesApi, ImagesContext, ImagesModel, ImagesOptions, ProviderImages } from "./types.ts";

/**
 * 图像生成提供商：图像侧与 `Provider` 对应的抽象。
 * 负责 id/name 元数据、身份验证、模型列表和生成行为。
 */
export interface ImagesProvider {
	readonly id: string;
	readonly name: string;

	/**
	 * 必填：`apiKey`/`oauth` 至少提供一项。语义与聊天提供商相同；
	 * 提供商未配置时，`ImagesModels.getAuth()` 返回 undefined。
	 */
	readonly auth: ProviderAuth;

	/**
	 * 同步返回当前已知模型。静态提供商返回其目录；动态提供商返回上次
	 * `refreshModels()` 后的列表（首次刷新前为空）。不得抛出异常；
	 * `ImagesModels` 会将抛出异常的实现视为没有模型。
	 */
	getModels(): readonly ImagesModel<ImagesApi>[];

	/**
	 * 仅供动态提供商使用：获取并更新模型列表。可能因网络问题被拒绝；
	 * 拒绝后模型列表保持最近已知状态，后续调用会重试。
	 */
	refreshModels?(): Promise<void>;

	generateImages(
		model: ImagesModel<ImagesApi>,
		context: ImagesContext,
		options?: ImagesOptions,
	): Promise<AssistantImages>;
}

/**
 * 图像生成提供商的运行时集合，同时负责应用身份验证并提供便捷生成接口：
 * 图像侧与 `Models` 对应的抽象。
 */
export interface ImagesModels {
	getProviders(): readonly ImagesProvider[];
	getProvider(id: string): ImagesProvider | undefined;

	/**
	 * 同步读取一个或所有提供商最近已知的模型。
	 * 尽力而为：提供商的 `getModels()` 抛出异常时，不返回其任何模型。
	 */
	getModels(provider?: string): readonly ImagesModel<ImagesApi>[];

	/** 在最近已知列表中同步查找运行时模型。 */
	getModel(provider: string, id: string): ImagesModel<ImagesApi> | undefined;

	/**
	 * 要求动态提供商重新获取模型列表。指定提供商 id 时，如果该提供商获取失败，
	 * 则以 `ModelsError`（"model_source"）拒绝；未指定时，尽力并发刷新所有提供商。
	 * 静态提供商（没有 `refreshModels`）不执行任何操作。
	 */
	refresh(provider?: string): Promise<void>;

	/**
	 * 按提供商 id 或图像模型解析请求身份验证。契约与 `Models.getAuth()` 相同：
	 * 未知或未配置时返回 undefined，实际失败时以
	 * `ModelsError`（"oauth"/"auth"）拒绝。
	 */
	getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	getAuth(model: ImagesModel<ImagesApi>, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;

	/**
	 * 解析并合并身份验证后，通过所属提供商生成图像（每个字段均以显式选项优先）。
	 * 永不拒绝；失败以 `stopReason: "error"` 的 `AssistantImages` 返回。
	 */
	generateImages(
		model: ImagesModel<ImagesApi>,
		context: ImagesContext,
		options?: ImagesOptions,
	): Promise<AssistantImages>;
}

export interface MutableImagesModels extends ImagesModels {
	/** 按 provider.id 插入或替换。提供商 id 唯一。 */
	setProvider(provider: ImagesProvider): void;
	deleteProvider(id: string): void;
	clearProviders(): void;
}

class ImagesModelsImpl implements MutableImagesModels {
	private providers = new Map<string, ImagesProvider>();
	private credentials: CredentialStore;
	private authContext: AuthContext;

	constructor(options?: CreateModelsOptions) {
		this.credentials = options?.credentials ?? new InMemoryCredentialStore();
		this.authContext = options?.authContext ?? defaultAuthContext();
	}

	setProvider(provider: ImagesProvider): void {
		this.providers.set(provider.id, provider);
	}

	deleteProvider(id: string): void {
		this.providers.delete(id);
	}

	clearProviders(): void {
		this.providers.clear();
	}

	getProviders(): readonly ImagesProvider[] {
		return Array.from(this.providers.values());
	}

	getProvider(id: string): ImagesProvider | undefined {
		return this.providers.get(id);
	}

	getModels(provider?: string): readonly ImagesModel<ImagesApi>[] {
		if (provider !== undefined) {
			const entry = this.providers.get(provider);
			if (!entry) return [];
			try {
				return entry.getModels();
			} catch {
				return [];
			}
		}

		const models: ImagesModel<ImagesApi>[] = [];
		for (const entry of this.providers.values()) {
			try {
				models.push(...entry.getModels());
			} catch {
				// 尽力而为：行为异常的提供商不返回任何模型。
			}
		}
		return models;
	}

	getModel(provider: string, id: string): ImagesModel<ImagesApi> | undefined {
		return this.getModels(provider).find((model) => model.id === id);
	}

	async refresh(provider?: string): Promise<void> {
		if (provider !== undefined) {
			const entry = this.providers.get(provider);
			if (!entry?.refreshModels) return;
			try {
				await entry.refreshModels();
			} catch (error) {
				if (error instanceof ModelsError) throw error;
				throw new ModelsError("model_source", `Model refresh failed for ${provider}`, { cause: error });
			}
			return;
		}

		// 不会拒绝：异步映射器会将行为异常提供商的同步抛出也转为拒绝，
		// 而 allSettled 会捕获全部拒绝。
		await Promise.allSettled(Array.from(this.providers.values(), async (entry) => entry.refreshModels?.()));
	}

	getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	getAuth(model: ImagesModel<ImagesApi>, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	async getAuth(
		providerOrModel: string | ImagesModel<ImagesApi>,
		overrides?: AuthResolutionOverrides,
	): Promise<AuthResult | undefined> {
		const providerId = typeof providerOrModel === "string" ? providerOrModel : providerOrModel.provider;
		const provider = this.providers.get(providerId);
		if (!provider) return undefined;
		return resolveProviderAuth(provider, this.credentials, this.authContext, overrides);
	}

	async generateImages(
		model: ImagesModel<ImagesApi>,
		context: ImagesContext,
		options?: ImagesOptions,
	): Promise<AssistantImages> {
		try {
			const provider = this.providers.get(model.provider);
			if (!provider) {
				throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
			}

			const resolution = await this.getAuth(model, {
				apiKey: options?.apiKey,
				env: options?.env,
				signal: options?.signal,
			});
			const auth = resolution?.auth;
			if (!auth) {
				return provider.generateImages(model, context, options);
			}

			const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;

			// 每个字段均以显式请求选项优先；headers/env 按键合并。
			const apiKey = options?.apiKey ?? auth.apiKey;
			const headers = auth.headers || options?.headers ? { ...auth.headers, ...options?.headers } : undefined;
			const env =
				resolution.env || options?.env ? { ...(resolution.env ?? {}), ...(options?.env ?? {}) } : undefined;

			return await provider.generateImages(requestModel, context, { ...options, apiKey, headers, env });
		} catch (error) {
			return {
				api: model.api,
				provider: model.provider,
				model: model.id,
				output: [],
				stopReason: "error",
				errorMessage: error instanceof Error ? error.message : String(error),
				timestamp: Date.now(),
			};
		}
	}
}

export function createImagesModels(options?: CreateModelsOptions): MutableImagesModels {
	return new ImagesModelsImpl(options);
}

export interface CreateImagesProviderOptions {
	id: string;
	/** 显示名称，默认为 `id`。 */
	name?: string;
	/** 必填——每个提供商都有身份验证语义，包括环境凭据或无密钥提供商。 */
	auth: ProviderAuth;
	/** 初始模型列表（纯动态提供商为空）。 */
	models: readonly ImagesModel<ImagesApi>[];
	/**
	 * 动态提供商：获取当前列表。成功后存储；并发调用共享同一个进行中的获取请求。
	 * 可能被拒绝：此时已存储列表保持最近已知状态，拒绝会传播给
	 * `refreshModels()` 的调用方（由 `ImagesModels.refresh(provider)` 包装为
	 * ModelsError "model_source"），后续调用会重试。
	 */
	refreshModels?: () => Promise<readonly ImagesModel<ImagesApi>[]>;
	api: ProviderImages;
}

/** 根据各组成部分构建图像生成提供商。 */
export function createImagesProvider(input: CreateImagesProviderOptions): ImagesProvider {
	let models = input.models;
	let inflightRefresh: Promise<void> | undefined;
	const refreshModels = input.refreshModels;

	return {
		id: input.id,
		name: input.name ?? input.id,
		auth: input.auth,
		getModels: () => models,
		refreshModels: refreshModels
			? () => {
					inflightRefresh ??= (async () => {
						try {
							models = await refreshModels();
						} finally {
							inflightRefresh = undefined;
						}
					})();
					return inflightRefresh;
				}
			: undefined,
		generateImages: (model, context, options) => input.api.generateImages(model, context, options),
	};
}
