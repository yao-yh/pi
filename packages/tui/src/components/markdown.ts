import { Marked, type Token, Tokenizer, type TokenizerExtension, type Tokens } from "marked";
import { renderLatex } from "../latex.ts";
import { getCapabilities, hyperlink, isImageLine } from "../terminal-image.ts";
import type { Component } from "../tui.ts";
import { applyBackgroundToLine, visibleWidth, wrapTextWithAnsi } from "../utils.ts";

const STRICT_STRIKETHROUGH_REGEX = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;

class StrictStrikethroughTokenizer extends Tokenizer {
	override del(src: string): Tokens.Del | undefined {
		const match = STRICT_STRIKETHROUGH_REGEX.exec(src);
		if (!match) {
			return undefined;
		}

		const text = match[2];
		return {
			type: "del",
			raw: match[0],
			text,
			tokens: this.lexer.inlineTokens(text),
		};
	}
}

interface LatexToken extends Tokens.Generic {
	type: "latex" | "latexBlock";
	text: string;
	pending?: boolean;
}

function isEscaped(source: string, index: number): boolean {
	let backslashes = 0;
	for (let position = index - 1; position >= 0 && source[position] === "\\"; position--) {
		backslashes++;
	}
	return backslashes % 2 === 1;
}

function findClosingDelimiter(source: string, closing: string, start: number): number {
	let index = source.indexOf(closing, start);
	while (index >= 0 && isEscaped(source, index)) {
		index = source.indexOf(closing, index + closing.length);
	}
	return index;
}

function looksLikePendingDollarMath(source: string): boolean {
	return /\\[A-Za-z]+|[_^=+*/<>()[\]|±≤≥≠≈∈→⇒∞∫∑√-]/.test(source);
}

function tokenizeInlineLatex(source: string): LatexToken | undefined {
	let opening = "";
	let closing = "";
	if (source.startsWith("$$")) {
		opening = "$$";
		closing = "$$";
	} else if (source.startsWith("\\(")) {
		opening = "\\(";
		closing = "\\)";
	} else if (source.startsWith("\\[")) {
		opening = "\\[";
		closing = "\\]";
	} else if (source.startsWith("$") && !/^\$\s/.test(source)) {
		opening = "$";
		closing = "$";
	} else {
		return undefined;
	}

	const closingIndex = findClosingDelimiter(source, closing, opening.length);
	if (
		closingIndex >= 0 &&
		opening === "$" &&
		(/\s$/.test(source.slice(opening.length, closingIndex)) ||
			/^\d/.test(source.slice(closingIndex + 1)) ||
			(/^[A-Z_][A-Z0-9_]*(?:[^A-Za-z0-9_\s])?$/.test(source.slice(opening.length, closingIndex)) &&
				/^[A-Za-z_][A-Za-z0-9_]*/.test(source.slice(closingIndex + 1))) ||
			source.slice(opening.length, closingIndex).includes("`"))
	) {
		return undefined;
	}

	if (closingIndex < 0) {
		const pendingSource = source.slice(opening.length);
		if (opening.startsWith("\\") || looksLikePendingDollarMath(pendingSource)) {
			return { type: "latex", raw: source, text: pendingSource, pending: true };
		}
		return undefined;
	}

	const text = source.slice(opening.length, closingIndex);
	if (!text || text.includes("\n")) {
		return undefined;
	}

	const raw = source.slice(0, closingIndex + closing.length);
	return { type: "latex", raw, text };
}

function tokenizeBlockLatex(source: string): LatexToken | undefined {
	const dollarMatch = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*?)\$\$[ \t]*(?:\n|$)/.exec(source);
	if (dollarMatch?.[1]) {
		return { type: "latexBlock", raw: dollarMatch[0], text: dollarMatch[1].trim() };
	}

	const bracketMatch = /^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*?)\\\][ \t]*(?:\n|$)/.exec(source);
	if (bracketMatch?.[1]) {
		return { type: "latexBlock", raw: bracketMatch[0], text: bracketMatch[1].trim() };
	}

	const pendingBracket = /^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*)$/.exec(source);
	if (pendingBracket) {
		return { type: "latexBlock", raw: pendingBracket[0], text: pendingBracket[1], pending: true };
	}
	const pendingDollar = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*)$/.exec(source);
	if (pendingDollar?.[1] && looksLikePendingDollarMath(pendingDollar[1])) {
		return { type: "latexBlock", raw: pendingDollar[0], text: pendingDollar[1], pending: true };
	}
	return undefined;
}

const LATEX_MARKDOWN_EXTENSIONS: readonly TokenizerExtension[] = [
	{
		name: "latexBlock",
		level: "block",
		start(source) {
			const match = /(?:^|\n) {0,3}(?:\$\$|\\\[)/.exec(source);
			return match ? match.index + (match[0].startsWith("\n") ? 1 : 0) : undefined;
		},
		tokenizer: tokenizeBlockLatex,
	},
	{
		name: "latex",
		level: "inline",
		start(source) {
			const indices = [source.indexOf("$"), source.indexOf("\\("), source.indexOf("\\[")].filter(
				(index) => index >= 0,
			);
			return indices.length > 0 ? Math.min(...indices) : undefined;
		},
		tokenizer: tokenizeInlineLatex,
	},
];

function trimPartialClosingFences(tokens: readonly Token[]): void {
	const token = tokens[tokens.length - 1];
	if (token?.type === "list") {
		trimPartialClosingFences(token.items[token.items.length - 1]?.tokens ?? []);
		return;
	}
	if (token?.type === "blockquote") {
		trimPartialClosingFences(token.tokens ?? []);
		return;
	}
	if (token?.type !== "code") {
		return;
	}

	// 修剪流式传输中不完整的结束围栏，避免最后一个围栏字符到达时代码块收缩或闪烁。
	// 参见 https://github.com/earendil-works/pi/issues/5825。
	const marker = /^(`{3,}|~{3,})/.exec(token.raw)?.[1];
	const lastLine = token.raw.split("\n").pop();
	if (!marker || !lastLine || lastLine.length >= marker.length || lastLine !== marker[0]?.repeat(lastLine.length)) {
		return;
	}

	token.text = token.text.slice(0, -lastLine.length).replace(/\n$/, "");
}

const markdownParser = new Marked();
markdownParser.setOptions({
	tokenizer: new StrictStrikethroughTokenizer(),
});
markdownParser.use({ extensions: [...LATEX_MARKDOWN_EXTENSIONS] });

/**
 * Markdown 内容的默认文本样式。
 * 除非被 Markdown 格式覆盖，否则应用于所有文本。
 */
export interface DefaultTextStyle {
	/** 前景色函数。 */
	color?: (text: string) => string;
	/** 背景色函数。 */
	bgColor?: (text: string) => string;
	/** 粗体文本。 */
	bold?: boolean;
	/** 斜体文本。 */
	italic?: boolean;
	/** 删除线文本。 */
	strikethrough?: boolean;
	/** 下划线文本。 */
	underline?: boolean;
}

/**
 * Markdown 元素的主题函数。
 * 每个函数接收文本，并返回带 ANSI 代码的样式化文本。
 */
export interface MarkdownTheme {
	heading: (text: string) => string;
	link: (text: string) => string;
	linkUrl: (text: string) => string;
	code: (text: string) => string;
	codeBlock: (text: string) => string;
	codeBlockBorder: (text: string) => string;
	quote: (text: string) => string;
	quoteBorder: (text: string) => string;
	hr: (text: string) => string;
	listBullet: (text: string) => string;
	bold: (text: string) => string;
	italic: (text: string) => string;
	strikethrough: (text: string) => string;
	underline: (text: string) => string;
	highlightCode?: (code: string, lang?: string) => string[];
	/** 应用于每个已渲染代码块行的前缀（默认："  "）。 */
	codeBlockIndent?: string;
}

export interface MarkdownOptions {
	/** 保留源列表标记，而不进行规范化。 */
	preserveOrderedListMarkers?: boolean;
	/** 保留源反斜杠转义，而不规范化已转义标点。 */
	preserveBackslashEscapes?: boolean;
	/** 解析前使用内容的精确可用宽度转换源 Markdown。 */
	transform?: (markdown: string, availableWidth: number) => string;
	/** 将支持的 LaTeX 数学表达式渲染为 Unicode 文本（默认：true）。 */
	renderLatex?: boolean;
}

interface InlineStyleContext {
	applyText: (text: string) => string;
	stylePrefix: string;
}

export class Markdown implements Component {
	private text: string;
	private paddingX: number; // 左右内边距
	private paddingY: number; // 上下内边距
	private defaultTextStyle?: DefaultTextStyle;
	private theme: MarkdownTheme;
	private options: MarkdownOptions;
	private defaultStylePrefix?: string;

	// 渲染输出缓存
	private cachedText?: string;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		text: string,
		paddingX: number,
		paddingY: number,
		theme: MarkdownTheme,
		defaultTextStyle?: DefaultTextStyle,
		options?: MarkdownOptions,
	) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.theme = theme;
		this.defaultTextStyle = defaultTextStyle;
		this.options = options ? { ...options } : {};
	}

	setText(text: string): void {
		this.text = text;
		this.invalidate();
	}

	invalidate(): void {
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		// 检查缓存。
		if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
			return this.cachedLines;
		}

		// 计算内容可用宽度，扣除水平内边距。
		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const text = this.options.transform?.(this.text, contentWidth) ?? this.text;

		// 没有实际文本时不渲染任何内容。
		if (!text || text.trim() === "") {
			const result: string[] = [];
			// 更新缓存。
			this.cachedText = this.text;
			this.cachedWidth = width;
			this.cachedLines = result;
			return result;
		}

		// 将制表符替换为 3 个空格，以保持渲染一致。
		const normalizedText = text.replace(/\t/g, "   ");

		// 将 Markdown 解析为类 HTML 词元。
		const tokens = markdownParser.lexer(normalizedText);
		trimPartialClosingFences(tokens);

		// 将词元转换为带样式的终端输出。
		const renderedLines: string[] = [];

		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			const nextToken = tokens[i + 1];
			const tokenLines = this.renderToken(token, contentWidth, nextToken?.type);
			for (const tokenLine of tokenLines) {
				renderedLines.push(tokenLine);
			}
		}

		// 对行进行换行处理，此时尚不应用内边距和背景。
		const wrappedLines: string[] = [];
		for (const line of renderedLines) {
			if (isImageLine(line)) {
				wrappedLines.push(line);
			} else {
				for (const wrappedLine of wrapTextWithAnsi(line, contentWidth)) {
					wrappedLines.push(wrappedLine);
				}
			}
		}

		// 为每个换行后的行添加边距和背景。
		const leftMargin = " ".repeat(this.paddingX);
		const rightMargin = " ".repeat(this.paddingX);
		const bgFn = this.defaultTextStyle?.bgColor;
		const contentLines: string[] = [];

		for (const line of wrappedLines) {
			if (isImageLine(line)) {
				contentLines.push(line);
				continue;
			}

			const lineWithMargins = leftMargin + line + rightMargin;

			if (bgFn) {
				contentLines.push(applyBackgroundToLine(lineWithMargins, width, bgFn));
			} else {
				// 没有背景时只填充到指定宽度。
				const visibleLen = visibleWidth(lineWithMargins);
				const paddingNeeded = Math.max(0, width - visibleLen);
				contentLines.push(lineWithMargins + " ".repeat(paddingNeeded));
			}
		}

		// 添加上下内边距（空行）。
		const emptyLine = " ".repeat(width);
		const emptyLines: string[] = [];
		for (let i = 0; i < this.paddingY; i++) {
			const line = bgFn ? applyBackgroundToLine(emptyLine, width, bgFn) : emptyLine;
			emptyLines.push(line);
		}

		// 合并顶部内边距、内容和底部内边距。
		const result = emptyLines.concat(contentLines, emptyLines);

		// 更新缓存。
		this.cachedText = this.text;
		this.cachedWidth = width;
		this.cachedLines = result;

		return result.length > 0 ? result : [""];
	}

	/**
	 * 对字符串应用默认文本样式。
	 * 这是应用于所有文本内容的基础样式。
	 * 注意：此处不应用背景色，而是在填充阶段应用，确保背景延伸到完整行宽。
	 */
	private applyDefaultStyle(text: string): string {
		if (!this.defaultTextStyle) {
			return text;
		}

		let styled = text;

		// 应用前景色；背景色在填充阶段应用。
		if (this.defaultTextStyle.color) {
			styled = this.defaultTextStyle.color(styled);
		}

		// 使用 this.theme 应用文本装饰。
		if (this.defaultTextStyle.bold) {
			styled = this.theme.bold(styled);
		}
		if (this.defaultTextStyle.italic) {
			styled = this.theme.italic(styled);
		}
		if (this.defaultTextStyle.strikethrough) {
			styled = this.theme.strikethrough(styled);
		}
		if (this.defaultTextStyle.underline) {
			styled = this.theme.underline(styled);
		}

		return styled;
	}

	private getDefaultStylePrefix(): string {
		if (!this.defaultTextStyle) {
			return "";
		}

		if (this.defaultStylePrefix !== undefined) {
			return this.defaultStylePrefix;
		}

		const sentinel = "\u0000";
		let styled = sentinel;

		if (this.defaultTextStyle.color) {
			styled = this.defaultTextStyle.color(styled);
		}

		if (this.defaultTextStyle.bold) {
			styled = this.theme.bold(styled);
		}
		if (this.defaultTextStyle.italic) {
			styled = this.theme.italic(styled);
		}
		if (this.defaultTextStyle.strikethrough) {
			styled = this.theme.strikethrough(styled);
		}
		if (this.defaultTextStyle.underline) {
			styled = this.theme.underline(styled);
		}

		const sentinelIndex = styled.indexOf(sentinel);
		this.defaultStylePrefix = sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
		return this.defaultStylePrefix;
	}

	private getStylePrefix(styleFn: (text: string) => string): string {
		const sentinel = "\u0000";
		const styled = styleFn(sentinel);
		const sentinelIndex = styled.indexOf(sentinel);
		return sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
	}

	private getDefaultInlineStyleContext(): InlineStyleContext {
		return {
			applyText: (text: string) => this.applyDefaultStyle(text),
			stylePrefix: this.getDefaultStylePrefix(),
		};
	}

	private renderToken(
		token: Token,
		width: number,
		nextTokenType?: string,
		styleContext?: InlineStyleContext,
	): string[] {
		const lines: string[] = [];

		switch (token.type) {
			case "heading": {
				const headingLevel = token.depth;
				const headingPrefix = `${"#".repeat(headingLevel)} `;

				// 构建标题专用样式上下文，使行内词元（codespan、bold 等）在自身 ANSI 重置后
				// 恢复标题样式，而不是回退到默认文本样式。
				let headingStyleFn: (text: string) => string;
				if (headingLevel === 1) {
					headingStyleFn = (text: string) => this.theme.heading(this.theme.bold(this.theme.underline(text)));
				} else {
					headingStyleFn = (text: string) => this.theme.heading(this.theme.bold(text));
				}

				const headingStyleContext: InlineStyleContext = {
					applyText: headingStyleFn,
					stylePrefix: this.getStylePrefix(headingStyleFn),
				};

				const headingText = this.renderInlineTokens(token.tokens || [], headingStyleContext);
				const styledHeading = headingLevel >= 3 ? headingStyleFn(headingPrefix) + headingText : headingText;
				lines.push(styledHeading);
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // 标题后添加间距，后接 space 词元时除外
				}
				break;
			}

			case "paragraph": {
				const paragraphText = this.renderInlineTokens(token.tokens || [], styleContext);
				lines.push(paragraphText);
				// 下一个词元为 space 或 list 时不添加间距。
				if (nextTokenType && nextTokenType !== "list" && nextTokenType !== "space") {
					lines.push("");
				}
				break;
			}

			case "text":
				lines.push(this.renderInlineTokens([token], styleContext));
				break;

			case "latexBlock": {
				const latexToken = token as LatexToken;
				const rendered =
					!latexToken.pending && this.options.renderLatex !== false
						? (renderLatex(latexToken.text, { display: true }) ?? latexToken.raw.trim())
						: latexToken.raw.trim();
				for (const line of rendered.split("\n")) {
					lines.push(this.applyDefaultStyle(line));
				}
				if (nextTokenType && nextTokenType !== "space") {
					lines.push("");
				}
				break;
			}

			case "code": {
				const indent = this.theme.codeBlockIndent ?? "  ";
				lines.push(this.theme.codeBlockBorder(`\`\`\`${token.lang || ""}`));
				if (this.theme.highlightCode) {
					const highlightedLines = this.theme.highlightCode(token.text, token.lang);
					for (const hlLine of highlightedLines) {
						lines.push(`${indent}${hlLine}`);
					}
				} else {
					// 按换行符拆分代码，并分别设置每行样式。
					const codeLines = token.text.split("\n");
					for (const codeLine of codeLines) {
						lines.push(`${indent}${this.theme.codeBlock(codeLine)}`);
					}
				}
				lines.push(this.theme.codeBlockBorder("```"));
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // 代码块后添加间距，后接 space 词元时除外
				}
				break;
			}

			case "list": {
				const listLines = this.renderList(token as Tokens.List, 0, width, styleContext);
				lines.push(...listLines);
				// 后接 space 词元时不在列表后添加间距，由 space 词元处理。
				break;
			}

			case "table": {
				const tableLines = this.renderTable(token as Tokens.Table, width, nextTokenType, styleContext);
				lines.push(...tableLines);
				break;
			}

			case "blockquote": {
				const quoteStyle = (text: string) => this.theme.quote(this.theme.italic(text));
				const quoteStylePrefix = this.getStylePrefix(quoteStyle);
				const applyQuoteStyle = (line: string): string => {
					if (!quoteStylePrefix) {
						return quoteStyle(line);
					}
					const lineWithReappliedStyle = line.replace(/\x1b\[0m/g, `\x1b[0m${quoteStylePrefix}`);
					return quoteStyle(lineWithReappliedStyle);
				};

				// 计算引用内容可用宽度，扣除边框 "│ " 的 2 个字符。
				const quoteContentWidth = Math.max(1, width - 2);

				// 块引用包含块级词元（paragraph、list、code 等），因此使用 renderToken()
				// 而不是 renderInlineTokens() 渲染子项。块引用内不应应用默认消息样式。
				const quoteInlineStyleContext: InlineStyleContext = {
					applyText: (text: string) => text,
					stylePrefix: quoteStylePrefix,
				};
				const quoteTokens = token.tokens || [];
				const renderedQuoteLines: string[] = [];
				for (let i = 0; i < quoteTokens.length; i++) {
					const quoteToken = quoteTokens[i];
					const nextQuoteToken = quoteTokens[i + 1];
					renderedQuoteLines.push(
						...this.renderToken(quoteToken, quoteContentWidth, nextQuoteToken?.type, quoteInlineStyleContext),
					);
				}

				// 避免在外层块引用间距前额外渲染空引用行。
				while (renderedQuoteLines.length > 0 && renderedQuoteLines[renderedQuoteLines.length - 1] === "") {
					renderedQuoteLines.pop();
				}

				for (const quoteLine of renderedQuoteLines) {
					const styledLine = applyQuoteStyle(quoteLine);
					const wrappedLines = wrapTextWithAnsi(styledLine, quoteContentWidth);
					for (const wrappedLine of wrappedLines) {
						lines.push(this.theme.quoteBorder("│ ") + wrappedLine);
					}
				}
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // 块引用后添加间距，后接 space 词元时除外
				}
				break;
			}

			case "hr":
				lines.push(this.theme.hr("─".repeat(Math.min(width, 80))));
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // 水平线后添加间距，后接 space 词元时除外
				}
				break;

			case "html":
				// 将 HTML 渲染为纯文本，并针对终端转义。
				if ("raw" in token && typeof token.raw === "string") {
					lines.push(this.applyDefaultStyle(token.raw.trim()));
				}
				break;

			case "space":
				// space 词元表示 Markdown 中的空行。
				lines.push("");
				break;

			default:
				// 将其他词元类型作为纯文本处理。
				if ("text" in token && typeof token.text === "string") {
					lines.push(token.text);
				}
		}

		return lines;
	}

	private renderInlineTokens(tokens: Token[], styleContext?: InlineStyleContext): string {
		let result = "";
		const resolvedStyleContext = styleContext ?? this.getDefaultInlineStyleContext();
		const { applyText, stylePrefix } = resolvedStyleContext;
		const applyTextWithNewlines = (text: string): string => {
			const segments: string[] = text.split("\n");
			return segments.map((segment: string) => applyText(segment)).join("\n");
		};

		for (const token of tokens) {
			switch (token.type) {
				case "latex": {
					const latexToken = token as LatexToken;
					const rendered =
						!latexToken.pending && this.options.renderLatex !== false
							? (renderLatex(latexToken.text) ?? latexToken.raw)
							: latexToken.raw;
					result += applyTextWithNewlines(rendered);
					break;
				}

				case "escape":
					result += applyTextWithNewlines(this.options.preserveBackslashEscapes ? token.raw : token.text);
					break;

				case "text":
					// 列表项中的 text 词元可以包含用于行内格式的嵌套词元。
					if (token.tokens && token.tokens.length > 0) {
						result += this.renderInlineTokens(token.tokens, resolvedStyleContext);
					} else {
						result += applyTextWithNewlines(token.text);
					}
					break;

				case "paragraph":
					// paragraph 词元包含嵌套行内词元。
					result += this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					break;

				case "strong": {
					const boldContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += this.theme.bold(boldContent) + stylePrefix;
					break;
				}

				case "em": {
					const italicContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += this.theme.italic(italicContent) + stylePrefix;
					break;
				}

				case "codespan":
					result += this.theme.code(token.text) + stylePrefix;
					break;

				case "link": {
					const linkText = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					const styledLink = this.theme.link(this.theme.underline(linkText));
					if (getCapabilities().hyperlinks) {
						// OSC 8：渲染为可点击超链接。URL 不会行内输出，
						// 因此无论链接文本是否与 href 相同，都只显示链接文本。
						result += hyperlink(styledLink, token.href) + stylePrefix;
					} else {
						// 回退：文本与 href 不同时，在括号中输出 URL。
						// 相等性检查使用原始 token.text（未设置样式）与 href 比较。
						// 对 mailto: 链接移除前缀，因为自动链接的邮箱使用 text="foo@bar.com"，
						// 而 href="mailto:foo@bar.com"。
						const hrefForComparison = token.href.startsWith("mailto:") ? token.href.slice(7) : token.href;
						if (token.text === token.href || token.text === hrefForComparison) {
							result += styledLink + stylePrefix;
						} else {
							result += styledLink + this.theme.linkUrl(` (${token.href})`) + stylePrefix;
						}
					}
					break;
				}

				case "br":
					result += "\n";
					break;

				case "del": {
					const delContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += this.theme.strikethrough(delContent) + stylePrefix;
					break;
				}

				case "html":
					// 将行内 HTML 渲染为纯文本。
					if ("raw" in token && typeof token.raw === "string") {
						result += applyTextWithNewlines(token.raw);
					}
					break;

				default:
					// 将其他行内词元类型作为纯文本处理。
					if ("text" in token && typeof token.text === "string") {
						result += applyTextWithNewlines(token.text);
					}
			}
		}

		while (stylePrefix && result.endsWith(stylePrefix)) {
			result = result.slice(0, -stylePrefix.length);
		}

		return result;
	}

	private getOrderedListMarker(item: Tokens.ListItem): string | undefined {
		const match = /^(?: {0,3})(\d{1,9}[.)])[ \t]+/.exec(item.raw);
		return match ? `${match[1]} ` : undefined;
	}

	private getUnorderedListMarker(item: Tokens.ListItem): string | undefined {
		const match = /^(?: {0,3})([-+*])(?:[ \t]+|(?=\r?\n|$))/.exec(item.raw);
		return match ? `${match[1]} ` : undefined;
	}

	/**
	 * 渲染正确支持嵌套的列表。
	 */
	private renderList(token: Tokens.List, depth: number, width: number, styleContext?: InlineStyleContext): string[] {
		const lines: string[] = [];
		const indent = "    ".repeat(depth);
		// 使用列表的 start 属性；有序列表默认为 1。
		const startNumber = typeof token.start === "number" ? token.start : 1;

		for (let i = 0; i < token.items.length; i++) {
			const item = token.items[i];
			const isLastItem = i === token.items.length - 1;
			const bullet = token.ordered
				? this.options.preserveOrderedListMarkers
					? (this.getOrderedListMarker(item) ?? `${startNumber + i}. `)
					: `${startNumber + i}. `
				: this.options.preserveOrderedListMarkers
					? (this.getUnorderedListMarker(item) ?? "- ")
					: "- ";
			const taskMarker = item.task ? `[${item.checked ? "x" : " "}] ` : "";
			const marker = bullet + taskMarker;
			const firstPrefix = indent + this.theme.listBullet(marker);
			const continuationPrefix = indent + " ".repeat(visibleWidth(marker));
			const itemWidth = Math.max(1, width - visibleWidth(firstPrefix));
			let renderedAnyLine = false;

			for (const itemToken of item.tokens) {
				if (itemToken.type === "list") {
					lines.push(...this.renderList(itemToken as Tokens.List, depth + 1, width, styleContext));
					renderedAnyLine = true;
					continue;
				}

				const itemLines = this.renderToken(itemToken, itemWidth, undefined, styleContext);
				for (const line of itemLines) {
					for (const wrappedLine of wrapTextWithAnsi(line, itemWidth)) {
						const linePrefix = renderedAnyLine ? continuationPrefix : firstPrefix;
						lines.push(linePrefix + wrappedLine);
						renderedAnyLine = true;
					}
				}
			}

			if (!renderedAnyLine) {
				lines.push(firstPrefix);
			}

			if (token.loose && !isLastItem) {
				lines.push("");
			}
		}

		return lines;
	}

	/**
	 * 获取字符串中最长单词的可视宽度。
	 */
	private getLongestWordWidth(text: string, maxWidth?: number): number {
		const words = text.split(/\s+/).filter((word) => word.length > 0);
		let longest = 0;
		for (const word of words) {
			longest = Math.max(longest, visibleWidth(word));
		}
		if (maxWidth === undefined) {
			return longest;
		}
		return Math.min(longest, maxWidth);
	}

	/**
	 * 对表格单元格换行，使其适合列宽。
	 *
	 * 委托给 wrapTextWithAnsi()，使 ANSI 代码和长词元的处理与渲染器其他部分保持一致。
	 */
	private wrapCellText(text: string, maxWidth: number, stylePrefix = ""): string[] {
		const lines = wrapTextWithAnsi(text, Math.max(1, maxWidth));
		return lines.map((line, index) => {
			// 每个非末尾片段后重置文本样式，再在填充和边框前恢复外围样式。
			const styleReset = index < lines.length - 1 ? "\x1b[22;23;24;25;27;28;29;39m" : "";
			return `${line}${styleReset}${stylePrefix}`;
		});
	}

	/**
	 * 渲染支持按宽度进行单元格换行的表格。
	 * 无法容纳的单元格会换成多行。
	 */
	private renderTable(
		token: Tokens.Table,
		availableWidth: number,
		nextTokenType?: string,
		styleContext?: InlineStyleContext,
	): string[] {
		const lines: string[] = [];
		const numCols = token.header.length;

		if (numCols === 0) {
			return lines;
		}

		// 计算边框开销："│ " + (n-1) * " │ " + " │"
		// = 2 + (n-1) * 3 + 2 = 3n + 1
		const borderOverhead = 3 * numCols + 1;
		const availableForCells = availableWidth - borderOverhead;
		if (availableForCells < numCols) {
			// 宽度过窄，无法稳定渲染表格，回退到原始 Markdown。
			const fallbackLines = token.raw ? wrapTextWithAnsi(token.raw, availableWidth) : [];
			if (nextTokenType && nextTokenType !== "space") {
				fallbackLines.push("");
			}
			return fallbackLines;
		}

		const maxUnbrokenWordWidth = 30;

		// 计算自然列宽，即没有约束时各列所需宽度。
		const naturalWidths: number[] = [];
		const minWordWidths: number[] = [];
		for (let i = 0; i < numCols; i++) {
			const headerText = this.renderInlineTokens(token.header[i].tokens || [], styleContext);
			naturalWidths[i] = visibleWidth(headerText);
			minWordWidths[i] = Math.max(1, this.getLongestWordWidth(headerText, maxUnbrokenWordWidth));
		}
		for (const row of token.rows) {
			for (let i = 0; i < row.length; i++) {
				const cellText = this.renderInlineTokens(row[i].tokens || [], styleContext);
				naturalWidths[i] = Math.max(naturalWidths[i] || 0, visibleWidth(cellText));
				minWordWidths[i] = Math.max(
					minWordWidths[i] || 1,
					this.getLongestWordWidth(cellText, maxUnbrokenWordWidth),
				);
			}
		}

		let minColumnWidths = minWordWidths;
		let minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);

		if (minCellsWidth > availableForCells) {
			minColumnWidths = new Array(numCols).fill(1);
			const remaining = availableForCells - numCols;

			if (remaining > 0) {
				const totalWeight = minWordWidths.reduce((total, width) => total + Math.max(0, width - 1), 0);
				const growth = minWordWidths.map((width) => {
					const weight = Math.max(0, width - 1);
					return totalWeight > 0 ? Math.floor((weight / totalWeight) * remaining) : 0;
				});

				for (let i = 0; i < numCols; i++) {
					minColumnWidths[i] += growth[i] ?? 0;
				}

				const allocated = growth.reduce((total, width) => total + width, 0);
				let leftover = remaining - allocated;
				for (let i = 0; leftover > 0 && i < numCols; i++) {
					minColumnWidths[i]++;
					leftover--;
				}
			}

			minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);
		}

		// 计算适合可用宽度的列宽。
		const totalNaturalWidth = naturalWidths.reduce((a, b) => a + b, 0) + borderOverhead;
		let columnWidths: number[];

		if (totalNaturalWidth <= availableWidth) {
			// 所有内容都能按自然宽度容纳。
			columnWidths = naturalWidths.map((width, index) => Math.max(width, minColumnWidths[index]));
		} else {
			// 需要缩小列宽以适配。
			const totalGrowPotential = naturalWidths.reduce((total, width, index) => {
				return total + Math.max(0, width - minColumnWidths[index]);
			}, 0);
			const extraWidth = Math.max(0, availableForCells - minCellsWidth);
			columnWidths = minColumnWidths.map((minWidth, index) => {
				const naturalWidth = naturalWidths[index];
				const minWidthDelta = Math.max(0, naturalWidth - minWidth);
				let grow = 0;
				if (totalGrowPotential > 0) {
					grow = Math.floor((minWidthDelta / totalGrowPotential) * extraWidth);
				}
				return minWidth + grow;
			});

			// 调整舍入误差并分配剩余空间。
			const allocated = columnWidths.reduce((a, b) => a + b, 0);
			let remaining = availableForCells - allocated;
			while (remaining > 0) {
				let grew = false;
				for (let i = 0; i < numCols && remaining > 0; i++) {
					if (columnWidths[i] < naturalWidths[i]) {
						columnWidths[i]++;
						remaining--;
						grew = true;
					}
				}
				if (!grew) {
					break;
				}
			}
		}

		// 渲染顶部边框。
		const topBorderCells = columnWidths.map((w) => "─".repeat(w));
		lines.push(`┌─${topBorderCells.join("─┬─")}─┐`);

		// 渲染支持换行的表头。
		const headerCellLines: string[][] = token.header.map((cell, i) => {
			const text = this.renderInlineTokens(cell.tokens || [], styleContext);
			return this.wrapCellText(text, columnWidths[i], styleContext?.stylePrefix);
		});
		const headerLineCount = Math.max(...headerCellLines.map((c) => c.length));

		for (let lineIdx = 0; lineIdx < headerLineCount; lineIdx++) {
			const rowParts = headerCellLines.map((cellLines, colIdx) => {
				const text = cellLines[lineIdx] || "";
				const padded = text + " ".repeat(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
				return this.theme.bold(padded);
			});
			lines.push(`│ ${rowParts.join(" │ ")} │`);
		}

		// 渲染分隔线。
		const separatorCells = columnWidths.map((w) => "─".repeat(w));
		const separatorLine = `├─${separatorCells.join("─┼─")}─┤`;
		lines.push(separatorLine);

		// 渲染支持换行的数据行。
		for (let rowIndex = 0; rowIndex < token.rows.length; rowIndex++) {
			const row = token.rows[rowIndex];
			const rowCellLines: string[][] = row.map((cell, i) => {
				const text = this.renderInlineTokens(cell.tokens || [], styleContext);
				return this.wrapCellText(text, columnWidths[i], styleContext?.stylePrefix);
			});
			const rowLineCount = Math.max(...rowCellLines.map((c) => c.length));

			for (let lineIdx = 0; lineIdx < rowLineCount; lineIdx++) {
				const rowParts = rowCellLines.map((cellLines, colIdx) => {
					const text = cellLines[lineIdx] || "";
					return text + " ".repeat(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
				});
				lines.push(`│ ${rowParts.join(" │ ")} │`);
			}

			if (rowIndex < token.rows.length - 1) {
				lines.push(separatorLine);
			}
		}

		// 渲染底部边框。
		const bottomBorderCells = columnWidths.map((w) => "─".repeat(w));
		lines.push(`└─${bottomBorderCells.join("─┴─")}─┘`);

		if (nextTokenType && nextTokenType !== "space") {
			lines.push(""); // 表格后添加间距
		}
		return lines;
	}
}
