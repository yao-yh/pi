/**
 * 主题 JSON 验证，有意与 `theme.ts` 分离。
 *
 * 验证用户编写的主题文件需要 typebox，导入后会增加约 17 MB 的模块图。
 * 调色板查找不需要它，因此只使用内置主题的演示端不应承担这项成本。
 * `interactive-mode.ts` 会安装此验证器；未安装它的组件直接跳过验证，
 * 与内置主题的现有做法一致。
 */

import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";

const ColorValueSchema = Type.Union([
	Type.String(), // 十六进制值 "#ff0000"、变量引用 "primary" 或空字符串 ""
	Type.Integer({ minimum: 0, maximum: 255 }), // 256 色索引
]);

const ThemeJsonSchema = Type.Object({
	$schema: Type.Optional(Type.String()),
	name: Type.String(),
	vars: Type.Optional(Type.Record(Type.String(), ColorValueSchema)),
	colors: Type.Object({
		// 核心 UI（11 种颜色）
		accent: ColorValueSchema,
		border: ColorValueSchema,
		borderAccent: ColorValueSchema,
		borderMuted: ColorValueSchema,
		success: ColorValueSchema,
		error: ColorValueSchema,
		warning: ColorValueSchema,
		muted: ColorValueSchema,
		dim: ColorValueSchema,
		text: ColorValueSchema,
		thinkingText: ColorValueSchema,
		// 滚动条（2 种可选颜色）
		scrollbarTrack: Type.Optional(ColorValueSchema),
		scrollbarThumb: Type.Optional(ColorValueSchema),
		// 背景和内容文本（11 种必需颜色，2 种可选颜色）
		selectedBg: ColorValueSchema,
		searchMatchBg: Type.Optional(ColorValueSchema),
		searchMatchText: Type.Optional(ColorValueSchema),
		userMessageBg: ColorValueSchema,
		userMessageText: ColorValueSchema,
		customMessageBg: ColorValueSchema,
		customMessageText: ColorValueSchema,
		customMessageLabel: ColorValueSchema,
		toolPendingBg: ColorValueSchema,
		toolSuccessBg: ColorValueSchema,
		toolErrorBg: ColorValueSchema,
		toolTitle: ColorValueSchema,
		toolOutput: ColorValueSchema,
		// Markdown（10 种颜色）
		mdHeading: ColorValueSchema,
		mdLink: ColorValueSchema,
		mdLinkUrl: ColorValueSchema,
		mdCode: ColorValueSchema,
		mdCodeBlock: ColorValueSchema,
		mdCodeBlockBorder: ColorValueSchema,
		mdQuote: ColorValueSchema,
		mdQuoteBorder: ColorValueSchema,
		mdHr: ColorValueSchema,
		mdListBullet: ColorValueSchema,
		// 工具差异（3 种颜色）
		toolDiffAdded: ColorValueSchema,
		toolDiffRemoved: ColorValueSchema,
		toolDiffContext: ColorValueSchema,
		// 语法高亮（9 种颜色）
		syntaxComment: ColorValueSchema,
		syntaxKeyword: ColorValueSchema,
		syntaxFunction: ColorValueSchema,
		syntaxVariable: ColorValueSchema,
		syntaxString: ColorValueSchema,
		syntaxNumber: ColorValueSchema,
		syntaxType: ColorValueSchema,
		syntaxOperator: ColorValueSchema,
		syntaxPunctuation: ColorValueSchema,
		// 思考级别边框（6 种颜色）
		thinkingOff: ColorValueSchema,
		thinkingMinimal: ColorValueSchema,
		thinkingLow: ColorValueSchema,
		thinkingMedium: ColorValueSchema,
		thinkingHigh: ColorValueSchema,
		thinkingXhigh: ColorValueSchema,
		thinkingMax: Type.Optional(ColorValueSchema),
		// Bash 模式（1 种颜色）
		bashMode: ColorValueSchema,
	}),
	export: Type.Optional(
		Type.Object({
			pageBg: Type.Optional(ColorValueSchema),
			cardBg: Type.Optional(ColorValueSchema),
			infoBg: Type.Optional(ColorValueSchema),
		}),
	),
});

const compiledThemeSchema = Compile(ThemeJsonSchema);

export type ThemeColorValue = Static<typeof ColorValueSchema>;
export type ValidatedThemeJson = Static<typeof ThemeJsonSchema>;

/** 验证一个主题文档；失败时抛出包含问题令牌名称的消息。 */
export function validateThemeJson(label: string, json: unknown): ValidatedThemeJson {
	if (!compiledThemeSchema.Check(json)) {
		const errors = Array.from(compiledThemeSchema.Errors(json));
		const missingColors = new Set<string>();
		const otherErrors: string[] = [];

		for (const error of errors) {
			if (error.keyword === "required" && error.instancePath === "/colors") {
				const requiredProperties = (error.params as { requiredProperties?: string[] }).requiredProperties;
				for (const requiredProperty of requiredProperties ?? []) {
					missingColors.add(requiredProperty);
				}
				continue;
			}

			const path = error.instancePath || "/";
			otherErrors.push(`  - ${path}: ${error.message}`);
		}

		let errorMessage = `Invalid theme "${label}":\n`;
		if (missingColors.size > 0) {
			errorMessage += "\nMissing required color tokens:\n";
			errorMessage += Array.from(missingColors)
				.sort()
				.map((color) => `  - ${color}`)
				.join("\n");
			errorMessage += '\n\nPlease add these colors to your theme\'s "colors" object.';
			errorMessage += "\nSee the built-in themes (dark.json, light.json) for reference values.";
		}
		if (otherErrors.length > 0) {
			errorMessage += `\n\nOther errors:\n${otherErrors.join("\n")}`;
		}

		throw new Error(errorMessage);
	}

	const themeJson = json as ValidatedThemeJson;
	if (themeJson.name.includes("/")) {
		throw new Error(
			`Invalid theme name "${themeJson.name}": theme names cannot contain "/" because it is reserved for automatic light/dark theme settings.`,
		);
	}
	return themeJson;
}
