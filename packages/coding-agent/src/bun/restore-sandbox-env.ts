/**
 * 针对 https://github.com/oven-sh/bun/issues/27802 的解决方法。
 *
 * Bun 编译的二进制文件在沙箱环境（例如 Linux/macOS 上的 nono）内运行时，
 * `process.env` 为空。在 Linux 上可以从 `/proc/self/environ` 恢复环境变量。
 *
 * 此处需与 packages/ai/src/utils/provider-env.ts 中的 getBunSandboxEnvValue()
 * 保持同步。ai 包为不经过此 coding-agent 入口点的直接使用方重复实现了该查找逻辑。
 */

import { readFileSync } from "node:fs";

/**
 * 在 Bun 的 `process.env` 为空的沙箱中运行时，从 `/proc/self/environ` 恢复环境变量。
 */
export function restoreSandboxEnv(): void {
	if (!process.versions?.bun) return;

	// 如果 process.env 已有内容，则无需修复。
	if (Object.keys(process.env).length > 0) return;

	try {
		const data = readFileSync("/proc/self/environ", "utf-8");
		for (const entry of data.split("\0")) {
			const idx = entry.indexOf("=");
			if (idx > 0) {
				process.env[entry.slice(0, idx)] = entry.slice(idx + 1);
			}
		}
	} catch {
		// /proc/self/environ 可能不可读，此时忽略。
	}
}
