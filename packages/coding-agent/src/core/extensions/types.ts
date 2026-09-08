/**
 * 扩展系统类型。
 *
 * 扩展是可以执行以下操作的 TypeScript 模块：
 * - 订阅代理生命周期事件
 * - 注册可由 LLM 调用的工具
 * - 注册命令、键盘快捷键和 CLI 标志
 * - 通过 UI 基础组件与用户交互
 */

import type {
	AgentMessage,
	AgentToolResult,
	AgentToolUpdateCallback,
	ThinkingLevel,
	ToolExecutionMode,
} from "@earendil-works/pi-agent-core";
import type {
	Api,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	ConstrainedSamplingConfig,
	Context,
	ImageContent,
	Model,
	OAuthCredentials,
	OAuthLoginCallbacks,
	Provider,
	ProviderHeaders,
	RefreshModelsContext,
	SimpleStreamOptions,
	TextContent,
	ToolResultMessage,
	Usage,
} from "@earendil-works/pi-ai";
import type {
	AutocompleteItem,
	AutocompleteProvider,
	Component,
	EditorComponent,
	EditorTheme,
	KeyId,
	OverlayHandle,
	OverlayOptions,
	TUI,
} from "@earendil-works/pi-tui";
import type { Static, TSchema } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { BashResult } from "../bash-executor.ts";
import type { CompactionPreparation, CompactionResult } from "../compaction/index.ts";
import type { EventBus } from "../event-bus.ts";
import type { ExecOptions, ExecResult } from "../exec.ts";
import type { ReadonlyFooterDataProvider } from "../footer-data-provider.ts";
import type { KeybindingsManager } from "../keybindings.ts";
import type { CustomMessage } from "../messages.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type { ScopedModel } from "../model-resolver.ts";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	CustomEntry,
	ReadonlySessionManager,
	SessionEntry,
	SessionManager,
} from "../session-manager.ts";
import type { SlashCommandInfo } from "../slash-commands.ts";
import type { SourceInfo } from "../source-info.ts";
import type { BuildSystemPromptOptions } from "../system-prompt.ts";
import type { BashOperations } from "../tools/bash.ts";
import type { EditToolDetails } from "../tools/edit.ts";
import type {
	BashToolDetails,
	BashToolInput,
	EditToolInput,
	FindToolDetails,
	FindToolInput,
	GrepToolDetails,
	GrepToolInput,
	LsToolDetails,
	LsToolInput,
	PowerShellToolDetails,
	PowerShellToolInput,
	ReadToolDetails,
	ReadToolInput,
	WriteToolInput,
} from "../tools/index.ts";

export type { ExecOptions, ExecResult } from "../exec.ts";
export type { BuildSystemPromptOptions } from "../system-prompt.ts";
export type { AgentToolResult, AgentToolUpdateCallback, ToolExecutionMode };
export type { AppKeybinding, KeybindingsManager } from "../keybindings.ts";

// ============================================================================
// UI 上下文
// ============================================================================

/** 扩展 UI 对话框选项。 */
export interface ExtensionUIDialogOptions {
	/** 用于以编程方式关闭对话框的 AbortSignal。 */
	signal?: AbortSignal;
	/** 超时时间（毫秒）。对话框会显示实时倒计时并自动关闭。 */
	timeout?: number;
}

/** 扩展小组件的放置位置。 */
export type WidgetPlacement = "aboveEditor" | "belowEditor";

/** 扩展小组件选项。 */
export interface ExtensionWidgetOptions {
	/** 小组件的渲染位置。默认为 "aboveEditor"。 */
	placement?: WidgetPlacement;
}

/** 供扩展使用的原始终端输入监听器。 */
export type TerminalInputHandler = (data: string) => { consume?: boolean; data?: string } | undefined;

/** 交互式流加载器的工作指示器配置。 */
export interface WorkingIndicatorOptions {
	/** 动画帧。使用空数组可完全隐藏指示器。自定义帧会原样渲染。 */
	frames?: string[];
	/** 动画指示器的帧间隔（毫秒）。 */
	intervalMs?: number;
}

/** 使用附加行为包装当前自动补全提供器。 */
export type AutocompleteProviderFactory = (current: AutocompleteProvider) => AutocompleteProvider;
export type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent;

/**
 * 供扩展请求交互式 UI 的 UI 上下文。
 * 每种模式（interactive、RPC、print）提供各自的实现。
 */
export interface ExtensionUIContext {
	/** 显示选择器并返回用户的选择。 */
	select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined>;

	/** 显示确认对话框。 */
	confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean>;

	/** 显示文本输入对话框。 */
	input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined>;

	/** 向用户显示通知。 */
	notify(message: string, type?: "info" | "warning" | "error"): void;

	/** 监听原始终端输入（仅限交互模式）。返回取消订阅函数。 */
	onTerminalInput(handler: TerminalInputHandler): () => void;

	/** 设置页脚/状态栏中的状态文本。传入 undefined 可清除。 */
	setStatus(key: string, text: string | undefined): void;

	/** 设置流式处理期间显示的工作/加载消息。无参数调用可恢复默认值。 */
	setWorkingMessage(message?: string): void;

	/** 在流式处理期间显示或隐藏内置交互式工作加载器行。 */
	setWorkingVisible(visible: boolean): void;

	/**
	 * 配置流式处理期间显示的交互式工作指示器。
	 *
	 * - 省略参数可恢复默认的动画旋转指示器。
	 * - 使用 `frames: ["●"]` 可显示静态指示器。
	 * - 使用 `frames: []` 可完全隐藏指示器。
	 * - 自定义帧会按原样渲染，因此扩展必须自行添加颜色。
	 */
	setWorkingIndicator(options?: WorkingIndicatorOptions): void;

	/** 设置隐藏思考块显示的标签。无参数调用可恢复默认值。 */
	setHiddenThinkingLabel(label?: string): void;

	/** 设置显示在编辑器上方或下方的小组件。接受字符串数组或组件工厂。 */
	setWidget(key: string, content: string[] | undefined, options?: ExtensionWidgetOptions): void;
	setWidget(
		key: string,
		content: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined,
		options?: ExtensionWidgetOptions,
	): void;

	/** 设置自定义页脚组件，传入 undefined 可恢复内置页脚。
	 *
	 * 工厂接收 FooterDataProvider，以访问其他方式无法取得的数据：git 分支和来自
	 * setStatus() 的扩展状态。上下文用量位于 ctx.getContextUsage()，令牌统计位于
	 * ctx.sessionManager.getEntries()，模型信息位于 ctx.model。
	 */
	setFooter(
		factory:
			| ((tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void })
			| undefined,
	): void;

	/** 设置自定义头部组件（启动时显示在聊天上方），传入 undefined 可恢复内置头部。 */
	setHeader(factory: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined): void;

	/** 设置终端窗口/标签页标题。 */
	setTitle(title: string): void;

	/** 显示获得键盘焦点的自定义组件。 */
	custom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: {
			overlay?: boolean;
			/** 浮层定位/尺寸选项。可以是静态值，也可以是用于动态更新的函数。 */
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
			/** 浮层显示后使用其句柄调用。可用于控制可见性。 */
			onHandle?: (handle: OverlayHandle) => void;
		},
	): Promise<T>;

	/** 将文本粘贴到编辑器中并触发粘贴处理（大段内容会折叠）。 */
	pasteToEditor(text: string): void;

	/** 设置核心输入编辑器中的文本。 */
	setEditorText(text: string): void;

	/** 获取核心输入编辑器中的当前文本。 */
	getEditorText(): string;

	/** 显示用于文本编辑的多行编辑器。 */
	editor(title: string, prefill?: string): Promise<string | undefined>;

	/** 在内置提供器之上叠加额外的自动补全行为。 */
	addAutocompleteProvider(factory: AutocompleteProviderFactory): void;

	/**
	 * 通过工厂函数设置自定义编辑器组件。
	 * 传入 undefined 可恢复默认编辑器。
	 *
	 * 工厂接收：
	 * - `theme`：用于设置边框和自动补全样式的 EditorTheme
	 * - `keybindings`：用于应用级按键绑定的 KeybindingsManager
	 *
	 * 如需完整的应用按键绑定支持（escape、ctrl+d、模型切换等），请继承
	 * `@earendil-works/pi-coding-agent` 中的 `CustomEditor`，并针对未处理的按键
	 * 调用 `super.handleInput(data)`。
	 *
	 * @example
	 * ```ts
	 * import { CustomEditor } from "@earendil-works/pi-coding-agent";
	 *
	 * class VimEditor extends CustomEditor {
	 *   private mode: "normal" | "insert" = "insert";
	 *
	 *   handleInput(data: string): void {
	 *     if (this.mode === "normal") {
	 *       // Handle vim normal mode keys...
	 *       if (data === "i") { this.mode = "insert"; return; }
	 *     }
	 *     super.handleInput(data);  // App keybindings + text editing
	 *   }
	 * }
	 *
	 * ctx.ui.setEditorComponent((tui, theme, keybindings) =>
	 *   new VimEditor(tui, theme, keybindings)
	 * );
	 * ```
	 */
	setEditorComponent(factory: EditorFactory | undefined): void;

	/** 获取当前配置的自定义编辑器工厂；使用默认编辑器时返回 undefined。 */
	getEditorComponent(): EditorFactory | undefined;

	/** 获取用于样式设置的当前主题。 */
	readonly theme: Theme;

	/** 获取所有可用主题及其名称和文件路径。 */
	getAllThemes(): { name: string; path: string | undefined }[];

	/** 按名称加载主题但不切换。找不到时返回 undefined。 */
	getTheme(name: string): Theme | undefined;

	/** 按名称或 Theme 对象设置当前主题。 */
	setTheme(theme: string | Theme): { success: boolean; error?: string };

	/** 获取当前工具输出展开状态。 */
	getToolsExpanded(): boolean;

	/** 设置工具输出展开状态。 */
	setToolsExpanded(expanded: boolean): void;
}

// ============================================================================
// 扩展上下文
// ============================================================================

export interface ContextUsage {
	/** 估算的上下文令牌数；未知时为 null（例如刚压缩后、下一次 LLM 响应前）。 */
	tokens: number | null;
	contextWindow: number;
	/** 上下文用量占上下文窗口的百分比；令牌数未知时为 null。 */
	percent: number | null;
}

export interface CompactOptions {
	customInstructions?: string;
	onComplete?: (result: CompactionResult) => void;
	onError?: (error: Error) => void;
}

/**
 * 传递给扩展事件处理器的上下文。
 */
export type ExtensionMode = "tui" | "rpc" | "json" | "print";

export interface ExtensionContext {
	/** 用于用户交互的 UI 方法 */
	ui: ExtensionUIContext;
	/** 当前运行模式。使用 "tui" 保护仅限终端的 UI，例如自定义组件。 */
	mode: ExtensionMode;
	/** 是否有支持对话框的 UI 可用（在 TUI 和 RPC 模式下为 true） */
	hasUI: boolean;
	/** 当前工作目录 */
	cwd: string;
	/** 会话管理器（只读） */
	sessionManager: ReadonlySessionManager;
	/** 用于解析 API 密钥的模型注册表 */
	modelRegistry: ModelRegistry;
	/** 当前模型（可能为 undefined） */
	model: Model<any> | undefined;
	/** 限定到此会话的模型（根据可用目录解析 `--models` / `enabledModels` 设置）。
	 *  与 `/scoped-models` 命令显示的集合相同。未配置范围时为空
	 *  （所有可用模型均可使用）。只读快照。 */
	scopedModels: readonly ScopedModel[];
	/** 会话运行时提供的当前思考级别。 */
	thinkingLevel?: ThinkingLevel;
	/** 代理是否空闲（未进行流式处理） */
	isIdle(): boolean;
	/** 项目本地信任是否在此上下文中生效。 */
	isProjectTrusted(): boolean;
	/** 当前中止信号；代理未进行流式处理时为 undefined。 */
	signal: AbortSignal | undefined;
	/** 中止当前代理操作 */
	abort(): void;
	/** 是否有正在等待的排队消息 */
	hasPendingMessages(): boolean;
	/** 优雅关闭 pi 并退出。所有上下文均可用。 */
	shutdown(): void;
	/** 获取活动模型的当前上下文用量。 */
	getContextUsage(): ContextUsage | undefined;
	/** 触发压缩但不等待完成。 */
	compact(options?: CompactOptions): void;
	/** 获取当前生效的系统提示词。 */
	getSystemPrompt(): string;
}

/**
 * 命令处理器的扩展上下文。
 * 包含仅可安全用于用户发起命令的会话控制方法。
 */
export interface ExtensionCommandContext extends ExtensionContext {
	/** 获取当前基础系统提示词的构建选项。 */
	getSystemPromptOptions(): BuildSystemPromptOptions;

	/** 等待代理完成流式处理 */
	waitForIdle(): Promise<void>;

	/** 启动新会话，可以选择执行初始化。 */
	newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }>;

	/** 从指定条目分叉，创建新的会话文件。 */
	fork(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean }>;

	/** 导航到会话树中的其他位置。 */
	navigateTree(
		targetId: string,
		options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
	): Promise<{ cancelled: boolean }>;

	/** 切换到其他会话文件。 */
	switchSession(
		sessionPath: string,
		options?: { withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean }>;

	/** 重新加载扩展、skill、提示词、主题和上下文文件。 */
	reload(): Promise<void>;
}

/**
 * 会话切换后绑定到替代会话的新命令上下文。
 *
 * 此上下文会传递给 `newSession()`、`fork()` 和 `switchSession()` 的 `withSession()` 回调。
 */
export interface ReplacedSessionContext extends ExtensionCommandContext {
	sendMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void>;

	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
	): Promise<void>;
}

// ============================================================================
// 工具类型
// ============================================================================

/** 工具结果的渲染选项 */
export interface ToolRenderResultOptions {
	/** 结果视图是否已展开 */
	expanded: boolean;
	/** 是否为部分/流式结果 */
	isPartial: boolean;
}

/** 传递给工具渲染器的上下文。 */
export interface ToolRenderContext<TState = any, TArgs = any> {
	/** 当前工具调用参数。同一工具调用的调用/结果渲染会共享此参数。 */
	args: TArgs;
	/** 此次工具执行的唯一 ID。同一工具调用的调用/结果渲染期间保持不变。 */
	toolCallId: string;
	/** 仅使此次工具执行组件失效，以便重绘。 */
	invalidate: () => void;
	/** 此渲染槽位先前返回的组件（如果存在）。 */
	lastComponent: Component | undefined;
	/** 此工具行的共享渲染器状态。由 tool-execution.ts 初始化。 */
	state: TState;
	/** 此次工具执行的工作目录。 */
	cwd: string;
	/** 工具执行是否已开始。 */
	executionStarted: boolean;
	/** 工具调用参数是否完整。 */
	argsComplete: boolean;
	/** 工具结果是否为部分/流式结果。 */
	isPartial: boolean;
	/** 结果视图是否已展开。 */
	expanded: boolean;
	/** 当前是否在 TUI 中显示内联图像。 */
	showImages: boolean;
	/** 当前结果是否为错误。 */
	isError: boolean;
}

/**
 * registerTool() 的工具定义。
 */
export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, TState = any> {
	/** 工具名称（用于 LLM 工具调用） */
	name: string;
	/** 供 UI 使用的人类可读标签 */
	label: string;
	/** 供 LLM 使用的说明 */
	description: string;
	/** 默认系统提示词“可用工具”部分的可选单行片段。未提供时，自定义工具不会出现在该部分。 */
	promptSnippet?: string;
	/** 此工具处于活动状态时，附加到默认系统提示词“指南”部分的可选要点。 */
	promptGuidelines?: string[];
	/** 参数架构（TypeBox） */
	parameters: TParams;
	/** 此工具的可选提供商侧受限采样请求。设为 false 可显式禁用，等同于保留 undefined。 */
	constrainedSampling?: false | ConstrainedSamplingConfig;
	/** 控制由 ToolExecutionComponent 渲染标准彩色外框，还是由工具自行渲染外框。 */
	renderShell?: "default" | "self";

	/** 在架构验证前准备原始工具调用参数的可选兼容层。必须返回符合 TParams 的对象。 */
	prepareArguments?: (args: unknown) => Static<TParams>;

	/**
	 * 单个工具的执行模式覆盖项。
	 * - "sequential"：此工具必须与其他工具调用逐个执行。
	 * - "parallel"：此工具可以与其他工具调用并发执行。
	 *
	 * 省略时采用默认执行模式。
	 */
	executionMode?: ToolExecutionMode;

	/** 执行工具。 */
	execute(
		toolCallId: string,
		params: Static<TParams>,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<TDetails>>;

	/** 工具调用显示的自定义渲染 */
	renderCall?: (args: Static<TParams>, theme: Theme, context: ToolRenderContext<TState, Static<TParams>>) => Component;

	/** 工具结果显示的自定义渲染 */
	renderResult?: (
		result: AgentToolResult<TDetails>,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: ToolRenderContext<TState, Static<TParams>>,
	) => Component;
}

type AnyToolDefinition = ToolDefinition<any, any, any>;

/**
 * 保留独立工具定义的参数推断。
 *
 * 将工具赋给变量或通过 `customTools` 等数组传递时使用此函数；否则上下文类型
 * 会将参数拓宽为 `unknown`。
 */
export function defineTool<TParams extends TSchema, TDetails = unknown, TState = any>(
	tool: ToolDefinition<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails, TState> & AnyToolDefinition {
	return tool as ToolDefinition<TParams, TDetails, TState> & AnyToolDefinition;
}

// ============================================================================
// 启动/资源事件
// ============================================================================

export interface ProjectTrustEvent {
	type: "project_trust";
	cwd: string;
}

export type ProjectTrustEventDecision = "yes" | "no" | "undecided";

export interface ProjectTrustEventResult {
	trusted: ProjectTrustEventDecision;
	remember?: boolean;
}

export interface ProjectTrustContext {
	cwd: string;
	mode: ExtensionMode;
	hasUI: boolean;
	ui: Pick<ExtensionUIContext, "select" | "confirm" | "input" | "notify">;
}

export type ProjectTrustHandler = (
	event: ProjectTrustEvent,
	ctx: ProjectTrustContext,
) => Promise<ProjectTrustEventResult> | ProjectTrustEventResult;

/** 在 session_start 后触发，允许扩展提供额外资源路径。 */
export interface ResourcesDiscoverEvent {
	type: "resources_discover";
	cwd: string;
	reason: "startup" | "reload";
}

/** resources_discover 事件处理器的结果 */
export interface ResourcesDiscoverResult {
	skillPaths?: string[];
	promptPaths?: string[];
	themePaths?: string[];
}

// ============================================================================
// 会话事件
// ============================================================================

/** 会话启动、加载或重新加载时触发 */
export interface SessionStartEvent {
	type: "session_start";
	/** 此次会话启动的原因。 */
	reason: "startup" | "reload" | "new" | "resume" | "fork";
	/** 先前活动的会话文件。原因是 "new"、"resume" 或 "fork" 时存在。 */
	previousSessionFile?: string;
}

/** 当前会话元数据更改时触发。 */
export interface SessionInfoChangedEvent {
	type: "session_info_changed";
	/** 当前规范化的会话名称。名称被清除时为 undefined。 */
	name: string | undefined;
}

/** 切换到其他会话前触发（可以取消） */
export interface SessionBeforeSwitchEvent {
	type: "session_before_switch";
	reason: "new" | "resume";
	targetSessionFile?: string;
}

/** 分叉会话前触发（可以取消） */
export interface SessionBeforeForkEvent {
	type: "session_before_fork";
	entryId: string;
	position: "before" | "at";
}

/** 上下文压缩前触发（可以取消或自定义） */
export interface SessionBeforeCompactEvent {
	type: "session_before_compact";
	preparation: CompactionPreparation;
	branchEntries: SessionEntry[];
	customInstructions?: string;
	/** 压缩触发原因：手动 /compact、上下文阈值或上下文溢出恢复 */
	reason: "manual" | "threshold" | "overflow";
	/** 此次压缩后会重试已中止轮次（溢出恢复）时为 true */
	willRetry: boolean;
	signal: AbortSignal;
}

/** 上下文压缩成功后触发 */
export interface SessionCompactEvent {
	type: "session_compact";
	compactionEntry: CompactionEntry;
	fromExtension: boolean;
	/** 压缩触发原因：手动 /compact、上下文阈值或上下文溢出恢复 */
	reason: "manual" | "threshold" | "overflow";
	/** 此次压缩后会重试已中止轮次（溢出恢复）时为 true */
	willRetry: boolean;
}

/** 上下文压缩失败或被中止后触发 */
export interface SessionCompactFailedEvent {
	type: "session_compact_failed";
	/** 压缩触发原因：手动 /compact、上下文阈值或上下文溢出恢复 */
	reason: "manual" | "threshold" | "overflow";
	/** 压缩因非中止原因失败时的错误文本。 */
	errorMessage?: string;
	/** 压缩被取消或中止时为 true。 */
	aborted: boolean;
	/** 此次压缩后原本会重试已中止轮次（溢出恢复）时为 true */
	willRetry: boolean;
	/** 失败的压缩内容来自 session_before_compact 处理器时为 true。 */
	fromExtension: boolean;
}

/** 扩展运行时因退出、重载或会话替换而拆除前触发。 */
export interface SessionShutdownEvent {
	type: "session_shutdown";
	reason: "quit" | "reload" | "new" | "resume" | "fork";
	/** 因会话替换而关闭时的目标会话文件。 */
	targetSessionFile?: string;
}

/** 树导航的准备数据 */
export interface TreePreparation {
	targetId: string;
	oldLeafId: string | null;
	commonAncestorId: string | null;
	entriesToSummarize: SessionEntry[];
	userWantsSummary: boolean;
	/** 摘要生成的自定义指令 */
	customInstructions?: string;
	/** 为 true 时，customInstructions 替换默认提示词而不是附加到其后 */
	replaceInstructions?: boolean;
	/** 要附加到分支摘要条目的标签 */
	label?: string;
}

/** 在会话树中导航前触发（可以取消） */
export interface SessionBeforeTreeEvent {
	type: "session_before_tree";
	preparation: TreePreparation;
	signal: AbortSignal;
}

/** 在会话树中导航后触发 */
export interface SessionTreeEvent {
	type: "session_tree";
	newLeafId: string | null;
	oldLeafId: string | null;
	summaryEntry?: BranchSummaryEntry;
	fromExtension?: boolean;
}

export type SessionEvent =
	| SessionStartEvent
	| SessionInfoChangedEvent
	| SessionBeforeSwitchEvent
	| SessionBeforeForkEvent
	| SessionBeforeCompactEvent
	| SessionCompactEvent
	| SessionCompactFailedEvent
	| SessionShutdownEvent
	| SessionBeforeTreeEvent
	| SessionTreeEvent;

// ============================================================================
// 代理事件
// ============================================================================

/** 每次 LLM 调用前触发。可以修改消息。 */
export interface ContextEvent {
	type: "context";
	messages: AgentMessage[];
}

/** 发送提供商请求前触发。可以替换负载。 */
export interface BeforeProviderRequestEvent {
	type: "before_provider_request";
	payload: unknown;
}

/**
 * 请求标头组装完成后、调用提供商 HTTP 接口前触发。
 * 处理器会原地修改 `headers`（例如注入跟踪/会话标头）；
 * 返回值会被忽略。值为 `null` 时删除该标头。
 */
export interface BeforeProviderHeadersEvent {
	type: "before_provider_headers";
	headers: ProviderHeaders;
}

/** 收到提供商响应后、使用响应流前触发。 */
export interface AfterProviderResponseEvent {
	type: "after_provider_response";
	status: number;
	headers: Record<string, string>;
}

/** 用户提交提示词后、代理循环开始前触发。 */
export interface BeforeAgentStartEvent {
	type: "before_agent_start";
	/** 原始用户提示词文本（展开后）。 */
	prompt: string;
	/** 附加到用户提示词的图像（如果存在）。 */
	images?: ImageContent[];
	/** 完整组装的系统提示词字符串。 */
	systemPrompt: string;
	/** 用于构建系统提示词的结构化选项。扩展可以检查此内容，了解 Pi 加载了哪些内容，而无需重新发现资源。 */
	systemPromptOptions: BuildSystemPromptOptions;
}

/** 代理循环开始时触发 */
export interface AgentStartEvent {
	type: "agent_start";
}

/** 代理循环结束时触发 */
export interface AgentEndEvent {
	type: "agent_end";
	messages: AgentMessage[];
}

/** 代理运行完全稳定，且不会再执行自动重试、压缩或排队的续行后触发。 */
export interface AgentSettledEvent {
	type: "agent_settled";
}

export type UIPromptKind = "select" | "confirm" | "input" | "editor" | "custom";

/** Pi 开始等待面向用户且会阻塞的扩展 UI 提示时触发。 */
export interface UIPromptStartEvent {
	type: "ui_prompt_start";
	reason: "ui_prompt";
	kind: UIPromptKind;
	title?: string;
}

/** Pi 不再等待面向用户且会阻塞的扩展 UI 提示时触发。 */
export interface UIPromptEndEvent {
	type: "ui_prompt_end";
	reason: "ui_prompt";
	kind: UIPromptKind;
	title?: string;
}

/** 每轮开始时触发 */
export interface TurnStartEvent {
	type: "turn_start";
	turnIndex: number;
	timestamp: number;
}

/** 每轮结束时触发 */
export interface TurnEndEvent {
	type: "turn_end";
	turnIndex: number;
	message: AgentMessage;
	toolResults: ToolResultMessage[];
}

/** 消息开始时触发（user、assistant 或 toolResult） */
export interface MessageStartEvent {
	type: "message_start";
	message: AgentMessage;
}

/** 助手消息流式传输期间随逐令牌更新触发 */
export interface MessageUpdateEvent {
	type: "message_update";
	message: AgentMessage;
	assistantMessageEvent: AssistantMessageEvent;
}

/** 消息结束时触发 */
export interface MessageEndEvent {
	type: "message_end";
	message: AgentMessage;
}

/** 工具开始执行时触发 */
export interface ToolExecutionStartEvent {
	type: "tool_execution_start";
	toolCallId: string;
	toolName: string;
	args: any;
}

/** 工具执行期间有部分/流式输出时触发 */
export interface ToolExecutionUpdateEvent {
	type: "tool_execution_update";
	toolCallId: string;
	toolName: string;
	args: any;
	partialResult: any;
}

/** 工具执行完成时触发 */
export interface ToolExecutionEndEvent {
	type: "tool_execution_end";
	toolCallId: string;
	toolName: string;
	result: any;
	isError: boolean;
}

// ============================================================================
// 模型事件
// ============================================================================

export type ModelSelectSource = "set" | "cycle" | "restore";

/** 选择新模型时触发 */
export interface ModelSelectEvent {
	type: "model_select";
	model: Model<any>;
	previousModel: Model<any> | undefined;
	source: ModelSelectSource;
}

/** 选择新思考级别时触发 */
export interface ThinkingLevelSelectEvent {
	type: "thinking_level_select";
	level: ThinkingLevel;
	previousLevel: ThinkingLevel;
}

// ============================================================================
// 用户 Bash 事件
// ============================================================================

/** 用户通过 ! 或 !! 前缀执行 bash 命令时触发 */
export interface UserBashEvent {
	type: "user_bash";
	/** 要执行的命令 */
	command: string;
	/** 使用 !! 前缀时为 true（不纳入 LLM 上下文） */
	excludeFromContext: boolean;
	/** 当前工作目录 */
	cwd: string;
}

// ============================================================================
// 输入事件
// ============================================================================

/** 用户输入来源 */
export type InputSource = "interactive" | "rpc" | "extension";

/** 收到用户输入后、代理处理前触发 */
export interface InputEvent {
	type: "input";
	/** 输入文本 */
	text: string;
	/** 附加的图像（如果存在） */
	images?: ImageContent[];
	/** 输入来源 */
	source: InputSource;
	/** 流式处理期间输入的投递方式；空闲时为 undefined */
	streamingBehavior?: "steer" | "followUp";
}

/** 输入事件处理器的结果 */
export type InputEventResult =
	| { action: "continue" }
	| { action: "transform"; text: string; images?: ImageContent[] }
	| { action: "handled" };

// ============================================================================
// 工具事件
// ============================================================================

interface ToolCallEventBase {
	type: "tool_call";
	toolCallId: string;
}

export interface BashToolCallEvent extends ToolCallEventBase {
	toolName: "bash";
	input: BashToolInput;
}

export interface PowerShellToolCallEvent extends ToolCallEventBase {
	toolName: "powershell";
	input: PowerShellToolInput;
}

export interface ReadToolCallEvent extends ToolCallEventBase {
	toolName: "read";
	input: ReadToolInput;
}

export interface EditToolCallEvent extends ToolCallEventBase {
	toolName: "edit";
	input: EditToolInput;
}

export interface WriteToolCallEvent extends ToolCallEventBase {
	toolName: "write";
	input: WriteToolInput;
}

export interface GrepToolCallEvent extends ToolCallEventBase {
	toolName: "grep";
	input: GrepToolInput;
}

export interface FindToolCallEvent extends ToolCallEventBase {
	toolName: "find";
	input: FindToolInput;
}

export interface LsToolCallEvent extends ToolCallEventBase {
	toolName: "ls";
	input: LsToolInput;
}

export interface CustomToolCallEvent extends ToolCallEventBase {
	toolName: string;
	input: Record<string, unknown>;
}

/**
 * 工具执行前触发。可以阻止执行。
 *
 * `event.input` 可变。原地修改它可以在执行前修补工具参数。
 * 后续 `tool_call` 处理器可以看到先前的修改。修改后不会重新验证。
 */
export type ToolCallEvent =
	| BashToolCallEvent
	| PowerShellToolCallEvent
	| ReadToolCallEvent
	| EditToolCallEvent
	| WriteToolCallEvent
	| GrepToolCallEvent
	| FindToolCallEvent
	| LsToolCallEvent
	| CustomToolCallEvent;

interface ToolResultEventBase {
	type: "tool_result";
	toolCallId: string;
	input: Record<string, unknown>;
	content: (TextContent | ImageContent)[];
	isError: boolean;
	/** 工具执行自身产生的用量（如果可用）。 */
	usage?: Usage;
}

export interface BashToolResultEvent extends ToolResultEventBase {
	toolName: "bash";
	details: BashToolDetails | undefined;
}

export interface PowerShellToolResultEvent extends ToolResultEventBase {
	toolName: "powershell";
	details: PowerShellToolDetails | undefined;
}

export interface ReadToolResultEvent extends ToolResultEventBase {
	toolName: "read";
	details: ReadToolDetails | undefined;
}

export interface EditToolResultEvent extends ToolResultEventBase {
	toolName: "edit";
	details: EditToolDetails | undefined;
}

export interface WriteToolResultEvent extends ToolResultEventBase {
	toolName: "write";
	details: undefined;
}

export interface GrepToolResultEvent extends ToolResultEventBase {
	toolName: "grep";
	details: GrepToolDetails | undefined;
}

export interface FindToolResultEvent extends ToolResultEventBase {
	toolName: "find";
	details: FindToolDetails | undefined;
}

export interface LsToolResultEvent extends ToolResultEventBase {
	toolName: "ls";
	details: LsToolDetails | undefined;
}

export interface CustomToolResultEvent extends ToolResultEventBase {
	toolName: string;
	details: unknown;
}

/** 工具执行后触发。可以修改结果。 */
export type ToolResultEvent =
	| BashToolResultEvent
	| PowerShellToolResultEvent
	| ReadToolResultEvent
	| EditToolResultEvent
	| WriteToolResultEvent
	| GrepToolResultEvent
	| FindToolResultEvent
	| LsToolResultEvent
	| CustomToolResultEvent;

// ToolResultEvent 的类型守卫
export function isBashToolResult(e: ToolResultEvent): e is BashToolResultEvent {
	return e.toolName === "bash";
}
export function isPowerShellToolResult(e: ToolResultEvent): e is PowerShellToolResultEvent {
	return e.toolName === "powershell";
}
export function isReadToolResult(e: ToolResultEvent): e is ReadToolResultEvent {
	return e.toolName === "read";
}
export function isEditToolResult(e: ToolResultEvent): e is EditToolResultEvent {
	return e.toolName === "edit";
}
export function isWriteToolResult(e: ToolResultEvent): e is WriteToolResultEvent {
	return e.toolName === "write";
}
export function isGrepToolResult(e: ToolResultEvent): e is GrepToolResultEvent {
	return e.toolName === "grep";
}
export function isFindToolResult(e: ToolResultEvent): e is FindToolResultEvent {
	return e.toolName === "find";
}
export function isLsToolResult(e: ToolResultEvent): e is LsToolResultEvent {
	return e.toolName === "ls";
}

/**
 * 按工具名称缩小 ToolCallEvent 类型的类型守卫。
 *
 * 内置工具会自动缩小类型（无需类型参数）：
 * ```ts
 * if (isToolCallEventType("bash", event)) {
 *   event.input.command;  // string
 * }
 * ```
 *
 * 自定义工具需要显式类型参数：
 * ```ts
 * if (isToolCallEventType<"my_tool", MyToolInput>("my_tool", event)) {
 *   event.input.action;  // typed
 * }
 * ```
 *
 * 注意：无法通过 `event.toolName === "bash"` 直接缩小类型，因为
 * CustomToolCallEvent.toolName 是与所有字面量重叠的 `string`。
 */
export function isToolCallEventType(toolName: "bash", event: ToolCallEvent): event is BashToolCallEvent;
export function isToolCallEventType(toolName: "powershell", event: ToolCallEvent): event is PowerShellToolCallEvent;
export function isToolCallEventType(toolName: "read", event: ToolCallEvent): event is ReadToolCallEvent;
export function isToolCallEventType(toolName: "edit", event: ToolCallEvent): event is EditToolCallEvent;
export function isToolCallEventType(toolName: "write", event: ToolCallEvent): event is WriteToolCallEvent;
export function isToolCallEventType(toolName: "grep", event: ToolCallEvent): event is GrepToolCallEvent;
export function isToolCallEventType(toolName: "find", event: ToolCallEvent): event is FindToolCallEvent;
export function isToolCallEventType(toolName: "ls", event: ToolCallEvent): event is LsToolCallEvent;
export function isToolCallEventType<TName extends string, TInput extends Record<string, unknown>>(
	toolName: TName,
	event: ToolCallEvent,
): event is ToolCallEvent & { toolName: TName; input: TInput };
export function isToolCallEventType(toolName: string, event: ToolCallEvent): boolean {
	return event.toolName === toolName;
}

/** 所有事件类型的联合类型 */
export type ExtensionEvent =
	| ProjectTrustEvent
	| ResourcesDiscoverEvent
	| SessionEvent
	| ContextEvent
	| BeforeProviderRequestEvent
	| BeforeProviderHeadersEvent
	| AfterProviderResponseEvent
	| BeforeAgentStartEvent
	| AgentStartEvent
	| AgentEndEvent
	| AgentSettledEvent
	| UIPromptStartEvent
	| UIPromptEndEvent
	| TurnStartEvent
	| TurnEndEvent
	| MessageStartEvent
	| MessageUpdateEvent
	| MessageEndEvent
	| ToolExecutionStartEvent
	| ToolExecutionUpdateEvent
	| ToolExecutionEndEvent
	| ModelSelectEvent
	| ThinkingLevelSelectEvent
	| UserBashEvent
	| InputEvent
	| ToolCallEvent
	| ToolResultEvent;

// ============================================================================
// 事件结果
// ============================================================================

export interface ContextEventResult {
	messages?: AgentMessage[];
}

export type BeforeProviderRequestEventResult = unknown;

export interface ToolCallEventResult {
	/** 阻止工具执行。如需修改参数，请改为原地修改 `event.input`。 */
	block?: boolean;
	reason?: string;
	/**
	 * 提示代理在此调用被阻止时，应在当前工具批次结束后停止。
	 * 仅当批次中每个已完成的工具结果都将此值设为 true 时，才会提前终止。
	 */
	terminate?: boolean;
}

/** user_bash 事件处理器的结果 */
export interface UserBashEventResult {
	/** 执行时使用的自定义操作 */
	operations?: BashOperations;
	/** 完全替换：扩展已处理执行，使用此结果 */
	result?: BashResult;
}

export interface ToolResultEventResult {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	isError?: boolean;
	usage?: Usage;
}

export interface MessageEndEventResult {
	/** 替换已完成的消息。替代消息必须保留原消息角色。 */
	message?: AgentMessage;
}

export interface BeforeAgentStartEventResult {
	message?: Pick<CustomMessage, "customType" | "content" | "display" | "details">;
	/** 替换本轮系统提示词。如果多个扩展返回此值，则会串联应用。 */
	systemPrompt?: string;
}

export interface SessionBeforeSwitchResult {
	cancel?: boolean;
}

export interface SessionBeforeForkResult {
	cancel?: boolean;
	skipConversationRestore?: boolean;
}

export interface SessionBeforeCompactResult {
	cancel?: boolean;
	compaction?: CompactionResult;
}

export interface SessionBeforeTreeResult {
	cancel?: boolean;
	summary?: {
		summary: string;
		details?: unknown;
		usage?: Usage;
	};
	/** 覆盖摘要生成的自定义指令 */
	customInstructions?: string;
	/** 覆盖 customInstructions 是否替换默认提示词 */
	replaceInstructions?: boolean;
	/** 覆盖要附加到分支摘要条目的标签 */
	label?: string;
}

// ============================================================================
// 消息和条目渲染
// ============================================================================

export interface MessageRenderOptions {
	expanded: boolean;
	/** 由 outputPad 设置配置的水平内边距。 */
	outputPad: number;
}

export interface MarkdownTransformContext {
	messageType: "user" | "assistant" | "assistant-thinking";
	isStreaming: boolean;
	availableWidth: number;
}

export type MarkdownTransformer = (markdown: string, context: MarkdownTransformContext) => string;

export interface EntryRenderOptions {
	expanded: boolean;
}

export type MessageRenderer<T = unknown> = (
	message: CustomMessage<T>,
	options: MessageRenderOptions,
	theme: Theme,
) => Component | undefined;

export type EntryRenderer<T = unknown> = (
	entry: CustomEntry<T>,
	options: EntryRenderOptions,
	theme: Theme,
) => Component | undefined;

// ============================================================================
// 命令注册
// ============================================================================

export interface RegisteredCommand {
	name: string;
	sourceInfo: SourceInfo;
	description?: string;
	getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

export interface ResolvedCommand extends RegisteredCommand {
	invocationName: string;
}

// ============================================================================
// 扩展 API
// ============================================================================

/** 事件处理函数类型 */
// biome-ignore lint/suspicious/noConfusingVoidType: void allows bare return statements
export type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;

/**
 * 传递给扩展工厂函数的 ExtensionAPI。
 */
export interface ExtensionAPI {
	// =========================================================================
	// 事件订阅
	// =========================================================================

	on(event: "project_trust", handler: ProjectTrustHandler): void;
	on(event: "resources_discover", handler: ExtensionHandler<ResourcesDiscoverEvent, ResourcesDiscoverResult>): void;
	on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
	on(event: "session_info_changed", handler: ExtensionHandler<SessionInfoChangedEvent>): void;
	on(
		event: "session_before_switch",
		handler: ExtensionHandler<SessionBeforeSwitchEvent, SessionBeforeSwitchResult>,
	): void;
	on(event: "session_before_fork", handler: ExtensionHandler<SessionBeforeForkEvent, SessionBeforeForkResult>): void;
	on(
		event: "session_before_compact",
		handler: ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>,
	): void;
	on(event: "session_compact", handler: ExtensionHandler<SessionCompactEvent>): void;
	on(event: "session_compact_failed", handler: ExtensionHandler<SessionCompactFailedEvent>): void;
	on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): void;
	on(event: "session_before_tree", handler: ExtensionHandler<SessionBeforeTreeEvent, SessionBeforeTreeResult>): void;
	on(event: "session_tree", handler: ExtensionHandler<SessionTreeEvent>): void;
	on(event: "context", handler: ExtensionHandler<ContextEvent, ContextEventResult>): void;
	on(
		event: "before_provider_request",
		handler: ExtensionHandler<BeforeProviderRequestEvent, BeforeProviderRequestEventResult>,
	): void;
	on(event: "before_provider_headers", handler: ExtensionHandler<BeforeProviderHeadersEvent>): void;
	on(event: "after_provider_response", handler: ExtensionHandler<AfterProviderResponseEvent>): void;
	on(event: "before_agent_start", handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>): void;
	on(event: "agent_start", handler: ExtensionHandler<AgentStartEvent>): void;
	on(event: "agent_end", handler: ExtensionHandler<AgentEndEvent>): void;
	on(event: "agent_settled", handler: ExtensionHandler<AgentSettledEvent>): void;
	on(event: "ui_prompt_start", handler: ExtensionHandler<UIPromptStartEvent>): void;
	on(event: "ui_prompt_end", handler: ExtensionHandler<UIPromptEndEvent>): void;
	on(event: "turn_start", handler: ExtensionHandler<TurnStartEvent>): void;
	on(event: "turn_end", handler: ExtensionHandler<TurnEndEvent>): void;
	on(event: "message_start", handler: ExtensionHandler<MessageStartEvent>): void;
	on(event: "message_update", handler: ExtensionHandler<MessageUpdateEvent>): void;
	on(event: "message_end", handler: ExtensionHandler<MessageEndEvent, MessageEndEventResult>): void;
	on(event: "tool_execution_start", handler: ExtensionHandler<ToolExecutionStartEvent>): void;
	on(event: "tool_execution_update", handler: ExtensionHandler<ToolExecutionUpdateEvent>): void;
	on(event: "tool_execution_end", handler: ExtensionHandler<ToolExecutionEndEvent>): void;
	on(event: "model_select", handler: ExtensionHandler<ModelSelectEvent>): void;
	on(event: "thinking_level_select", handler: ExtensionHandler<ThinkingLevelSelectEvent>): void;
	on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): void;
	on(event: "tool_result", handler: ExtensionHandler<ToolResultEvent, ToolResultEventResult>): void;
	on(event: "user_bash", handler: ExtensionHandler<UserBashEvent, UserBashEventResult>): void;
	on(event: "input", handler: ExtensionHandler<InputEvent, InputEventResult>): void;

	// =========================================================================
	// 工具注册
	// =========================================================================

	/** 注册可由 LLM 调用的工具。 */
	registerTool<TParams extends TSchema = TSchema, TDetails = unknown, TState = any>(
		tool: ToolDefinition<TParams, TDetails, TState>,
	): void;

	// =========================================================================
	// 命令、快捷键和标志注册
	// =========================================================================

	/** 注册自定义命令。 */
	registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void;

	/** 注册键盘快捷键。 */
	registerShortcut(
		shortcut: KeyId,
		options: {
			description?: string;
			handler: (ctx: ExtensionContext) => Promise<void> | void;
		},
	): void;

	/** 注册 CLI 标志。 */
	registerFlag(
		name: string,
		options:
			| {
					description?: string;
					type: "boolean";
					default?: boolean;
			  }
			| {
					description?: string;
					type: "string";
					default?: string;
			  },
	): void;

	/** 获取已注册 CLI 标志的值。 */
	getFlag(name: string): boolean | string | undefined;

	// =========================================================================
	// 消息渲染
	// =========================================================================

	/** 为 CustomMessageEntry 注册自定义渲染器。 */
	registerMessageRenderer<T = unknown>(customType: string, renderer: MessageRenderer<T>): void;

	/** 注册转换器，在 Pi 将用户和助手 Markdown 渲染到交互式记录前进行转换。 */
	registerMarkdownTransformer(transformer: MarkdownTransformer): void;

	/** 为 CustomEntry 注册自定义渲染器。自定义条目不参与 LLM 上下文。 */
	registerEntryRenderer<T = unknown>(customType: string, renderer: EntryRenderer<T>): void;

	// =========================================================================
	// 操作
	// =========================================================================

	/** 向会话发送自定义消息。 */
	sendMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void;

	/**
	 * 向代理发送用户消息。始终会触发一个轮次。
	 * 代理进行流式处理时，使用 deliverAs 指定消息的排队方式。
	 * 设置 expandPromptTemplates 可分派扩展命令，并展开 skill 命令和提示词模板。
	 */
	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
	): void;

	/** 向会话追加用于状态持久化的自定义条目（不发送给 LLM）。 */
	appendEntry<T = unknown>(customType: string, data?: T): void;

	// =========================================================================
	// 会话元数据
	// =========================================================================

	/** 设置会话显示名称（显示在会话选择器中）。 */
	setSessionName(name: string): void;

	/** 获取当前会话名称（如果已设置）。 */
	getSessionName(): string | undefined;

	/** 设置或清除条目的标签。标签是用户自定义的书签/导航标记。 */
	setLabel(entryId: string, label: string | undefined): void;

	/** 执行 shell 命令。 */
	exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;

	/** 获取当前活动工具名称列表。 */
	getActiveTools(): string[];

	/** 获取所有已配置工具及其参数架构、提示词指南和来源元数据。 */
	getAllTools(): ToolInfo[];

	/** 按名称设置活动工具。 */
	setActiveTools(toolNames: string[]): void;

	/** 获取当前会话中可用的斜杠命令。 */
	getCommands(): SlashCommandInfo[];

	// =========================================================================
	// 模型和思考级别
	// =========================================================================

	/**
	 * 设置当前会话的模型，不更改为新会话配置的默认模型。
	 * 如果模型提供商未配置认证，则返回 false。
	 */
	setModel(model: Model<any>): Promise<boolean>;

	/** 获取当前思考级别。 */
	getThinkingLevel(): ThinkingLevel;

	/**
	 * 设置当前会话的思考级别（限制在模型能力范围内），
	 * 不更改为新会话配置的默认值。
	 */
	setThinkingLevel(level: ThinkingLevel): void;

	// =========================================================================
	// 提供商注册
	// =========================================================================

	/**
	 * 注册或覆盖模型提供商。
	 *
	 * 如果提供 `models`：替换此提供商的所有现有模型。
	 * 如果仅提供 `baseUrl`：覆盖现有模型的 URL。
	 * 如果提供 `oauth`：注册支持 /login 的 OAuth 提供商。
	 * 如果提供 `streamSimple`：注册自定义 API 流处理器。
	 *
	 * 初始加载扩展时，此调用会排队，并在运行器绑定上下文后应用。
	 * 此后调用会立即生效，因此可安全地从命令处理器或事件回调中调用，
	 * 无需执行 `/reload`。
	 *
	 * @example
	 * // Register a new provider with custom models
	 * pi.registerProvider("my-proxy", {
	 *   baseUrl: "https://proxy.example.com",
	 *   apiKey: "$PROXY_API_KEY",
	 *   api: "anthropic-messages",
	 *   models: [
	 *     {
	 *       id: "claude-sonnet-4-20250514",
	 *       name: "Claude 4 Sonnet (proxy)",
	 *       reasoning: false,
	 *       input: ["text", "image"],
	 *       cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	 *       contextWindow: 200000,
	 *       maxTokens: 16384
	 *     }
	 *   ]
	 * });
	 *
	 * @example
	 * // Override baseUrl for an existing provider
	 * pi.registerProvider("anthropic", {
	 *   baseUrl: "https://proxy.example.com"
	 * });
	 *
	 * @example
	 * // Register provider with OAuth support
	 * pi.registerProvider("corporate-ai", {
	 *   baseUrl: "https://ai.corp.com",
	 *   api: "openai-responses",
	 *   models: [...],
	 *   oauth: {
	 *     name: "Corporate AI (SSO)",
	 *     async login(callbacks) { ... },
	 *     async refreshToken(credentials) { ... },
	 *     getApiKey(credentials) { return credentials.access; }
	 *   }
	 * });
	 */
	registerProvider(provider: Provider): void;
	registerProvider(name: string, config: ProviderConfig): void;

	/**
	 * 注销先前注册的提供商。
	 *
	 * 删除属于指定提供商的所有模型，并恢复被其覆盖的内置模型。
	 * 如果提供商当前未注册，则不产生任何效果。
	 *
	 * 与 `registerProvider` 一样，在初始加载阶段后调用时会立即生效。
	 *
	 * @example
	 * pi.unregisterProvider("my-proxy");
	 */
	unregisterProvider(name: string): void;

	/** 用于扩展通信的共享事件总线。 */
	events: EventBus;
}

// ============================================================================
// 提供商注册类型
// ============================================================================

/** 通过 pi.registerProvider() 注册提供商的配置。 */
export interface ProviderConfig {
	/** 提供商在 UI 中的显示名称。 */
	name?: string;
	/** API 端点的基础 URL。定义模型时必需。 */
	baseUrl?: string;
	/** API 密钥字面量、环境变量插值（$ENV_VAR 或 ${ENV_VAR}），或以 ! 开头的命令。定义模型时必需（除非提供 oauth）。 */
	apiKey?: string;
	/** API 类型。定义模型时必须在提供商或模型级别指定。 */
	api?: Api;
	/**
	 * 自定义 API 的可选 streamSimple 处理器。
	 * 实现必须在发送提供商请求前调用 `options.onPayload`，并使用其返回的替代负载；
	 * 还必须在收到响应后、使用响应正文前调用 `options.onResponse`，以匹配内置提供商。
	 */
	streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
	/** 请求中包含的自定义标头。 */
	headers?: Record<string, string>;
	/** 为 true 时，使用已解析的 API 密钥添加 Authorization: Bearer 标头。 */
	authHeader?: boolean;
	/** 要注册的模型。提供时替换此提供商的所有现有模型。 */
	models?: ProviderModelConfig[];
	/**
	 * 刷新此提供商的模型列表。返回的列表会替换扩展提供的模型。
	 * 需要跨会话保留目录时，使用 context.publish({ persist: entry })。
	 */
	refreshModels?(context: RefreshModelsContext): Promise<ProviderModelConfig[]>;
	/** 支持 /login 的 OAuth 提供商。`id` 会根据提供商名称自动设置。 */
	oauth?: {
		/** 提供商在登录 UI 中的显示名称。 */
		name: string;
		/** 通过此认证方式进行的访问是否由提供商订阅支持。 */
		isSubscription?: boolean;
		/** @deprecated 为源码兼容性保留；规范认证流程会忽略此字段。 */
		usesCallbackServer?: boolean;
		/** 运行登录流程，返回要持久化的凭据。 */
		login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
		/** 刷新过期凭据，返回要持久化的更新后凭据。 */
		refreshToken(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials>;
		/** 将凭据转换为供提供商使用的 API 密钥字符串。 */
		getApiKey(credentials: OAuthCredentials): string;
		/** 旧版同步且依赖凭据的模型投影。 */
		modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
	};
}

/** 提供商内模型的配置。 */
export interface ProviderModelConfig {
	/** 模型 ID（例如 "claude-sonnet-4-20250514"）。 */
	id: string;
	/** 显示名称（例如 "Claude 4 Sonnet"）。 */
	name: string;
	/** 此模型的 API 类型覆盖项。 */
	api?: Api;
	/** 此模型的 API 端点 URL 覆盖项。 */
	baseUrl?: string;
	/** 模型是否支持扩展思考。 */
	reasoning: boolean;
	/** 将 pi 思考级别映射为提供商/模型专用值；null 表示不支持该级别。 */
	thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
	/** 支持的输入类型。 */
	input: ("text" | "image")[];
	/** 每百万令牌的费率，以及可选的整次请求输入分级定价。 */
	cost: Model<Api>["cost"];
	/** 上下文窗口的最大令牌数。 */
	contextWindow: number;
	/** 最大输出令牌数。 */
	maxTokens: number;
	/** 此模型的自定义标头。 */
	headers?: Record<string, string>;
	/** OpenAI 兼容性设置。 */
	compat?: Model<Api>["compat"];
}

/** 扩展工厂函数类型。支持同步和异步初始化。 */
export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

export type InlineExtension =
	| ExtensionFactory
	| {
			/** 启动时在扩展列表中显示为 `<inline:name>` 的名称。 */
			name: string;
			factory: ExtensionFactory;
			/** 从启动时的扩展列表中省略此扩展。 */
			hidden?: boolean;
	  };

// ============================================================================
// 已加载的扩展类型
// ============================================================================

export interface RegisteredTool {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

export interface ExtensionFlag {
	name: string;
	description?: string;
	type: "boolean" | "string";
	default?: boolean | string;
	extensionPath: string;
}

export interface ExtensionShortcut {
	shortcut: KeyId;
	description?: string;
	handler: (ctx: ExtensionContext) => Promise<void> | void;
	extensionPath: string;
}

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

export type SendMessageHandler = <T = unknown>(
	message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
	options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
) => void;

export type SendUserMessageHandler = (
	content: string | (TextContent | ImageContent)[],
	options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
) => void;

export type AppendEntryHandler = <T = unknown>(customType: string, data?: T) => void;

export type SetSessionNameHandler = (name: string) => void;

export type GetSessionNameHandler = () => string | undefined;

export type GetActiveToolsHandler = () => string[];

/** 包含名称、说明、参数架构、提示词指南和来源元数据的工具信息。 */
export type ToolInfo = Pick<ToolDefinition, "name" | "description" | "parameters" | "promptGuidelines"> & {
	sourceInfo: SourceInfo;
};

export type GetAllToolsHandler = () => ToolInfo[];

export type GetCommandsHandler = () => SlashCommandInfo[];

export type SetActiveToolsHandler = (toolNames: string[]) => void;

export type RefreshToolsHandler = () => void;

export type SetModelHandler = (model: Model<any>) => Promise<boolean>;

export type GetThinkingLevelHandler = () => ThinkingLevel;

export type SetThinkingLevelHandler = (level: ThinkingLevel) => void;

export type SetLabelHandler = (entryId: string, label: string | undefined) => void;

/**
 * 加载器创建的共享状态，在注册和运行时使用。
 * 包含标志值（注册时设置默认值，之后设置 CLI 值）。
 */
export interface ExtensionRuntimeState {
	flagValues: Map<string, boolean | string>;
	/** 扩展加载期间排队的旧版提供商配置注册，在运行器绑定时处理。 */
	pendingProviderRegistrations: Array<{ name: string; config: ProviderConfig; extensionPath: string }>;
	/** 扩展加载期间排队的原生 pi-ai 提供商注册，在运行器绑定时处理。 */
	pendingNativeProviderRegistrations: Array<{ provider: Provider; extensionPath: string }>;
	/** 运行时替换后此扩展实例过期时抛出异常。 */
	assertActive: () => void;
	/** 在运行时替换或重新加载后将此扩展实例标记为过期。 */
	invalidate: (message?: string) => void;
	/** 保留事件总线订阅，直到此运行时失效。 */
	trackEventBusSubscription: (unsubscribe: () => void) => () => void;
	/**
	 * 注册或注销提供商。
	 *
	 * bindCore() 前：将注册加入队列/从队列移除。
	 * bindCore() 后：直接调用 ModelRegistry，使操作立即生效。
	 */
	registerProvider: (name: string, config: ProviderConfig, extensionPath?: string) => void;
	registerNativeProvider: (provider: Provider, extensionPath?: string) => void;
	unregisterProvider: (name: string, extensionPath?: string) => void;
}

/**
 * pi.* API 方法的操作实现。
 * 提供给 runner.initialize()，并复制到共享运行时。
 */
export interface ExtensionActions {
	sendMessage: SendMessageHandler;
	sendUserMessage: SendUserMessageHandler;
	appendEntry: AppendEntryHandler;
	setSessionName: SetSessionNameHandler;
	getSessionName: GetSessionNameHandler;
	setLabel: SetLabelHandler;
	getActiveTools: GetActiveToolsHandler;
	getAllTools: GetAllToolsHandler;
	setActiveTools: SetActiveToolsHandler;
	refreshTools: RefreshToolsHandler;
	getCommands: GetCommandsHandler;
	setModel: SetModelHandler;
	getThinkingLevel: GetThinkingLevelHandler;
	setThinkingLevel: SetThinkingLevelHandler;
}

/**
 * ExtensionContext 的操作（事件处理器中的 ctx.*）。
 * 所有模式均必需。
 */
export interface ExtensionContextActions {
	getModel: () => Model<any> | undefined;
	getScopedModels: () => readonly ScopedModel[];
	isIdle: () => boolean;
	isProjectTrusted: () => boolean;
	getSignal: () => AbortSignal | undefined;
	abort: () => void;
	hasPendingMessages: () => boolean;
	shutdown: () => void;
	getContextUsage: () => ContextUsage | undefined;
	compact: (options?: CompactOptions) => void;
	getSystemPrompt: () => string;
	getSystemPromptOptions?: () => BuildSystemPromptOptions;
}

/**
 * ExtensionCommandContext 的操作（命令处理器中的 ctx.*）。
 * 仅在可调用扩展命令的交互模式中需要。
 */
export interface ExtensionCommandContextActions {
	waitForIdle: () => Promise<void>;
	newSession: (options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}) => Promise<{ cancelled: boolean }>;
	fork: (
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	) => Promise<{ cancelled: boolean }>;
	navigateTree: (
		targetId: string,
		options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
	) => Promise<{ cancelled: boolean }>;
	switchSession: (
		sessionPath: string,
		options?: { withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	) => Promise<{ cancelled: boolean }>;
	reload: () => Promise<void>;
}

/**
 * 完整运行时 = 状态 + 操作。
 * 由加载器使用会抛出异常的操作桩创建，并由 runner.initialize() 补全。
 */
export interface ExtensionRuntime extends ExtensionRuntimeState, ExtensionActions {}

/** 包含所有已注册项的已加载扩展。 */
export interface Extension {
	path: string;
	resolvedPath: string;
	hidden?: boolean;
	sourceInfo: SourceInfo;
	handlers: Map<string, HandlerFn[]>;
	tools: Map<string, RegisteredTool>;
	messageRenderers: Map<string, MessageRenderer>;
	markdownTransformer?: MarkdownTransformer;
	entryRenderers?: Map<string, EntryRenderer>;
	commands: Map<string, RegisteredCommand>;
	flags: Map<string, ExtensionFlag>;
	shortcuts: Map<KeyId, ExtensionShortcut>;
}

/** 加载扩展的结果。 */
export interface LoadExtensionsResult {
	extensions: Extension[];
	errors: Array<{ path: string; error: string }>;
	/** 共享运行时——在 runner.initialize() 之前，操作均为会抛出异常的桩 */
	runtime: ExtensionRuntime;
}

// ============================================================================
// 扩展错误
// ============================================================================

export interface ExtensionError {
	extensionPath: string;
	event: string;
	error: string;
	stack?: string;
}
