/**
 * 模型解析、作用域限定和初始选择。
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AuthOperationOptions,
	type KnownProvider,
	type Model,
	modelsAreEqual,
} from "@earendil-works/pi-ai";
import chalk from "chalk";
import { minimatch } from "minimatch";
import { isValidThinkingLevel } from "../cli/args.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import type { ModelRuntime } from "./model-runtime.ts";

/** 每个已知提供商的默认模型 ID */
export const defaultModelPerProvider: Record<KnownProvider, string> = {
	"amazon-bedrock": "us.anthropic.claude-opus-4-6-v1",
	"ant-ling": "Ring-2.6-1T",
	anthropic: "claude-opus-4-8",
	openai: "gpt-5.5",
	"azure-openai-responses": "gpt-5.4",
	"openai-codex": "gpt-5.5",
	radius: "balanced",
	nvidia: "nvidia/nemotron-3-super-120b-a12b",
	deepseek: "deepseek-v4-pro",
	google: "gemini-3.1-pro-preview",
	"google-vertex": "gemini-3.1-pro-preview",
	"github-copilot": "gpt-5.4",
	openrouter: "moonshotai/kimi-k2.6",
	"vercel-ai-gateway": "zai/glm-5.1",
	xai: "grok-4.6",
	groq: "openai/gpt-oss-120b",
	cerebras: "gpt-oss-120b",
	zai: "glm-5.3",
	"zai-coding-cn": "glm-5.3",
	mistral: "devstral-medium-latest",
	minimax: "MiniMax-M2.7",
	"minimax-cn": "MiniMax-M2.7",
	moonshotai: "kimi-k2.6",
	"moonshotai-cn": "kimi-k2.6",
	huggingface: "moonshotai/Kimi-K2.6",
	fireworks: "accounts/fireworks/models/kimi-k2p6",
	together: "moonshotai/Kimi-K2.6",
	baseten: "zai-org/GLM-5.2",
	opencode: "kimi-k2.6",
	"opencode-go": "kimi-k2.6",
	"kimi-coding": "kimi-for-coding",
	"cloudflare-workers-ai": "@cf/moonshotai/kimi-k2.6",
	"cloudflare-ai-gateway": "workers-ai/@cf/moonshotai/kimi-k2.6",
	"qwen-token-plan": "qwen3.7-max",
	"qwen-token-plan-cn": "qwen3.7-max",
	"qwen-token-plan-individual": "qwen3.8-max",
	xiaomi: "mimo-v2.5-pro",
	"xiaomi-token-plan-cn": "mimo-v2.5-pro",
	"xiaomi-token-plan-ams": "mimo-v2.5-pro",
	"xiaomi-token-plan-sgp": "mimo-v2.5-pro",
};

export interface ScopedModel {
	model: Model<Api>;
	/** 模式中显式指定的思考级别（例如 "model:high"），否则为 undefined */
	thinkingLevel?: ThinkingLevel;
}

/**
 * 检查模型 ID 是否像别名（没有日期后缀）的辅助函数。
 * 日期通常采用 -20241022 或 -20250929 格式。
 */
function isAlias(id: string): boolean {
	// 检查 ID 是否以 -latest 结尾
	if (id.endsWith("-latest")) return true;

	// 检查 ID 是否以日期模式（-YYYYMMDD）结尾
	const datePattern = /-\d{8}$/;
	return !datePattern.test(id);
}

/**
 * 查找精确匹配的模型引用。
 * 支持纯模型 ID 或标准 provider/modelId 引用。
 * 使用纯 ID 匹配时，会拒绝跨提供商的歧义匹配。
 */
export function findExactModelReferenceMatch(
	modelReference: string,
	availableModels: Model<Api>[],
): Model<Api> | undefined {
	const trimmedReference = modelReference.trim();
	if (!trimmedReference) {
		return undefined;
	}

	const normalizedReference = trimmedReference.toLowerCase();

	const canonicalMatches = availableModels.filter(
		(model) => `${model.provider}/${model.id}`.toLowerCase() === normalizedReference,
	);
	if (canonicalMatches.length === 1) {
		return canonicalMatches[0];
	}
	if (canonicalMatches.length > 1) {
		return undefined;
	}

	const slashIndex = trimmedReference.indexOf("/");
	if (slashIndex !== -1) {
		const provider = trimmedReference.substring(0, slashIndex).trim();
		const modelId = trimmedReference.substring(slashIndex + 1).trim();
		if (provider && modelId) {
			const providerMatches = availableModels.filter(
				(model) =>
					model.provider.toLowerCase() === provider.toLowerCase() &&
					model.id.toLowerCase() === modelId.toLowerCase(),
			);
			if (providerMatches.length === 1) {
				return providerMatches[0];
			}
			if (providerMatches.length > 1) {
				return undefined;
			}
		}
	}

	const idMatches = availableModels.filter((model) => model.id.toLowerCase() === normalizedReference);
	return idMatches.length === 1 ? idMatches[0] : undefined;
}

/**
 * 尝试使用模式匹配可用模型列表中的模型。
 * 返回匹配的模型，未找到时返回 undefined。
 */
function tryMatchModel(modelPattern: string, availableModels: Model<Api>[]): Model<Api> | undefined {
	const exactMatch = findExactModelReferenceMatch(modelPattern, availableModels);
	if (exactMatch) {
		return exactMatch;
	}

	// 没有精确匹配时回退到部分匹配
	const matches = availableModels.filter(
		(m) =>
			m.id.toLowerCase().includes(modelPattern.toLowerCase()) ||
			m.name?.toLowerCase().includes(modelPattern.toLowerCase()),
	);

	if (matches.length === 0) {
		return undefined;
	}

	// 分为别名和带日期版本
	const aliases = matches.filter((m) => isAlias(m.id));
	const datedVersions = matches.filter((m) => !isAlias(m.id));

	if (aliases.length > 0) {
		// 优先选择别名；存在多个别名时选择排序最高者
		aliases.sort((a, b) => b.id.localeCompare(a.id));
		return aliases[0];
	} else {
		// 未找到别名时选择最新的带日期版本
		datedVersions.sort((a, b) => b.id.localeCompare(a.id));
		return datedVersions[0];
	}
}

export interface ParsedModelResult {
	model: Model<Api> | undefined;
	/** 模式中显式指定的思考级别，否则为 undefined */
	thinkingLevel?: ThinkingLevel;
	warning: string | undefined;
}

function buildFallbackModel(provider: string, modelId: string, availableModels: Model<Api>[]): Model<Api> | undefined {
	const providerModels = availableModels.filter((m) => m.provider === provider);
	if (providerModels.length === 0) return undefined;

	const defaultId = defaultModelPerProvider[provider as KnownProvider];
	const baseModel = defaultId
		? (providerModels.find((m) => m.id === defaultId) ?? providerModels[0])
		: providerModels[0];

	return {
		...baseModel,
		id: modelId,
		name: modelId,
	};
}

/**
 * 解析模式以提取模型和思考级别。
 * 支持 ID 中包含冒号的模型（例如 OpenRouter 的 :exacto 后缀）。
 *
 * 算法：
 * 1. 尝试将完整模式匹配为模型
 * 2. 找到后返回模型，并使用 "off" 思考级别
 * 3. 未找到且包含冒号时，按最后一个冒号拆分：
 *    - 后缀是有效思考级别时使用该级别，并递归处理前缀
 *    - 后缀无效时发出警告，并使用 "off" 递归处理前缀
 *
 * @internal 导出供测试使用
 */
export function parseModelPattern(
	pattern: string,
	availableModels: Model<Api>[],
	options?: { allowInvalidThinkingLevelFallback?: boolean },
): ParsedModelResult {
	// 先尝试精确匹配
	const exactMatch = tryMatchModel(pattern, availableModels);
	if (exactMatch) {
		return { model: exactMatch, thinkingLevel: undefined, warning: undefined };
	}

	// 未匹配时尝试按最后一个冒号拆分（如果存在）
	const lastColonIndex = pattern.lastIndexOf(":");
	if (lastColonIndex === -1) {
		// 没有冒号，说明模式不匹配任何模型
		return { model: undefined, thinkingLevel: undefined, warning: undefined };
	}

	const prefix = pattern.substring(0, lastColonIndex);
	const suffix = pattern.substring(lastColonIndex + 1);

	if (isValidThinkingLevel(suffix)) {
		// 思考级别有效：递归处理前缀并使用该级别
		const result = parseModelPattern(prefix, availableModels, options);
		if (result.model) {
			// 仅当内部递归没有警告时使用此思考级别
			return {
				model: result.model,
				thinkingLevel: result.warning ? undefined : suffix,
				warning: result.warning,
			};
		}
		return result;
	} else {
		// 后缀无效
		const allowFallback = options?.allowInvalidThinkingLevelFallback ?? true;
		if (!allowFallback) {
			// 严格模式（CLI --model 解析）下将其视为模型 ID 的一部分并返回失败，
			// 避免意外解析为其他模型。
			return { model: undefined, thinkingLevel: undefined, warning: undefined };
		}

		// 作用域模式：递归处理前缀并发出警告
		const result = parseModelPattern(prefix, availableModels, options);
		if (result.model) {
			return {
				model: result.model,
				thinkingLevel: undefined,
				warning: `Invalid thinking level "${suffix}" in pattern "${pattern}". Using default instead.`,
			};
		}
		return result;
	}
}

/**
 * 将模型模式解析为带可选思考级别的实际 Model 对象。
 * 格式为 "pattern:level"，其中 :level 可选。
 * 对每个模式查找所有匹配模型并选择最佳版本：
 * 1. 优先选择别名（例如 claude-sonnet-4-5），而非带日期版本（claude-sonnet-4-5-20250929）
 * 2. 没有别名时选择最新的带日期版本
 *
 * 支持 ID 中包含冒号的模型（例如 OpenRouter 的 model:exacto）。
 * 算法先尝试匹配完整模式，再逐步移除冒号后缀以查找匹配。
 */
export interface ModelScopeDiagnostic {
	type: "warning";
	code: "no-match" | "invalid-thinking-level";
	message: string;
	pattern: string;
}

export interface ResolveModelScopeResult {
	scopedModels: ScopedModel[];
	diagnostics: ModelScopeDiagnostic[];
}

export function resolveModelScopeFromModels(
	patterns: string[],
	models: readonly Model<Api>[],
): ResolveModelScopeResult {
	const availableModels = [...models];
	const scopedModels: ScopedModel[] = [];
	const diagnostics: ModelScopeDiagnostic[] = [];

	for (const pattern of patterns) {
		// 检查模式是否包含 glob 字符
		if (pattern.includes("*") || pattern.includes("?") || pattern.includes("[")) {
			// 提取可选的思考级别后缀（例如 "provider/*:high"）
			const colonIdx = pattern.lastIndexOf(":");
			let globPattern = pattern;
			let thinkingLevel: ThinkingLevel | undefined;

			if (colonIdx !== -1) {
				const suffix = pattern.substring(colonIdx + 1);
				if (isValidThinkingLevel(suffix)) {
					thinkingLevel = suffix;
					globPattern = pattern.substring(0, colonIdx);
				}
			}

			const exactMatch = findExactModelReferenceMatch(globPattern, availableModels);
			if (exactMatch) {
				if (!scopedModels.find((sm) => modelsAreEqual(sm.model, exactMatch))) {
					scopedModels.push({ model: exactMatch, thinkingLevel });
				}
				continue;
			}

			// 同时匹配 "provider/modelId" 格式和纯模型 ID，
			// 使 "*sonnet*" 无需写成 "anthropic/*sonnet*" 即可匹配
			const matchingModels = availableModels.filter((m) => {
				const fullId = `${m.provider}/${m.id}`;
				return minimatch(fullId, globPattern, { nocase: true }) || minimatch(m.id, globPattern, { nocase: true });
			});

			if (matchingModels.length === 0) {
				diagnostics.push({
					type: "warning",
					code: "no-match",
					message: `No models match pattern "${pattern}"`,
					pattern,
				});
				continue;
			}

			for (const model of matchingModels) {
				if (!scopedModels.find((sm) => modelsAreEqual(sm.model, model))) {
					scopedModels.push({ model, thinkingLevel });
				}
			}
			continue;
		}

		const { model, thinkingLevel, warning } = parseModelPattern(pattern, availableModels);

		if (warning) {
			diagnostics.push({ type: "warning", code: "invalid-thinking-level", message: warning, pattern });
		}

		if (!model) {
			diagnostics.push({
				type: "warning",
				code: "no-match",
				message: `No models match pattern "${pattern}"`,
				pattern,
			});
			continue;
		}

		// 避免重复
		if (!scopedModels.find((sm) => modelsAreEqual(sm.model, model))) {
			scopedModels.push({ model, thinkingLevel });
		}
	}

	return { scopedModels, diagnostics };
}

export async function resolveModelScopeWithDiagnostics(
	patterns: string[],
	modelRuntime: ModelRuntime,
	options?: AuthOperationOptions,
): Promise<ResolveModelScopeResult> {
	return resolveModelScopeFromModels(patterns, await modelRuntime.getAvailable(undefined, options));
}

export async function resolveModelScope(
	patterns: string[],
	modelRuntime: ModelRuntime,
	options?: AuthOperationOptions,
): Promise<ScopedModel[]> {
	const { scopedModels, diagnostics } = await resolveModelScopeWithDiagnostics(patterns, modelRuntime, options);
	for (const diagnostic of diagnostics) {
		console.warn(chalk.yellow(`Warning: ${diagnostic.message}`));
	}
	return scopedModels;
}

export interface ResolveCliModelResult {
	model: Model<Api> | undefined;
	thinkingLevel?: ThinkingLevel;
	warning: string | undefined;
	/**
	 * 适合 CLI 显示的错误消息。
	 * 设置后 model 将为 undefined。
	 */
	error: string | undefined;
}

/**
 * 根据 CLI 标志解析单个模型。
 *
 * 支持：
 * - --provider <provider> --model <pattern>
 * - --model <provider>/<pattern>
 * - 模糊匹配（规则与模型作用域相同：先精确 ID，再部分匹配 ID/名称）
 *
 * 注意：此函数本身不应用思考级别，但可以从 "<pattern>:<thinking>"
 * 解析并返回思考级别，供调用方应用。
 */
export function resolveCliModel(options: {
	cliProvider?: string;
	cliModel?: string;
	cliThinking?: ThinkingLevel;
	modelRuntime: ModelRuntime;
}): ResolveCliModelResult {
	const { cliProvider, cliModel, cliThinking, modelRuntime } = options;

	if (!cliModel) {
		return { model: undefined, warning: undefined, error: undefined };
	}

	// 重要：此处使用所有模型，而非仅使用预先配置身份验证的模型，
	// 以便首次设置时能够使用 "--api-key"。
	const availableModels = [...modelRuntime.getModels()];
	if (availableModels.length === 0) {
		return {
			model: undefined,
			warning: undefined,
			error: "No models available. Check your installation or add models to models.json.",
		};
	}

	// 构建不区分大小写的标准提供商查找表
	const providerMap = new Map<string, string>();
	for (const m of availableModels) {
		providerMap.set(m.provider.toLowerCase(), m.provider);
	}

	let provider = cliProvider ? providerMap.get(cliProvider.toLowerCase()) : undefined;
	if (cliProvider && !provider) {
		return {
			model: undefined,
			warning: undefined,
			error: `Unknown provider "${cliProvider}". Use --list-models to see available providers/models.`,
		};
	}

	// 未显式提供 --provider 时，先尝试解释 "provider/model" 格式。
	// 如果第一个斜杠前的前缀匹配已知提供商，则优先采用该解释，
	// 而不是匹配 ID 中实际包含斜杠的模型（例如 "zai/glm-5" 应解析为
	// provider=zai、model=glm-5，而非 ID 为 "zai/glm-5" 的 vercel-ai-gateway 模型）。
	let pattern = cliModel;
	let inferredProvider = false;

	if (!provider) {
		const slashIndex = cliModel.indexOf("/");
		if (slashIndex !== -1) {
			const maybeProvider = cliModel.substring(0, slashIndex);
			const canonical = providerMap.get(maybeProvider.toLowerCase());
			if (canonical) {
				provider = canonical;
				pattern = cliModel.substring(slashIndex + 1);
				inferredProvider = true;
			}
		}
	}

	// 如果无法根据斜杠推断提供商，则在不推断提供商的情况下尝试精确匹配。
	// 这可处理 ID 天然包含斜杠的模型（例如 OpenRouter 风格 ID）。
	// 纯精确 ID 可能存在于多个提供商中，因此不要按目录顺序选择。
	// 如果仅有一个提供商已通过身份验证则优先使用，否则要求显式指定提供商，
	// 避免静默选择不可用的提供商。
	if (!provider) {
		const lower = cliModel.toLowerCase();
		const exactMatches = availableModels.filter(
			(m) => m.id.toLowerCase() === lower || `${m.provider}/${m.id}`.toLowerCase() === lower,
		);
		if (exactMatches.length === 1) {
			return { model: exactMatches[0], warning: undefined, thinkingLevel: undefined, error: undefined };
		}
		if (exactMatches.length > 1) {
			const authenticatedExactMatches = exactMatches.filter((m) => modelRuntime.hasConfiguredAuth(m.provider));
			if (authenticatedExactMatches.length === 1) {
				return {
					model: authenticatedExactMatches[0],
					warning: undefined,
					thinkingLevel: undefined,
					error: undefined,
				};
			}

			const matches = exactMatches
				.map((m) => `${m.provider}/${m.id}`)
				.sort((a, b) => a.localeCompare(b))
				.join(", ");
			const authHint =
				authenticatedExactMatches.length === 0
					? "No matching provider is authenticated."
					: "More than one matching provider is authenticated.";
			return {
				model: undefined,
				warning: undefined,
				thinkingLevel: undefined,
				error: `Model "${cliModel}" is ambiguous across providers: ${matches}. ${authHint} Use --provider or provider/model.`,
			};
		}
	}

	if (cliProvider && provider) {
		// 两者都提供时，移除提供商前缀以兼容 --model <provider>/<pattern>
		const prefix = `${provider}/`;
		if (cliModel.toLowerCase().startsWith(prefix.toLowerCase())) {
			pattern = cliModel.substring(prefix.length);
		}
	}

	const candidates = provider ? availableModels.filter((m) => m.provider === provider) : availableModels;
	const { model, thinkingLevel, warning } = parseModelPattern(pattern, candidates, {
		allowInvalidThinkingLevelFallback: false,
	});

	if (model) {
		// 如果提供商推断匹配到未通过身份验证的提供商/模型组合，
		// 则优先使用一个已通过身份验证的原始模型 ID 精确匹配。
		// 这样在可用时仍优先采用 "provider/model" 语法，同时也能处理
		// 字面 ID 以已知提供商名称开头的模型（例如 commandcode 的 "xiaomi/mimo-v2.5-pro"）。
		if (inferredProvider) {
			const rawExactMatches = availableModels.filter(
				(m) => m.id.toLowerCase() === cliModel.toLowerCase() && !modelsAreEqual(m, model),
			);
			if (rawExactMatches.length > 0 && !modelRuntime.hasConfiguredAuth(model.provider)) {
				const authenticatedRawMatches = rawExactMatches.filter((m) => modelRuntime.hasConfiguredAuth(m.provider));
				if (authenticatedRawMatches.length === 1) {
					return {
						model: authenticatedRawMatches[0],
						thinkingLevel: undefined,
						warning: undefined,
						error: undefined,
					};
				}
			}
		}
		return { model, thinkingLevel, warning, error: undefined };
	}

	// 如果根据斜杠推断出提供商，但该提供商内没有匹配，
	// 则回退到在所有模型中将完整输入作为原始模型 ID 匹配。
	// 这可处理 "openai/gpt-4o:extended" 等 OpenRouter 风格 ID：
	// "openai" 看似提供商，但完整字符串实际是 openrouter 上的模型 ID。
	if (inferredProvider) {
		const lower = cliModel.toLowerCase();
		const exact = availableModels.find(
			(m) => m.id.toLowerCase() === lower || `${m.provider}/${m.id}`.toLowerCase() === lower,
		);
		if (exact) {
			return { model: exact, warning: undefined, thinkingLevel: undefined, error: undefined };
		}
		// 同时使用完整输入对所有模型尝试 parseModelPattern
		const fallback = parseModelPattern(cliModel, availableModels, {
			allowInvalidThinkingLevelFallback: false,
		});
		if (fallback.model) {
			return {
				model: fallback.model,
				thinkingLevel: fallback.thinkingLevel,
				warning: fallback.warning,
				error: undefined,
			};
		}
	}

	if (provider) {
		// 构建回退模型前从模式中解析思考级别后缀，
		// 但仅在未显式提供 --thinking 时进行。
		// 例如 "zai-org/GLM-5.1-FP8:high" → modelId="zai-org/GLM-5.1-FP8"、fallbackThinking="high"
		let fallbackPattern = pattern;
		let fallbackThinking: ThinkingLevel | undefined;
		if (!cliThinking) {
			const lastColon = pattern.lastIndexOf(":");
			if (lastColon !== -1) {
				const suffix = pattern.substring(lastColon + 1);
				if (isValidThinkingLevel(suffix)) {
					fallbackPattern = pattern.substring(0, lastColon);
					fallbackThinking = suffix;
				}
			}
		}

		const fallbackModel = buildFallbackModel(provider, fallbackPattern, availableModels);
		if (fallbackModel) {
			const requestedThinking = cliThinking ?? fallbackThinking;
			const model =
				requestedThinking && requestedThinking !== "off" ? { ...fallbackModel, reasoning: true } : fallbackModel;
			const fallbackWarning = warning
				? `${warning} Model "${fallbackPattern}" not found for provider "${provider}". Using custom model id.`
				: `Model "${fallbackPattern}" not found for provider "${provider}". Using custom model id.`;
			return { model, thinkingLevel: fallbackThinking, warning: fallbackWarning, error: undefined };
		}
	}

	const display = provider ? `${provider}/${pattern}` : cliModel;
	return {
		model: undefined,
		thinkingLevel: undefined,
		warning,
		error: `Model "${display}" not found. Use --list-models to see available models.`,
	};
}

export interface InitialModelResult {
	model: Model<Api> | undefined;
	thinkingLevel: ThinkingLevel;
	fallbackMessage: string | undefined;
}

/**
 * 按以下优先级查找要使用的初始模型：
 * 1. CLI 参数（提供商 + 模型）
 * 2. 作用域模型中的第一个模型（非继续/恢复会话时）
 * 3. 从会话恢复（继续/恢复会话时）
 * 4. 设置中保存的默认模型
 * 5. 第一个具有有效 API 密钥的可用模型
 */
export async function findInitialModel(options: {
	cliProvider?: string;
	cliModel?: string;
	scopedModels: ScopedModel[];
	isContinuing: boolean;
	defaultProvider?: string;
	defaultModelId?: string;
	defaultThinkingLevel?: ThinkingLevel;
	modelThinkingLevels?: Record<string, ThinkingLevel>;
	modelRuntime: ModelRuntime;
}): Promise<InitialModelResult> {
	const {
		cliProvider,
		cliModel,
		scopedModels,
		isContinuing,
		defaultProvider,
		defaultModelId,
		defaultThinkingLevel,
		modelThinkingLevels,
		modelRuntime,
	} = options;

	let model: Model<Api> | undefined;
	let thinkingLevel: ThinkingLevel = DEFAULT_THINKING_LEVEL;

	// 1. CLI 参数优先
	if (cliProvider && cliModel) {
		const resolved = resolveCliModel({
			cliProvider,
			cliModel,
			modelRuntime,
		});
		if (resolved.error) {
			console.error(chalk.red(resolved.error));
			process.exit(1);
		}
		if (resolved.model) {
			return { model: resolved.model, thinkingLevel: DEFAULT_THINKING_LEVEL, fallbackMessage: undefined };
		}
	}

	// 2. 使用作用域模型中的第一个模型（继续/恢复会话时跳过）
	if (scopedModels.length > 0 && !isContinuing) {
		const scopedModel = scopedModels[0];
		const perModel = modelThinkingLevels?.[`${scopedModel.model.provider}/${scopedModel.model.id}`];
		return {
			model: scopedModel.model,
			thinkingLevel: scopedModel.thinkingLevel ?? perModel ?? defaultThinkingLevel ?? DEFAULT_THINKING_LEVEL,
			fallbackMessage: undefined,
		};
	}

	// 3. 如果已配置身份验证，则尝试使用设置中保存的默认模型。
	if (defaultProvider && defaultModelId) {
		const found = modelRuntime.getModel(defaultProvider, defaultModelId);
		if (found && modelRuntime.hasConfiguredAuth(found.provider)) {
			model = found;
			const perModel = modelThinkingLevels?.[`${defaultProvider}/${defaultModelId}`];
			if (perModel) {
				thinkingLevel = perModel;
			} else if (defaultThinkingLevel) {
				thinkingLevel = defaultThinkingLevel;
			}
			return { model, thinkingLevel, fallbackMessage: undefined };
		}
	}

	// 4. 尝试使用第一个具有有效 API 密钥的可用模型
	const availableModels = [...modelRuntime.getAvailableSnapshot()];

	if (availableModels.length > 0) {
		// 尝试查找已知提供商的默认模型
		for (const provider of Object.keys(defaultModelPerProvider) as KnownProvider[]) {
			const defaultId = defaultModelPerProvider[provider];
			const match = availableModels.find((m) => m.provider === provider && m.id === defaultId);
			if (match) {
				return { model: match, thinkingLevel: DEFAULT_THINKING_LEVEL, fallbackMessage: undefined };
			}
		}

		// 未找到默认模型时使用第一个可用模型
		return { model: availableModels[0], thinkingLevel: DEFAULT_THINKING_LEVEL, fallbackMessage: undefined };
	}

	// 5. 未找到模型
	return { model: undefined, thinkingLevel: DEFAULT_THINKING_LEVEL, fallbackMessage: undefined };
}

/**
 * 从会话恢复模型，并在失败时回退到可用模型。
 */
export async function restoreModelFromSession(
	savedProvider: string,
	savedModelId: string,
	currentModel: Model<Api> | undefined,
	shouldPrintMessages: boolean,
	modelRuntime: ModelRuntime,
): Promise<{ model: Model<Api> | undefined; fallbackMessage: string | undefined }> {
	const restoredModel = modelRuntime.getModel(savedProvider, savedModelId);

	// 检查恢复的模型是否存在且仍已配置身份验证
	const hasConfiguredAuth = restoredModel ? modelRuntime.hasConfiguredAuth(restoredModel.provider) : false;

	if (restoredModel && hasConfiguredAuth) {
		if (shouldPrintMessages) {
			console.log(chalk.dim(`Restored model: ${savedProvider}/${savedModelId}`));
		}
		return { model: restoredModel, fallbackMessage: undefined };
	}

	// 未找到模型或没有 API 密钥时进行回退
	const reason = !restoredModel ? "model no longer exists" : "no auth configured";

	if (shouldPrintMessages) {
		console.error(chalk.yellow(`Warning: Could not restore model ${savedProvider}/${savedModelId} (${reason}).`));
	}

	// 如果已有模型，则将其用作回退
	if (currentModel) {
		if (shouldPrintMessages) {
			console.log(chalk.dim(`Falling back to: ${currentModel.provider}/${currentModel.id}`));
		}
		return {
			model: currentModel,
			fallbackMessage: `Could not restore model ${savedProvider}/${savedModelId} (${reason}). Using ${currentModel.provider}/${currentModel.id}.`,
		};
	}

	// 尝试查找任意可用模型
	const availableModels = [...modelRuntime.getAvailableSnapshot()];

	if (availableModels.length > 0) {
		// 尝试查找已知提供商的默认模型
		let fallbackModel: Model<Api> | undefined;
		for (const provider of Object.keys(defaultModelPerProvider) as KnownProvider[]) {
			const defaultId = defaultModelPerProvider[provider];
			const match = availableModels.find((m) => m.provider === provider && m.id === defaultId);
			if (match) {
				fallbackModel = match;
				break;
			}
		}

		// 未找到默认模型时使用第一个可用模型
		if (!fallbackModel) {
			fallbackModel = availableModels[0];
		}

		if (shouldPrintMessages) {
			console.log(chalk.dim(`Falling back to: ${fallbackModel.provider}/${fallbackModel.id}`));
		}

		return {
			model: fallbackModel,
			fallbackMessage: `Could not restore model ${savedProvider}/${savedModelId} (${reason}). Using ${fallbackModel.provider}/${fallbackModel.id}.`,
		};
	}

	// 没有可用模型
	return { model: undefined, fallbackMessage: undefined };
}
