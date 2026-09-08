import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { processImage } from "./image-process.ts";

export type ToolResultContent = TextContent | ImageContent;

export interface NormalizeToolResultImagesOptions {
	/** 是否将过大图像缩放到提供商的内联限制以内。默认值：true。 */
	autoResizeImages?: boolean;
}

/**
 * 规范化工具结果返回的图像块。
 *
 * `read` 工具和 `@file` CLI 附件会通过 `processImage` 处理图像，但自行生成图像的工具
 * （扩展、MCP 桥接器、截图工具）会返回任意 base64 负载，并将其直接写入会话历史及后续
 * 每一次提供商请求。过大的图像会导致提供商拒绝整个对话，而不只是有问题的那一轮，
 * 因此应在图像进入历史记录时统一规范化一次。
 *
 * 未发生更改时返回原数组，使调用方可以跳过结果重写。
 */
export async function normalizeToolResultImages(
	content: ToolResultContent[],
	options?: NormalizeToolResultImagesOptions,
): Promise<ToolResultContent[]> {
	if (!content.some((block) => block.type === "image")) {
		return content;
	}

	const autoResizeImages = options?.autoResizeImages ?? true;
	const normalized: ToolResultContent[] = [];
	let changed = false;

	for (const block of content) {
		if (block.type !== "image") {
			normalized.push(block);
			continue;
		}

		const processed = await processImage(Buffer.from(block.data, "base64"), block.mimeType, { autoResizeImages });
		if (!processed.ok) {
			// 与 `read` 不同，此处保留原始块。工具已经生成了该图像，失败原因可能只是图像后端不可用；
			// 直接传递原块可以维持工具当前的行为，避免静默删除其输出。
			normalized.push(block);
			continue;
		}

		if (processed.data === block.data && processed.mimeType === block.mimeType && processed.hints.length === 0) {
			normalized.push(block);
			continue;
		}

		normalized.push({ type: "image", data: processed.data, mimeType: processed.mimeType });
		if (processed.hints.length > 0) {
			normalized.push({ type: "text", text: processed.hints.join("\n") });
		}
		changed = true;
	}

	return changed ? normalized : content;
}
