import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { spawn, spawnSync } from "child_process";
import { getBinDir } from "../config.ts";

export interface ShellConfig {
	shell: string;
	args: string[];
	commandTransport?: "argv" | "stdin";
}

/**
 * 在 PATH 中查找 bash 可执行文件（跨平台）。
 */
function isLegacyWslBashPath(path: string): boolean {
	const normalized = path.replace(/\//g, "\\").toLowerCase();
	return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
}

function getBashShellConfig(shell: string): ShellConfig {
	return isLegacyWslBashPath(shell) ? { shell, args: ["-s"], commandTransport: "stdin" } : { shell, args: ["-c"] };
}

function findExecutableOnPath(executable: string): string | null {
	if (process.platform === "win32") {
		// Windows：使用 'where' 并验证文件存在（where 可能返回不存在的路径）
		try {
			const result = spawnSync("where", [executable], {
				encoding: "utf-8",
				timeout: 5000,
				windowsHide: true,
			});
			if (result.status === 0 && result.stdout) {
				const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
				if (firstMatch && existsSync(firstMatch)) {
					return firstMatch;
				}
			}
		} catch {
			// 忽略错误
		}
		return null;
	}

	// Unix：使用 'which' 并信任其输出（可处理 Termux 和特殊文件系统）
	try {
		const result = spawnSync("which", [executable], { encoding: "utf-8", timeout: 5000 });
		if (result.status === 0 && result.stdout) {
			const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
			if (firstMatch) {
				return firstMatch;
			}
		}
	} catch {
		// 忽略错误
	}
	return null;
}

/**
 * 根据平台和可选的显式 shell 路径解析 shell 配置。
 * 解析顺序：
 * 1. 用户指定的 shellPath
 * 2. Windows：已知位置中的 Git Bash，然后是 PATH 中的 bash
 * 3. Unix：/bin/bash，然后是 PATH 中的 bash，最后回退到 sh
 */
export function getShellConfig(customShellPath?: string): ShellConfig {
	// 1. 检查用户指定的 shell 路径
	if (customShellPath) {
		if (existsSync(customShellPath)) {
			return getBashShellConfig(customShellPath);
		}
		throw new Error(`Custom shell path not found: ${customShellPath}`);
	}

	if (process.platform === "win32") {
		// 2. 尝试已知位置中的 Git Bash
		const paths: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles) {
			paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
		}
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86) {
			paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		}

		for (const path of paths) {
			if (existsSync(path)) {
				return getBashShellConfig(path);
			}
		}

		// 3. 回退方案：在 PATH 中查找 bash.exe（Cygwin、MSYS2、WSL 等）
		const bashOnPath = findExecutableOnPath("bash.exe");
		if (bashOnPath) {
			return getBashShellConfig(bashOnPath);
		}

		throw new Error(
			`No bash shell found. Options:\n` +
				`  1. Install Git for Windows: https://git-scm.com/download/win\n` +
				`  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
				"  3. Set shellPath in settings.json\n\n" +
				`Searched Git Bash in:\n${paths.map((p) => `  ${p}`).join("\n")}`,
		);
	}

	// Unix：先尝试 /bin/bash，再尝试 PATH 中的 bash，最后回退到 sh
	if (existsSync("/bin/bash")) {
		return getBashShellConfig("/bin/bash");
	}

	const bashOnPath = findExecutableOnPath("bash");
	if (bashOnPath) {
		return getBashShellConfig(bashOnPath);
	}

	return { shell: "sh", args: ["-c"] };
}

export const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"] as const;

/** 在 Windows 上解析 PowerShell；PowerShell 7 可用时优先使用。 */
export function getPowerShellConfig(): ShellConfig {
	if (process.platform !== "win32") {
		throw new Error("The powershell tool is only available on Windows.");
	}

	const shell = findExecutableOnPath("pwsh.exe") ?? findExecutableOnPath("powershell.exe");
	if (!shell) {
		throw new Error("No PowerShell executable found. Install PowerShell or add powershell.exe/pwsh.exe to PATH.");
	}

	return { shell, args: [...POWERSHELL_ARGS] };
}

export function getShellEnv(): NodeJS.ProcessEnv {
	const binDir = getBinDir();
	const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const currentPath = process.env[pathKey] ?? "";
	const pathEntries = currentPath.split(delimiter).filter(Boolean);
	const hasBinDir = pathEntries.includes(binDir);
	const updatedPath = hasBinDir ? currentPath : [binDir, currentPath].filter(Boolean).join(delimiter);

	return {
		...process.env,
		[pathKey]: updatedPath,
	};
}

/**
 * 清理用于显示或存储的二进制输出。
 * 移除会导致 string-width 崩溃或引起显示问题的字符：
 * - 控制字符（制表符、换行符和回车符除外）
 * - 孤立代理项
 * - Unicode 格式字符（会因缺陷导致 string-width 崩溃）
 * - 码点未定义的字符
 */
export function sanitizeBinaryOutput(str: string): string {
	// 使用 Array.from 正确遍历码点（而非代码单元）。
	// 这样既能正确处理代理对，也能捕获 codePointAt() 可能返回 undefined 的边界情况。
	return Array.from(str)
		.filter((char) => {
			// 过滤会导致 string-width 崩溃的字符，包括：
			// - Unicode 格式字符
			// - 孤立代理项（已由 Array.from 过滤）
			// - 除 \t、\n、\r 外的控制字符
			// - 码点未定义的字符

			const code = char.codePointAt(0);

			// 码点未定义时跳过（无效字符串的边界情况）
			if (code === undefined) return false;

			// 允许制表符、换行符和回车符
			if (code === 0x09 || code === 0x0a || code === 0x0d) return true;

			// 过滤控制字符（0x00-0x1F，但 0x09、0x0a、0x0d 除外）
			if (code <= 0x1f) return false;

			// 过滤 Unicode 格式字符
			if (code >= 0xfff9 && code <= 0xfffb) return false;

			return true;
		})
		.join("");
}

/**
 * 必须跟踪分离的子进程，以便在父进程收到关闭信号（SIGHUP/SIGTERM）时终止它们。
 */
const trackedDetachedChildPids = new Set<number>();

export function trackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.add(pid);
}

export function untrackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.delete(pid);
}

export function killTrackedDetachedChildren(): void {
	for (const pid of trackedDetachedChildPids) {
		killProcessTree(pid);
	}
	trackedDetachedChildPids.clear();
}

/**
 * 终止一个进程及其所有子进程（跨平台）。
 */
export function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		// 使用受信任的 System32 可执行文件，使清理过程不依赖 PATH。
		try {
			const child = spawn(
				join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
				["/F", "/T", "/PID", String(pid)],
				{
					stdio: "ignore",
					detached: true,
					windowsHide: true,
				},
			);
			// spawn 失败会异步触发 "error"；消费该事件以避免 Node 崩溃。
			child.once("error", () => {});
		} catch {
			// taskkill 失败时忽略错误。
		}
	} else {
		// 在 Unix/Linux/Mac 上使用 SIGKILL
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// 如果终止进程组失败，则回退为仅终止子进程
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// 进程已经终止
			}
		}
	}
}
