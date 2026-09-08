/*
 * Portions of this file are derived from:
 * - ansi-regex (https://github.com/chalk/ansi-regex)
 * - strip-ansi (https://github.com/chalk/strip-ansi)
 *
 * MIT License
 *
 * Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

function ansiRegex({ onlyFirst = false }: { onlyFirst?: boolean } = {}): RegExp {
	// 有效的字符串终止序列为 BEL、ESC\ 和 0x9c
	const ST = "(?:\\u0007|\\u001B\\u005C|\\u009C)";

	// 仅匹配 OSC 序列：ESC ] ... ST（非贪婪匹配，直到第一个 ST）
	const osc = `(?:\\u001B\\][\\s\\S]*?${ST})`;

	// CSI 及相关序列：ESC/C1、可选中间字节、可选参数（支持 ; 和 :），最后是终止字节
	const csi = "[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]";

	const pattern = `${osc}|${csi}`;

	return new RegExp(pattern, onlyFirst ? undefined : "g");
}

const regex = ansiRegex();

export function stripAnsi(value: string): string {
	if (typeof value !== "string") {
		throw new TypeError(`Expected a \`string\`, got \`${typeof value}\``);
	}

	// 快速路径：ANSI 代码必须以 ESC（7 位）或 CSI（8 位）作为引导符
	if (!value.includes("\u001B") && !value.includes("\u009B")) {
		return value;
	}

	// 虽然该正则表达式是全局的，但无需重置 `.lastIndex`，因为与 `.exec()` 和 `.test()` 不同，
	// `.replace()` 会自动重置；手动重置反而会造成性能损耗。
	return value.replace(regex, "");
}
