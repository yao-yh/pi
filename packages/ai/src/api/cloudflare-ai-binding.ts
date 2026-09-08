/**
 * 基于 Workers AI 绑定的 AI Gateway 传输。
 *
 * pi 的 Cloudflare AI Gateway 支持使用 HTTPS
 *（`gateway.ai.cloudflare.com/v1/{account}/{gateway}/{provider}/...`，参见
 * `api/cloudflare.ts`），即使调用方是网关所属账户内的 Worker，也需要 Cloudflare API 令牌。
 *
 * Worker 可通过 AI 绑定的 `fetch` 透传（`env.AI.fetch()`）与网关通信，从而避免使用该令牌。
 * 它在 `https://workers-binding.ai/ai-gateway/gateways/{gateway}/{provider}/{endpoint...}`
 * 提供网关的提供商透传；其结构与 HTTPS URL 相同，但省略账户 id（绑定通道会携带身份）。
 * 绑定调用已在账户内预先完成身份验证，并将提供商原生线格式作为常规（流式）`Response`
 * 返回，因此 API 实现在两种传输上行为一致。
 *
 * 因此，`baseUrl` 指向该路由的模型无需转换：让它指向该地址，并将
 * {@link createAiBindingFetch} 作为请求 `fetch` 传入。不重写、缓冲或重新编码任何内容——
 * 方法、请求头、查询字符串和正文流都会按原样进入绑定，所以所有方法、非 JSON 正文和
 * 流式请求正文都能工作。
 *
 * 相比直接调用 `env.AI.fetch()`，此模块只额外提供了类型：`Ai#fetch` 在运行时存在
 * （`workerd/src/cloudflare/internal/ai-api.ts:158`），但 `@cloudflare/workers-types` 的
 * `Ai` 类尚未声明它，因此直接调用意味着在每个调用点都要转换绑定类型。
 * {@link AiBinding} 统一承担该转换——将 `fetch` 声明为可选并在构造时检查一次——使
 * `env.AI` 可以按原样传入。workers-types 声明 `fetch` 后，可同时移除可选标记和运行时检查。
 */

import type { FetchFunction } from "../types.ts";

/**
 * Workers AI 绑定（`env.AI`），使用结构化方式描述，使此模块不依赖
 * `@cloudflare/workers-types`。
 *
 * `fetch` 仅因为已发布的 `Ai` 类型尚未声明它而成为可选项——所有真实绑定在运行时都具备它。
 * `aiGatewayLogId` 用于将类型限定为 AI 绑定：它是 `Ai` 独有的成员；没有它，此接口还会
 * 接受 `AiGateway` 或任意手写的 `{ fetch }` 对象，而这正是运行时检查会延迟报告的错误。
 */
export interface AiBinding {
	aiGatewayLogId: string | null;
	fetch?(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}

/**
 * 绑定路由请求的身份验证请求头占位值。API 实现在分派前要求 API 密钥或可识别的身份验证
 * 请求头（`authorization`、`x-api-key`、`cf-aig-authorization`）；绑定调用已预先完成
 * 身份验证，因此传入 `cf-aig-authorization: Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`
 * 以通过检查。网关会忽略并移除绑定路由请求中的 `cf-aig-authorization`。同时设置
 * `Authorization: null` / `x-api-key: null`，避免 SDK 的身份验证占位请求头到达网关；
 * 否则网关会将请求提供的身份验证头视为覆盖其存储密钥的 BYOK 提供商密钥，行为与 HTTPS 相同。
 */
export const CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL = "cloudflare-gateway-binding";

/**
 * 为 `baseUrl` 已指向绑定所服务路由的模型创建由 AI 绑定支持的 `fetch`，包括网关的
 * 提供商透传 `https://workers-binding.ai/ai-gateway/gateways/{gateway}/{provider}/...`。
 * 请求会原样透传。
 *
 * ```ts
 * const model = {
 *   // ...
 *   baseUrl: `https://workers-binding.ai/ai-gateway/gateways/${gateway}/anthropic`,
 * };
 * await models.complete(model, context, {
 *   headers: {
 *     "cf-aig-authorization": `Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`,
 *     Authorization: null,
 *     "x-api-key": null,
 *   },
 *   fetch: createAiBindingFetch(env.AI),
 * });
 * ```
 */
export function createAiBindingFetch(binding: AiBinding): FetchFunction {
	// `fetch` 在类型上可选，因此在此处提前检查是否存在，避免首次推理请求时出现难以理解的失败。
	if (typeof binding.fetch !== "function") {
		throw new TypeError("createAiBindingFetch: the AI binding does not expose fetch()");
	}
	// 提前绑定：`fetch` 是可变属性，因此上述类型缩小无法延续到返回的闭包中。
	const bindingFetch = binding.fetch.bind(binding);
	return (input, init) => bindingFetch(input, init);
}
