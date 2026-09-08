import type { ImageContent, TextContent, ThinkingContent, ToolCall } from "../types.ts";

type Content = TextContent | ImageContent | ThinkingContent | ToolCall;

/** 从消息内容中提取并拼接文本。 */
export function contentText(content: string | readonly Content[], separator = "\n"): string {
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join(separator);
}
