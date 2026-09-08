import type { ProviderEnv, ProviderHeaders } from "../types.ts";

/**
 * 单次模型请求的身份验证。如果某个值无法表示为 `apiKey`、`headers` 或 `baseUrl`，
 * 则它属于提供商配置，而非身份验证。
 */
export interface ModelAuth {
	apiKey?: string;
	headers?: ProviderHeaders;
	baseUrl?: string;
}

/**
 * 已存储的 API 密钥凭据。`env` 保存 Cloudflare 账户/网关 id 等提供商范围的环境/配置值。
 */
export interface ApiKeyCredential {
	type: "api_key";
	key?: string;
	env?: ProviderEnv;
}

/** 扩展兼容流程返回的 OAuth 令牌数据。 */
export interface OAuthCredentials {
	refresh: string;
	access: string;
	expires: number;
	[key: string]: unknown;
}

/** 已存储的规范 OAuth 凭据。 */
export interface OAuthCredential extends OAuthCredentials {
	type: "oauth";
}

/** 每个提供商一个带类型标记的凭据——当前 auth.json 的结构。 */
export type Credential = ApiKeyCredential | OAuthCredential;

/** 用于枚举账户/状态的非敏感凭据元数据。 */
export interface CredentialInfo {
	providerId: string;
	type: Credential["type"];
}

/** 公开身份验证和凭据操作的可选取消信号。 */
export interface AuthOperationOptions {
	signal?: AbortSignal;
}

/**
 * 应用自有的凭据存储，以 `Provider.id` 为键，每个提供商一个凭据。`modify` 是唯一写入
 * 路径，因此每次变更都是串行化的读取-修改-写入；`Models.getAuth()` 在 `modify` 内运行
 * OAuth 刷新，使并发请求无法重复刷新已轮换令牌。应用在登录后通过
 * `modify(provider.id, async () => credential)` 持久化凭据。登录/注销编排由应用负责。
 *
 * 错误语义：条目缺失时 `read` 解析为 `undefined`。方法只在存储失败时拒绝；`Models`
 * 将此类拒绝包装为代码为 "auth" 的 `ModelsError`。提供内存视图并在内部记录持久化错误的
 * 尽力型存储（例如 coding-agent 的 AuthStorage）也是有效实现。
 */
export interface CredentialStore {
	/**
	 * 读取可能已经到期的已存储凭据，供显示/状态使用；
	 * 解析后的请求身份验证来自 `Models.getAuth()`。
	 */
	read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined>;

	/**
	 * 列出已存储凭据的元数据，不解析或暴露敏感信息。
	 * 实现在列出时不得执行已配置的 API 密钥命令。
	 */
	list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]>;

	/**
	 * 串行化写入——唯一写入路径。`fn` 可看到当前凭据，因为正确写入（刷新、刷新期间登录）
	 * 依赖该值；返回新凭据，或返回 undefined 以保持条目不变。按提供商 id 互斥；
	 * 后端存储支持时也跨进程互斥（例如文件锁）。解析为写入后的凭据。
	 * `fn` 的拒绝会继续传播。
	 */
	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined>;

	/** 删除凭据（注销）。实现需要使此操作与 `modify` 串行执行。 */
	delete(providerId: string, options?: AuthOperationOptions): Promise<void>;
}

/** 身份验证解析所需的环境访问，可为测试和浏览器注入。 */
export interface AuthContext {
	env(name: string): Promise<string | undefined>;
	/** 检查文件是否存在。支持前导 `~`；浏览器中始终为 false。 */
	fileExists(path: string): Promise<boolean>;
}

/** 模型身份验证的解析结果。 */
export interface AuthResult {
	auth: ModelAuth;
	/** 从凭据和环境上下文解析出的提供商范围环境/配置值。 */
	env?: ProviderEnv;
	/** 状态界面使用的可读标签："ANTHROPIC_API_KEY"、"OAuth"、"~/.aws/credentials"。 */
	source?: string;
}

export interface AuthCheck {
	source?: string;
	type: "api_key" | "oauth";
}

export type AuthType = "api_key" | "oauth";

/**
 * 登录期间向用户显示的提示。带外事件完成当前步骤时，`signal` 允许流程取消待处理提示；
 * 例如 `manual_code` 提示与回调服务器竞争，回调先完成时中止提示。
 */
export type AuthPrompt = { signal?: AbortSignal } & (
	| { type: "text"; message: string; placeholder?: string }
	| { type: "secret"; message: string; placeholder?: string }
	| { type: "select"; message: string; options: readonly { id: string; label: string; description?: string }[] }
	| { type: "manual_code"; message: string; placeholder?: string }
);

export interface AuthInfoLink {
	url: string;
	label?: string;
}

export type AuthEvent =
	| { type: "info"; message: string; links?: readonly AuthInfoLink[] }
	| { type: "auth_url"; url: string; instructions?: string }
	| {
			type: "device_code";
			userCode: string;
			verificationUri: string;
			intervalSeconds?: number;
			expiresInSeconds?: number;
	  }
	| { type: "progress"; message: string };

/**
 * 同时服务于 API 密钥和 OAuth 流程的登录交互回调。
 *
 * `prompt()` 返回输入/选择的字符串（`select` 返回选项 id）。取消/中止时拒绝。
 * `signal` 中止整个登录流程；单个提示的取消使用 `AuthPrompt.signal`。
 */
export interface AuthInteraction {
	signal?: AbortSignal;

	prompt(prompt: AuthPrompt): Promise<string>;
	notify(event: AuthEvent): void;
}

/** 传给提供商登录实现的规范化交互。 */
export type ProviderAuthInteraction = AuthInteraction & { signal: AbortSignal };

/**
 * API 密钥身份验证：已存储密钥/提供商环境加环境来源（环境变量、AWS 配置文件、ADC 文件）。
 * 仅使用环境来源的提供商省略 `login`。
 */
export interface ApiKeyAuth {
	/** 显示名称，例如 "Anthropic API key"。 */
	name: string;

	/** 交互式设置（提示输入密钥/提供商环境）。不存在表示仅使用环境来源。 */
	login?(interaction: ProviderAuthInteraction): Promise<ApiKeyCredential>;

	/**
	 * 可选的无副作用可用性检查。当 `resolve()` 可能执行命令或其他仅应在请求期间执行的工作时使用。
	 * 缺失表示 Models 通过解析身份验证来检查可用性。
	 */
	check?(input: {
		ctx: AuthContext;
		credential?: ApiKeyCredential;
		signal: AbortSignal;
	}): Promise<AuthCheck | undefined>;

	/**
	 * 从已存储凭据和/或环境来源解析身份验证，并逐字段合并
	 * （`credential.key ?? env("...")`、`credential.env?.NAME ?? env("...")`）。
	 * undefined 表示未配置。解析限定在提供商范围；模型专用端点准备在身份验证解析后进行。
	 */
	resolve(input: {
		ctx: AuthContext;
		credential?: ApiKeyCredential;
		signal: AbortSignal;
	}): Promise<AuthResult | undefined>;
}

/**
 * OAuth 身份验证。拆分 `refresh`/`toAuth` 使 `Models` 负责加锁刷新模式：
 * `refresh` 生成凭据，`toAuth` 从最终存储的凭据派生请求身份验证。
 */
export interface OAuthAuth {
	/** 显示名称，例如 "Anthropic (Claude Pro/Max)"。 */
	name: string;

	/** 通过此身份验证方式进行的访问是否由提供商订阅支持。 */
	isSubscription?: boolean;

	/** OAuth 登录选项的选择器标签，例如 "Sign in with SuperGrok or X Premium"。 */
	loginLabel?: string;

	login(interaction: ProviderAuthInteraction): Promise<OAuthCredential>;

	/**
	 * 交换刷新令牌。此网络调用失败时抛出异常（invalid_grant 等）。
	 * `Models` 在存储锁内运行此操作。
	 */
	refresh(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential>;

	/**
	 * 从有效凭据无副作用地派生请求身份验证。
	 * 涵盖每个凭据的 baseUrl（GitHub Copilot）。采用异步形式，使延迟包装器可以在首次使用时加载实现。
	 */
	toAuth(credential: OAuthCredential): Promise<ModelAuth>;
}

/**
 * 提供商身份验证。`apiKey`/`oauth` 必须至少存在一项：即使是使用环境凭据的提供商和
 * 无密钥本地服务器，也要提供 `apiKey` 身份验证，其 `resolve()` 用于报告提供商是否已配置。
 */
export interface ProviderAuth {
	apiKey?: ApiKeyAuth;
	oauth?: OAuthAuth;
}
