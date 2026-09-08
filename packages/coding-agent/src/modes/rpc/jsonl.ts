import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/**
 * 序列化一条严格的 JSONL 记录。
 *
 * 分帧仅使用 LF。负载字符串可能包含 U+2028、U+2029 等其他 Unicode 分隔符。
 * 客户端必须只使用 `\n` 分割记录。
 */
export function serializeJsonLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

/**
 * 将仅使用 LF 的 JSONL 读取器附加到流。
 *
 * 此处有意不使用 Node readline。readline 会按其他 Unicode 分隔符进行分割，
 * 而这些分隔符在 JSON 字符串内是有效的，因此无法实现严格的 JSONL 分帧。
 */
export function attachJsonlLineReader(stream: Readable, onLine: (line: string) => void): () => void {
	const decoder = new StringDecoder("utf8");
	let buffer = "";

	const emitLine = (line: string) => {
		onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
	};

	const onData = (chunk: string | Buffer) => {
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);

		while (true) {
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) {
				return;
			}

			emitLine(buffer.slice(0, newlineIndex));
			buffer = buffer.slice(newlineIndex + 1);
		}
	};

	const onEnd = () => {
		buffer += decoder.end();
		if (buffer.length > 0) {
			emitLine(buffer);
			buffer = "";
		}
	};

	stream.on("data", onData);
	stream.on("end", onEnd);

	return () => {
		stream.off("data", onData);
		stream.off("end", onEnd);
	};
}
