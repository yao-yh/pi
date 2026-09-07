import {
	type Api,
	contentText,
	type Model,
	type Models,
	type RetryCallbacks,
	type RetryPolicy,
	type Usage,
} from "@earendil-works/pi-ai";

import type { AgentMessage } from "../../types.ts";
import type { Context } from "../context.ts";
import { convertToLlm, createBranchSummaryMessage, createCompactionSummaryMessage } from "../messages.ts";
import type { Branch, Entry, Session } from "../session/index.ts";
import { BranchSummaryError, err, ok, type Result } from "../types.ts";
import {
	completeSimpleWithRetries,
	createSummaryRequestOptions,
	estimateTokens,
	SUMMARIZATION_SYSTEM_PROMPT,
	type SummaryRequest,
} from "./compaction.ts";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
	serializeConversation,
} from "./utils.ts";

/** 已生成、可持久化为分支摘要条目的数据。 */
export interface BranchSummaryResult {
	summary: string;
	usage?: Usage;
	readFiles: string[];
	modifiedFiles: string[];
}

/** 存储在已生成分支摘要条目上的文件操作详情。 */
export interface BranchSummaryDetails {
	/** 探索待摘要分支期间读取的文件。 */
	readFiles: string[];
	/** 探索待摘要分支期间修改的文件。 */
	modifiedFiles: string[];
}

export type { FileOperations } from "./utils.ts";

/** 已准备好进行摘要的分支内容。 */
export interface BranchPreparation {
	/** 为分支摘要选取的消息。 */
	messages: AgentMessage[];
	/** 从分支中提取的文件操作。 */
	fileOps: FileOperations;
	/** 所选消息的估算令牌数。 */
	totalTokens: number;
}

/** 为分支摘要选取的条目。 */
export interface CollectEntriesResult {
	/** 按时间顺序排列的待摘要条目。 */
	entries: Entry[];
	/** 上一个末端条目与目标条目之间最深的公共祖先。 */
	commonAncestorId: string | null;
}

/** 生成分支摘要的选项。 */
export interface GenerateBranchSummaryOptions {
	/** 摘要请求经过的提供方集合，负责解析身份验证信息。 */
	models: Models;
	/** 用于生成摘要的模型。 */
	model: Model<Api>;
	/** 追加到默认提示或替换默认提示的可选指令。 */
	customInstructions?: string;
	/** 使用自定义指令替换默认提示，而不是将其追加到默认提示。 */
	replaceInstructions?: boolean;
	/** 为提示和模型输出预留的令牌数，默认为 16384。 */
	reserveTokens?: number;
	/** 摘要临时错误使用的可选重试策略。 */
	retry?: RetryPolicy;
	/** 用于报告重试状态的可选回调。 */
	callbacks?: RetryCallbacks;
}

/** 在导航到其他会话树条目前，收集应当生成摘要的条目。 */
export async function collectEntriesForBranchSummary(
	branch: Pick<Branch, "findEntries">,
	session: Pick<Session, "getEntry">,
	oldTipId: string | null,
	targetId: string,
	context: Context,
): Promise<CollectEntriesResult> {
	if (!oldTipId) {
		return { entries: [], commonAncestorId: null };
	}
	const oldPath = new Set((await branch.findEntries({ start: oldTipId }, context)).map((entry) => entry.id));
	const targetPath = await branch.findEntries({ start: targetId }, context);
	let commonAncestorId: string | null = null;
	for (const entry of targetPath) {
		if (oldPath.has(entry.id)) {
			commonAncestorId = entry.id;
			break;
		}
	}
	const entries: Entry[] = [];
	let current: string | null = oldTipId;

	while (current && current !== commonAncestorId) {
		const entry = await session.getEntry(current, context);
		if (!entry) throw new Error(`Corrupt session: entry ${current} not found`);
		entries.push(entry);
		current = entry.parentId;
	}
	entries.reverse();

	return { entries, commonAncestorId };
}
function getMessageFromEntry(entry: Entry): AgentMessage | undefined {
	switch (entry.type) {
		case "message":
			if (entry.message.role === "toolResult") return undefined;
			return entry.message;

		case "branch_summary":
			return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);

		case "compaction":
			return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);
		case "custom":
			return undefined;
	}
}

/** 在可选令牌预算内准备待摘要的分支条目。 */
export function prepareBranchEntries(entries: Entry[], tokenBudget: number = 0): BranchPreparation {
	const messages: AgentMessage[] = [];
	const fileOps = createFileOps();
	let totalTokens = 0;
	for (const entry of entries) {
		if (
			entry.type !== "branch_summary" ||
			typeof entry.details !== "object" ||
			entry.details === null ||
			Array.isArray(entry.details)
		) {
			continue;
		}
		if (Array.isArray(entry.details.readFiles)) {
			for (const path of entry.details.readFiles) {
				if (typeof path === "string") fileOps.read.add(path);
			}
		}
		if (Array.isArray(entry.details.modifiedFiles)) {
			for (const path of entry.details.modifiedFiles) {
				if (typeof path === "string") fileOps.edited.add(path);
			}
		}
	}
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = getMessageFromEntry(entry);
		if (!message) continue;
		extractFileOpsFromMessage(message, fileOps);

		const tokens = estimateTokens(message);
		if (tokenBudget > 0 && totalTokens + tokens > tokenBudget) {
			if (entry.type === "compaction" || entry.type === "branch_summary") {
				if (totalTokens < tokenBudget * 0.9) {
					messages.unshift(message);
					totalTokens += tokens;
				}
			}
			break;
		}

		messages.unshift(message);
		totalTokens += tokens;
	}

	return { messages, fileOps, totalTokens };
}

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

/** 为已离开的分支条目生成摘要。 */
export function generateBranchSummary(
	entries: Entry[],
	options: GenerateBranchSummaryOptions,
	context: Context,
): Promise<Result<BranchSummaryResult, BranchSummaryError>> {
	const { models, model, customInstructions, replaceInstructions, reserveTokens = 16384, retry, callbacks } = options;
	const contextWindow = model.contextWindow || 128000;
	const preparation = prepareBranchEntries(entries, contextWindow - reserveTokens);
	return generateBranchSummaryWithRequest(
		preparation,
		{ customInstructions, replaceInstructions },
		(aiContext, requestOptions, requestContext) =>
			completeSimpleWithRetries(models, model, aiContext, requestOptions, retry, callbacks, requestContext),
		context,
	);
}

export interface PreparedBranchSummaryOptions {
	customInstructions?: string;
	replaceInstructions?: boolean;
}

/** 通过调用方持有的单请求边界生成已准备的分支摘要。 */
export async function generateBranchSummaryWithRequest(
	preparation: BranchPreparation,
	options: PreparedBranchSummaryOptions,
	request: SummaryRequest,
	context: Context,
): Promise<Result<BranchSummaryResult, BranchSummaryError>> {
	const { customInstructions, replaceInstructions } = options;
	const { messages, fileOps } = preparation;
	if (messages.length === 0) {
		return ok({ summary: "No content to summarize", readFiles: [], modifiedFiles: [] });
	}
	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);
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
	const response = await request(
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		createSummaryRequestOptions({ maxTokens: 2048 }, context),
		context,
	);
	if (response.stopReason === "aborted") {
		return err(new BranchSummaryError("aborted", response.errorMessage || "Branch summary aborted"));
	}
	if (response.stopReason === "error") {
		return err(
			new BranchSummaryError(
				"summarization_failed",
				`Branch summary failed: ${response.errorMessage || "Unknown error"}`,
			),
		);
	}

	let summary = contentText(response.content);
	summary = BRANCH_SUMMARY_PREAMBLE + summary;
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);

	return ok({
		summary: summary || "No summary generated",
		usage: response.usage,
		readFiles,
		modifiedFiles,
	});
}
