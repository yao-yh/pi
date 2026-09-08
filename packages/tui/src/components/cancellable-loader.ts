import { getKeybindings } from "../keybindings.ts";
import { Loader } from "./loader.ts";

/**
 * 可通过 Escape 取消的加载器。
 * 使用 AbortSignal 扩展 Loader，以取消异步操作。
 *
 * @example
 * const loader = new CancellableLoader(tui, cyan, dim, "Working...");
 * loader.onAbort = () => done(null);
 * doWork(loader.signal).then(done);
 */
export class CancellableLoader extends Loader {
	private abortController = new AbortController();

	/** 用户按下 Escape 时调用。 */
	onAbort?: () => void;

	/** 用户按下 Escape 时中止的 AbortSignal。 */
	get signal(): AbortSignal {
		return this.abortController.signal;
	}

	/** 加载器是否已中止。 */
	get aborted(): boolean {
		return this.abortController.signal.aborted;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.abortController.abort();
			this.onAbort?.();
		}
	}

	dispose(): void {
		this.stop();
	}
}
