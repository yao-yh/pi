import type { AgentSessionRuntimeDiagnostic } from "./agent-session-services.ts";
import type { SettingsManager } from "./settings-manager.ts";

export function collectSettingsDiagnostics(settingsManager: SettingsManager): AgentSessionRuntimeDiagnostic[] {
	return settingsManager.drainErrors().map(({ scope, path, error }) => ({
		type: "warning",
		message: path ? `Invalid settings file ${path}: ${error.message}` : `Invalid ${scope} settings: ${error.message}`,
	}));
}

/**
 * 删除类型和消息均重复的诊断，同时保留首次出现的诊断。
 * 启动设置管理器和运行时设置管理器可能报告同一个文件错误。
 */
export function deduplicateDiagnostics(
	diagnostics: readonly AgentSessionRuntimeDiagnostic[],
): AgentSessionRuntimeDiagnostic[] {
	const seen = new Set<string>();
	return diagnostics.filter((diagnostic) => {
		const key = `${diagnostic.type}\0${diagnostic.message}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
