import type { Api, Model } from "./types.ts";

export interface ModelsStoreEntry {
	models: readonly Model<Api>[];
	/** 远程目录 Last-Modified 响应头中的 Unix 时间戳。 */
	lastModified?: number;
	/** 上次完成远程检查时的 Unix 时间戳。 */
	checkedAt?: number;
	/**
	 * 远程目录 ETag 响应头中的不透明校验值，按原样存储（包括引号），
	 * 并通过 If-None-Match 原样回传。
	 */
	etag?: string;
}

export interface ModelsStoreOperationOptions {
	signal?: AbortSignal;
}

/** 以提供商 ID 为键的持久化模型目录。 */
export interface ModelsStore {
	read(providerId: string, options?: ModelsStoreOperationOptions): Promise<ModelsStoreEntry | undefined>;
	write(providerId: string, entry: ModelsStoreEntry, options?: ModelsStoreOperationOptions): Promise<void>;
	delete(providerId: string, options?: ModelsStoreOperationOptions): Promise<void>;
}

export class InMemoryModelsStore implements ModelsStore {
	private readonly entries = new Map<string, ModelsStoreEntry>();

	async read(providerId: string, options?: ModelsStoreOperationOptions): Promise<ModelsStoreEntry | undefined> {
		options?.signal?.throwIfAborted();
		const entry = this.entries.get(providerId);
		return entry ? structuredClone(entry) : undefined;
	}

	async write(providerId: string, entry: ModelsStoreEntry, options?: ModelsStoreOperationOptions): Promise<void> {
		options?.signal?.throwIfAborted();
		this.entries.set(providerId, structuredClone(entry));
	}

	async delete(providerId: string, options?: ModelsStoreOperationOptions): Promise<void> {
		options?.signal?.throwIfAborted();
		this.entries.delete(providerId);
	}
}
