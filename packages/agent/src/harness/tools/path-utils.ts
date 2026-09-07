import type { Context } from "../context.ts";
import type { ExecutionEnv } from "../types.ts";
import { getOrThrow } from "../types.ts";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const NARROW_NO_BREAK_SPACE = "\u202F";

function normalizeToolPath(path: string): string {
	const normalized = path.replace(UNICODE_SPACES, " ");
	return normalized.startsWith("@") ? normalized.slice(1) : normalized;
}

/** 规范化模型可能生成的路径字符，并解析为执行环境中的绝对路径。 */
export async function resolveToolPath(env: ExecutionEnv, path: string, context: Context): Promise<string> {
	return getOrThrow(await env.absolutePath(normalizeToolPath(path), context));
}

/**
 * 解析读取工具路径，并尝试 macOS 常见的窄不换行空格、Unicode 规范化和弯引号变体。
 * 返回第一个实际存在的变体；均不存在时返回普通解析结果，由后续读取生成正式错误。
 */
export async function resolveReadToolPath(env: ExecutionEnv, path: string, context: Context): Promise<string> {
	const resolved = await resolveToolPath(env, path, context);
	const variants = [
		resolved,
		resolved.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`),
		resolved.normalize("NFD"),
		resolved.replace(/'/g, "\u2019"),
		resolved.normalize("NFD").replace(/'/g, "\u2019"),
	];

	for (const variant of new Set(variants)) {
		if (getOrThrow(await env.exists(variant, context))) return variant;
	}
	return resolved;
}
