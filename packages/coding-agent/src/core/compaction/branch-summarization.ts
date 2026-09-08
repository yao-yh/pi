/**
 * 树导航使用的分支摘要。
 *
 * 导航到会话树中的其他位置时，生成即将离开分支的摘要，避免上下文丢失。
 */

import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { RetryCallbacks, RetryPolicy } from "@earendil-works/pi-ai";
import { contentText } from "@earendil-works/pi-ai";
import type { Model, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai/compat";
import {
	convertToLlm,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "../messages.ts";
import type { ReadonlySessionManager, SessionEntry } from "../session-manager.ts";
import { completeSummarization, estimateTokens, getSummarizationFailure } from "./compaction.ts";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversation,
} from "./utils.ts";

// ============================================================================
// 类型
// ============================================================================

export interface BranchSummaryResult {
	summary?: string;
	usage?: Usage;
	readFiles?: string[];
	modifiedFiles?: string[];
	aborted?: boolean;
	error?: string;
}

/** 存储在 BranchSummaryEntry.details 中用于文件跟踪的明细 */
export interface BranchSummaryDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

export type { FileOperations } from "./utils.ts";

export interface BranchPreparation {
	/** 按时间顺序提取用于生成摘要的消息 */
	messages: AgentMessage[];
	/** 从工具调用中提取的文件操作 */
	fileOps: FileOperations;
	/** 消息的估算 token 总数 */
	totalTokens: number;
}

export interface CollectEntriesResult {
	/** 按时间顺序排列的待摘要条目 */
	entries: SessionEntry[];
	/** 原位置与新位置的公共祖先节点（如果存在） */
	commonAncestorId: string | null;
}

export interface GenerateBranchSummaryOptions {
	/** 用于生成摘要的模型 */
	model: Model<any>;
	/** 模型的 API 密钥 */
	apiKey?: string;
	/** 模型请求头 */
	headers?: Record<string, string>;
	/** 模型的提供商作用域环境值 */
	env?: Record<string, string>;
	/** 用于取消的中止信号 */
	signal: AbortSignal;
	/** 可选的自定义摘要说明 */
	customInstructions?: string;
	/** 为 true 时，customInstructions 替换默认提示词而非追加 */
	replaceInstructions?: boolean;
	/** 选择分支历史时预留的 token 数（默认 16384） */
	reserveTokens?: number;
	/** 可选的会话流函数，用于在不改变代理状态的情况下保留 SDK 请求行为。 */
	streamFn?: StreamFn;
	/** 摘要瞬时错误的重试策略，复用 coding-agent 的 `settings.retry`。 */
	retry?: RetryPolicy;
	/** 用于报告重试的可选回调（例如 TUI 重试指示器）。 */
	callbacks?: RetryCallbacks;
}

// ============================================================================
// 条目收集
// ============================================================================

/**
 * 收集从一个位置导航到另一个位置时应生成摘要的条目。
 *
 * 从 oldLeafId 回溯到与 targetId 的公共祖先节点，并收集沿途条目。
 * 不会在压缩边界停止；压缩条目会纳入，其摘要成为上下文。
 *
 * @param session - 会话管理器（只读访问）
 * @param oldLeafId - 当前导航起点
 * @param targetId - 导航目标位置
 * @returns 待摘要条目和公共祖先节点
 */
export function collectEntriesForBranchSummary(
	session: ReadonlySessionManager,
	oldLeafId: string | null,
	targetId: string,
): CollectEntriesResult {
	// 没有原位置时无需生成摘要
	if (!oldLeafId) {
		return { entries: [], commonAncestorId: null };
	}

	// 查找公共祖先节点（同时位于两条路径上的最深节点）
	const oldPath = new Set(session.getBranch(oldLeafId).map((e) => e.id));
	const targetPath = session.getBranch(targetId);

	// targetPath 以根节点优先，因此反向迭代查找最深公共祖先节点
	let commonAncestorId: string | null = null;
	for (let i = targetPath.length - 1; i >= 0; i--) {
		if (oldPath.has(targetPath[i].id)) {
			commonAncestorId = targetPath[i].id;
			break;
		}
	}

	// 从原叶节点向公共祖先节点收集条目
	const entries: SessionEntry[] = [];
	let current: string | null = oldLeafId;

	while (current && current !== commonAncestorId) {
		const entry = session.getEntry(current);
		if (!entry) break;
		entries.push(entry);
		current = entry.parentId;
	}

	// 反转为时间顺序
	entries.reverse();

	return { entries, commonAncestorId };
}

// ============================================================================
// 条目到消息的转换
// ============================================================================

/**
 * 从会话条目中提取 AgentMessage。
 * 与 compaction.ts 中的 getMessageFromEntry 类似，但也处理压缩条目。
 */
function getMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	switch (entry.type) {
		case "message":
			// 跳过工具结果，因为上下文已包含在助手的工具调用中
			if (entry.message.role === "toolResult") return undefined;
			return entry.message;

		case "custom_message":
			return createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp);

		case "branch_summary":
			return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);

		case "compaction":
			return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);

		// 这些条目不产生对话内容
		case "thinking_level_change":
		case "model_change":
		case "custom":
		case "label":
		case "session_info":
			return undefined;
	}
}

/**
 * 在 token 预算内准备待摘要条目。
 *
 * 从最新到最旧遍历条目并添加消息，直至达到 token 预算。
 * 这样可在分支过长时保留最近的上下文。
 *
 * 同时从以下位置收集文件操作：
 * - 助手消息中的工具调用
 * - 现有 branch_summary 条目的 details（用于累计跟踪）
 *
 * @param entries - 按时间顺序排列的条目
 * @param tokenBudget - 最多包含的 token 数（0 表示无限制）
 */
export function prepareBranchEntries(entries: SessionEntry[], tokenBudget: number = 0): BranchPreparation {
	const messages: AgentMessage[] = [];
	const fileOps = createFileOps();
	let totalTokens = 0;

	// 第一遍：从所有条目收集文件操作，即使它们超出 token 预算
	// 这样可捕获嵌套分支摘要中的累计文件跟踪信息
	// 仅从 pi 生成的摘要（fromHook !== true）提取，不处理扩展生成的摘要
	for (const entry of entries) {
		if (entry.type === "branch_summary" && !entry.fromHook && entry.details) {
			const details = entry.details as BranchSummaryDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				// 修改过的文件同时加入 edited 和 written，以便正确去重
				for (const f of details.modifiedFiles) {
					fileOps.edited.add(f);
				}
			}
		}
	}

	// 第二遍：从最新到最旧遍历并添加消息，直至达到 token 预算
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = getMessageFromEntry(entry);
		if (!message) continue;

		// 从助手消息的工具调用中提取文件操作
		extractFileOpsFromMessage(message, fileOps);

		const tokens = estimateTokens(message);

		// 添加前检查预算
		if (tokenBudget > 0 && totalTokens + tokens > tokenBudget) {
			// 摘要条目是重要上下文，尽量将其纳入
			if (entry.type === "compaction" || entry.type === "branch_summary") {
				if (totalTokens < tokenBudget * 0.9) {
					messages.unshift(message);
					totalTokens += tokens;
				}
			}
			// 已达到预算，停止处理
			break;
		}

		messages.unshift(message);
		totalTokens += tokens;
	}

	return { messages, fileOps, totalTokens };
}

// ============================================================================
// 摘要生成
// ============================================================================

const BRANCH_SUMMARY_PREAMBLE = `The user explored a different conversation branch before returning here.
Summary of that exploration:

`;

const BRANCH_SUMMARY_PROMPT = `Create a structured summary of this conversation branch for context when returning later.

Use this EXACT format:

## Goal
[What was the user trying to accomplish in this branch?]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Work that was started but not finished]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What should happen next to continue this work]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/**
 * 为已离开的分支条目生成摘要。
 *
 * @param entries - 按时间顺序排列的待摘要会话条目
 * @param options - 生成选项
 */
export async function generateBranchSummary(
	entries: SessionEntry[],
	options: GenerateBranchSummaryOptions,
): Promise<BranchSummaryResult> {
	const {
		model,
		apiKey,
		headers,
		env,
		signal,
		customInstructions,
		replaceInstructions,
		reserveTokens = 16384,
		streamFn,
		retry,
		callbacks,
	} = options;

	// token 预算等于上下文窗口减去为提示词和响应预留的空间
	const contextWindow = model.contextWindow || 128000;
	const tokenBudget = contextWindow - reserveTokens;

	const { messages, fileOps } = prepareBranchEntries(entries, tokenBudget);

	if (messages.length === 0) {
		return { summary: "No content to summarize" };
	}

	// 转换为 LLM 兼容消息，再序列化为文本
	// 序列化可防止模型将其视为需要继续的对话
	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);

	// 构建提示词
	let instructions: string;
	if (replaceInstructions && customInstructions) {
		instructions = customInstructions;
	} else if (customInstructions) {
		instructions = `${BRANCH_SUMMARY_PROMPT}\n\nAdditional focus: ${customInstructions}`;
	} else {
		instructions = BRANCH_SUMMARY_PROMPT;
	}
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${instructions}`;

	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	const maxTokens = Math.min(4096, model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY);

	// 调用 LLM 生成摘要。优先使用会话流函数，在不经过代理状态/事件的情况下，
	// 保持 SDK 请求行为（超时、重试、归属请求头）一致。
	// 通过 completeSummarization 重试，使瞬时流中断复用已配置的重试策略。
	const context = { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages };
	const requestOptions: SimpleStreamOptions = { apiKey, headers, env, signal, maxTokens };
	const response = await completeSummarization(model, context, requestOptions, streamFn, retry, callbacks);

	// 检查是否已中止或出错
	if (response.stopReason === "aborted") {
		return { aborted: true };
	}
	const failure = getSummarizationFailure(response, "Branch summarization");
	if (failure) {
		return { error: failure };
	}
	if (response.content.some((block) => block.type === "toolCall")) {
		return { error: "Branch summarization attempted to call a tool" };
	}

	let summary = contentText(response.content);

	// 前置引言，为分支摘要提供上下文
	summary = BRANCH_SUMMARY_PREAMBLE + summary;

	// 计算文件列表并追加到摘要
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);

	return {
		summary: summary || "No summary generated",
		usage: response.usage,
		readFiles,
		modifiedFiles,
	};
}
