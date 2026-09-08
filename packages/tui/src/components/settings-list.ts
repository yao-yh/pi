import { fuzzyFilter } from "../fuzzy.ts";
import { getKeybindings } from "../keybindings.ts";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "../tui.ts";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils.ts";
import { Input } from "./input.ts";

export interface SettingItem {
	/** 当前设置的唯一标识。 */
	id: string;
	/** 显示标签（左侧）。 */
	label: string;
	/** 选中时显示的可选说明。 */
	description?: string;
	/** 当前显示值（右侧）。 */
	currentValue: string;
	/** 如果提供，按 Enter 或空格会循环切换这些值。 */
	values?: string[];
	/** 如果提供，按 Enter 会打开此子菜单。接收当前值和 done 回调。
	 *  done() 接受可选的 selectedValue，以及用于关闭后移动光标的可选 navigateTo ID。 */
	submenu?: (
		currentValue: string,
		done: (selectedValue?: string, options?: { navigateTo?: string }) => void,
	) => Component;
}

export interface SettingsListTheme {
	label: (text: string, selected: boolean) => string;
	value: (text: string, selected: boolean) => string;
	description: (text: string) => string;
	cursor: string;
	hint: (text: string) => string;
}

export interface SettingsListOptions {
	enableSearch?: boolean;
}

export class SettingsList implements Component {
	private items: SettingItem[];
	private filteredItems: SettingItem[];
	private theme: SettingsListTheme;
	private selectedIndex = 0;
	private mousePressedIndex: number | undefined;
	private maxVisible: number;
	private onChange: (id: string, newValue: string) => void;
	private onCancel: () => void;
	private searchInput?: Input;
	private searchEnabled: boolean;

	// 子菜单状态
	private submenuComponent: Component | null = null;
	private submenuItemIndex: number | null = null;
	private navigateAfterClose: string | null = null;

	constructor(
		items: SettingItem[],
		maxVisible: number,
		theme: SettingsListTheme,
		onChange: (id: string, newValue: string) => void,
		onCancel: () => void,
		options: SettingsListOptions = {},
	) {
		this.items = items;
		this.filteredItems = items;
		this.maxVisible = maxVisible;
		this.theme = theme;
		this.onChange = onChange;
		this.onCancel = onCancel;
		this.searchEnabled = options.enableSearch ?? false;
		if (this.searchEnabled) {
			this.searchInput = new Input();
		}
	}

	/** 更新某项的 currentValue。 */
	updateValue(id: string, newValue: string): void {
		const item = this.items.find((i) => i.id === id);
		if (item) {
			item.currentValue = newValue;
		}
	}

	/** 将选中项移动到指定 ID 的项目；未找到时不执行操作。 */
	selectItem(id: string): void {
		const items = this.searchEnabled ? this.filteredItems : this.items;
		const index = items.findIndex((i) => i.id === id);
		if (index !== -1) {
			this.selectedIndex = index;
		}
	}

	invalidate(): void {
		this.submenuComponent?.invalidate?.();
	}

	render(width: number): string[] {
		// 子菜单处于活动状态时改为渲染子菜单。
		if (this.submenuComponent) {
			return this.submenuComponent.render(width);
		}

		return this.renderMainList(width);
	}

	private renderMainList(width: number): string[] {
		const lines: string[] = [];

		if (this.searchEnabled && this.searchInput) {
			lines.push(...this.searchInput.render(width));
			lines.push("");
		}

		if (this.items.length === 0) {
			lines.push(this.theme.hint("  No settings available"));
			if (this.searchEnabled) {
				this.addHintLine(lines, width);
			}
			return lines;
		}

		const displayItems = this.getDisplayItems();
		if (displayItems.length === 0) {
			lines.push(truncateToWidth(this.theme.hint("  No matching settings"), width));
			this.addHintLine(lines, width);
			return lines;
		}

		// 计算滚动后的可见范围。
		const { startIndex, endIndex } = this.getVisibleRange(displayItems);

		// 计算用于对齐的最大标签宽度。
		const maxLabelWidth = Math.min(36, Math.max(...this.items.map((item) => visibleWidth(item.label))));

		// 渲染可见项。
		for (let i = startIndex; i < endIndex; i++) {
			const item = displayItems[i];
			if (!item) continue;

			const isSelected = i === this.selectedIndex;
			const prefix = isSelected ? this.theme.cursor : "  ";
			const prefixWidth = visibleWidth(prefix);

			// 填充标签以对齐各值。
			const labelPadded = item.label + " ".repeat(Math.max(0, maxLabelWidth - visibleWidth(item.label)));
			const labelText = this.theme.label(labelPadded, isSelected);

			// 计算值的可用空间。
			const separator = "  ";
			const usedWidth = prefixWidth + maxLabelWidth + visibleWidth(separator);
			const valueMaxWidth = width - usedWidth - 2;

			const valueText = this.theme.value(truncateToWidth(item.currentValue, valueMaxWidth, ""), isSelected);

			lines.push(truncateToWidth(prefix + labelText + separator + valueText, width));
		}

		// 必要时添加滚动指示器。
		if (startIndex > 0 || endIndex < displayItems.length) {
			const scrollText = `  (${this.selectedIndex + 1}/${displayItems.length})`;
			lines.push(this.theme.hint(truncateToWidth(scrollText, width - 2, "")));
		}

		// 添加选中项的说明。
		const selectedItem = displayItems[this.selectedIndex];
		if (selectedItem?.description) {
			lines.push("");
			const wrappedDesc = wrapTextWithAnsi(selectedItem.description, width - 4);
			for (const line of wrappedDesc) {
				lines.push(this.theme.description(`  ${line}`));
			}
		}

		// 添加操作提示。
		this.addHintLine(lines, width);

		return lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.submenuComponent) {
			const result = this.submenuComponent.handleMouse?.(event);
			return result ? { ...result, focus: true } : undefined;
		}

		if (this.searchEnabled && this.searchInput) {
			if (event.y === 0) {
				const result = this.searchInput.handleMouse?.(event);
				return result ? { ...result, focus: true } : undefined;
			}
			if (event.y === 1) return undefined;
		}

		const displayItems = this.getDisplayItems();
		if (displayItems.length === 0) return undefined;
		if (event.type === "wheel" && event.wheelDelta) {
			const delta = event.wheelDelta < 0 ? -1 : 1;
			const previousIndex = this.selectedIndex;
			this.selectedIndex = Math.max(0, Math.min(displayItems.length - 1, this.selectedIndex + delta));
			return { handled: true, render: this.selectedIndex !== previousIndex };
		}
		// 悬停不得改变选中项，因为可见范围以选中项为中心。
		if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;

		const rowOffset = this.searchEnabled ? 2 : 0;
		const { startIndex, endIndex } = this.getVisibleRange(displayItems);
		const itemIndex = startIndex + event.y - rowOffset;
		if (itemIndex < startIndex || itemIndex >= endIndex) return undefined;
		if (event.type === "press") {
			this.mousePressedIndex = itemIndex;
			this.selectedIndex = itemIndex;
			return { handled: true, focus: true };
		}
		if (event.type === "click") {
			this.selectedIndex = this.mousePressedIndex ?? itemIndex;
			this.mousePressedIndex = undefined;
			this.activateItem();
			return { handled: true };
		}
		return undefined;
	}

	handleInput(data: string): void {
		// 子菜单处于活动状态时，将所有输入委托给它。
		// 子菜单的 onCancel（由 Escape 触发）会调用 done() 将其关闭。
		if (this.submenuComponent) {
			this.submenuComponent.handleInput?.(data);
			return;
		}

		// 主列表输入处理。
		const kb = getKeybindings();
		const displayItems = this.getDisplayItems();
		if (kb.matches(data, "tui.select.up")) {
			if (displayItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? displayItems.length - 1 : this.selectedIndex - 1;
		} else if (kb.matches(data, "tui.select.down")) {
			if (displayItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === displayItems.length - 1 ? 0 : this.selectedIndex + 1;
		} else if (
			kb.matches(data, "tui.select.confirm") ||
			(data === " " && (!this.searchEnabled || this.searchInput?.getValue().length === 0))
		) {
			this.activateItem();
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.onCancel();
		} else if (this.searchEnabled && this.searchInput) {
			this.searchInput.handleInput(data);
			this.applyFilter(this.searchInput.getValue());
		}
	}

	private getDisplayItems(): SettingItem[] {
		return this.searchEnabled ? this.filteredItems : this.items;
	}

	private getVisibleRange(displayItems: readonly SettingItem[]): { startIndex: number; endIndex: number } {
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), displayItems.length - this.maxVisible),
		);
		return { startIndex, endIndex: Math.min(startIndex + this.maxVisible, displayItems.length) };
	}

	private activateItem(): void {
		const item = this.getDisplayItems()[this.selectedIndex];
		if (!item) return;

		if (item.submenu) {
			// 打开子菜单并传入当前值，使其能够正确预选。
			this.submenuItemIndex = this.selectedIndex;
			this.submenuComponent = item.submenu(
				item.currentValue,
				(selectedValue?: string, options?: { navigateTo?: string }) => {
					if (selectedValue !== undefined) {
						item.currentValue = selectedValue;
						this.onChange(item.id, selectedValue);
					}
					if (options?.navigateTo) {
						this.navigateAfterClose = options.navigateTo;
					}
					this.closeSubmenu();
				},
			);
		} else if (item.values && item.values.length > 0) {
			// 循环切换各个值。
			const currentIndex = item.values.indexOf(item.currentValue);
			const nextIndex = (currentIndex + 1) % item.values.length;
			const newValue = item.values[nextIndex];
			item.currentValue = newValue;
			this.onChange(item.id, newValue);
		}
	}

	private closeSubmenu(): void {
		this.submenuComponent = null;
		if (this.navigateAfterClose !== null) {
			const id = this.navigateAfterClose;
			this.navigateAfterClose = null;
			this.submenuItemIndex = null;
			this.selectItem(id);
			// 自动打开目标项的子菜单。
			this.activateItem();
		} else if (this.submenuItemIndex !== null) {
			// 恢复选中打开该子菜单的项目。
			this.selectedIndex = this.submenuItemIndex;
			this.submenuItemIndex = null;
		}
	}

	private applyFilter(query: string): void {
		this.filteredItems = fuzzyFilter(this.items, query, (item) => item.label);
		this.selectedIndex = 0;
	}

	private addHintLine(lines: string[], width: number): void {
		lines.push("");
		lines.push(
			truncateToWidth(
				this.theme.hint(
					this.searchEnabled
						? "  Type to search · Enter/Space to change · Esc to cancel"
						: "  Enter/Space to change · Esc to cancel",
				),
				width,
			),
		);
	}
}
