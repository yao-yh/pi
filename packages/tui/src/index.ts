// 核心 TUI 接口和类

export { Marked, type Token, type Tokens } from "marked";
// 自动补全支持
export {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	CombinedAutocompleteProvider,
	type SlashCommand,
} from "./autocomplete.ts";
// 组件
export { Box } from "./components/box.ts";
export { CancellableLoader } from "./components/cancellable-loader.ts";
export { Editor, type EditorOptions, type EditorTheme } from "./components/editor.ts";
export { HStack } from "./components/h-stack.ts";
export { Image, type ImageOptions, type ImageTheme } from "./components/image.ts";
export { Input } from "./components/input.ts";
export { Loader, type LoaderIndicatorOptions } from "./components/loader.ts";
export { type DefaultTextStyle, Markdown, type MarkdownOptions, type MarkdownTheme } from "./components/markdown.ts";
export { MouseRegion, type MouseRegionHandler } from "./components/mouse-region.ts";
export {
	ScrollView,
	type ScrollViewOptions,
	type ScrollViewScrollbar,
	type ScrollViewScrollToOptions,
} from "./components/scroll-view.ts";
export {
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	type SelectListTheme,
	type SelectListTruncatePrimaryContext,
} from "./components/select-list.ts";
export { type SettingItem, SettingsList, type SettingsListTheme } from "./components/settings-list.ts";
export { Spacer } from "./components/spacer.ts";
export { Text } from "./components/text.ts";
export { TruncatedText } from "./components/truncated-text.ts";
export {
	type StackChild,
	type StackEntry,
	type StackEntryOptions,
	type StackOptions,
	VStack,
} from "./components/v-stack.ts";
// 编辑器组件接口（用于自定义编辑器）
export type { EditorComponent } from "./editor-component.ts";
// 模糊匹配
export { type FuzzyMatch, fuzzyFilter, fuzzyMatch } from "./fuzzy.ts";
// 快捷键绑定
export {
	getKeybindings,
	type Keybinding,
	type KeybindingConflict,
	type KeybindingDefinition,
	type KeybindingDefinitions,
	type Keybindings,
	type KeybindingsConfig,
	KeybindingsManager,
	setKeybindings,
	TUI_KEYBINDINGS,
} from "./keybindings.ts";
// 键盘输入处理
export {
	decodeKittyPrintable,
	isKeyRelease,
	isKeyRepeat,
	isKittyProtocolActive,
	Key,
	type KeyEventType,
	type KeyId,
	matchesKey,
	parseKey,
	setKittyProtocolActive,
} from "./keys.ts";
// LaTeX 渲染
export { type RenderLatexOptions, renderLatex } from "./latex.ts";
// 原生平台集成
export { getNativeClipboard, type NativeClipboard } from "./native-platform.ts";
// 用于批次拆分的输入缓冲
export { StdinBuffer, type StdinBufferEventMap, type StdinBufferOptions } from "./stdin-buffer.ts";
// 终端接口及实现
export { ProcessTerminal, type Terminal } from "./terminal.ts";
// 终端颜色
export {
	parseOsc11BackgroundColor,
	parseTerminalColorSchemeReport,
	type RgbColor,
	type TerminalColorScheme,
} from "./terminal-colors.ts";
// 终端图像支持
export {
	allocateImageId,
	type CellDimensions,
	calculateImageRows,
	deleteAllKittyImages,
	deleteKittyImage,
	detectCapabilities,
	encodeITerm2,
	encodeKitty,
	getCapabilities,
	getCellDimensions,
	getGifDimensions,
	getImageDimensions,
	getJpegDimensions,
	getPngDimensions,
	getWebpDimensions,
	hyperlink,
	type ImageDimensions,
	type ImageProtocol,
	type ImageRenderOptions,
	imageFallback,
	renderImage,
	resetCapabilitiesCache,
	setCapabilities,
	setCapabilityOverrides,
	setCellDimensions,
	type TerminalCapabilities,
} from "./terminal-image.ts";
export {
	type Component,
	Container,
	CURSOR_MARKER,
	compositeTuiLine,
	type Focusable,
	isFocusable,
	isViewportTUI,
	type OverlayAnchor,
	type OverlayBounds,
	type OverlayHandle,
	type OverlayMargin,
	type OverlayOptions,
	type OverlayUnfocusOptions,
	type SizeValue,
	type TUI,
	type TuiInputListener,
	type TuiInputListenerResult,
	type TuiMode,
	type TuiMouseButton,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	type TuiMouseEventType,
	type TuiStopOptions,
	type ViewportTUI,
} from "./tui.ts";
export { TuiAltScreen, type TuiAltScreenOptions } from "./tui-alt-screen.ts";
export { TuiMainScreen, type TuiMainScreenRenderState } from "./tui-main-screen.ts";
// 工具函数
export {
	getOsc8LinkAtColumn,
	sliceByColumn,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "./utils.ts";
