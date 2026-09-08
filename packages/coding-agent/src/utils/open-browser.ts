import { spawn } from "node:child_process";

/**
 * 使用平台浏览器或默认处理程序打开 URL 或文件。
 *
 * 此处有意不调用 shell。在 Windows 上不要使用 `cmd /c start`：cmd.exe 会在
 * `start` 运行前重新解析元字符（&、|、^ 等），导致攻击者可通过受控 URL 注入命令。
 */
export function openBrowser(target: string): void {
	const [cmd, args]: [string, string[]] =
		process.platform === "darwin"
			? ["open", [target]]
			: process.platform === "win32"
				? ["rundll32", ["url.dll,FileProtocolHandler", target]]
				: ["xdg-open", [target]];

	// spawn 通过 error 事件报告启动器故障（例如缺少 xdg-open）。浏览器启动采用尽力而为策略：
	// 调用方仍会向用户显示目标，因此不要让启动器故障导致进程崩溃。
	spawn(cmd, args, { stdio: "ignore", detached: true })
		.on("error", () => {})
		.unref();
}
