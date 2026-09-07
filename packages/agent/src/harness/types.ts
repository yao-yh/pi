import type { SimpleStreamOptions, Transport } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";
import type { AgentTool, AgentToolResult } from "../types.ts";
import type { Context } from "./context.ts";
import type { JsonValue } from "./session/types.ts";
import type { TruncationResult } from "./utils/truncate.ts";

/** 可失败操作的结果。预期失败以 `ok: false` 返回，而不是抛出异常。 */
export type Result<TValue, TError> = { ok: true; value: TValue } | { ok: false; error: TError };

/** 创建成功的 {@link Result}。 */
export function ok<TValue, TError>(value: TValue): Result<TValue, TError> {
	return { ok: true, value };
}

/** 创建失败的 {@link Result}。 */
export function err<TValue, TError>(error: TError): Result<TValue, TError> {
	return { ok: false, error };
}

/** 返回成功值或抛出失败错误。用于测试和显式适配器边界。 */
export function getOrThrow<TValue, TError>(result: Result<TValue, TError>): TValue {
	if (!result.ok) throw result.error;
	return result.value;
}

/** 返回成功值或 `undefined`。只允许对象值，以避免原始值的真假判断错误。 */
export function getOrUndefined<TValue extends object, TError>(result: Result<TValue, TError>): TValue | undefined {
	return result.ok ? result.value : undefined;
}

/** 将未知的抛出值规范化为 Error 实例，再作为类型化错误原因使用。 */
export function toError(error: unknown): Error {
	if (error instanceof Error) return error;
	if (typeof error === "string") return new Error(error);
	try {
		return new Error(JSON.stringify(error));
	} catch {
		return new Error(String(error));
	}
}

/**
 * 从 `SKILL.md` 文件加载或由应用提供的技能。
 *
 * 按照 agentskills.io 的建议，`name`、`description` 和 `filePath` 会以 XML 格式块插入系统提示。
 * 使用 {@link formatSkillsForSystemPrompt} 生成符合规范的系统提示块。
 */
export interface Skill {
	/** 用于查找和模型可见列表的稳定技能名称。 */
	name: string;
	/** 向模型简要说明何时使用该技能。 */
	description: string;
	/** 完整的技能指令。 */
	content: string;
	/** 技能文件的绝对路径，用于模型可见位置和解析相对引用。 */
	filePath: string;
	/** 从模型可见技能列表中排除此技能，但仍允许应用显式调用。 */
	disableModelInvocation?: boolean;
}

/** 可格式化为提示并显式调用的提示模板。 */
export interface PromptTemplate {
	/** 用于查找或应用命令路由的稳定模板名称。 */
	name: string;
	/** 供命令列表或自动补全使用的可选说明。 */
	description?: string;
	/** 模板内容。参数占位符由 `formatPromptTemplateInvocation` 格式化。 */
	content: string;
}

/** 提供给显式调用方法和系统提示回调的资源。 */
export interface AgentHarnessResources<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
> {
	/** 可供显式调用的提示模板。 */
	promptTemplates?: TPromptTemplate[];
	/** 可供模型调用和显式调用的技能。 */
	skills?: TSkill[];
}

/** 一次代理框架工具实时进度更新的选项。 */
export interface AgentHarnessToolUpdateOptions {
	/** 请求替换本次调用的持久化恢复检查点。 */
	checkpoint?: true;
}

/** 提供给代理框架原生工具的同步完整快照进度回调。 */
export type AgentHarnessToolUpdateCallback<TDetails> = (
	partialResult: AgentToolResult<TDetails>,
	options?: AgentHarnessToolUpdateOptions,
) => void;

/** 单个逻辑工具调用的稳定代理框架标识，安全重放期间保持不变。 */
export interface AgentHarnessToolInvocation {
	/** 会话内唯一的不透明 ID，等于该调用预留的结果条目 ID。 */
	readonly invocationId: string;
	readonly operationId: string;
	readonly turnId: string;
	/** 读取一条调用范围内的持久化重放备忘录。 */
	getMemo(name: string): Promise<JsonValue | undefined>;
	/** 设置或删除一条调用范围内的持久化重放备忘录。 */
	setMemo(name: string, value: JsonValue | undefined): Promise<void>;
}

/** 由 {@link AgentHarness} 使用应用定义上下文执行的工具定义。 */
export type AgentHarnessTool<
	TContext extends object | undefined,
	TParameters extends TSchema = TSchema,
	TDetails = unknown,
> = Omit<AgentTool<TParameters, TDetails>, "execute"> & {
	/** 使用为当前轮次快照解析出的上下文执行工具调用。 */
	execute(
		toolCallId: string,
		params: Static<TParameters>,
		onUpdate: AgentHarnessToolUpdateCallback<TDetails>,
		toolContext: TContext,
		invocation: AgentHarnessToolInvocation,
		context: Context,
	): Promise<AgentToolResult<TDetails>>;
};

/** 静态工具上下文，或为每个轮次快照解析上下文的提供函数。 */
export type AgentHarnessToolContextSource<TContext extends object | undefined> =
	| TContext
	| ((context: Context) => TContext | Promise<TContext>);

/** 由代理框架持有、并按轮次创建快照的受控提供方请求选项。 */
export interface AgentHarnessStreamOptions {
	/** 转发给流函数的首选传输方式。 */
	transport?: Transport;
	/** 提供方请求超时时间，单位为毫秒。 */
	timeoutMs?: number;
	/** 提供方最大重试次数。 */
	maxRetries?: number;
	/** 提供方所请求重试延迟的可选上限。 */
	maxRetryDelayMs?: number;
	/** 与身份验证及生命周期请求头合并的附加请求头。 */
	headers?: Record<string, string>;
	/** 随请求转发的提供方元数据。 */
	metadata?: SimpleStreamOptions["metadata"];
	/** 提供方缓存保留提示。 */
	cacheRetention?: SimpleStreamOptions["cacheRetention"];
	/** 请求支持该能力的提供方异步继续生成。 */
	deferred?: boolean | { window?: "15m" | "1h" | "24h" };
}

/** 提供方钩子为单次请求返回的流选项补丁。 */
export interface AgentHarnessStreamOptionsPatch
	extends Omit<Partial<AgentHarnessStreamOptions>, "headers" | "metadata"> {
	/** 请求头补丁。值为 `undefined` 时删除对应键；显式 `headers: undefined` 清除全部请求头。 */
	headers?: Record<string, string | undefined>;
	/** 元数据补丁。值为 `undefined` 时删除对应键；显式 `metadata: undefined` 清除全部元数据。 */
	metadata?: Record<string, unknown | undefined>;
}

/** {@link FileSystem} 所寻址的文件系统对象类型。符号链接不会被自动跟随。 */
export type FileKind = "file" | "directory" | "symlink";

/** {@link FileSystem} 文件操作返回的稳定、与后端无关的错误代码。 */
export type FileErrorCode =
	| "aborted"
	| "not_found"
	| "permission_denied"
	| "not_directory"
	| "is_directory"
	| "invalid"
	| "not_supported"
	| "unknown";

/** {@link FileSystem} 文件操作返回的错误。 */
export class FileError extends Error {
	/** 与后端无关的错误代码。 */
	public code: FileErrorCode;
	/** 与失败关联的绝对寻址路径（如果可用）。 */
	public path?: string;

	constructor(code: FileErrorCode, message: string, path?: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "FileError";
		this.code = code;
		this.path = path;
	}
}

/** {@link ExecutionEnv.exec} 返回的稳定、与后端无关的执行错误代码。 */
export type ExecutionErrorCode =
	| "aborted"
	| "timeout"
	| "shell_unavailable"
	| "spawn_error"
	| "callback_error"
	| "unknown";

/** {@link ExecutionEnv.exec} 返回的错误。 */
export class ExecutionError extends Error {
	/** 与后端无关的错误代码。 */
	public code: ExecutionErrorCode;

	constructor(code: ExecutionErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "ExecutionError";
		this.code = code;
	}
}

/** 压缩辅助函数返回的稳定错误代码。 */
export type CompactionErrorCode = "aborted" | "summarization_failed";

/** 压缩辅助函数返回的错误。 */
export class CompactionError extends Error {
	/** 与后端无关的错误代码。 */
	public code: CompactionErrorCode;

	constructor(code: CompactionErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "CompactionError";
		this.code = code;
	}
}

/** 分支摘要辅助函数返回的稳定错误代码。 */
export type BranchSummaryErrorCode = "aborted" | "summarization_failed";

/** 分支摘要辅助函数返回的错误。 */
export class BranchSummaryError extends Error {
	/** 与后端无关的错误代码。 */
	public code: BranchSummaryErrorCode;

	constructor(code: BranchSummaryErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "BranchSummaryError";
		this.code = code;
	}
}

/** {@link FileSystem} 中单个文件系统对象的元数据。 */
export interface FileInfo {
	/** {@link path} 的基本名称。 */
	name: string;
	/** 执行环境中经过语法规范化的绝对寻址路径，不跟随符号链接。 */
	path: string;
	/** 对象类型。不跟随符号链接目标；需要时显式使用 {@link FileSystem.canonicalPath}。 */
	kind: FileKind;
	/** 所寻址文件系统对象的字节大小。 */
	size: number;
	/** 自 Unix 纪元起以毫秒表示的修改时间。 */
	mtimeMs: number;
}

/**
 * 代理框架使用的文件系统能力。
 *
 * 传入方法的路径可以是绝对路径，也可以是相对于 {@link cwd} 的路径。文件操作返回的路径是
 * 文件系统命名空间中的寻址路径；除非由 {@link canonicalPath} 返回，否则不会通过符号链接进行规范化。
 *
 * 操作方法不得抛出异常或拒绝 Promise。所有文件系统失败（包括意外的后端失败）都必须编码到
 * 返回的 {@link Result} 中，实现必须保持此不变量。
 */
export interface FileSystem {
	/** 相对路径使用的当前工作目录。 */
	cwd: string;

	/** 返回绝对寻址路径，不要求路径存在，也不解析符号链接。 */
	absolutePath(path: string, context: Context): Promise<Result<string, FileError>>;
	/** 在文件系统命名空间中连接路径片段，不要求结果路径存在。 */
	joinPath(parts: string[], context: Context): Promise<Result<string, FileError>>;
	/** 读取 UTF-8 文本文件。 */
	readTextFile(path: string, context: Context): Promise<Result<string, FileError>>;
	/** 读取 UTF-8 文本行。读取 `maxLines` 行后，实现应停止读取。 */
	readTextLines(
		path: string,
		options: { maxLines?: number } | undefined,
		context: Context,
	): Promise<Result<string[], FileError>>;
	/** 读取二进制文件。 */
	readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>>;
	/** 创建或覆盖文件；支持时同时创建父目录。 */
	writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>>;
	/** 创建文件或追加内容；支持时同时创建父目录。 */
	appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>>;
	/** 原子重命名文件，目标存在时将其替换。不跨文件系统复制。 */
	renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>>;
	/** 返回寻址路径的元数据，不跟随符号链接。 */
	fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>>;
	/** 列出目录的直接子项，不跟随符号链接。 */
	listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>>;
	/** 返回现有路径的规范路径，并在支持时解析符号链接。 */
	canonicalPath(path: string, context: Context): Promise<Result<string, FileError>>;
	/** 路径缺失时返回 false；权限失败等其他错误返回 {@link FileError}。 */
	exists(path: string, context: Context): Promise<Result<boolean, FileError>>;
	/** 创建目录。默认为 `recursive: true`。 */
	createDir(
		path: string,
		options: { recursive?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>>;
	/** 删除文件或目录。默认为 `recursive: false` 和 `force: false`。 */
	remove(
		path: string,
		options: { recursive?: boolean; force?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>>;
	/** 创建临时目录并返回其绝对路径。默认为 `prefix: "tmp-"`。 */
	createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>>;
	/** 创建临时文件并返回其绝对路径。默认为 `prefix: ""` 和 `suffix: ""`。 */
	createTempFile(
		options: { prefix?: string; suffix?: string } | undefined,
		context: Context,
	): Promise<Result<string, FileError>>;

	/** 释放文件系统资源。必须尽力完成，且不得抛出异常或拒绝 Promise。 */
	cleanup(context: Context): Promise<void>;
}

/** 有界输出超过限制后保留的部分。 */
export type ShellOutputRetention = "head" | "tail";

/** 单个合并 Shell 输出视图在源端使用的限制。 */
export interface ShellOutputLimits {
	maxBytes: number;
	maxLines: number;
	/** 默认为 `"tail"`。 */
	retain?: ShellOutputRetention;
}

/** 调用方请求的有界 Shell 输出捕获。 */
export interface ShellOutputCaptureOptions {
	limits: ShellOutputLimits;
	/** 超过限制后，将完整输出保存在执行环境本地文件中。 */
	spill?: boolean;
}

/** 不重复包含保留文本的截断元数据。 */
export type ShellOutputTruncation = Omit<TruncationResult, "content">;

/** 有界 Shell 输出视图附带的元数据。 */
export interface ShellOutputMetadata {
	truncation: ShellOutputTruncation;
	spillPath?: string;
	lastLineBytes?: number;
}

/** 完整的有界 Shell 输出视图。 */
export interface ShellOutputView extends ShellOutputMetadata {
	text: string;
}

/** 单个有界 Shell 输出视图在源端产生的增量变更。 */
export type ShellOutputUpdate =
	| { kind: "replace"; output: ShellOutputView }
	| { kind: "append"; text: string; metadata: ShellOutputMetadata }
	| { kind: "slide"; drop: number; text: string; metadata: ShellOutputMetadata }
	| { kind: "metadata"; metadata: ShellOutputMetadata };

/** 有界 Shell 执行完成结果。输出文本通过 {@link ShellExecOptions.onUpdate} 发送。 */
export interface ShellExecResult extends ShellOutputMetadata {
	exitCode: number;
}

/** {@link Shell.exec} 的选项。 */
export interface ShellExecOptions {
	/** 命令的工作目录。相对路径基于 {@link ExecutionEnv.cwd} 解析，默认值也是该目录。 */
	cwd?: string;
	/** 命令的环境变量。`inheritEnv` 为 true 时，这些值会覆盖继承的默认值。 */
	env?: Record<string, string>;
	/** 是否继承执行环境的默认变量，默认为 true。 */
	inheritEnv?: boolean;
	/** 超时时间，单位为秒。命令超过该时长时实现应返回超时错误，默认不超时。 */
	timeout?: number;
	/** 源端有界捕获。如果此项和 `onUpdate` 均不存在，则丢弃输出。 */
	capture?: ShellOutputCaptureOptions;
	/** 有界输出发生变更时调用。 */
	onUpdate?: (update: ShellOutputUpdate, context: Context) => void;
}

/** 代理框架使用的 Shell 执行能力。 */
export interface Shell {
	/** 在 {@link FileSystem.cwd} 中执行 Shell 命令；提供 `options.cwd` 时使用后者。 */
	exec(
		command: string,
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>>;
	/** 释放 Shell 资源。必须尽力完成，且不得抛出异常或拒绝 Promise。 */
	cleanup(context: Context): Promise<void>;
}

/** 代理框架使用的文件系统和进程执行环境。 */
export interface ExecutionEnv extends FileSystem, Shell {}
