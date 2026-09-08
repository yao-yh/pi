/**
 * 用于生命周期事件和自定义工具的扩展系统。
 */

export type { SlashCommandInfo, SlashCommandSource } from "../slash-commands.ts";
export type { SourceInfo } from "../source-info.ts";
export {
	createExtensionRuntime,
	discoverAndLoadExtensions,
	loadExtensionFromFactory,
	loadExtensions,
} from "./loader.ts";
export type {
	ExtensionErrorListener,
	ForkHandler,
	NavigateTreeHandler,
	NewSessionHandler,
	ShutdownHandler,
	SwitchSessionHandler,
} from "./runner.ts";
export { ExtensionRunner } from "./runner.ts";
export type {
	AfterProviderResponseEvent,
	AgentEndEvent,
	AgentSettledEvent,
	AgentStartEvent,
	// 重新导出
	AgentToolResult,
	AgentToolUpdateCallback,
	AppendEntryHandler,
	// 应用按键绑定（供自定义编辑器使用）
	AppKeybinding,
	AutocompleteProviderFactory,
	// 事件：工具（ToolCallEvent 类型）
	BashToolCallEvent,
	BashToolResultEvent,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BeforeProviderHeadersEvent,
	BeforeProviderRequestEvent,
	BeforeProviderRequestEventResult,
	BuildSystemPromptOptions,
	// 上下文
	CompactOptions,
	// 事件：代理
	ContextEvent,
	// 事件结果
	ContextEventResult,
	ContextUsage,
	CustomToolCallEvent,
	CustomToolResultEvent,
	EditorFactory,
	EditToolCallEvent,
	EditToolResultEvent,
	// 消息与条目渲染
	EntryRenderer,
	EntryRenderOptions,
	ExecOptions,
	ExecResult,
	Extension,
	ExtensionActions,
	// API
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionCommandContextActions,
	ExtensionContext,
	ExtensionContextActions,
	// 错误
	ExtensionError,
	ExtensionEvent,
	ExtensionFactory,
	ExtensionFlag,
	ExtensionHandler,
	ExtensionMode,
	// 运行时
	ExtensionRuntime,
	ExtensionShortcut,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	FindToolCallEvent,
	FindToolResultEvent,
	GetActiveToolsHandler,
	GetAllToolsHandler,
	GetCommandsHandler,
	GetThinkingLevelHandler,
	GrepToolCallEvent,
	GrepToolResultEvent,
	InlineExtension,
	// 事件：输入
	InputEvent,
	InputEventResult,
	InputSource,
	KeybindingsManager,
	LoadExtensionsResult,
	LsToolCallEvent,
	LsToolResultEvent,
	MarkdownTransformContext,
	MarkdownTransformer,
	// 事件：消息
	MessageEndEvent,
	MessageRenderer,
	MessageRenderOptions,
	MessageStartEvent,
	MessageUpdateEvent,
	ModelSelectEvent,
	ModelSelectSource,
	PowerShellToolCallEvent,
	PowerShellToolResultEvent,
	ProjectTrustContext,
	ProjectTrustEvent,
	ProjectTrustEventDecision,
	ProjectTrustEventResult,
	ProjectTrustHandler,
	// 提供商注册
	ProviderConfig,
	ProviderModelConfig,
	ReadToolCallEvent,
	ReadToolResultEvent,
	// 命令
	RegisteredCommand,
	RegisteredTool,
	ReplacedSessionContext,
	ResolvedCommand,
	// 事件：资源
	ResourcesDiscoverEvent,
	ResourcesDiscoverResult,
	SendMessageHandler,
	SendUserMessageHandler,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
	SessionBeforeForkEvent,
	SessionBeforeForkResult,
	SessionBeforeSwitchEvent,
	SessionBeforeSwitchResult,
	SessionBeforeTreeEvent,
	SessionBeforeTreeResult,
	SessionCompactEvent,
	SessionCompactFailedEvent,
	SessionEvent,
	SessionInfoChangedEvent,
	SessionShutdownEvent,
	// 事件：会话
	SessionStartEvent,
	SessionTreeEvent,
	SetActiveToolsHandler,
	SetLabelHandler,
	SetModelHandler,
	SetThinkingLevelHandler,
	TerminalInputHandler,
	// 事件：工具
	ToolCallEvent,
	ToolCallEventResult,
	// 工具
	ToolDefinition,
	// 事件：工具执行
	ToolExecutionEndEvent,
	// 工具执行模式
	ToolExecutionMode,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	ToolInfo,
	ToolRenderResultOptions,
	ToolResultEvent,
	ToolResultEventResult,
	TreePreparation,
	TurnEndEvent,
	TurnStartEvent,
	UIPromptEndEvent,
	UIPromptKind,
	UIPromptStartEvent,
	// 事件：用户 Bash
	UserBashEvent,
	UserBashEventResult,
	WidgetPlacement,
	WorkingIndicatorOptions,
	WriteToolCallEvent,
	WriteToolResultEvent,
} from "./types.ts";
// 类型守卫
export {
	defineTool,
	isBashToolResult,
	isEditToolResult,
	isFindToolResult,
	isGrepToolResult,
	isLsToolResult,
	isPowerShellToolResult,
	isReadToolResult,
	isToolCallEventType,
	isWriteToolResult,
} from "./types.ts";
export { wrapRegisteredTool, wrapRegisteredTools } from "./wrapper.ts";
