/**
 * 用于以编程方式访问编码代理的 RPC 客户端。
 *
 * 以 RPC 模式启动代理，并为所有操作提供类型化 API。
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { SessionStats } from "../../core/agent-session.ts";
import type { BashResult } from "../../core/bash-executor.ts";
import type { CompactionResult } from "../../core/compaction/index.ts";
import type { SessionEntry, SessionTreeNode } from "../../core/session-manager.ts";
import type { JsonAgentSessionEvent } from "../json-event.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import type { RpcCommand, RpcResponse, RpcSessionState, RpcSlashCommand } from "./rpc-types.ts";

// ============================================================================
// 类型
// ============================================================================

/** 适用于联合类型的分布式 Omit */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** 不含 id 字段的 RpcCommand（供内部发送使用） */
type RpcCommandBody = DistributiveOmit<RpcCommand, "id">;

export interface RpcClientOptions {
	/** CLI 入口点路径（默认查找 dist/cli.js） */
	cliPath?: string;
	/** 代理的工作目录 */
	cwd?: string;
	/** 环境变量 */
	env?: Record<string, string>;
	/** 要使用的提供商 */
	provider?: string;
	/** 要使用的模型 ID */
	model?: string;
	/** 其他 CLI 参数 */
	args?: string[];
}

export interface ModelInfo {
	provider: string;
	id: string;
	contextWindow: number;
	reasoning: boolean;
}

export type RpcEventListener = (event: JsonAgentSessionEvent) => void;

// ============================================================================
// RPC 客户端
// ============================================================================

export class RpcClient {
	private process: ChildProcess | null = null;
	private stopReadingStdout: (() => void) | null = null;
	private eventListeners: RpcEventListener[] = [];
	private pendingRequests: Map<string, { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }> =
		new Map();
	private requestId = 0;
	private stderr = "";
	private exitError: Error | null = null;
	private options: RpcClientOptions;

	constructor(options: RpcClientOptions = {}) {
		this.options = options;
	}

	/**
	 * 启动 RPC 代理进程。
	 */
	async start(): Promise<void> {
		if (this.process) {
			throw new Error("Client already started");
		}

		this.exitError = null;

		const cliPath = this.options.cliPath ?? "dist/cli.js";
		const args = ["--mode", "rpc"];

		if (this.options.provider) {
			args.push("--provider", this.options.provider);
		}
		if (this.options.model) {
			args.push("--model", this.options.model);
		}
		if (this.options.args) {
			args.push(...this.options.args);
		}

		const childProcess = spawn("node", [cliPath, ...args], {
			cwd: this.options.cwd,
			env: { ...process.env, ...this.options.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.process = childProcess;

		// 收集 stderr 以便调试
		childProcess.stderr?.on("data", (data) => {
			this.stderr += data.toString();
			process.stderr.write(data);
		});

		childProcess.once("exit", (code, signal) => {
			if (this.process !== childProcess) return;
			const error = this.createProcessExitError(code, signal);
			this.exitError = error;
			this.rejectPendingRequests(error);
		});
		childProcess.once("error", (error) => {
			if (this.process !== childProcess) return;
			const processError = new Error(`Agent process error: ${error.message}. Stderr: ${this.stderr}`);
			this.exitError = processError;
			this.rejectPendingRequests(processError);
		});
		childProcess.stdin?.on("error", (error) => {
			if (this.process !== childProcess) return;
			const stdinError =
				this.exitError ?? new Error(`Agent process stdin error: ${error.message}. Stderr: ${this.stderr}`);
			this.exitError = stdinError;
			this.rejectPendingRequests(stdinError);
		});

		// 为 stdout 设置严格的 JSONL 读取器。
		this.stopReadingStdout = attachJsonlLineReader(childProcess.stdout!, (line) => {
			this.handleLine(line);
		});

		// 短暂等待进程完成初始化
		await new Promise((resolve) => setTimeout(resolve, 100));

		if (this.process.exitCode !== null) {
			const error = this.exitError ?? this.createProcessExitError(this.process.exitCode, this.process.signalCode);
			this.exitError = error;
			throw error;
		}
	}

	/**
	 * 停止 RPC 代理进程。
	 */
	async stop(): Promise<void> {
		if (!this.process) return;

		this.stopReadingStdout?.();
		this.stopReadingStdout = null;
		this.process.kill("SIGTERM");

		// 等待进程退出
		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				this.process?.kill("SIGKILL");
				resolve();
			}, 1000);

			this.process?.on("exit", () => {
				clearTimeout(timeout);
				resolve();
			});
		});

		this.process = null;
		this.pendingRequests.clear();
	}

	/**
	 * 订阅代理事件。
	 */
	onEvent(listener: RpcEventListener): () => void {
		this.eventListeners.push(listener);
		return () => {
			const index = this.eventListeners.indexOf(listener);
			if (index !== -1) {
				this.eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * 获取已收集的 stderr 输出（便于调试）。
	 */
	getStderr(): string {
		return this.stderr;
	}

	// =========================================================================
	// 命令方法
	// =========================================================================

	/**
	 * 向代理发送提示词。
	 * 发送后立即返回；使用 onEvent() 接收流式事件。
	 * 使用 waitForIdle() 等待完成。
	 */
	async prompt(message: string, images?: ImageContent[]): Promise<void> {
		await this.send({ type: "prompt", message, images });
	}

	/**
	 * 将引导消息加入队列，以便在代理运行过程中中断并调整方向。
	 */
	async steer(message: string, images?: ImageContent[]): Promise<void> {
		await this.send({ type: "steer", message, images });
	}

	/**
	 * 将后续消息加入队列，待代理完成后处理。
	 */
	async followUp(message: string, images?: ImageContent[]): Promise<void> {
		await this.send({ type: "follow_up", message, images });
	}

	/**
	 * 中止当前操作。
	 */
	async abort(): Promise<void> {
		await this.send({ type: "abort" });
	}

	/**
	 * 清除队列中的引导消息和后续消息，并返回其文本。
	 */
	async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
		const response = await this.send({ type: "clear_queue" });
		return this.getData(response);
	}

	/**
	 * 启动新会话，可选择跟踪父会话。
	 * @param parentSession - 用于跟踪会话谱系的可选父会话路径
	 * @returns 如果扩展取消了新会话，则返回包含 `cancelled: true` 的对象
	 */
	async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "new_session", parentSession });
		return this.getData(response);
	}

	/**
	 * 获取当前会话状态。
	 */
	async getState(): Promise<RpcSessionState> {
		const response = await this.send({ type: "get_state" });
		return this.getData(response);
	}

	/**
	 * 按提供商和 ID 设置模型。
	 */
	async setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
		const response = await this.send({ type: "set_model", provider, modelId });
		return this.getData(response);
	}

	/**
	 * 循环切换到下一个模型。
	 */
	async cycleModel(): Promise<{
		model: { provider: string; id: string };
		thinkingLevel: ThinkingLevel;
		isScoped: boolean;
	} | null> {
		const response = await this.send({ type: "cycle_model" });
		return this.getData(response);
	}

	/**
	 * 获取可用模型列表。
	 */
	async getAvailableModels(): Promise<ModelInfo[]> {
		const response = await this.send({ type: "get_available_models" });
		return this.getData<{ models: ModelInfo[] }>(response).models;
	}

	/**
	 * 设置思考级别。
	 */
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		await this.send({ type: "set_thinking_level", level });
	}

	/**
	 * 循环切换思考级别。
	 */
	async cycleThinkingLevel(): Promise<{ level: ThinkingLevel } | null> {
		const response = await this.send({ type: "cycle_thinking_level" });
		return this.getData(response);
	}

	/**
	 * 获取当前模型可用的思考级别列表。
	 */
	async getAvailableThinkingLevels(): Promise<ThinkingLevel[]> {
		const response = await this.send({ type: "get_available_thinking_levels" });
		return this.getData<{ levels: ThinkingLevel[] }>(response).levels;
	}

	/**
	 * 设置引导消息处理模式。
	 */
	async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.send({ type: "set_steering_mode", mode });
	}

	/**
	 * 设置后续消息处理模式。
	 */
	async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.send({ type: "set_follow_up_mode", mode });
	}

	/**
	 * 压缩会话上下文。
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		const response = await this.send({ type: "compact", customInstructions });
		return this.getData(response);
	}

	/**
	 * 启用或禁用自动压缩。
	 */
	async setAutoCompaction(enabled: boolean): Promise<void> {
		await this.send({ type: "set_auto_compaction", enabled });
	}

	/**
	 * 启用或禁用自动重试。
	 */
	async setAutoRetry(enabled: boolean): Promise<void> {
		await this.send({ type: "set_auto_retry", enabled });
	}

	/**
	 * 中止正在进行的重试。
	 */
	async abortRetry(): Promise<void> {
		await this.send({ type: "abort_retry" });
	}

	/**
	 * 执行 bash 命令。
	 */
	async bash(command: string): Promise<BashResult> {
		const response = await this.send({ type: "bash", command });
		return this.getData(response);
	}

	/**
	 * 中止正在运行的 bash 命令。
	 */
	async abortBash(): Promise<void> {
		await this.send({ type: "abort_bash" });
	}

	/**
	 * 获取会话统计信息。
	 */
	async getSessionStats(): Promise<SessionStats> {
		const response = await this.send({ type: "get_session_stats" });
		return this.getData(response);
	}

	/**
	 * 将会话导出为 HTML。
	 */
	async exportHtml(outputPath?: string): Promise<{ path: string }> {
		const response = await this.send({ type: "export_html", outputPath });
		return this.getData(response);
	}

	/**
	 * 切换到其他会话文件。
	 * @returns 如果扩展取消了切换，则返回包含 `cancelled: true` 的对象
	 */
	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "switch_session", sessionPath });
		return this.getData(response);
	}

	/**
	 * 从指定消息创建分支。
	 * @returns 包含 `text`（消息文本）和 `cancelled`（扩展是否已取消）的对象
	 */
	async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
		const response = await this.send({ type: "fork", entryId });
		return this.getData(response);
	}

	/**
	 * 将当前活动分支克隆到新会话。
	 * @returns 如果扩展取消了克隆，则返回包含 `cancelled: true` 的对象
	 */
	async clone(): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "clone" });
		return this.getData(response);
	}

	/**
	 * 获取可用于创建分支的消息。
	 */
	async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
		const response = await this.send({ type: "get_fork_messages" });
		return this.getData<{ messages: Array<{ entryId: string; text: string }> }>(response).messages;
	}

	/**
	 * 按追加顺序获取会话条目，也可仅获取 `since` 条目 ID 之后的条目。
	 */
	async getEntries(since?: string): Promise<{ entries: SessionEntry[]; leafId: string | null }> {
		const response = await this.send({ type: "get_entries", since });
		return this.getData<{ entries: SessionEntry[]; leafId: string | null }>(response);
	}

	/**
	 * 获取会话条目树。
	 */
	async getTree(): Promise<{ tree: SessionTreeNode[]; leafId: string | null }> {
		const response = await this.send({ type: "get_tree" });
		return this.getData<{ tree: SessionTreeNode[]; leafId: string | null }>(response);
	}

	/**
	 * 获取最后一条助手消息的文本。
	 */
	async getLastAssistantText(): Promise<string | null> {
		const response = await this.send({ type: "get_last_assistant_text" });
		return this.getData<{ text: string | null }>(response).text;
	}

	/**
	 * 设置会话显示名称。
	 */
	async setSessionName(name: string): Promise<void> {
		await this.send({ type: "set_session_name", name });
	}

	/**
	 * 获取会话中的所有消息。
	 */
	async getMessages(): Promise<AgentMessage[]> {
		const response = await this.send({ type: "get_messages" });
		return this.getData<{ messages: AgentMessage[] }>(response).messages;
	}

	/**
	 * 获取可用命令（扩展命令、提示词模板和 skill）。
	 */
	async getCommands(): Promise<RpcSlashCommand[]> {
		const response = await this.send({ type: "get_commands" });
		return this.getData<{ commands: RpcSlashCommand[] }>(response).commands;
	}

	// =========================================================================
	// 辅助方法
	// =========================================================================

	/**
	 * 等待代理进入空闲状态（无流式输出）。
	 * 收到 agent_settled 事件时完成。
	 */
	waitForIdle(timeout = 60000): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				unsubscribe();
				reject(new Error(`Timeout waiting for agent to become idle. Stderr: ${this.stderr}`));
			}, timeout);

			const unsubscribe = this.onEvent((event) => {
				if (event.type === "agent_settled") {
					clearTimeout(timer);
					unsubscribe();
					resolve();
				}
			});
		});
	}

	/**
	 * 收集事件，直至代理进入空闲状态。
	 */
	collectEvents(timeout = 60000): Promise<JsonAgentSessionEvent[]> {
		return new Promise((resolve, reject) => {
			const events: JsonAgentSessionEvent[] = [];
			const timer = setTimeout(() => {
				unsubscribe();
				reject(new Error(`Timeout collecting events. Stderr: ${this.stderr}`));
			}, timeout);

			const unsubscribe = this.onEvent((event) => {
				events.push(event);
				if (event.type === "agent_settled") {
					clearTimeout(timer);
					unsubscribe();
					resolve(events);
				}
			});
		});
	}

	/**
	 * 发送提示词并等待完成，返回所有事件。
	 */
	async promptAndWait(message: string, images?: ImageContent[], timeout = 60000): Promise<JsonAgentSessionEvent[]> {
		const eventsPromise = this.collectEvents(timeout);
		await this.prompt(message, images);
		return eventsPromise;
	}

	// =========================================================================
	// 内部实现
	// =========================================================================

	private handleLine(line: string): void {
		try {
			const data = JSON.parse(line);

			// 检查该数据是否为待处理请求的响应
			if (data.type === "response" && data.id && this.pendingRequests.has(data.id)) {
				const pending = this.pendingRequests.get(data.id)!;
				this.pendingRequests.delete(data.id);
				pending.resolve(data as RpcResponse);
				return;
			}

			// 否则将其视为事件
			for (const listener of this.eventListeners) {
				listener(data as JsonAgentSessionEvent);
			}
		} catch {
			// 忽略非 JSON 行
		}
	}

	private createProcessExitError(code: number | null, signal: NodeJS.Signals | null): Error {
		return new Error(`Agent process exited (code=${code} signal=${signal}). Stderr: ${this.stderr}`);
	}

	private rejectPendingRequests(error: Error): void {
		for (const pending of this.pendingRequests.values()) {
			pending.reject(error);
		}
		this.pendingRequests.clear();
	}

	private async send(command: RpcCommandBody): Promise<RpcResponse> {
		const childProcess = this.process;
		const stdin = childProcess?.stdin;
		if (!childProcess || !stdin) {
			throw new Error("Client not started");
		}
		if (this.exitError) {
			throw this.exitError;
		}
		if (childProcess.exitCode !== null) {
			const error = this.createProcessExitError(childProcess.exitCode, childProcess.signalCode);
			this.exitError = error;
			throw error;
		}
		if (stdin.destroyed || !stdin.writable) {
			const error = new Error(`Agent process stdin is not writable. Stderr: ${this.stderr}`);
			this.exitError = error;
			throw error;
		}

		const id = `req_${++this.requestId}`;
		const fullCommand = { ...command, id } as RpcCommand;

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`Timeout waiting for response to ${command.type}. Stderr: ${this.stderr}`));
			}, 30000);

			this.pendingRequests.set(id, {
				resolve: (response) => {
					clearTimeout(timeout);
					resolve(response);
				},
				reject: (error) => {
					clearTimeout(timeout);
					reject(error);
				},
			});

			try {
				stdin.write(serializeJsonLine(fullCommand));
			} catch (error: unknown) {
				const writeError = error instanceof Error ? error : new Error(String(error));
				const pending = this.pendingRequests.get(id);
				this.pendingRequests.delete(id);
				pending?.reject(writeError);
			}
		});
	}

	private getData<T>(response: RpcResponse): T {
		if (!response.success) {
			const errorResponse = response as Extract<RpcResponse, { success: false }>;
			throw new Error(errorResponse.error);
		}
		// 类型断言：根据已发送的命令，信任 response.data 与 T 匹配。
		// 这是安全的，因为每个公共方法都为其命令指定了正确的 T。
		const successResponse = response as Extract<RpcResponse, { success: true; data: unknown }>;
		return successResponse.data as T;
	}
}
