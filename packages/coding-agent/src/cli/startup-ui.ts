import {
	ProcessTerminal,
	setCapabilityOverrides,
	setKeybindings,
	type TUI,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import { existsSync } from "fs";
import { APP_NAME, CONFIG_DIR_NAME, ENV_AGENT_DIR, getAgentDir, getSettingsPath, PACKAGE_NAME } from "../config.ts";
import { areExperimentalFeaturesEnabled } from "../core/experimental.ts";
import { KeybindingsManager } from "../core/keybindings.ts";
import { DefaultPackageManager, type ResolvedResource } from "../core/package-manager.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { ExtensionInputComponent } from "../modes/interactive/components/extension-input.ts";
import { ExtensionSelectorComponent } from "../modes/interactive/components/extension-selector.ts";
import {
	FirstTimeSetupComponent,
	type FirstTimeSetupResult,
} from "../modes/interactive/components/first-time-setup.ts";
import {
	detectTerminalBackgroundFromEnv,
	detectTerminalThemeForAuto,
	initTheme,
	loadThemeFromPath,
	parseAutoThemeSetting,
	resolveThemeSetting,
	setRegisteredThemes,
	setTheme,
	type Theme,
} from "../modes/interactive/theme/theme.ts";

const OFFICIAL_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const OFFICIAL_APP_NAME = "pi";
const OFFICIAL_CONFIG_DIR_NAME = ".pi";

interface DistributionMetadata {
	packageName: string;
	appName: string;
	configDirName: string;
}

function isOfficialDistribution({ packageName, appName, configDirName }: DistributionMetadata): boolean {
	return (
		packageName === OFFICIAL_PACKAGE_NAME &&
		appName === OFFICIAL_APP_NAME &&
		configDirName === OFFICIAL_CONFIG_DIR_NAME
	);
}

function loadThemes(resources: ResolvedResource[]): Theme[] {
	const themes: Theme[] = [];
	const seen = new Set<string>();
	for (const resource of resources) {
		if (!resource.enabled) continue;
		try {
			const loadedTheme = loadThemeFromPath(resource.path);
			if (loadedTheme.name) {
				if (seen.has(loadedTheme.name)) continue;
				seen.add(loadedTheme.name);
			}
			themes.push(loadedTheme);
		} catch {
			// 启动提示不应因主题损坏而失败。常规资源加载器会在后续启动过程中报告主题诊断。
		}
	}
	return themes;
}

async function loadStartupThemes(settingsManager: SettingsManager): Promise<Theme[]> {
	const globalSettingsManager = SettingsManager.inMemory(settingsManager.getGlobalSettings(), {
		projectTrusted: false,
	});
	const packageManager = new DefaultPackageManager({
		cwd: process.cwd(),
		agentDir: getAgentDir(),
		settingsManager: globalSettingsManager,
	});
	const resolvedPaths = await packageManager.resolve(async () => "skip");
	return loadThemes(resolvedPaths.themes);
}

export async function createStartupTui(settingsManager: SettingsManager): Promise<TUI> {
	setCapabilityOverrides(settingsManager.getTerminalCapabilityOverrides());
	setRegisteredThemes(await loadStartupThemes(settingsManager));
	const terminalTheme = detectTerminalBackgroundFromEnv().theme;
	initTheme(resolveThemeSetting(settingsManager.getThemeSetting(), terminalTheme) ?? terminalTheme);
	setKeybindings(KeybindingsManager.create());
	const ui: TUI = new TuiMainScreen(new ProcessTerminal(), settingsManager.getShowHardwareCursor(), getAgentDir());
	ui.setClearOnShrink(settingsManager.getClearOnShrink());
	return ui;
}

export function startStartupTui(ui: TUI, settingsManager: SettingsManager): void {
	ui.start();
	void applyDetectedStartupTheme(ui, settingsManager);
}

async function applyDetectedStartupTheme(ui: TUI, settingsManager: SettingsManager): Promise<void> {
	const themeSetting = settingsManager.getThemeSetting();
	if (themeSetting && !parseAutoThemeSetting(themeSetting)) return;

	const terminalTheme = await detectTerminalThemeForAuto({ ui, timeoutMs: 100 });
	setTheme(resolveThemeSetting(themeSetting, terminalTheme) ?? terminalTheme);
	ui.invalidate();
	ui.requestRender();
}

async function clearStartupTui(ui: TUI): Promise<void> {
	ui.clear();
	ui.requestRender();
	await new Promise((resolve) => setTimeout(resolve, 25));
}

/**
 * 满足以下所有条件时运行首次设置：
 * - 当前为官方 Pi 发行版（不是分支或更名版本）
 * - 已启用实验功能（PI_EXPERIMENTAL=1）
 * - 使用默认 agent 目录（没有自定义 agent 目录覆盖项）
 * - 以前未完成设置（settings.json 不存在）
 */
export function shouldRunFirstTimeSetup(settingsPath: string = getSettingsPath()): boolean {
	if (
		!isOfficialDistribution({
			packageName: PACKAGE_NAME,
			appName: APP_NAME,
			configDirName: CONFIG_DIR_NAME,
		})
	) {
		return false;
	}
	if (!areExperimentalFeaturesEnabled()) {
		return false;
	}
	if (process.env[ENV_AGENT_DIR]) {
		return false;
	}
	return !existsSync(settingsPath);
}

export async function showStartupSelector<T>(
	settingsManager: SettingsManager,
	title: string,
	options: Array<{ label: string; value: T }>,
): Promise<T | undefined> {
	const ui = await createStartupTui(settingsManager);
	return new Promise((resolve) => {
		let settled = false;
		const finish = async (result: T | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			await clearStartupTui(ui);
			ui.stop();
			resolve(result);
		};

		const selector = new ExtensionSelectorComponent(
			title,
			options.map((option) => option.label),
			(option) => void finish(options.find((entry) => entry.label === option)?.value),
			() => void finish(undefined),
			{ tui: ui },
		);
		ui.addChild(selector);
		ui.setFocus(selector);
		startStartupTui(ui, settingsManager);
	});
}

/** 显示首次设置对话框并持久化结果。 */
export async function showFirstTimeSetup(settingsManager: SettingsManager): Promise<void> {
	const ui = await createStartupTui(settingsManager);
	return new Promise((resolve) => {
		let settled = false;
		const finish = async (result: FirstTimeSetupResult | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			if (result) {
				settingsManager.setTheme(result.theme);
				settingsManager.setEnableAnalytics(result.shareAnalytics);
				await settingsManager.flush();
			}
			await clearStartupTui(ui);
			ui.stop();
			resolve();
		};

		const showSetup = async () => {
			ui.start();
			const detectedTheme = await detectTerminalThemeForAuto({ ui, timeoutMs: 100 });
			setTheme(detectedTheme);
			const component = new FirstTimeSetupComponent({
				detectedTheme,
				onThemePreview: (themeName) => {
					setTheme(themeName);
					ui.requestRender();
				},
				onSubmit: (result) => void finish(result),
				onCancel: () => void finish(undefined),
			});
			ui.addChild(component);
			ui.setFocus(component);
			ui.requestRender();
		};

		void showSetup();
	});
}

export async function showStartupInput(
	settingsManager: SettingsManager,
	title: string,
	placeholder?: string,
): Promise<string | undefined> {
	const ui = await createStartupTui(settingsManager);
	return new Promise((resolve) => {
		let settled = false;
		const finish = async (result: string | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			input.dispose();
			await clearStartupTui(ui);
			ui.stop();
			resolve(result);
		};

		const input = new ExtensionInputComponent(
			title,
			placeholder,
			(value) => void finish(value),
			() => void finish(undefined),
			{
				tui: ui,
			},
		);
		ui.addChild(input);
		ui.setFocus(input);
		startStartupTui(ui, settingsManager);
	});
}
