import type { ProviderEnv } from "../types.ts";

let procEnvCache: Map<string, string> | null = null;

/**
 * https://github.com/oven-sh/bun/issues/27802 的回退方案。
 * 即使 /proc/self/environ 包含环境变量，Bun 编译的二进制文件在 Linux 沙箱内也可能
 * 暴露空的 process.env。
 *
 * 此处有意重复 packages/coding-agent/src/bun/restore-sandbox-env.ts 中的
 * restoreSandboxEnv()。ai 包可以绕过该入口直接使用，因此提供商环境查找不能依赖
 * process.env 已被修补。
 */
function getBunSandboxEnvValue(name: string): string | undefined {
	if (typeof process === "undefined" || !process.versions?.bun || Object.keys(process.env).length > 0) {
		return undefined;
	}

	if (procEnvCache === null) {
		procEnvCache = new Map();
		try {
			const { readFileSync } = require("node:fs") as {
				readFileSync(path: string, encoding: BufferEncoding): string;
			};
			const data = readFileSync("/proc/self/environ", "utf-8");
			for (const entry of data.split("\0")) {
				const idx = entry.indexOf("=");
				if (idx > 0) {
					procEnvCache.set(entry.slice(0, idx), entry.slice(idx + 1));
				}
			}
		} catch {
			// /proc/self/environ 可能不存在或不可读。
		}
	}

	return procEnvCache.get(name);
}

/**
 * 依次从范围覆盖值、常规 process.env，以及为直接使用 pi-ai 的调用方复制的
 * Bun 沙箱回退方案中解析提供商环境变量值。
 */
export function getProviderEnvValue(name: string, env?: ProviderEnv): string | undefined {
	return (
		env?.[name] ||
		(typeof process !== "undefined" ? process.env[name] : undefined) ||
		getBunSandboxEnvValue(name) ||
		undefined
	);
}
