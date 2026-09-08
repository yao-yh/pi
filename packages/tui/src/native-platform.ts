import { createRequire } from "node:module";
import * as path from "node:path";
import { getNativeModuleCandidates } from "./native-module-path.ts";

const cjsRequire = createRequire(import.meta.url);

export type ModifierKey = "shift" | "command" | "control" | "option";

export interface NativeClipboard {
	/** undefined 表示不可用，null 表示没有文本；传输失败时拒绝。 */
	getText(): Promise<string | null | undefined>;
	/** undefined 表示不可用，null 表示没有图像；传输失败时拒绝。 */
	getImage(): Promise<Uint8Array | null | undefined>;
	/** Linux 改用命令行工具保持剪贴板所有权。 */
	setText?(text: string): Promise<void>;
}

type NativePlatformHelper = NativeClipboard & {
	enableVirtualTerminalInput?: () => boolean;
	isModifierPressed?: (name: ModifierKey) => boolean;
};

// 缓存模块加载结果，而非显示服务可用性：断开的显示服务仍可能恢复。
const helpers = new Map<string, NativePlatformHelper | undefined>();

function loadNativePlatformHelper(platform: string, suffix = ""): NativePlatformHelper | undefined {
	const arch = process.arch;
	if (arch !== "x64" && arch !== "arm64") return undefined;
	const nativePath = path.join(
		"native",
		platform,
		"prebuilds",
		`${platform}-${arch}`,
		`${platform}-platform${suffix}.node`,
	);
	if (helpers.has(nativePath)) return helpers.get(nativePath);

	for (const modulePath of getNativeModuleCandidates(nativePath)) {
		try {
			const helper = cjsRequire(modulePath) as Partial<NativePlatformHelper> | null;
			if (typeof helper?.getText === "function" && typeof helper.getImage === "function") {
				helpers.set(nativePath, helper as NativePlatformHelper);
				return helper as NativePlatformHelper;
			}
		} catch {
			// 尝试下一个可能的打包位置。
		}
	}
	helpers.set(nativePath, undefined);
	return undefined;
}

export function getNativePlatformHelper(): NativePlatformHelper | undefined {
	if (process.platform !== "darwin" && process.platform !== "win32") return undefined;
	return loadNativePlatformHelper(process.platform);
}

/** 加载剪贴板辅助程序，但在请求读取前不打开显示服务。 */
export function getNativeClipboard(): NativeClipboard | undefined {
	if (process.platform !== "linux") return getNativePlatformHelper();
	if (!process.env.DISPLAY) return undefined;
	return loadNativePlatformHelper("linux", "-x11");
}
