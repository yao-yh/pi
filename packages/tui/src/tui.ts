/**
 * 支持差异渲染的最小 TUI 实现。
 */

import { performance } from "node:perf_hooks";
import { isKeyRelease, matchesKey } from "./keys.ts";
import type { Terminal } from "./terminal.ts";
import {
	isOsc11BackgroundColorResponse,
	parseOsc11BackgroundColor,
	parseTerminalColorSchemeReport,
	type RgbColor,
	type TerminalColorScheme,
} from "./terminal-colors.ts";
import { getCapabilities, isImageLine, setCellDimensions } from "./terminal-image.ts";
import { extractSegments, normalizeTerminalOutput, sliceByColumn, sliceWithWidth, visibleWidth } from "./utils.ts";

/**
 * 组件接口——所有组件都必须实现。
 */
export type TuiMouseEventType = "press" | "release" | "move" | "drag" | "click" | "wheel";
export type TuiMouseButton = "left" | "middle" | "right" | "none";

/** 规范化的基于单元格的鼠标事件。坐标从零开始。 */
export interface TuiMouseEvent {
	type: TuiMouseEventType;
	button: TuiMouseButton;
	/** 接收组件内的局部坐标。 */
	x: number;
	y: number;
	/** 终端绝对坐标。 */
	screenX: number;
	screenY: number;
	/** 当前组件边界。 */
	width: number;
	height: number;
	shift: boolean;
	alt: boolean;
	ctrl: boolean;
	/** 逻辑行数。负值表示向上滚动。 */
	wheelDelta?: number;
	/** type 为 click 时的连续点击次数。 */
	clickCount?: number;
}

export interface TuiMouseEventResult {
	/** 停止传播并禁止渲染器层回退行为。 */
	handled?: boolean;
	/** 将后续拖动/释放事件路由到当前组件，同时表示 handled。 */
	capture?: boolean;
	/** 将键盘焦点交给当前组件，同时表示 handled。 */
	focus?: boolean;
	/**
	 * 显式请求或禁止渲染。move 和 release 默认为 false；
	 * press、click、drag 和 wheel 默认为 true。
	 */
	render?: boolean;
}

/** 容器和备用屏幕分派使用的内部目标元数据。 */
export interface TuiMouseDispatchTarget {
	component: Component;
	originX: number;
	originY: number;
	width: number;
	height: number;
}

/** 分派到具体组件的结果。 */
export interface TuiMouseDispatchResult extends TuiMouseEventResult {
	handled: true;
	target: TuiMouseDispatchTarget;
	/** 键盘焦点目标，可能是负责委托的父容器。 */
	focusTarget?: Component;
}

/**
 * 将事件分派给组件，并保留精确目标和坐标变换。
 * 容器向嵌套子组件转发事件时使用此函数。
 */
export function dispatchMouseEvent(component: Component, event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
	const result = component.handleMouse?.(event);
	if (!result) return undefined;
	if ("target" in result) return result as TuiMouseDispatchResult;
	if (!result.handled && !result.capture && !result.focus) return undefined;
	return {
		...result,
		handled: true,
		...(result.focus ? { focusTarget: component } : {}),
		target: {
			component,
			originX: event.screenX - event.x,
			originY: event.screenY - event.y,
			width: event.width,
			height: event.height,
		},
	};
}

/** 为此前分派的鼠标目标重新创建局部坐标。 */
export function retargetMouseEvent(event: TuiMouseEvent, target: TuiMouseDispatchTarget): TuiMouseEvent {
	return {
		...event,
		x: event.screenX - target.originX,
		y: event.screenY - target.originY,
		width: target.width,
		height: target.height,
	};
}

export interface Component {
	/**
	 * 按给定视口宽度将组件渲染为多行。
	 * @param width - 当前视口宽度
	 * @returns 字符串数组，每个字符串表示一行
	 */
	render(width: number): string[];

	/** 组件获得焦点时使用的可选键盘输入处理器。 */
	handleInput?(data: string): void;

	/** 可选的规范化鼠标处理器。 */
	handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;

	/**
	 * 为 true 时，组件接收按键释放事件（Kitty 协议）。
	 * 默认为 false，释放事件会被过滤。
	 */
	wantsKeyRelease?: boolean;

	/**
	 * 使所有缓存的渲染状态失效。
	 * 主题变化或组件需要从头重新渲染时调用。
	 */
	invalidate(): void;
}

export type TuiInputListenerResult = { consume?: boolean; data?: string } | undefined;
export type TuiInputListener = (data: string) => TuiInputListenerResult;
type PendingOsc11BackgroundQuery = {
	settled: boolean;
	resolve: ((rgb: RgbColor | undefined) => void) | undefined;
	timer: NodeJS.Timeout | undefined;
};

/**
 * 可接收焦点并显示硬件光标的组件接口。
 * 获得焦点时，组件应在渲染输出的光标位置发出 CURSOR_MARKER。
 * TUI 会找到该标记并将硬件光标放置于此，以正确定位 IME 候选窗口。
 */
export interface Focusable {
	/** 焦点变化时由 TUI 设置。为 true 时组件应发出 CURSOR_MARKER。 */
	focused: boolean;
}

/** 检查组件是否实现 Focusable 的类型守卫。 */
export function isFocusable(component: Component | null): component is Component & Focusable {
	return component !== null && "focused" in component;
}

/**
 * 光标位置标记——APC（应用程序命令）序列。
 * 这是终端会忽略的零宽转义序列。组件获得焦点时在光标位置发出此标记。
 * TUI 会找到并移除该标记，然后将硬件光标定位到对应位置。
 */
export const CURSOR_MARKER = "\x1b_pi:c\x07";

export { visibleWidth };

/**
 * 覆盖层的锚点位置。
 */
export type OverlayAnchor =
	| "center"
	| "top-left"
	| "top-right"
	| "bottom-left"
	| "bottom-right"
	| "top-center"
	| "bottom-center"
	| "left-center"
	| "right-center";

/**
 * 覆盖层的边距配置。
 */
export interface OverlayMargin {
	top?: number;
	right?: number;
	bottom?: number;
	left?: number;
}

/** 可以是绝对值（数字）或百分比（如 "50%" 字符串）的值。 */
export type SizeValue = number | `${number}%`;

/** 根据参考尺寸将 SizeValue 解析为绝对值。 */
function parseSizeValue(value: SizeValue | undefined, referenceSize: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") return value;
	// 解析 "50%" 等百分比字符串。
	const match = value.match(/^(\d+(?:\.\d+)?)%$/);
	if (match) {
		return Math.floor((referenceSize * parseFloat(match[1])) / 100);
	}
	return undefined;
}

/**
 * 覆盖层定位和尺寸选项。
 * 值可以是绝对数字或百分比字符串，例如 "50%"。
 */
export interface OverlayOptions {
	// === 尺寸 ===
	/** 以列计的宽度，或终端宽度百分比（例如 "50%"）。 */
	width?: SizeValue;
	/** 以列计的最小宽度。 */
	minWidth?: number;
	/** 以行计的最大高度，或终端高度百分比（例如 "50%"）。 */
	maxHeight?: SizeValue;

	// === 基于锚点的定位 ===
	/** 定位锚点（默认：'center'）。 */
	anchor?: OverlayAnchor;
	/** 相对于锚点位置的水平偏移（正值向右）。 */
	offsetX?: number;
	/** 相对于锚点位置的垂直偏移（正值向下）。 */
	offsetY?: number;

	// === 百分比或绝对定位 ===
	/** 行位置：绝对数字或百分比（例如 "25%" 表示距顶部 25%）。 */
	row?: SizeValue;
	/** 列位置：绝对数字或百分比（例如 "50%" 表示水平居中）。 */
	col?: SizeValue;

	// === 距终端边缘的边距 ===
	/** 距终端边缘的边距。数字会应用于所有边。 */
	margin?: OverlayMargin | number;

	// === 可见性 ===
	/**
	 * 根据终端尺寸控制覆盖层可见性。
	 * 如果提供，仅当其返回 true 时才渲染覆盖层。
	 * 每个渲染周期都会用当前终端尺寸调用。
	 */
	visible?: (termWidth: number, termHeight: number) => boolean;
	/** 为 true 时，显示后不捕获键盘焦点。 */
	nonCapturing?: boolean;
}

/** {@link OverlayHandle.unfocus} 的选项。 */
export interface OverlayUnfocusOptions {
	/** 释放当前覆盖层后要聚焦的显式目标。 */
	target: Component | null;
}

/** 最近一次渲染的终端相对覆盖层矩形。 */
export interface OverlayBounds {
	row: number;
	col: number;
	width: number;
	height: number;
}

/**
 * showOverlay 返回的覆盖层控制句柄。
 */
export interface OverlayHandle {
	/** 永久移除覆盖层，之后无法再次显示。 */
	hide(): void;
	/** 临时隐藏或显示覆盖层。 */
	setHidden(hidden: boolean): void;
	/** 检查覆盖层是否暂时隐藏。 */
	isHidden(): boolean;
	/** 聚焦当前覆盖层，并将其移到视觉最前方。 */
	focus(): void;
	/** 将焦点释放给下一个可见捕获型覆盖层、先前目标，或所提供的显式目标。 */
	unfocus(options?: OverlayUnfocusOptions): void;
	/** 检查当前覆盖层是否具有焦点。 */
	isFocused(): boolean;
	/** 获取可见覆盖层最近一次渲染的边界。 */
	getBounds(): OverlayBounds | undefined;
}

type OverlayStackEntry = {
	component: Component;
	options?: OverlayOptions;
	preFocus: Component | null;
	hidden: boolean;
	focusOrder: number;
	bounds?: OverlayBounds;
};

type RenderedOverlayLayout = {
	entry: OverlayStackEntry;
	row: number;
	col: number;
	width: number;
	height: number;
};

type OverlayBlockedFocusResume = { status: "restore-overlay" } | { status: "focus-target"; target: Component | null };
type EligibleOverlayFocusRestoreState = { status: "eligible"; overlay: OverlayStackEntry };
type BlockedOverlayFocusRestoreState = {
	status: "blocked";
	overlay: OverlayStackEntry;
	blockedBy: Component;
	resume: OverlayBlockedFocusResume;
};
type ActiveOverlayFocusRestoreState = EligibleOverlayFocusRestoreState | BlockedOverlayFocusRestoreState;
type OverlayFocusRestoreState = { status: "inactive" } | ActiveOverlayFocusRestoreState;
type OverlayFocusRestorePolicy = "clear" | "preserve";

/**
 * Container——包含其他组件的组件。
 */
export class Container implements Component {
	children: Component[] = [];
	private mouseLayout?: { width: number; children: Array<{ component: Component; height: number }> };

	addChild(component: Component): void {
		this.children.push(component);
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
		}
	}

	clear(): void {
		this.children = [];
	}

	invalidate(): void {
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
		if (event.y < 0 || event.y >= event.height) return undefined;
		const mouseChildren =
			this.mouseLayout?.width === event.width
				? this.mouseLayout.children
				: this.children.map((component) => ({ component, height: component.render(event.width).length }));
		let childY = 0;
		for (const { component: child, height: childHeight } of mouseChildren) {
			if (event.y >= childY && event.y < childY + childHeight) {
				const result = dispatchMouseEvent(child, {
					...event,
					y: event.y - childY,
					height: childHeight,
				});
				if (result?.focus && (this as Component).handleInput) return { ...result, focusTarget: this };
				return result;
			}
			childY += childHeight;
		}
		return undefined;
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const mouseChildren: Array<{ component: Component; height: number }> = [];
		for (const child of this.children) {
			const childLines = child.render(width);
			mouseChildren.push({ component: child, height: childLines.length });
			for (const line of childLines) {
				lines.push(line);
			}
		}
		this.mouseLayout = { width, children: mouseChildren };
		return lines;
	}
}

/**
 * TUI——使用差异渲染管理终端 UI 的主类。
 */
const SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";

/** 在固定列将覆盖层内容合成到终端行中。 */
export function compositeTuiLine(
	baseLine: string,
	overlayLine: string,
	startCol: number,
	overlayWidth: number,
	totalWidth: number,
): string {
	if (isImageLine(baseLine)) return baseLine;

	const afterStart = startCol + overlayWidth;
	const base = extractSegments(baseLine, startCol, afterStart, totalWidth - afterStart, true);
	const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true);
	const beforePad = Math.max(0, startCol - base.beforeWidth);
	const overlayPad = Math.max(0, overlayWidth - overlay.width);
	const actualBeforeWidth = Math.max(startCol, base.beforeWidth);
	const actualOverlayWidth = Math.max(overlayWidth, overlay.width);
	const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth);
	const afterPad = Math.max(0, afterTarget - base.afterWidth);
	const result =
		base.before +
		" ".repeat(beforePad) +
		SEGMENT_RESET +
		overlay.text +
		" ".repeat(overlayPad) +
		SEGMENT_RESET +
		base.after +
		" ".repeat(afterPad);

	return visibleWidth(result) <= totalWidth ? result : sliceByColumn(result, 0, totalWidth, true);
}

export type TuiMode = "regular" | "fullscreen";

export interface TuiStopOptions {
	/** 保留渲染器输出，以供接管同一终端的其他 TUI 使用。 */
	preserveScreen?: boolean;
}

export interface TUI extends Component {
	readonly mode: TuiMode;
	children: Component[];
	terminal: Terminal;
	onDebug?: () => void;
	readonly fullRedraws: number;
	addChild(component: Component): void;
	removeChild(component: Component): void;
	clear(): void;
	getShowHardwareCursor(): boolean;
	setShowHardwareCursor(enabled: boolean): void;
	getClearOnShrink(): boolean;
	setClearOnShrink(enabled: boolean): void;
	setFocus(component: Component | null): void;
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle;
	hideOverlay(): void;
	hasOverlay(): boolean;
	start(): void;
	stop(options?: TuiStopOptions): void;
	renderNow(force?: boolean): void;
	requestRender(force?: boolean): void;
	addInputListener(listener: TuiInputListener): () => void;
	removeInputListener(listener: TuiInputListener): void;
	onTerminalColorSchemeChange(listener: (scheme: TerminalColorScheme) => void): () => void;
	setTerminalColorSchemeNotifications(enabled: boolean): void;
	queryTerminalBackgroundColor(options: { timeoutMs: number }): Promise<RgbColor | undefined>;
	queryTerminalColorScheme(options: { timeoutMs: number }): Promise<TerminalColorScheme | undefined>;
}

export const VIEWPORT_TUI = Symbol.for("@earendil-works/pi-tui/viewport");

export interface ViewportTUI extends TUI {
	readonly [VIEWPORT_TUI]: true;
	setLayoutRoot(component: Component | undefined): void;
}

export function isViewportTUI(tui: TUI): tui is ViewportTUI {
	return (tui as Partial<ViewportTUI>)[VIEWPORT_TUI] === true;
}

export abstract class TuiBase extends Container implements TUI {
	abstract readonly mode: TuiMode;
	public terminal: Terminal;
	private focusedComponent: Component | null = null;
	private inputListeners = new Set<TuiInputListener>();

	/** 调试键（Shift+Ctrl+D）的全局回调。在输入转发给焦点组件前调用。 */
	public onDebug?: () => void;
	private renderRequested = false;
	private immediateRenderScheduled = false;
	private renderTimer: NodeJS.Timeout | undefined;
	private lastRenderAt = 0;
	private static readonly MIN_RENDER_INTERVAL_MS = 16;
	private showHardwareCursor = false;
	private clearOnShrink = false;
	protected fullRedrawCount = 0;
	protected stopped = false;
	private pendingOsc11BackgroundReplies = 0;
	private pendingOsc11BackgroundQueries: PendingOsc11BackgroundQuery[] = [];
	private terminalColorSchemeListeners = new Set<(scheme: TerminalColorScheme) => void>();
	private terminalColorSchemeNotificationsEnabled = false;
	/** 调试/崩溃日志目录。为 undefined 时禁用调试日志，崩溃转储回退到操作系统临时目录。 */
	protected readonly logDirectory: string | undefined;

	// 渲染在基础内容之上的模态组件覆盖层栈。
	private focusOrderCounter = 0;
	private overlayStack: OverlayStackEntry[] = [];
	private renderedOverlayLayouts: RenderedOverlayLayout[] = [];

	get hasOverlayEntries(): boolean {
		return this.overlayStack.length > 0;
	}
	private overlayFocusRestore: OverlayFocusRestoreState = { status: "inactive" };

	constructor(terminal: Terminal, showHardwareCursor?: boolean, logDirectory?: string) {
		super();
		this.terminal = terminal;
		this.logDirectory = logDirectory;
		if (showHardwareCursor !== undefined) {
			this.showHardwareCursor = showHardwareCursor;
		}
	}

	protected abstract doRender(): void;

	protected resetRenderState(): void {}

	protected beforeTerminalStart(): void {}

	protected afterTerminalStart(): void {}

	protected beforeTerminalStop(_options: TuiStopOptions): void {}

	protected afterTerminalStop(_options: TuiStopOptions): void {}

	get fullRedraws(): number {
		return this.fullRedrawCount;
	}

	getShowHardwareCursor(): boolean {
		return this.showHardwareCursor;
	}

	setShowHardwareCursor(enabled: boolean): void {
		if (this.showHardwareCursor === enabled) return;
		this.showHardwareCursor = enabled;
		if (!enabled) {
			this.terminal.hideCursor();
		}
		this.requestRender();
	}

	getClearOnShrink(): boolean {
		return this.clearOnShrink;
	}

	/**
	 * 设置内容缩小时是否触发完整重绘。
	 * 为 true 时，内容缩小会清除空行。
	 * 为 false（默认）时保留空行，以减少较慢终端上的重绘。
	 */
	setClearOnShrink(enabled: boolean): void {
		this.clearOnShrink = enabled;
	}

	getFocusedComponent(): Component | null {
		return this.focusedComponent;
	}

	setFocus(component: Component | null): void {
		this.setFocusInternal({ component, overlayFocusRestore: "clear" });
	}

	private setFocusInternal({
		component,
		overlayFocusRestore,
	}: {
		component: Component | null;
		overlayFocusRestore: OverlayFocusRestorePolicy;
	}): void {
		const previousFocus = this.focusedComponent;
		let nextFocus = component;
		const previousFocusedOverlay = previousFocus
			? this.overlayStack.find((entry) => entry.component === previousFocus && this.isOverlayVisible(entry))
			: undefined;
		const nextFocusIsOverlay = nextFocus ? this.overlayStack.some((entry) => entry.component === nextFocus) : false;
		const restoreState = this.getVisibleOverlayFocusRestore();
		if (nextFocus && !nextFocusIsOverlay) {
			if (restoreState.status === "blocked" && restoreState.blockedBy === previousFocus) {
				if (restoreState.resume.status === "focus-target" || !this.isComponentMounted(restoreState.blockedBy)) {
					nextFocus = this.resolveBlockedOverlayFocusResume(restoreState);
				} else {
					this.overlayFocusRestore = {
						status: "blocked",
						overlay: restoreState.overlay,
						blockedBy: nextFocus,
						resume: restoreState.resume,
					};
				}
			} else if (
				previousFocusedOverlay &&
				restoreState.status !== "inactive" &&
				restoreState.overlay === previousFocusedOverlay &&
				!this.isOverlayFocusAncestor(previousFocusedOverlay, nextFocus)
			) {
				this.overlayFocusRestore = {
					status: "blocked",
					overlay: previousFocusedOverlay,
					blockedBy: nextFocus,
					resume: { status: "restore-overlay" },
				};
			}
		} else if (nextFocus === null) {
			if (restoreState.status === "blocked" && restoreState.blockedBy === previousFocus) {
				nextFocus = this.resolveBlockedOverlayFocusResume(restoreState);
			} else if (overlayFocusRestore === "clear") {
				this.clearOverlayFocusRestore();
			}
		}

		if (isFocusable(this.focusedComponent)) {
			this.focusedComponent.focused = false;
		}

		this.focusedComponent = nextFocus;

		if (isFocusable(nextFocus)) {
			nextFocus.focused = true;
		}

		const focusedOverlay = nextFocus
			? this.overlayStack.find((entry) => entry.component === nextFocus && this.isOverlayVisible(entry))
			: undefined;
		if (focusedOverlay) {
			this.overlayFocusRestore = { status: "eligible", overlay: focusedOverlay };
		}
	}

	private clearOverlayFocusRestore(): void {
		this.overlayFocusRestore = { status: "inactive" };
	}

	private clearOverlayFocusRestoreFor(overlay: OverlayStackEntry): void {
		if (this.overlayFocusRestore.status !== "inactive" && this.overlayFocusRestore.overlay === overlay) {
			this.clearOverlayFocusRestore();
		}
	}

	private resolveBlockedOverlayFocusResume(restoreState: BlockedOverlayFocusRestoreState): Component | null {
		if (restoreState.resume.status === "restore-overlay") return restoreState.overlay.component;
		this.clearOverlayFocusRestore();
		return restoreState.resume.target;
	}

	private getVisibleOverlayFocusRestore(): OverlayFocusRestoreState {
		const restoreState = this.overlayFocusRestore;
		if (restoreState.status === "inactive") return restoreState;
		if (!this.overlayStack.includes(restoreState.overlay) || !this.isOverlayVisible(restoreState.overlay)) {
			return { status: "inactive" };
		}
		return restoreState;
	}

	private isOverlayFocusAncestor(entry: OverlayStackEntry, component: Component): boolean {
		const visited = new Set<Component>();
		let current = entry.preFocus;
		while (current && !visited.has(current)) {
			visited.add(current);
			if (current === component) return true;
			current = this.overlayStack.find((overlay) => overlay.component === current)?.preFocus ?? null;
		}
		return false;
	}

	private retargetOverlayPreFocus(removed: OverlayStackEntry): void {
		for (const overlay of this.overlayStack) {
			if (overlay !== removed && overlay.preFocus === removed.component) {
				overlay.preFocus = removed.preFocus;
			}
		}
	}

	protected getMountedRoots(): readonly Component[] {
		return this.children;
	}

	private isComponentMounted(component: Component): boolean {
		return this.getMountedRoots().some((child) => this.containsComponent(child, component));
	}

	private containsComponent(root: Component, target: Component): boolean {
		if (root === target) return true;
		if (!(root instanceof Container)) return false;
		return root.children.some((child) => this.containsComponent(child, target));
	}

	/**
	 * 显示位置和尺寸可配置的覆盖层组件。
	 * 返回用于控制覆盖层可见性的句柄。
	 */
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
		const entry: OverlayStackEntry = {
			component,
			...(options === undefined ? {} : { options }),
			preFocus: this.focusedComponent,
			hidden: false,
			focusOrder: ++this.focusOrderCounter,
		};
		this.overlayStack.push(entry);
		// 仅在覆盖层实际可见时聚焦。
		if (!options?.nonCapturing && this.isOverlayVisible(entry)) {
			this.setFocus(component);
		}
		this.terminal.hideCursor();
		this.requestRender();

		// 返回用于控制当前覆盖层的句柄。
		return {
			hide: () => {
				const index = this.overlayStack.indexOf(entry);
				if (index !== -1) {
					this.clearOverlayFocusRestoreFor(entry);
					this.retargetOverlayPreFocus(entry);
					this.overlayStack.splice(index, 1);
					// 当前覆盖层原本有焦点时恢复焦点。
					if (this.focusedComponent === component) {
						const topVisible = this.getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
					if (this.overlayStack.length === 0) this.terminal.hideCursor();
					this.requestRender();
				}
			},
			setHidden: (hidden: boolean) => {
				if (entry.hidden === hidden) return;
				entry.hidden = hidden;
				// 隐藏或显示时更新焦点。
				if (hidden) {
					this.clearOverlayFocusRestoreFor(entry);
					// 当前覆盖层有焦点时，将焦点移到下一个可见覆盖层或 preFocus。
					if (this.focusedComponent === component) {
						const topVisible = this.getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
				} else {
					// 显示时如果当前覆盖层实际可见，则恢复其焦点。
					if (!options?.nonCapturing && this.isOverlayVisible(entry)) {
						entry.focusOrder = ++this.focusOrderCounter;
						this.setFocus(component);
					}
				}
				this.requestRender();
			},
			isHidden: () => entry.hidden,
			focus: () => {
				if (!this.overlayStack.includes(entry) || !this.isOverlayVisible(entry)) return;
				entry.focusOrder = ++this.focusOrderCounter;
				this.setFocus(component);
				this.requestRender();
			},
			unfocus: (unfocusOptions) => {
				const isFocused = this.focusedComponent === component;
				const restoreState = this.overlayFocusRestore;
				const hasPendingRestore = restoreState.status !== "inactive" && restoreState.overlay === entry;
				if (!isFocused && !hasPendingRestore) return;
				if (
					restoreState.status === "blocked" &&
					restoreState.overlay === entry &&
					this.focusedComponent === restoreState.blockedBy
				) {
					if (unfocusOptions) {
						this.overlayFocusRestore = {
							status: "blocked",
							overlay: entry,
							blockedBy: restoreState.blockedBy,
							resume: { status: "focus-target", target: unfocusOptions.target },
						};
					} else {
						this.clearOverlayFocusRestore();
					}
					this.requestRender();
					return;
				}
				this.clearOverlayFocusRestoreFor(entry);
				if (isFocused || unfocusOptions) {
					const topVisible = this.getTopmostVisibleOverlay();
					const fallbackTarget = topVisible && topVisible !== entry ? topVisible.component : entry.preFocus;
					this.setFocus(unfocusOptions ? unfocusOptions.target : fallbackTarget);
				}
				this.requestRender();
			},
			isFocused: () => this.focusedComponent === component,
			getBounds: () => {
				if (!this.overlayStack.includes(entry) || !this.isOverlayVisible(entry) || !entry.bounds) return undefined;
				return { ...entry.bounds };
			},
		};
	}

	/** 隐藏最上层覆盖层并恢复先前焦点。 */
	hideOverlay(): void {
		const overlay = this.overlayStack[this.overlayStack.length - 1];
		if (!overlay) return;
		this.clearOverlayFocusRestoreFor(overlay);
		this.retargetOverlayPreFocus(overlay);
		this.overlayStack.pop();
		if (this.focusedComponent === overlay.component) {
			// 查找最上层可见覆盖层，否则回退到 preFocus。
			const topVisible = this.getTopmostVisibleOverlay();
			this.setFocus(topVisible?.component ?? overlay.preFocus);
		}
		if (this.overlayStack.length === 0) this.terminal.hideCursor();
		this.requestRender();
	}

	/** 检查是否存在可见覆盖层。 */
	hasOverlay(): boolean {
		return this.overlayStack.some((o) => this.isOverlayVisible(o));
	}

	/** 检查焦点组件是否为可见覆盖层。 */
	protected isOverlayFocused(): boolean {
		return this.overlayStack.some(
			(entry) => entry.component === this.focusedComponent && this.isOverlayVisible(entry),
		);
	}

	/** 点击嵌套控件时，保持覆盖层容器为键盘焦点所有者。 */
	protected resolveMouseFocusTarget(component: Component): Component {
		for (let index = this.overlayStack.length - 1; index >= 0; index--) {
			const overlay = this.overlayStack[index]!;
			if (this.isOverlayVisible(overlay) && this.containsComponent(overlay.component, component)) {
				return overlay.component;
			}
		}
		return component;
	}

	/** 分派到指针下方视觉上最靠前的覆盖层。 */
	protected dispatchMouseToOverlay(event: TuiMouseEvent): { hit: boolean; result?: TuiMouseDispatchResult } {
		for (let index = this.renderedOverlayLayouts.length - 1; index >= 0; index--) {
			const layout = this.renderedOverlayLayouts[index]!;
			if (
				event.screenX < layout.col ||
				event.screenX >= layout.col + layout.width ||
				event.screenY < layout.row ||
				event.screenY >= layout.row + layout.height
			) {
				continue;
			}
			const result = dispatchMouseEvent(layout.entry.component, {
				...event,
				x: event.screenX - layout.col,
				y: event.screenY - layout.row,
				width: layout.width,
				height: layout.height,
			});
			return result
				? {
						hit: true,
						result: result.focus ? { ...result, focusTarget: layout.entry.component } : result,
					}
				: { hit: true };
		}
		return { hit: false };
	}

	/** 检查覆盖层条目当前是否可见。 */
	private isOverlayVisible(entry: OverlayStackEntry): boolean {
		if (entry.hidden) return false;
		if (entry.options?.visible) {
			return entry.options.visible(this.terminal.columns, this.terminal.rows);
		}
		return true;
	}

	/** 查找视觉上最靠前的可见捕获型覆盖层（如果有）。 */
	private getTopmostVisibleOverlay(): OverlayStackEntry | undefined {
		let topmost: OverlayStackEntry | undefined;
		for (const overlay of this.overlayStack) {
			if (overlay.options?.nonCapturing || !this.isOverlayVisible(overlay)) continue;
			if (!topmost || overlay.focusOrder > topmost.focusOrder) {
				topmost = overlay;
			}
		}
		return topmost;
	}

	override invalidate(): void {
		for (const root of this.getMountedRoots()) root.invalidate();
		for (const overlay of this.overlayStack) overlay.component.invalidate();
	}

	start(): void {
		this.stopped = false;
		this.beforeTerminalStart();
		this.terminal.start(
			(data) => this.handleTerminalInput(data),
			() => this.requestRender(),
		);
		this.afterTerminalStart();
		this.terminal.hideCursor();
		if (this.terminalColorSchemeNotificationsEnabled) {
			this.terminal.write("\x1b[?2031h");
		}
		this.queryCellSize();
		this.requestRender();
	}

	addInputListener(listener: TuiInputListener): () => void {
		this.inputListeners.add(listener);
		return () => {
			this.inputListeners.delete(listener);
		};
	}

	removeInputListener(listener: TuiInputListener): void {
		this.inputListeners.delete(listener);
	}

	onTerminalColorSchemeChange(listener: (scheme: TerminalColorScheme) => void): () => void {
		this.terminalColorSchemeListeners.add(listener);
		return () => {
			this.terminalColorSchemeListeners.delete(listener);
		};
	}

	setTerminalColorSchemeNotifications(enabled: boolean): void {
		if (this.terminalColorSchemeNotificationsEnabled === enabled) {
			return;
		}
		this.terminalColorSchemeNotificationsEnabled = enabled;
		if (!this.stopped) {
			this.terminal.write(enabled ? "\x1b[?2031h" : "\x1b[?2031l");
		}
	}

	private queryCellSize(): void {
		// 仅在终端支持图像时查询，因为单元格尺寸只用于图像渲染。
		if (!getCapabilities().images) {
			return;
		}
		// 查询以像素计的终端单元格尺寸：CSI 16 t。
		// 响应格式：CSI 6 ; height ; width t
		this.terminal.write("\x1b[16t");
	}

	stop(options: TuiStopOptions = {}): void {
		this.stopped = true;
		this.cancelRenderTimer();
		if (this.terminalColorSchemeNotificationsEnabled) {
			this.terminal.write("\x1b[?2031l");
		}
		this.beforeTerminalStop(options);
		this.terminal.showCursor();
		this.terminal.stop();
		this.afterTerminalStop(options);
	}

	renderNow(force = false): void {
		if (force) this.resetRenderState();
		this.renderRequested = false;
		this.cancelRenderTimer();
		this.lastRenderAt = performance.now();
		this.doRender();
	}

	requestRender(force = false): void {
		if (force) {
			this.resetRenderState();
			this.requestImmediateRender();
			return;
		}
		if (this.renderRequested) return;
		this.renderRequested = true;
		process.nextTick(() => this.scheduleRender());
	}

	private requestImmediateRender(): void {
		this.cancelRenderTimer();
		this.renderRequested = true;
		if (this.immediateRenderScheduled) return;
		this.immediateRenderScheduled = true;
		process.nextTick(() => {
			this.immediateRenderScheduled = false;
			if (this.stopped || !this.renderRequested) return;
			// 此回调运行前，先前排队的 scheduleRender() 可能已经创建计时器。
			// 用户输入必须抢占该节流帧。
			this.cancelRenderTimer();
			this.renderRequested = false;
			this.lastRenderAt = performance.now();
			this.doRender();
		});
	}

	private cancelRenderTimer(): void {
		if (!this.renderTimer) return;
		clearTimeout(this.renderTimer);
		this.renderTimer = undefined;
	}

	private scheduleRender(): void {
		if (this.stopped || this.renderTimer || !this.renderRequested) {
			return;
		}
		const elapsed = performance.now() - this.lastRenderAt;
		const delay = Math.max(0, TuiBase.MIN_RENDER_INTERVAL_MS - elapsed);
		this.renderTimer = setTimeout(() => {
			this.renderTimer = undefined;
			if (this.stopped || !this.renderRequested) {
				return;
			}
			this.renderRequested = false;
			this.lastRenderAt = performance.now();
			this.doRender();
			if (this.renderRequested) {
				this.scheduleRender();
			}
		}, delay);
	}

	private handleTerminalInput(data: string): void {
		if (this.consumeOsc11BackgroundResponse(data)) {
			return;
		}
		if (this.consumeTerminalColorSchemeReport(data)) {
			return;
		}

		if (this.inputListeners.size > 0) {
			let current = data;
			for (const listener of this.inputListeners) {
				const result = listener(current);
				if (result?.consume) {
					return;
				}
				if (result?.data !== undefined) {
					current = result.data;
				}
			}
			if (current.length === 0) {
				return;
			}
			data = current;
		}

		// 消费终端单元格尺寸响应，同时不阻塞无关输入。
		if (this.consumeCellSizeResponse(data)) {
			return;
		}

		// 全局调试键处理器（Shift+Ctrl+D）。
		if (matchesKey(data, "shift+ctrl+d") && this.onDebug) {
			this.onDebug();
			return;
		}

		// 焦点组件是覆盖层时，验证其是否仍然可见。
		// 终端尺寸变化或 visible() 回调可能改变可见性。
		const focusedOverlay = this.overlayStack.find((o) => o.component === this.focusedComponent);
		if (focusedOverlay && !this.isOverlayVisible(focusedOverlay)) {
			// 焦点覆盖层已不可见，重定向到最上层可见覆盖层。
			const topVisible = this.getTopmostVisibleOverlay();
			if (topVisible) {
				this.setFocus(topVisible.component);
			} else {
				this.setFocusInternal({ component: focusedOverlay.preFocus, overlayFocusRestore: "preserve" });
			}
		}

		const focusIsOverlay = this.overlayStack.some((o) => o.component === this.focusedComponent);
		if (!focusIsOverlay) {
			const restoreState = this.getVisibleOverlayFocusRestore();
			if (restoreState.status === "eligible") {
				this.setFocus(restoreState.overlay.component);
			} else if (restoreState.status === "blocked" && restoreState.blockedBy !== this.focusedComponent) {
				if (restoreState.resume.status === "restore-overlay") {
					this.setFocus(restoreState.overlay.component);
				} else {
					this.clearOverlayFocusRestore();
					this.setFocus(restoreState.resume.target);
				}
			}
		}

		// 将输入（包括 Ctrl+C）传递给焦点组件。
		// 焦点组件可自行决定如何处理 Ctrl+C。
		if (this.focusedComponent?.handleInput) {
			// 除非组件选择接收，否则过滤按键释放事件。
			if (isKeyRelease(data) && !this.focusedComponent.wantsKeyRelease) {
				return;
			}
			this.focusedComponent.handleInput(data);
			// 键盘输入对延迟敏感，应避开节流计时器路径；
			// 在 Windows 上，即使 setTimeout(0) 也可能耗费完整的 16 ms tick。
			this.requestImmediateRender();
		}
	}

	private consumeOsc11BackgroundResponse(data: string): boolean {
		if (this.pendingOsc11BackgroundReplies <= 0) {
			return false;
		}

		if (!isOsc11BackgroundColorResponse(data)) {
			return false;
		}

		const rgb = parseOsc11BackgroundColor(data);
		this.pendingOsc11BackgroundReplies -= 1;
		const query = this.pendingOsc11BackgroundQueries.shift();
		if (query && !query.settled) {
			query.settled = true;
			if (query.timer) {
				clearTimeout(query.timer);
				query.timer = undefined;
			}
			query.resolve?.(rgb);
			query.resolve = undefined;
		}
		return true;
	}

	private consumeTerminalColorSchemeReport(data: string): boolean {
		const scheme = parseTerminalColorSchemeReport(data);
		if (!scheme) {
			return false;
		}

		for (const listener of this.terminalColorSchemeListeners) {
			listener(scheme);
		}
		return true;
	}

	private consumeCellSizeResponse(data: string): boolean {
		// 响应格式：ESC [ 6 ; height ; width t
		const match = data.match(/^\x1b\[6;(\d+);(\d+)t$/);
		if (!match) {
			return false;
		}

		const heightPx = parseInt(match[1], 10);
		const widthPx = parseInt(match[2], 10);
		if (heightPx <= 0 || widthPx <= 0) {
			return true;
		}

		setCellDimensions({ widthPx, heightPx });
		// 使所有组件失效，以便图像按正确尺寸重新渲染。
		this.invalidate();
		this.requestRender();
		return true;
	}

	/**
	 * 根据选项解析覆盖层布局。
	 * 返回供渲染使用的 { width, row, col, maxHeight }。
	 */
	private resolveOverlayLayout(
		options: OverlayOptions | undefined,
		overlayHeight: number,
		termWidth: number,
		termHeight: number,
	): { width: number; row: number; col: number; maxHeight: number | undefined } {
		const opt = options ?? {};

		// 解析边距，并限制为非负值。
		const margin =
			typeof opt.margin === "number"
				? { top: opt.margin, right: opt.margin, bottom: opt.margin, left: opt.margin }
				: (opt.margin ?? {});
		const marginTop = Math.max(0, margin.top ?? 0);
		const marginRight = Math.max(0, margin.right ?? 0);
		const marginBottom = Math.max(0, margin.bottom ?? 0);
		const marginLeft = Math.max(0, margin.left ?? 0);

		// 扣除边距后的可用空间。
		const availWidth = Math.max(1, termWidth - marginLeft - marginRight);
		const availHeight = Math.max(1, termHeight - marginTop - marginBottom);

		// === 解析宽度 ===
		let width = parseSizeValue(opt.width, termWidth) ?? Math.min(80, availWidth);
		// 应用 minWidth。
		if (opt.minWidth !== undefined) {
			width = Math.max(width, opt.minWidth);
		}
		// 限制到可用空间。
		width = Math.max(1, Math.min(width, availWidth));

		// === 解析 maxHeight ===
		let maxHeight = parseSizeValue(opt.maxHeight, termHeight);
		// 限制到可用空间。
		if (maxHeight !== undefined) {
			maxHeight = Math.max(1, Math.min(maxHeight, availHeight));
		}

		// 覆盖层有效高度，可能受 maxHeight 限制。
		const effectiveHeight = maxHeight !== undefined ? Math.min(overlayHeight, maxHeight) : overlayHeight;

		// === 解析位置 ===
		let row: number;
		let col: number;

		if (opt.row !== undefined) {
			if (typeof opt.row === "string") {
				// 百分比：0% 为顶部，100% 为底部，覆盖层保持在边界内。
				const match = opt.row.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxRow = Math.max(0, availHeight - effectiveHeight);
					const percent = parseFloat(match[1]) / 100;
					row = marginTop + Math.floor(maxRow * percent);
				} else {
					// 格式无效，回退到居中。
					row = this.resolveAnchorRow("center", effectiveHeight, availHeight, marginTop);
				}
			} else {
				// 绝对行位置。
				row = opt.row;
			}
		} else {
			// 基于锚点定位，默认为居中。
			const anchor = opt.anchor ?? "center";
			row = this.resolveAnchorRow(anchor, effectiveHeight, availHeight, marginTop);
		}

		if (opt.col !== undefined) {
			if (typeof opt.col === "string") {
				// 百分比：0% 为左侧，100% 为右侧，覆盖层保持在边界内。
				const match = opt.col.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxCol = Math.max(0, availWidth - width);
					const percent = parseFloat(match[1]) / 100;
					col = marginLeft + Math.floor(maxCol * percent);
				} else {
					// 格式无效，回退到居中。
					col = this.resolveAnchorCol("center", width, availWidth, marginLeft);
				}
			} else {
				// 绝对列位置。
				col = opt.col;
			}
		} else {
			// 基于锚点定位，默认为居中。
			const anchor = opt.anchor ?? "center";
			col = this.resolveAnchorCol(anchor, width, availWidth, marginLeft);
		}

		// 应用偏移。
		if (opt.offsetY !== undefined) row += opt.offsetY;
		if (opt.offsetX !== undefined) col += opt.offsetX;

		// 在尊重边距的情况下限制到终端边界。
		row = Math.max(marginTop, Math.min(row, termHeight - marginBottom - effectiveHeight));
		col = Math.max(marginLeft, Math.min(col, termWidth - marginRight - width));

		return { width, row, col, maxHeight };
	}

	private resolveAnchorRow(anchor: OverlayAnchor, height: number, availHeight: number, marginTop: number): number {
		switch (anchor) {
			case "top-left":
			case "top-center":
			case "top-right":
				return marginTop;
			case "bottom-left":
			case "bottom-center":
			case "bottom-right":
				return marginTop + availHeight - height;
			case "left-center":
			case "center":
			case "right-center":
				return marginTop + Math.floor((availHeight - height) / 2);
		}
	}

	private resolveAnchorCol(anchor: OverlayAnchor, width: number, availWidth: number, marginLeft: number): number {
		switch (anchor) {
			case "top-left":
			case "left-center":
			case "bottom-left":
				return marginLeft;
			case "top-right":
			case "right-center":
			case "bottom-right":
				return marginLeft + availWidth - width;
			case "top-center":
			case "center":
			case "bottom-center":
				return marginLeft + Math.floor((availWidth - width) / 2);
		}
	}

	/** 将所有覆盖层合成到内容行中；按 focusOrder 排序，值越高越靠前。 */
	protected compositeOverlays(lines: string[], termWidth: number, termHeight: number): string[] {
		if (this.overlayStack.length === 0) {
			this.renderedOverlayLayouts = [];
			return lines;
		}
		const result = [...lines];

		for (const entry of this.overlayStack) entry.bounds = undefined;

		// 预渲染所有可见覆盖层并计算位置。
		const rendered: { entry: OverlayStackEntry; overlayLines: string[]; row: number; col: number; w: number }[] = [];
		let minLinesNeeded = result.length;

		const visibleEntries = this.overlayStack.filter((e) => this.isOverlayVisible(e));
		visibleEntries.sort((a, b) => a.focusOrder - b.focusOrder);
		for (const entry of visibleEntries) {
			const { component, options } = entry;

			// 先用 height=0 获取布局，以确定 width 和 maxHeight；
			// 两者均不依赖覆盖层高度。
			const { width, maxHeight } = this.resolveOverlayLayout(options, 0, termWidth, termHeight);

			// 按计算出的宽度渲染组件。
			let overlayLines = component.render(width);

			// 如果指定了 maxHeight，则应用它。
			if (maxHeight !== undefined && overlayLines.length > maxHeight) {
				overlayLines = overlayLines.slice(0, maxHeight);
			}

			// 使用覆盖层实际高度获取最终行列位置。
			const { row, col } = this.resolveOverlayLayout(options, overlayLines.length, termWidth, termHeight);
			entry.bounds = { row, col, width, height: overlayLines.length };

			rendered.push({ entry, overlayLines, row, col, w: width });
			minLinesNeeded = Math.max(minLinesNeeded, row + overlayLines.length);
		}
		this.renderedOverlayLayouts = rendered.map(({ entry, row, col, w, overlayLines }) => ({
			entry,
			row,
			col,
			width: w,
			height: overlayLines.length,
		}));

		// 至少填充到终端高度，使覆盖层具有屏幕相对位置。
		// 不包括 maxLinesRendered：历史高水位会造成自我强化的膨胀，
		// 在终端变宽时将内容推入回滚区。
		const workingHeight = Math.max(result.length, termHeight, minLinesNeeded);

		// 内容过短无法放置覆盖层或覆盖工作区时，用空行扩展结果。
		while (result.length < workingHeight) {
			result.push("");
		}

		const viewportStart = Math.max(0, workingHeight - termHeight);

		// 合成每个覆盖层。
		for (const { overlayLines, row, col, w } of rendered) {
			for (let i = 0; i < overlayLines.length; i++) {
				const idx = viewportStart + row + i;
				if (idx >= 0 && idx < result.length) {
					// 防御性处理：合成前将覆盖层行截断到声明宽度。
					// 组件本应遵守宽度约束，此处进一步保证。
					const truncatedOverlayLine =
						visibleWidth(overlayLines[i]) > w ? sliceByColumn(overlayLines[i], 0, w, true) : overlayLines[i];
					result[idx] = this.compositeLineAt(result[idx], truncatedOverlayLine, col, w, termWidth);
				}
			}
		}

		return result;
	}

	protected applyLineResets(lines: string[]): string[] {
		const reset = SEGMENT_RESET;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!isImageLine(line)) {
				lines[i] = normalizeTerminalOutput(line) + reset;
			}
		}
		return lines;
	}

	private compositeLineAt(
		baseLine: string,
		overlayLine: string,
		startCol: number,
		overlayWidth: number,
		totalWidth: number,
	): string {
		return compositeTuiLine(baseLine, overlayLine, startCol, overlayWidth, totalWidth);
	}

	/**
	 * 从渲染行中查找并提取光标位置。
	 * 搜索 CURSOR_MARKER，计算其位置并从输出中移除。
	 * 仅扫描底部 terminal height 行，即可见视口。
	 * @param lines - 要搜索的渲染行
	 * @param height - 终端高度，即可见视口尺寸
	 * @returns 光标位置 { row, col }；未找到标记时返回 null
	 */
	protected extractCursorPosition(lines: string[], height: number): { row: number; col: number } | null {
		// 仅扫描底部 `height` 行，即可见视口。
		const viewportTop = Math.max(0, lines.length - height);
		for (let row = lines.length - 1; row >= viewportTop; row--) {
			const line = lines[row];
			const markerIndex = line.indexOf(CURSOR_MARKER);
			if (markerIndex !== -1) {
				// 计算可视列，即标记前文本的宽度。
				const beforeMarker = line.slice(0, markerIndex);
				const col = visibleWidth(beforeMarker);

				// 从行中移除标记。
				lines[row] = line.slice(0, markerIndex) + line.slice(markerIndex + CURSOR_MARKER.length);

				return { row, col };
			}
		}
		return null;
	}

	/**
	 * 使用 OSC 11（`ESC ] 11 ; ? BEL`）查询终端默认背景色。
	 * @param timeoutMs 查询超时时间，单位为毫秒。
	 * @returns 包含已解析 RGB 颜色的 Promise；超时或解析失败时为 undefined。
	 */
	queryTerminalBackgroundColor({ timeoutMs }: { timeoutMs: number }): Promise<RgbColor | undefined> {
		return new Promise((resolve) => {
			const query: PendingOsc11BackgroundQuery = {
				settled: false,
				resolve,
				timer: undefined,
			};

			query.timer = setTimeout(() => {
				if (query.settled) {
					return;
				}
				query.settled = true;
				query.timer = undefined;
				query.resolve?.(undefined);
				query.resolve = undefined;
			}, timeoutMs);
			this.pendingOsc11BackgroundQueries.push(query);
			this.pendingOsc11BackgroundReplies += 1;
			this.terminal.write("\x1b]11;?\x07");
		});
	}

	/**
	 * 使用 DSR（`CSI ? 996 n`）查询终端配色方案偏好。
	 * 支持调色板通知协议的终端会回复 `CSI ? 997 ; 1 n` 表示深色，
	 * 或回复 `CSI ? 997 ; 2 n` 表示浅色。
	 */
	queryTerminalColorScheme({ timeoutMs }: { timeoutMs: number }): Promise<TerminalColorScheme | undefined> {
		return new Promise((resolve) => {
			let settled = false;
			let timer: NodeJS.Timeout | undefined;
			let unsubscribe: () => void = () => {};
			const settle = (scheme: TerminalColorScheme | undefined) => {
				if (settled) return;
				settled = true;
				if (timer) {
					clearTimeout(timer);
					timer = undefined;
				}
				unsubscribe();
				resolve(scheme);
			};

			unsubscribe = this.onTerminalColorSchemeChange(settle);
			timer = setTimeout(() => settle(undefined), timeoutMs);
			this.terminal.write("\x1b[?996n");
		});
	}
}
