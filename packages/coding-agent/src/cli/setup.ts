import { APP_NAME } from "../config.ts";
import { configureHttpDispatcher } from "../core/http-dispatcher.ts";

export function setupCli(): void {
	process.title = APP_NAME;
	process.env.PI_CODING_AGENT = "true";
	process.env.AI_AGENT = "pi";
	process.emitWarning = (() => {}) as typeof process.emitWarning;

	// 在提供方 SDK 发出请求前配置 undici。
	// SettingsManager 加载全局/项目配置后会应用相关设置。
	configureHttpDispatcher();
}
