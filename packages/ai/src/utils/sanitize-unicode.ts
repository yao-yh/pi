/**
 * 从字符串中移除未配对的 Unicode 代理字符。
 *
 * 未配对的代理字符（0xD800-0xDBFF 高代理项没有匹配的 0xDC00-0xDFFF 低代理项，
 * 或反之）会导致许多 API 提供商发生 JSON 序列化错误。
 *
 * 有效 Emoji 和基本多文种平面之外的其他字符使用正确配对的代理项，
 * 不受此函数影响。
 *
 * @param text - 要清理的文本
 * @returns 已移除未配对代理项的清理后文本
 *
 * @example
 * // 保留有效 Emoji（正确配对的代理项）
 * sanitizeSurrogates("Hello 🙈 World") // => "Hello 🙈 World"
 *
 * // 移除未配对的高代理项
 * const unpaired = String.fromCharCode(0xD83D); // 没有低代理项的高代理项
 * sanitizeSurrogates(`Text ${unpaired} here`) // => "Text  here"
 */
export function sanitizeSurrogates(text: string): string {
	// 替换未配对的高代理项（0xD800-0xDBFF 后面没有低代理项）
	// 替换未配对的低代理项（0xDC00-0xDFFF 前面没有高代理项）
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}
