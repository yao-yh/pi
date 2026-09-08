import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

/**
 * 通过变量说明符加载 Bedrock 实现，使打包器（浏览器 smoke、Bun 编译）无法沿着
 * 导入进入仅限 Node 的 AWS SDK。重写 `.ts`/`.js` 可让此方式同时适用于源码和构建产物。
 */
const importNodeOnlyApi = (specifier: string): Promise<unknown> => {
	const runtimeSpecifier = import.meta.url.endsWith(".js") ? specifier.replace(/\.ts$/, ".js") : specifier;
	return import(runtimeSpecifier);
};

let bedrockModuleOverride: ProviderStreams | undefined;

/**
 * 覆盖动态导入的 Bedrock 实现。用于无法打包变量说明符导入的 Bun 二进制构建；
 * 该构建会改为注册静态导入的模块。
 */
export function setBedrockProviderModule(module: ProviderStreams): void {
	bedrockModuleOverride = module;
}

export const bedrockConverseStreamApi = (): ProviderStreams =>
	lazyApi(
		async () =>
			bedrockModuleOverride ?? ((await importNodeOnlyApi("./bedrock-converse-stream.ts")) as ProviderStreams),
	);
