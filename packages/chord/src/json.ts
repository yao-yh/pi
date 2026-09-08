import type { JsonValue } from "./types.ts";

/** 判断值是否为有限、仅含普通对象且无循环引用的严格 JSON。 */
export function isJsonValue(value: unknown): value is JsonValue {
	return check(value, new Set<object>(), 0);
}

function check(value: unknown, ancestors: Set<object>, depth: number): boolean {
	if (depth > 512) return false;
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) {
		const keys = Reflect.ownKeys(value);
		if (keys.length !== value.length + 1 || keys.some((key) => typeof key !== "string")) return false;
		if (ancestors.has(value)) return false;
		ancestors.add(value);
		try {
			for (let index = 0; index < value.length; index++) {
				const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
				if (
					descriptor === undefined ||
					!descriptor.enumerable ||
					!("value" in descriptor) ||
					!check(descriptor.value, ancestors, depth + 1)
				) {
					return false;
				}
			}
			return true;
		} finally {
			ancestors.delete(value);
		}
	}
	if (typeof value !== "object" || value === null) return false;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) return false;
	if (ancestors.has(value)) return false;
	ancestors.add(value);
	try {
		for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
			if (!descriptor.enumerable || !("value" in descriptor) || !check(descriptor.value, ancestors, depth + 1)) {
				return false;
			}
		}
		return true;
	} finally {
		ancestors.delete(value);
	}
}
