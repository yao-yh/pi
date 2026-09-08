import type { ProviderEnv } from "../types.ts";
import { operationSignal, raceWithAbortSignal } from "../utils/abort.ts";
import { formatThrownValue } from "../utils/diagnostics.ts";
import type {
	ApiKeyAuth,
	ApiKeyCredential,
	AuthContext,
	AuthResult,
	Credential,
	CredentialStore,
	OAuthAuth,
	OAuthCredential,
	ProviderAuth,
} from "./types.ts";

export type ModelsErrorCode = "model_source" | "model_validation" | "provider" | "stream" | "auth" | "oauth";

export interface AuthResolutionOverrides {
	apiKey?: string;
	env?: ProviderEnv;
	/** 要求 OAuth 令牌至少剩余这么长的有效期；默认为五分钟。 */
	minOAuthValidityMs?: number;
	signal?: AbortSignal;
}

export class ModelsError extends Error {
	readonly code: ModelsErrorCode;

	constructor(code: ModelsErrorCode, message: string, options?: { cause?: unknown }) {
		super(withCauseDetail(message, options?.cause), options);
		this.name = "ModelsError";
		this.code = code;
	}
}

/** 调用方只显示 `error.message`，因此在其中保留底层原因。 */
function withCauseDetail(message: string, cause: unknown): string {
	if (cause === undefined || cause === null) return message;
	const detail = formatThrownValue(cause).trim();
	if (!detail || message.includes(detail)) return message;
	return `${message}: ${detail}`;
}

/**
 * `Models` 和 `ImagesModels` 集合共享的身份验证解析。
 * 已存储凭据拥有提供商的身份验证权；仅在没有存储任何凭据时查询环境凭据/环境变量。
 * 刷新失败后，或凭据类型没有匹配处理器时，不会静默回退到环境变量。
 */
export function resolveProviderAuth(
	provider: { id: string; auth: ProviderAuth },
	credentials: CredentialStore,
	authContext: AuthContext,
	overrides?: AuthResolutionOverrides,
): Promise<AuthResult | undefined> {
	const signal = operationSignal(overrides?.signal);
	return raceWithAbortSignal(
		resolveProviderAuthWithSignal(provider, credentials, authContext, overrides, signal),
		signal,
	);
}

async function resolveProviderAuthWithSignal(
	provider: { id: string; auth: ProviderAuth },
	credentials: CredentialStore,
	authContext: AuthContext,
	overrides: AuthResolutionOverrides | undefined,
	signal: AbortSignal,
): Promise<AuthResult | undefined> {
	signal.throwIfAborted();
	const requestAuthContext = overrides?.env ? overlayEnvAuthContext(authContext, overrides.env) : authContext;

	if (overrides?.apiKey !== undefined && provider.auth.apiKey) {
		return resolveApiKey(
			requestAuthContext,
			provider.auth.apiKey,
			provider.id,
			{
				type: "api_key",
				key: overrides.apiKey,
				env: overrides.env,
			},
			signal,
		);
	}

	const stored = await readCredential(credentials, provider.id, signal);
	if (stored) {
		if (stored.type === "oauth" && provider.auth.oauth) {
			return resolveStoredOAuth(
				credentials,
				provider.id,
				provider.auth.oauth,
				stored,
				signal,
				overrides?.minOAuthValidityMs,
			);
		}
		if (stored.type === "api_key" && provider.auth.apiKey) {
			const credential = overrides?.env ? { ...stored, env: { ...stored.env, ...overrides.env } } : stored;
			return resolveApiKey(requestAuthContext, provider.auth.apiKey, provider.id, credential, signal);
		}
		return undefined;
	}

	// 环境凭据（环境变量、AWS 配置文件、ADC 文件）。
	return provider.auth.apiKey
		? resolveApiKey(requestAuthContext, provider.auth.apiKey, provider.id, undefined, signal)
		: undefined;
}

function overlayEnvAuthContext(base: AuthContext, env: ProviderEnv): AuthContext {
	return {
		env: async (name) => env[name] || (await base.env(name)),
		fileExists: (path) => base.fileExists(path),
	};
}

const DEFAULT_OAUTH_MINIMUM_VALIDITY_MS = 5 * 60 * 1000;
const DEFAULT_OAUTH_REFRESH_TIMEOUT_MS = 15_000;

/**
 * 使用双重检查锁定解析 OAuth：剩余有效期不足五分钟的令牌会获取锁，
 * 在锁内重新检查到期时间，全局只刷新一次，并在释放锁前持久化轮换后的凭据。
 */
async function resolveStoredOAuth(
	credentials: CredentialStore,
	providerId: string,
	oauth: OAuthAuth,
	stored: OAuthCredential,
	signal: AbortSignal,
	minOAuthValidityMs?: number,
): Promise<AuthResult | undefined> {
	const minimumValidityMs = Math.max(DEFAULT_OAUTH_MINIMUM_VALIDITY_MS, minOAuthValidityMs ?? 0);
	const expiresSoon = (credential: OAuthCredential) => Date.now() + minimumValidityMs >= credential.expires;
	let credential = stored;

	if (expiresSoon(credential)) {
		// 乐观检查判断即将到期；权威检查在锁内运行。
		let post: Credential | undefined;
		try {
			post = await credentials.modify(
				providerId,
				async (current) => {
					if (current?.type !== "oauth") return undefined; // 此期间已注销
					if (!expiresSoon(current)) return undefined; // 另一进程/请求已刷新
					try {
						const refreshSignal = AbortSignal.any([
							signal,
							AbortSignal.timeout(DEFAULT_OAUTH_REFRESH_TIMEOUT_MS),
						]);
						return await oauth.refresh(current, refreshSignal);
					} catch (error) {
						throw new ModelsError("oauth", `OAuth refresh failed for ${providerId}`, { cause: error });
					}
				},
				{ signal },
			);
		} catch (error) {
			if (error instanceof ModelsError) throw error;
			throw new ModelsError("auth", `Credential store modify failed for ${providerId}`, { cause: error });
		}
		if (post?.type !== "oauth") return undefined; // 此期间已注销
		credential = post;
		// 常规五分钟窗口会触发刷新，但不强制提供商遵守该契约。
		// 显式调用方（例如 Bearer 令牌导出）确实要求刷新后满足请求的最短有效期。
		if (minOAuthValidityMs !== undefined && expiresSoon(credential)) {
			throw new ModelsError("oauth", `OAuth refresh returned a token that expires too soon for ${providerId}`);
		}
	}

	try {
		return { auth: await oauth.toAuth(credential), source: "OAuth" };
	} catch (error) {
		throw new ModelsError("oauth", `OAuth auth derivation failed for ${providerId}`, { cause: error });
	}
}

async function resolveApiKey(
	authContext: AuthContext,
	apiKey: ApiKeyAuth,
	providerId: string,
	credential: ApiKeyCredential | undefined,
	signal: AbortSignal,
): Promise<AuthResult | undefined> {
	try {
		return await apiKey.resolve({ ctx: authContext, credential, signal });
	} catch (error) {
		throw new ModelsError("auth", `API key auth failed for provider ${providerId}`, { cause: error });
	}
}

async function readCredential(
	credentials: CredentialStore,
	providerId: string,
	signal: AbortSignal,
): Promise<Credential | undefined> {
	try {
		return await credentials.read(providerId, { signal });
	} catch (error) {
		throw new ModelsError("auth", `Credential store read failed for ${providerId}`, { cause: error });
	}
}
