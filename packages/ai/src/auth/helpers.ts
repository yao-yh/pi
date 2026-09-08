import type { ApiKeyAuth, OAuthAuth } from "./types.ts";

/**
 * 标准 API 密钥身份验证：优先使用已存储的凭据密钥，否则解析首个已设置的环境变量。
 * 包含提示输入密钥的 `login`。采用非标准解析方式（提供商环境、环境文件、IAM）的
 * 提供商应自行实现 `ApiKeyAuth`。
 */
export function envApiKeyAuth(name: string, envVars: readonly string[]): ApiKeyAuth {
	return {
		name,
		login: async (interaction) => {
			interaction.signal.throwIfAborted();
			const key = await interaction.prompt({ type: "secret", message: `Enter ${name}` });
			interaction.signal.throwIfAborted();
			return { type: "api_key", key };
		},
		resolve: async ({ ctx, credential, signal }) => {
			signal.throwIfAborted();
			if (credential?.key) {
				return { auth: { apiKey: credential.key }, env: credential.env, source: "stored credential" };
			}
			for (const envVar of envVars) {
				const value = await ctx.env(envVar);
				signal.throwIfAborted();
				if (value) return { auth: { apiKey: value }, source: envVar };
			}
			return undefined;
		},
	};
}

/**
 * 包装动态导入的 `OAuthAuth`，使提供商定义无需导入实现即可声明 OAuth 支持。
 * 首次调用 `login`/`refresh`/`toAuth` 时加载流程；调用方通过打包器不可见的动态导入
 * （变量说明符，参见 Bedrock 延迟包装器）加载，使仅限 Node 的流程代码不进入打包产物。
 */
export function lazyOAuth(input: {
	name: string;
	isSubscription?: boolean;
	loginLabel?: string;
	load: () => Promise<OAuthAuth>;
}): OAuthAuth {
	let promise: Promise<OAuthAuth> | undefined;
	const loaded = () => {
		promise ??= input.load();
		return promise;
	};
	return {
		name: input.name,
		isSubscription: input.isSubscription,
		loginLabel: input.loginLabel,
		login: async (interaction) => (await loaded()).login(interaction),
		refresh: async (credential, signal) => (await loaded()).refresh(credential, signal),
		toAuth: async (credential) => (await loaded()).toAuth(credential),
	};
}
