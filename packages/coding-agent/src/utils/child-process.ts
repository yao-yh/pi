import {
	type ChildProcess,
	type ChildProcessByStdio,
	spawn as nodeSpawn,
	spawnSync as nodeSpawnSync,
	type SpawnOptions,
	type SpawnOptionsWithStdioTuple,
	type SpawnSyncOptionsWithStringEncoding,
	type SpawnSyncReturns,
	type StdioNull,
	type StdioPipe,
} from "node:child_process";
import type { Readable } from "node:stream";
import crossSpawn from "cross-spawn";

const EXIT_STDIO_GRACE_MS = 100;

export function spawnProcess(
	command: string,
	args: string[],
	options: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe>,
): ChildProcessByStdio<null, Readable, Readable>;
export function spawnProcess(command: string, args: string[], options: SpawnOptions): ChildProcess;
export function spawnProcess(command: string, args: string[], options: SpawnOptions): ChildProcess {
	return process.platform === "win32" ? crossSpawn(command, args, options) : nodeSpawn(command, args, options);
}

export function spawnProcessSync(
	command: string,
	args: string[],
	options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string> {
	return process.platform === "win32"
		? crossSpawn.sync(command, args, options)
		: nodeSpawnSync(command, args, options);
}

/**
 * 等待子进程终止，同时避免因继承的 stdio 句柄而挂起。
 *
 * 短生命周期的子进程可能已触发 `exit`，但分离的后代进程仍保持 stdout/stderr 管道打开。
 * 不能从 `exit` 起按固定截止时间结束等待并销毁流，否则超过该时限仍在写入的输出会被静默丢失
 * （earendil-works/pi#5303）。因此，`exit` 后应等待管道转为空闲状态：每收到一个数据块都会
 * 重新启动宽限计时器，使仍在主动写入的后代进程可继续被读取；对于静默的继承句柄
 * （例如始终不触发 `close` 的 Windows 守护化后代进程），宽限期结束后仍能解除等待。
 */
export function waitForChildProcess(child: ChildProcess): Promise<number | null> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let postExitTimer: NodeJS.Timeout | undefined;
		let stdoutEnded = child.stdout === null;
		let stderrEnded = child.stderr === null;

		const cleanup = () => {
			if (postExitTimer) {
				clearTimeout(postExitTimer);
				postExitTimer = undefined;
			}
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdout?.removeListener("end", onStdoutEnd);
			child.stderr?.removeListener("end", onStderrEnd);
			child.stdout?.removeListener("data", onData);
			child.stderr?.removeListener("data", onData);
		};

		const finalize = (code: number | null) => {
			if (settled) return;
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve(code);
		};

		const maybeFinalizeAfterExit = () => {
			if (!exited || settled) return;
			if (stdoutEnded && stderrEnded) {
				finalize(exitCode);
			}
		};

		const armIdleTimer = () => {
			if (postExitTimer) clearTimeout(postExitTimer);
			postExitTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS);
		};

		const onData = () => {
			// `exit` 后仍有输出到达；延迟结束处理，避免在写入过程中销毁流并截断尾部。
			if (exited && !settled) armIdleTimer();
		};

		const onStdoutEnd = () => {
			stdoutEnded = true;
			maybeFinalizeAfterExit();
		};

		const onStderrEnd = () => {
			stderrEnded = true;
			maybeFinalizeAfterExit();
		};

		const onError = (err: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(err);
		};

		const onExit = (code: number | null) => {
			exited = true;
			exitCode = code;
			maybeFinalizeAfterExit();
			if (!settled) {
				armIdleTimer();
			}
		};

		const onClose = (code: number | null) => {
			finalize(code);
		};

		child.stdout?.once("end", onStdoutEnd);
		child.stderr?.once("end", onStderrEnd);
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("error", onError);
		child.once("exit", onExit);
		child.once("close", onClose);
	});
}
