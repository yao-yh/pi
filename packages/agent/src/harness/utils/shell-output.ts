import type { Context } from "../context.ts";
import {
	type ExecutionEnv,
	type ExecutionError,
	err,
	ok,
	type Result,
	type ShellExecOptions,
	type ShellOutputView,
} from "../types.ts";
import { applyShellOutputUpdate, sanitizeShellOutput } from "./output-capture.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult, truncateTail } from "./truncate.ts";

export interface ShellCaptureProgress {
	output: string;
	truncation: TruncationResult;
	fullOutputPath?: string;
	lastLineBytes: number;
}

export interface ShellCaptureOptions extends Omit<ShellExecOptions, "capture" | "onUpdate"> {
	onChunk?: (chunk: string, getProgress: () => ShellCaptureProgress, context: Context) => void;
	/** 将 Shell 执行失败与捕获的输出一起返回，而不是返回失败的 Result。 */
	returnExecutionErrors?: boolean;
}

export interface ShellCaptureResult extends ShellCaptureProgress {
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	executionError?: ExecutionError;
}

function progressFrom(output: ShellOutputView): ShellCaptureProgress {
	return {
		output: output.text,
		truncation: { content: output.text, ...output.truncation },
		...(output.spillPath === undefined ? {} : { fullOutputPath: output.spillPath }),
		lastLineBytes: output.lastLineBytes ?? 0,
	};
}

/**
 * 为需要单个有界最终视图的调用方提供的兼容收集器。
 * 源端捕获、自适应发布和溢出存储仍由执行环境负责。
 */
export async function executeShellWithCapture(
	env: ExecutionEnv,
	command: string,
	options: ShellCaptureOptions | undefined,
	context: Context,
): Promise<Result<ShellCaptureResult, ExecutionError>> {
	let output: ShellOutputView | undefined;
	const result = await env.exec(
		command,
		{
			cwd: options?.cwd,
			env: options?.env,
			inheritEnv: options?.inheritEnv,
			timeout: options?.timeout,
			capture: {
				limits: { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES, retain: "tail" },
				spill: true,
			},
			onUpdate: (update, updateContext) => {
				const previous = output;
				output = applyShellOutputUpdate(output, update);
				const chunk =
					update.kind === "append" || update.kind === "slide"
						? update.text
						: update.kind === "replace" && previous === undefined
							? output.text
							: undefined;
				// 仅包含元数据的更新和达到上限后的替换都不含新的增量块。
				// 如果向累积此兼容回调的调用方报告完整视图，会造成字节重复。
				if (chunk) options?.onChunk?.(chunk, () => progressFrom(output!), updateContext);
			},
		},
		context,
	);

	if (output === undefined) {
		const { content, ...truncation } = truncateTail("");
		output = { text: content, truncation };
	}
	const progress = progressFrom(output);
	if (!result.ok) {
		if (result.error.code === "aborted" || context.abortSignal?.aborted) {
			return ok({ ...progress, exitCode: undefined, cancelled: true, truncated: progress.truncation.truncated });
		}
		if (options?.returnExecutionErrors) {
			return ok({
				...progress,
				exitCode: undefined,
				cancelled: false,
				truncated: progress.truncation.truncated,
				executionError: result.error,
			});
		}
		return err(result.error);
	}
	return ok({
		...progress,
		exitCode: result.value.exitCode,
		cancelled: false,
		truncated: result.value.truncation.truncated,
	});
}

export { sanitizeShellOutput as sanitizeBinaryOutput };
