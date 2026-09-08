import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "./session-manager.ts";

/**
 * 提示词缓存 TTL：超过此值的空闲间隔值得标记为缓存未命中的可能原因。
 * Anthropic 的默认缓存 TTL 为 5 分钟。
 */
export const CACHE_TTL_MS = 5 * 60 * 1000;

/** 每轮不超过此值的未命中属于缓存断点粒度噪声。 */
const NOISE_FLOOR_TOKENS = 1024;

/** 单条助手消息中计入统计的缓存未命中。 */
export interface CacheMiss {
	/** 上一轮提示词中存在但未从缓存读取的提示词 token。 */
	missedTokens: number;
	/** 相比完整缓存命中多支付的费用；价格未知时为 0。 */
	missedCost: number;
	/** 距离上一次请求（最近一次刷新缓存）的毫秒数。 */
	idleMs: number;
	/** 相比上一次请求模型发生变化时为 true。 */
	modelChanged: boolean;
}

export interface CacheWasteTotals {
	missedTokens: number;
	missedCost: number;
	/** 计入统计的未命中次数（超过噪声下限的轮次）。 */
	missCount: number;
}

/** 最小价格查询接口，由 ModelRuntime 实现；费用单位为美元/百万 token。 */
export interface ModelPriceSource {
	getModel(provider: string, modelId: string): { cost: { cacheRead: number } } | undefined;
}

/** 扫描遇到的最后一个请求；其提示词中的所有内容都应已缓存。 */
interface PreviousRequest {
	promptTokens: number;
	modelKey: string;
	timestamp: number;
	/**
	 * 粘性状态：此扫描段中的某个较早请求报告过缓存活动。
	 * 用于区分只报告缓存读取的提供商（OpenAI 风格，不报告写入）发生完整未命中，
	 * 与提供商从不报告任何缓存活动这两种情况。
	 */
	reportedCache: boolean;
}

/**
 * 计算一条助手消息相对于上一次请求的缓存未命中。
 * 以下无需计数时返回 undefined：首轮、重置后、从未报告缓存活动
 * （提供商不支持缓存），或未命中低于噪声下限。
 */
function detectMiss(
	prev: PreviousRequest | undefined,
	message: AssistantMessage,
	models: ModelPriceSource,
): CacheMiss | undefined {
	const usage = message.usage;
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	// 仅当此前报告过缓存活动时，缓存量为零的轮次才计入统计：
	// 对只报告缓存读取的提供商，这表示完整未命中；
	// 对从不报告缓存的提供商，这没有统计意义。
	if (!prev || promptTokens <= 0 || (usage.cacheRead + usage.cacheWrite === 0 && !prev.reportedCache)) {
		return undefined;
	}

	const missedTokens = Math.min(prev.promptTokens, promptTokens) - usage.cacheRead;
	if (missedTokens <= NOISE_FLOOR_TOKENS) return undefined;

	// 额外费用等于未命中 token 按实际支付费率（input/cacheWrite，包含写入溢价）
	// 而非缓存读取费率计费的差额。未命中 token 只会落入 input 或 cacheWrite，
	// 因此支付费率直接取自该消息自身的费用明细。
	const paidTokens = usage.input + usage.cacheWrite;
	const paidPerToken = paidTokens > 0 ? (usage.cost.input + usage.cost.cacheWrite) / paidTokens : 0;
	const readPerToken =
		usage.cacheRead > 0
			? usage.cost.cacheRead / usage.cacheRead
			: (models.getModel(message.provider, message.model)?.cost.cacheRead ?? 0) / 1_000_000;

	return {
		missedTokens,
		missedCost: missedTokens * Math.max(0, paidPerToken - readPerToken),
		idleMs: Math.max(0, message.timestamp - prev.timestamp),
		modelChanged: `${message.provider}/${message.model}` !== prev.modelKey,
	};
}

function asPreviousRequest(message: AssistantMessage, reportedCache: boolean): PreviousRequest | undefined {
	const usage = message.usage;
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	if (promptTokens <= 0) return undefined;
	return {
		promptTokens,
		modelKey: `${message.provider}/${message.model}`,
		timestamp: message.timestamp,
		reportedCache: reportedCache || usage.cacheRead + usage.cacheWrite > 0,
	};
}

function scan(
	entries: SessionEntry[],
	models: ModelPriceSource,
): { prev: PreviousRequest | undefined; totals: CacheWasteTotals; misses: Map<AssistantMessage, CacheMiss> } {
	let prev: PreviousRequest | undefined;
	const totals: CacheWasteTotals = { missedTokens: 0, missedCost: 0, missCount: 0 };
	const misses = new Map<AssistantMessage, CacheMiss>();

	for (const entry of entries) {
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			// 上下文已合理变化；下一轮提示词是新内容，并非重复计费内容。
			// 模型切换不在豁免范围内：它会让完整提示词重新计费，应计入统计。
			prev = undefined;
			continue;
		}
		if (entry.type === "message" && entry.message.role === "assistant") {
			const miss = detectMiss(prev, entry.message, models);
			if (miss) {
				totals.missedTokens += miss.missedTokens;
				totals.missedCost += miss.missedCost;
				totals.missCount += 1;
				misses.set(entry.message, miss);
			}
			prev = asPreviousRequest(entry.message, prev?.reportedCache ?? false) ?? prev;
		}
	}
	return { prev, totals, misses };
}

/**
 * 会话累计缓存浪费：本应从缓存读取（已存在于上一轮提示词中）
 * 却被重新计费的提示词 token。
 */
export function computeCacheWaste(entries: SessionEntry[], models: ModelPriceSource): CacheWasteTotals {
	return scan(entries, models).totals;
}

/**
 * 会话中所有计入统计的缓存未命中，以产生费用的助手消息引用为键。
 * 从条目重建聊天区时（恢复会话、压缩后重建）用于重新推导对话记录通知。
 */
export function collectCacheMisses(
	entries: SessionEntry[],
	models: ModelPriceSource,
): Map<AssistantMessage, CacheMiss> {
	return scan(entries, models).misses;
}

/**
 * 检测刚完成的助手消息是否发生缓存未命中。
 * `entries` 此时不得包含 `message`（message_end 在持久化前触发）。
 */
export function detectCacheMiss(
	entries: SessionEntry[],
	message: AssistantMessage,
	models: ModelPriceSource,
): CacheMiss | undefined {
	return detectMiss(scan(entries, models).prev, message, models);
}
