# Pi packages 功能与依赖关系

本文只依据当前工作区源码和各级 package.json 整理，不使用网络资料，也不以包名猜测实现。文中的依赖箭头统一表示“左侧包依赖右侧包”；实线是 dependencies，虚线是 devDependencies。

## 1. 范围与总览

### 1.1 结论：主体架构由 11 个实现包组成，session-backends 是分组目录

根工作区声明 packages/* 和 packages/session-backends/*。前者对应 10 个带 package.json 的顶层实现包，后者当前对应 sqlite-node；因此主体部分按 11 个实现包整理。根工作区另外显式包含 5 个扩展示例，其他嵌套 package.json 则是示例、文档实验或安装锁定目录，统一放在附录。

源码示例：

~~~json
"workspaces": [
	"packages/*",
	"packages/session-backends/*",
	"packages/coding-agent/examples/extensions/with-deps",
	"packages/coding-agent/examples/extensions/custom-provider-anthropic",
	"packages/coding-agent/examples/extensions/custom-provider-gitlab-duo",
	"packages/coding-agent/examples/extensions/sandbox",
	"packages/coding-agent/examples/extensions/gondolin"
]
~~~

证据：[根工作区清单](../package.json#L5)、[SQLite 后端包名](../packages/session-backends/sqlite-node/package.json#L2)。

主体包总览（这里只用于定位；具体功能点见每个包开头的功能地图）：

| 包 | 路径 | 一级能力域 | 二级模块概览 | 生产期内部依赖 |
|---|---|---|---|---|
| @earendil-works/chord | packages/chord | Facet、服务、复制状态、Context、构建加载 | Host/Loader、Provider/Binding、State Codec、ContextKey、Bundle Loader | 无 |
| @earendil-works/pi-telemetry | packages/telemetry | 遥测协议、类型化 Schema、记录实现 | Context/Span、类型推导、Typed Starter、Memory/NOOP | 无 |
| @earendil-works/pi-ai | packages/ai | 模型、请求、认证、Provider 适配、图片、资源清理 | Models/Provider、EventStream、Credential、API Adapter、ImagesModels | pi-telemetry |
| @earendil-works/pi-agent-core | packages/agent | 基础 Agent、Harness、工具、会话、压缩、Prompt 资源 | Agent/Loop、Lane/Drive、Tool Pipeline、Storage/Repo、Compaction、Skills/Templates | chord、pi-ai、pi-telemetry |
| @earendil-works/pi-session-backend-sqlite-node | packages/session-backends/sqlite-node | SessionRepo、Storage、Session 门面、数据库适配、Schema | Repo Lifecycle、Entry/Value/Usage、SqliteOpenSession、DatabaseSync Adapter、Migration | pi-agent-core、pi-ai |
| @earendil-works/pi-protocol | packages/protocol | 协议模型、运行时校验、消息编码、增量解码 | Client/Server Schema、Codec、Framing、CBOR | chord |
| @earendil-works/pi-client | packages/client | Transport、Connection、RPC、订阅、Attachment、Unix | ByteTransport、Handshake、Pending Request、State Decoder、Chord Adapter、Unix Discovery | chord、pi-protocol |
| @earendil-works/pi-server | packages/server | Listener、连接状态、RPC、SessionRouter、Host、Unix | Handshake、Request/Cancel、Attachment Lease、Session Host、Unix Listener | chord、pi-agent-core、pi-protocol |
| @earendil-works/pi-tui | packages/tui | 组件、运行时、屏幕、布局、编辑器、输入、富文本、图片 | Component/Container、Main/Alt Screen、Layout、Editor、Keybinding、Markdown、Kitty/iTerm2 | 无 |
| @earendil-works/pi-coding-agent | packages/coding-agent | CLI、装配、会话、模型、Prompt、Tool、Extension、配置、模式、远程实验 | SDK/Services/Runtime、AgentSession/SessionManager、ModelRuntime、ResourceLoader、Tool Registry、ExtensionRunner、TUI/RPC | chord、pi-agent-core、pi-ai、pi-tui |
| @earendil-works/pi-evals | packages/evals | 评估 Harness、产物、数据集、统计、Reporter | Pi Harness、Session Artifact、Harness Table、Comparison Summary、Vitest Reporter | 无生产依赖；开发期依赖 pi-ai、pi-coding-agent |

各行证据：[Chord manifest](../packages/chord/package.json#L2)、[Telemetry manifest](../packages/telemetry/package.json#L2)、[AI manifest](../packages/ai/package.json#L2)、[Agent manifest](../packages/agent/package.json#L2)、[SQLite manifest](../packages/session-backends/sqlite-node/package.json#L2)、[Protocol manifest](../packages/protocol/package.json#L2)、[Client manifest](../packages/client/package.json#L2)、[Server manifest](../packages/server/package.json#L2)、[TUI manifest](../packages/tui/package.json#L2)、[Coding Agent manifest](../packages/coding-agent/package.json#L2)、[Evals manifest](../packages/evals/package.json#L2)。

### 1.2 功能分解和证据规则

后文对每个实现包使用三层结构：

- 一级分类：包内相对独立的能力域，例如“服务运行时”“认证”“会话持久化”。
- 二级分类：能力域中的实现模块，例如“远程服务提供端”“凭据解析”“JSONL Storage”。
- 具体功能点：可以落实到函数、类或接口的方法行为。

功能结论以 `packages/*/src` 下的实现为准。`package.json` 只用于证明包名、发布入口和依赖边，不用它推断功能。源码摘录中的位置直接写成注释：

~~~ts
// 源码: packages/chord/src/api.ts:19-26
export async function createFacetHost(options: FacetOptions): Promise<FacetHost> {
	const kernel = new FacetKernel(options);
	await kernel.activate();
	return Object.freeze({
		services: kernel.provider,
		reload: (facets: readonly Facet[]) => kernel.reload(facets),
		dispose: () => kernel.dispose(),
	});
}
~~~

### 1.3 结论：仓库存在三条主要依赖链，而不是一个所有包相互引用的整体

第一条是本地 Agent 主链：coding-agent → agent-core → pi-ai → telemetry，同时 coding-agent 直接使用 TUI。第二条是远程会话链：client/server 共同依赖 protocol 和 Chord，server 再通过 agent-core 的 Session 抽象接入会话。第三条是持久化链：SQLite 后端实现 agent-core 定义的 Session/Storage 接口。

源码示例：

~~~json
// packages/coding-agent/package.json
"@earendil-works/pi-agent-core": "^0.85.1",
"@earendil-works/pi-ai": "^0.85.1",
"@earendil-works/pi-tui": "^0.85.1"

// packages/server/package.json
"@earendil-works/chord": "^0.85.1",
"@earendil-works/pi-agent-core": "^0.85.1",
"@earendil-works/pi-protocol": "^0.85.1"

// packages/session-backends/sqlite-node/package.json
"@earendil-works/pi-ai": "^0.85.1",
"@earendil-works/pi-agent-core": "^0.85.1"
~~~

证据：[Coding Agent 生产依赖](../packages/coding-agent/package.json#L51)、[Server 生产依赖](../packages/server/package.json#L49)、[SQLite 生产依赖](../packages/session-backends/sqlite-node/package.json#L37)。

~~~mermaid
flowchart TD
    coding["@earendil-works/pi-coding-agent"]
    agent["@earendil-works/pi-agent-core"]
    ai["@earendil-works/pi-ai"]
    telemetry["@earendil-works/pi-telemetry"]
    tui["@earendil-works/pi-tui"]
    chord["@earendil-works/chord"]
    protocol["@earendil-works/pi-protocol"]
    client["@earendil-works/pi-client"]
    server["@earendil-works/pi-server"]
    sqlite["@earendil-works/pi-session-backend-sqlite-node"]
    evals["@earendil-works/pi-evals"]

    coding --> agent
    coding --> ai
    coding --> tui
    coding --> chord
    agent --> ai
    agent --> telemetry
    agent --> chord
    ai --> telemetry
    sqlite --> agent
    sqlite --> ai
    protocol --> chord
    client --> protocol
    client --> chord
    server --> protocol
    server --> chord
    server --> agent
    coding -. dev .-> client
    coding -. dev .-> protocol
    coding -. dev .-> server
    evals -. dev .-> coding
    evals -. dev .-> ai
~~~

## 2. @earendil-works/chord

功能地图：

| 一级分类 | 二级分类 | 具体功能点 | 直接实现证据 |
|---|---|---|---|
| Facet 组合运行时 | Host 创建 | 创建 `FacetKernel`、激活 facet、暴露 services/reload/dispose | [createFacetHost](../packages/chord/src/api.ts#L19) |
| Facet 组合运行时 | Loader 组合 | 顺序加载多个 loader；失败时按逆序释放已加载 facet | [combineFacetLoaders](../packages/chord/src/api.ts#L38)、[disposeLoadedFacets](../packages/chord/src/facets/loader.ts#L3) |
| Facet 组合运行时 | 生命周期内核 | 维护 facet 激活、reload、service provider 和清理状态 | [FacetKernel](../packages/chord/src/facets/host.ts#L340) |
| 服务运行时 | 服务契约 | 创建带稳定 id 的本地或远程 `Service<T>`；阻止保留命名空间 | [defineService](../packages/chord/src/api.ts#L70) |
| 服务运行时 | 远程提供端 | 接收 service call、订阅和取消，将实现结果转换成远程 endpoint | [RemoteServiceProvider](../packages/chord/src/services/provider.ts#L77)、[createRemoteServiceEndpoint](../packages/chord/src/services/provider.ts#L502) |
| 服务运行时 | 远程消费端 | 建立 binding，解析 snapshot/update，管理远程订阅的生命周期 | [RemoteServiceBindingImpl](../packages/chord/src/services/consumer.ts#L425) |
| 复制状态 | 主状态与副本 | 主状态发布变更；副本按更新应用状态 | [MutableReplicatedStateImpl](../packages/chord/src/services/state.ts#L6)、[ReplicatedStateReplica](../packages/chord/src/services/state.ts#L60) |
| 复制状态 | Wire 编解码 | 把 snapshot/update 编码为 JSON 服务负载，并在消费端恢复 | [createServiceStateEncoder](../packages/chord/src/services/state-codec.ts#L60)、[createServiceStateDecoder](../packages/chord/src/services/state-codec.ts#L90) |
| Context | 值传播 | 通过 `ContextKey` 在父子调用链中携带显式值 | [createContextKey](../packages/chord/src/context/index.ts#L58)、[withContextValue](../packages/chord/src/context/index.ts#L63) |
| Context | 取消传播 | 附加/移除 AbortSignal，创建可取消 context，并让 Promise 响应取消 | [withAbortSignal](../packages/chord/src/context/index.ts#L71)、[withCancel](../packages/chord/src/context/index.ts#L83)、[awaitWithContext](../packages/chord/src/context/index.ts#L98) |
| 构建与加载 | Facet bundle | 用 esbuild 生成内容寻址 artifact 与 manifest | [bundleFacets](../packages/chord/src/node/bundle.ts#L39) |
| 构建与加载 | Bundle loader | 校验 manifest/artifact，再创建可供 Host 消费的 FacetLoader | [readFacetBundleManifest](../packages/chord/src/node/bundle-loader.ts#L44)、[createFacetBundleLoader](../packages/chord/src/node/bundle-loader.ts#L134) |

### 2.1 功能结论：Chord 提供应用组合内核，不负责 LLM 或终端

公开 API 把应用拆成 facet。createFacetHost 激活 facet 集合，defineService 创建稳定服务标识，replicatedState 创建可发布变更的状态。远程服务绑定也在同一层，但它只约束 JSON 服务调用，不指定具体网络协议。

源码示例：

~~~ts
// 源码: packages/chord/src/api.ts:19-26
export async function createFacetHost(options: FacetOptions): Promise<FacetHost> {
	const kernel = new FacetKernel(options);
	await kernel.activate();
	return Object.freeze({
		services: kernel.provider,
		reload: (facets: readonly Facet[]) => kernel.reload(facets),
		dispose: () => kernel.dispose(),
	});
}

// 源码: packages/chord/src/api.ts:77-82
export function defineService(id: string, options?: { readonly local?: boolean }): Service<unknown> {
	if (id.length === 0) throw new TypeError("Service ID must not be empty");
	return Object.freeze({ id, local: options?.local ?? false });
}

// 源码: packages/chord/src/api.ts:88-90
export function replicatedState<T extends object>(initial: T): MutableReplicatedState<T> {
	return new MutableReplicatedStateImpl(initial);
}
~~~

证据：[createFacetHost](../packages/chord/src/api.ts#L19)、[defineService](../packages/chord/src/api.ts#L70)、[replicatedState](../packages/chord/src/api.ts#L88)、[RemoteServiceTransport 边界](../packages/chord/src/types.ts#L148)。

模块入口可以按以下方式阅读：

| 子模块 | 公开内容 | 代码证据 |
|---|---|---|
| 根入口 | facet、service、复制状态、远程 provider/binding | [src/index.ts](../packages/chord/src/index.ts#L1) |
| context | 显式传递值、取消信号、子 context | [src/context/index.ts](../packages/chord/src/context/index.ts#L3) |
| delta | 复制状态的操作编码/解码 | [src/delta/index.ts](../packages/chord/src/delta/index.ts#L1) |
| services | 调用、订阅、状态快照和 wire 转换 | [服务状态编码器](../packages/chord/src/services/state-codec.ts#L54) |
| bundler/node | facet 包构建与 Node 加载支持 | [bundler 入口](../packages/chord/src/bundler.ts#L1) |

### 2.2 依赖结论：Chord 没有内部 workspace 依赖；唯一生产依赖 esbuild 只服务于 bundler

Chord 的 dependencies 只有 esbuild。核心 service/facet API 都是包内实现；esbuild 在 node/bundle.ts 中用于把每个 facet entry 构建成独立内容寻址文件。

源码示例：

~~~json
"dependencies": {
	"esbuild": "0.28.1"
}
~~~

~~~ts
import { type BuildOptions, build, type Message } from "esbuild";

let result: Awaited<ReturnType<typeof build>>;
try {
	result = await build(buildOptions);
} catch (error) {
	// ...
}
~~~

证据：[Chord dependencies](../packages/chord/package.json#L65)、[esbuild 的实际调用](../packages/chord/src/node/bundle.ts#L4)。

## 3. @earendil-works/pi-telemetry

功能地图：

| 一级分类 | 二级分类 | 具体功能点 | 直接实现证据 |
|---|---|---|---|
| 遥测协议 | Context | 用 `startSpan` 建立父子 span 执行边界 | [TelemetryContext](../packages/telemetry/src/index.ts#L14) |
| 遥测协议 | Span 操作 | 添加事件、合并属性并设置成功/错误状态 | [TelemetrySpan](../packages/telemetry/src/index.ts#L18) |
| 类型化 Schema | Schema 声明 | 保存 span、start/end attributes、event 和 parent 约束 | [TelemetrySchemaDefinition](../packages/telemetry/src/index.ts#L66)、[defineTelemetrySchema](../packages/telemetry/src/index.ts#L72) |
| 类型化 Schema | 类型推导 | 从 schema 推导合法 span 名、开始/结束属性和事件属性 | [SchemaTelemetrySpan](../packages/telemetry/src/index.ts#L222)、[TypedSpanStarter](../packages/telemetry/src/index.ts#L318) |
| 类型化 Schema | 启动器 | 把一个 context 和多个 schema 绑定为编译期受约束的 span starter | [createTypedSpanStarter](../packages/telemetry/src/index.ts#L349) |
| 记录实现 | 内存记录 | 保存 span 层级、属性、事件、状态和完成时间，供测试或诊断读取 | [InMemoryTelemetryContext](../packages/telemetry/src/memory.ts#L192) |
| 记录实现 | 空实现 | 完整实现协议但丢弃所有数据，避免调用方到处判断 telemetry 是否启用 | [NOOP_TELEMETRY_CONTEXT](../packages/telemetry/src/noop.ts#L20) |

### 3.1 功能结论：Telemetry 定义最小追踪协议，并用类型系统绑定 schema

运行时核心只有 startSpan、addEvent、setAttributes、setStatus。defineTelemetrySchema 保存可序列化 schema；createTypedSpanStarter 把一个 TelemetryContext 与一个或多个 schema 的 span 名称和属性类型绑定。包内还提供 NOOP 和内存记录实现。

源码示例：

~~~ts
// 源码: packages/telemetry/src/index.ts:14-21
export interface TelemetryContext {
	startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T>;
}

export interface TelemetrySpan extends TelemetryContext {
	addEvent(name: string, attributes?: SpanAttributes): void;
	setAttributes(attributes: SpanAttributes): void;
	setStatus(status: SpanStatus): void;
}

// 源码: packages/telemetry/src/index.ts:72-74
export function defineTelemetrySchema<const T extends TelemetrySchemaDefinition>(schema: T): T {
	return schema;
}
~~~

证据：[TelemetryContext 与 TelemetrySpan](../packages/telemetry/src/index.ts#L14)、[defineTelemetrySchema](../packages/telemetry/src/index.ts#L72)、[createTypedSpanStarter](../packages/telemetry/src/index.ts#L349)、[内存实现](../packages/telemetry/src/memory.ts#L192)、[NOOP 实现](../packages/telemetry/src/noop.ts#L16)。

### 3.2 依赖结论：Telemetry 没有生产依赖，是 ai 和 agent-core 的底层契约

manifest 没有 dependencies 字段，只有开发依赖。pi-ai 在 ProviderRequestOptions 中接受 TelemetryContext；agent-core 则重导出 telemetry 类型并建立 Agent/Harness schema。

源码示例：

~~~ts
// packages/ai/src/types.ts
import type { TelemetryContext } from "@earendil-works/pi-telemetry";

export interface ProviderRequestOptions<TModel = Model<Api>> {
	signal?: AbortSignal;
	telemetryContext?: TelemetryContext;
	// ...
}
~~~

证据：[Telemetry manifest 无生产依赖](../packages/telemetry/package.json#L40)、[AI 使用 TelemetryContext](../packages/ai/src/types.ts#L1)、[Agent 重导出 telemetry](../packages/agent/src/index.ts#L2)。

## 4. @earendil-works/pi-ai

功能地图：

| 一级分类 | 二级分类 | 具体功能点 | 直接实现证据 |
|---|---|---|---|
| 模型目录 | Provider 契约 | 统一 provider id、认证、模型列表、原生 stream 和简化 stream | [Provider](../packages/ai/src/models.ts#L97) |
| 模型目录 | Models 聚合 | 按 provider/model 查询，刷新目录，解析认证并委派生成请求 | [Models](../packages/ai/src/models.ts#L156) |
| 模型目录 | 动态注册 | 创建可变模型集合并注册/移除 provider | [createModels](../packages/ai/src/models.ts#L748)、[createProvider](../packages/ai/src/models.ts#L775) |
| 模型目录 | 内置目录 | 从生成数据构造所有内置文本/图片 provider 与模型集合 | [builtinProviders](../packages/ai/src/providers/all.ts#L89)、[builtinModels](../packages/ai/src/providers/all.ts#L135) |
| 请求协议 | 上下文 | 向 provider 传递 system prompt、消息和 tool schema | [Context](../packages/ai/src/types.ts#L524) |
| 请求协议 | 事件流 | 将异步增量事件最终归并为完整 `AssistantMessage` | [EventStream](../packages/ai/src/utils/event-stream.ts#L4)、[AssistantMessageEventStream](../packages/ai/src/utils/event-stream.ts#L69) |
| 请求可靠性 | Provider 重试 | 根据错误分类、重试次数、延迟和 AbortSignal 重试请求 | [retryProviderRequest](../packages/ai/src/utils/provider-retry.ts#L105) |
| API 装载 | 懒加载 | 首次调用时加载 provider stream 实现并缓存，降低初始加载范围 | [lazyStream](../packages/ai/src/api/lazy.ts#L46)、[lazyApi](../packages/ai/src/api/lazy.ts#L73) |
| 认证 | Credential Store | 在内存中存取 API key/OAuth credential | [InMemoryCredentialStore](../packages/ai/src/auth/credential-store.ts#L9) |
| 认证 | 认证解析 | 合并调用覆盖、credential store 和 provider auth，返回实际请求认证 | [resolveProviderAuth](../packages/ai/src/auth/resolve.ts#L50) |
| 图片生成 | 图片模型目录 | 注册图片 provider，查询与刷新图片模型 | [ImagesModels](../packages/ai/src/images-models.ts#L49)、[createImagesModels](../packages/ai/src/images-models.ts#L227) |
| 图片生成 | API 注册表 | 按 images API 名注册并获取具体执行器 | [registerImagesApiProvider](../packages/ai/src/images-api-registry.ts#L38) |
| 会话资源 | 清理钩子 | 注册进程级清理器，并按 sessionId 释放 provider 资源 | [registerSessionResourceCleanup](../packages/ai/src/session-resources.ts#L5)、[cleanupSessionResources](../packages/ai/src/session-resources.ts#L12) |
| Provider 适配 | 多 API 转换 | 把统一 Context/Tool/消息转换为 Anthropic、OpenAI、Google、Bedrock 等请求与事件 | [Anthropic stream](../packages/ai/src/api/anthropic-messages.ts#L1)、[OpenAI Responses stream](../packages/ai/src/api/openai-responses.ts#L1)、[Google stream](../packages/ai/src/api/google-generative-ai.ts#L1)、[Bedrock stream](../packages/ai/src/api/bedrock-converse-stream.ts#L1) |

### 4.1 功能结论：pi-ai 是模型/provider/auth 与流式事件的统一边界

Provider 同时拥有身份、认证、模型列表和 stream 行为；Models 是 provider 集合，负责查找模型、刷新目录、解析认证并把请求委派给模型所属 provider。真正跨包传递的生成上下文只包含 systemPrompt、messages 和 tools，输出则是 AssistantMessageEvent 流。

源码示例：

~~~ts
// 源码: packages/ai/src/models.ts:97-110
export interface Provider<TApi extends Api = Api> {
	readonly id: string;
	readonly auth: ProviderAuth;
	getModels(): readonly Model<TApi>[];
	stream<T extends TApi>(
		model: Model<T>,
		context: Context,
		options?: ApiStreamOptions<T>,
	): AssistantMessageEventStream;
	streamSimple(model: Model<TApi>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
}

// 源码: packages/ai/src/types.ts:524-528
export interface Context {
	systemPrompt?: string;
	messages: Message[];
	tools?: Tool[];
}
~~~

证据：[Provider 接口](../packages/ai/src/models.ts#L97)、[Models 接口](../packages/ai/src/models.ts#L156)、[LLM Context](../packages/ai/src/types.ts#L524)、[流式事件协议](../packages/ai/src/types.ts#L546)、[Model 元数据](../packages/ai/src/types.ts#L843)。

模块关系：

| 子模块 | 作用 | 代码证据 |
|---|---|---|
| models.ts / models-store.ts | provider 注册、模型目录、刷新和缓存 | [createModels](../packages/ai/src/models.ts#L748) |
| auth | credential store、认证解析和交互 | [根入口导出](../packages/ai/src/index.ts#L17) |
| providers | 内置 provider 工厂和模型数据 | [builtinProviders](../packages/ai/src/providers/all.ts#L89)、[builtinModels](../packages/ai/src/providers/all.ts#L135) |
| api | Anthropic、OpenAI、Google、Bedrock 等 API 适配 | [lazyApi](../packages/ai/src/api/lazy.ts#L73)、[Anthropic 实现](../packages/ai/src/api/anthropic-messages.ts#L1)、[OpenAI 实现](../packages/ai/src/api/openai-responses.ts#L1) |
| utils/event-stream | AssistantMessageEventStream 的生产和消费 | [根入口导出](../packages/ai/src/index.ts#L38) |
| images | 图片模型与图片请求注册 | [createImagesModels](../packages/ai/src/images-models.ts#L227)、[图片 API registry](../packages/ai/src/images-api-registry.ts#L38) |
| compat | 旧的全局 API 兼容入口 | [compat 实现](../packages/ai/src/compat.ts#L1) |

### 4.2 依赖结论：pi-ai 对内只依赖 telemetry，对外依赖 provider SDK、schema 和流解析工具

内部依赖只有 pi-telemetry。Anthropic、AWS、Google、OpenAI 的 SDK 分别在对应 api 适配器中使用；typebox 定义工具/schema 类型；partial-json 用于解析尚未完整到达的 JSON；代理包和 Smithy handler 用在 Bedrock HTTP 配置。

源码示例：

~~~json
"dependencies": {
	"@anthropic-ai/sdk": "0.123.0",
	"@aws-sdk/client-bedrock-runtime": "3.1048.0",
	"@earendil-works/pi-telemetry": "^0.85.1",
	"@google/genai": "1.52.0",
	"@smithy/node-http-handler": "4.7.3",
	"http-proxy-agent": "7.0.2",
	"https-proxy-agent": "7.0.6",
	"openai": "6.40.0",
	"partial-json": "0.1.7",
	"typebox": "1.3.7"
}
~~~

证据：[AI dependencies](../packages/ai/package.json#L66)、[Anthropic 适配器](../packages/ai/src/api/anthropic-messages.ts#L1)、[OpenAI 适配器](../packages/ai/src/api/openai-responses.ts#L1)、[Google 适配器](../packages/ai/src/api/google-generative-ai.ts#L1)、[Bedrock 适配器和代理](../packages/ai/src/api/bedrock-converse-stream.ts#L1)、[partial-json](../packages/ai/src/utils/json-parse.ts#L1)、[typebox](../packages/ai/src/index.ts#L1)。

## 5. @earendil-works/pi-agent-core

功能地图：

| 一级分类 | 二级分类 | 具体功能点 | 直接实现证据 |
|---|---|---|---|
| 基础 Agent | 状态与控制 | 保存模型、system prompt、消息、工具、thinking 状态和运行状态 | [Agent](../packages/agent/src/agent.ts#L173) |
| 基础 Agent | 输入队列 | 正常 prompt、steering、follow-up 使用不同队列和接纳时机 | [steer/followUp](../packages/agent/src/agent.ts#L283)、[Agent.prompt](../packages/agent/src/agent.ts#L347) |
| 基础 Agent | 模型循环 | 启动新循环或从已有上下文继续，持续产出 AgentEvent | [agentLoop](../packages/agent/src/agent-loop.ts#L32)、[agentLoopContinue](../packages/agent/src/agent-loop.ts#L65) |
| 基础 Agent | 工具回合 | 收集 tool call、执行工具、追加 tool result，再决定下一轮模型调用 | [runAgentLoop](../packages/agent/src/agent-loop.ts#L96)、[工具批处理](../packages/agent/src/agent-loop.ts#L416) |
| Harness 运行时 | Harness 门面 | 管理 lane、operation admission、队列、watch、hook 和关闭 | [Harness](../packages/agent/src/harness/runtime/harness.ts#L29)、[createAgentHarness](../packages/agent/src/harness/runtime/harness.ts#L375) |
| Harness 运行时 | Operation 驱动 | 按 operation state 推进 generation、tools、retry、summary、navigation | [driveOperation](../packages/agent/src/harness/runtime/drive.ts#L29) |
| Harness 运行时 | 状态归约 | 从持久状态和事件计算 lane snapshot，并处理 rebase | [reduceLaneSnapshot](../packages/agent/src/harness/runtime/reducer.ts#L22) |
| 工具执行 | 调用流水线 | prepare → before-hook decision → execute → after-hook/finalize | [prepareToolCall](../packages/agent/src/harness/execution/tools.ts#L78)、[executeToolCall](../packages/agent/src/harness/execution/tools.ts#L125)、[finalizeToolCall](../packages/agent/src/harness/execution/tools.ts#L161) |
| 工具执行 | Effect Gate | 在副作用前阻塞；允许控制端继续或请求取消 | [createGate](../packages/agent/src/harness/execution/effect-gate.ts#L31) |
| 会话抽象 | 契约 | 定义 `Storage`、`Session`、`SessionRepo` 的读写、分支和生命周期边界 | [Storage](../packages/agent/src/harness/session/types.ts#L454)、[Session](../packages/agent/src/harness/session/types.ts#L529)、[SessionRepo](../packages/agent/src/harness/session/types.ts#L591) |
| 会话抽象 | Storage 会话 | 在 Storage 上实现 mutation、branch、值/list 和统计操作 | [StorageBackedSession](../packages/agent/src/harness/session/session.ts#L224) |
| 会话实现 | 内存后端 | 以内存状态实现 Storage 和 SessionRepo，支持快照分叉 | [MemoryStorage](../packages/agent/src/harness/session/memory.ts#L43)、[MemorySessionRepo](../packages/agent/src/harness/session/memory.ts#L344) |
| 会话实现 | JSONL 后端 | 以目录/JSONL 文件实现 SessionRepo 和 Storage | [JsonlSessionRepo](../packages/agent/src/harness/session/jsonl/repo.ts#L50)、[JsonlStorage](../packages/agent/src/harness/session/jsonl/storage.ts#L125) |
| 上下文压缩 | 触发与切点 | 计算 context token、判断阈值、寻找保留回合的切点 | [shouldCompact](../packages/agent/src/harness/compaction/compaction.ts#L246)、[findCutPoint](../packages/agent/src/harness/compaction/compaction.ts#L370) |
| 上下文压缩 | 摘要与提交 | 生成摘要、准备 compaction entry 并写入 session | [generateSummary](../packages/agent/src/harness/compaction/compaction.ts#L497)、[prepareCompaction](../packages/agent/src/harness/compaction/compaction.ts#L634)、[compact](../packages/agent/src/harness/compaction/compaction.ts#L727) |
| Prompt 资源 | 模板 | 扫描模板、解析参数、替换占位符并格式化调用 | [loadPromptTemplates](../packages/agent/src/harness/prompt-templates.ts#L31)、[substituteArgs](../packages/agent/src/harness/prompt-templates.ts#L252) |
| Prompt 资源 | Skill | 扫描 skill、验证元数据并格式化为 prompt block | [loadSkills](../packages/agent/src/harness/skills.ts#L51)、[formatSkillInvocation](../packages/agent/src/harness/skills.ts#L39) |
| 内建工具 | 文件与 Shell | 提供 read/write/edit/bash/image 工具工厂及共享 path/output 规则 | [tools 入口](../packages/agent/src/harness/tools/index.ts#L1) |

### 5.1 功能结论：agent-core 把模型流、消息状态、队列和工具执行组合成可复用 Agent

Agent 是有状态包装器，持有 transcript、stream function、工具策略以及 steering/follow-up 队列。agent-loop 每轮先调用模型，若 assistant 输出 toolCall，则执行工具，把 ToolResultMessage 追加回上下文，再决定是否继续。

源码示例：

~~~ts
// 源码: packages/agent/src/agent.ts:173-184, 347-356
export class Agent {
	private _state: MutableAgentState;
	private readonly steeringQueue: PendingMessageQueue;
	private readonly followUpQueue: PendingMessageQueue;
	public streamFunction: StreamFn;
	public toolExecution: ToolExecutionMode;

	async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
		if (this.activeRun) {
			throw new Error(
				"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
			);
		}
		const messages = this.normalizePromptInput(input, images);
		await this.runPromptMessages(messages);
	}
}
~~~

~~~ts
// 源码: packages/agent/src/agent-loop.ts:217-228
const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFunction);
const toolCalls = message.content.filter((c) => c.type === "toolCall");
if (toolCalls.length > 0) {
	const executedToolBatch =
		message.stopReason === "length"
			? await failToolCallsFromTruncatedMessage(toolCalls, emit)
			: await executeToolCalls(currentContext, message, config, signal, emit);
	for (const result of executedToolBatch.messages) {
		currentContext.messages.push(result);
	}
}
~~~

证据：[Agent 状态与职责](../packages/agent/src/agent.ts#L167)、[prompt 入口](../packages/agent/src/agent.ts#L347)、[模型与工具循环](../packages/agent/src/agent-loop.ts#L217)、[并行/串行工具选择](../packages/agent/src/agent-loop.ts#L416)。

agent-core 的根入口还导出 harness 的 context、session、compaction、prompt、skills 和 tools，所以它不仅包含基础 Agent 类，也包含可复用的应用运行框架。

证据：[agent-core 根导出](../packages/agent/src/index.ts#L41)。

### 5.2 依赖结论：agent-core 用 pi-ai 定义模型边界，用 telemetry 记录链路，用 Chord 提供 context/服务数据类型

agent.ts 和 agent-loop.ts 直接消费 pi-ai 的 Model、Message、Context 和流事件。harness/context.ts 使用 Chord Context 传播取消和值，同时把 TelemetryContext 放进 Agent 上下文。外部的 diff、ignore、yaml、typebox 分别服务于编辑差异、忽略规则、模板/skill 元数据和工具参数 schema。

源码示例：

~~~json
"dependencies": {
	"@earendil-works/chord": "^0.85.1",
	"@earendil-works/pi-ai": "^0.85.1",
	"@earendil-works/pi-telemetry": "^0.85.1",
	"diff": "8.0.4",
	"ignore": "7.0.5",
	"typebox": "1.3.7",
	"yaml": "2.9.0"
}
~~~

证据：[Agent dependencies](../packages/agent/package.json#L57)、[Agent 使用 pi-ai](../packages/agent/src/agent.ts#L1)、[Harness 使用 Chord 与 telemetry](../packages/agent/src/harness/context.ts#L1)、[diff](../packages/agent/src/harness/tools/edit-diff.ts#L5)、[ignore 与 yaml](../packages/agent/src/harness/skills.ts#L1)、[typebox 工具 schema](../packages/agent/src/harness/tools/read.ts#L1)。

## 6. @earendil-works/pi-session-backend-sqlite-node

功能地图：

| 一级分类 | 二级分类 | 具体功能点 | 直接实现证据 |
|---|---|---|---|
| SessionRepo | 创建/打开 | 创建独占数据库文件、应用 schema、写 session metadata；打开时校验版本 | [create](../packages/session-backends/sqlite-node/src/sqlite/repo.ts#L175)、[open](../packages/session-backends/sqlite-node/src/sqlite/repo.ts#L226) |
| SessionRepo | 查询/删除 | 列举 `.sqlite` 会话，读取 metadata；关闭后删除数据库及伴随文件 | [list](../packages/session-backends/sqlite-node/src/sqlite/repo.ts#L250)、[delete](../packages/session-backends/sqlite-node/src/sqlite/repo.ts#L287) |
| SessionRepo | 分叉 | 捕获源会话快照，复制目标范围的数据并建立 parentSessionId | [fork](../packages/session-backends/sqlite-node/src/sqlite/repo.ts#L312) |
| SessionRepo | 生命周期 | 跟踪打开的 storage/session，关闭时统一释放连接 | [close](../packages/session-backends/sqlite-node/src/sqlite/repo.ts#L378) |
| Storage | 事务提交 | 串行化 commit，验证 writes，并在一个 SQLite transaction 中写入 | [SqliteStorage.commit](../packages/session-backends/sqlite-node/src/sqlite/storage.ts#L67)、[applyCommit](../packages/session-backends/sqlite-node/src/sqlite/storage.ts#L163) |
| Storage | Entry | 写入、批量读取、扫描 entry，并恢复 `EntryStructure` | [EntryRowWriter](../packages/session-backends/sqlite-node/src/sqlite/session/entries.ts#L85)、[scanEntryRows](../packages/session-backends/sqlite-node/src/sqlite/session/entries.ts#L150) |
| Storage | Scalar/List Value | set/delete/get/scan 标量值，append/delete/read 列表值 | [setScalarValueRow](../packages/session-backends/sqlite-node/src/sqlite/session/values.ts#L25)、[readListValueRows](../packages/session-backends/sqlite-node/src/sqlite/session/values.ts#L137) |
| Storage | Usage/统计 | 追加 usage ledger，并同步 message/token/cost 聚合统计 | [UsageLedgerRowWriter](../packages/session-backends/sqlite-node/src/sqlite/session/usage-ledger.ts#L29)、[addUsageToSessionStats](../packages/session-backends/sqlite-node/src/sqlite/session/session-stats.ts#L42) |
| Session 门面 | 接口适配 | 将 SqliteStorage 包装成符合 agent-core `Session` 的对象 | [SqliteOpenSession](../packages/session-backends/sqlite-node/src/sqlite/session.ts#L24) |
| 数据库适配 | Node sqlite | 把 `DatabaseSync` 的 statement/transaction/close 适配为内部接口 | [wrapNodeSqliteDatabase](../packages/session-backends/sqlite-node/src/index.ts#L102)、[createNodeSqliteFactory](../packages/session-backends/sqlite-node/src/index.ts#L106) |
| Schema | 初始化迁移 | 读取并执行初始 SQL，设置 schema 版本 | [applyInitialSchema](../packages/session-backends/sqlite-node/src/sqlite/migrations.ts#L5)、[001_initial.sql](../packages/session-backends/sqlite-node/src/sqlite/migrations/001_initial.sql#L1) |

### 6.1 功能结论：该包把 agent-core 的 SessionRepo、Session 和 Storage 契约映射到 Node SQLite

SqliteSessionRepo 负责创建、打开、列举、分叉和删除会话；SqliteStorage 实现 entries、values、lists、usage 和 stats 的读写；顶层 index.ts 再把 node:sqlite 的 DatabaseSync 包装成包内抽象的 SqliteDatabaseFactory。

源码示例：

~~~ts
// 源码: packages/session-backends/sqlite-node/src/sqlite/repo.ts:157, 175-210
export class SqliteSessionRepo {
	// ...
	async create(options: SqliteSessionCreateOptions | undefined, _context: Context): Promise<SqliteOpenSession> {
		this.assertOpen();
		options ??= {};
		// ...
		const activeDb = await this.databaseFactory.open(path);
		configureWritableConnection(activeDb);
		await applyInitialSchema(activeDb);
		// ...
	}
}

// 源码: packages/session-backends/sqlite-node/src/sqlite/storage.ts:49, 67-74
export class SqliteStorage implements Storage {
	async commit(writes: Write[], _context: Context): Promise<CommitResult> {
		const result = this.commitQueue.then(() => this.applyCommit(writes));
		this.commitQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}
~~~

证据：[SqliteSessionRepo](../packages/session-backends/sqlite-node/src/sqlite/repo.ts#L157)、[create 实现](../packages/session-backends/sqlite-node/src/sqlite/repo.ts#L175)、[SqliteStorage](../packages/session-backends/sqlite-node/src/sqlite/storage.ts#L49)、[事务提交分类](../packages/session-backends/sqlite-node/src/sqlite/storage.ts#L163)、[Node DatabaseSync 适配](../packages/session-backends/sqlite-node/src/index.ts#L1)。

### 6.2 依赖结论：SQLite 后端依赖 agent-core 的契约和算法，pi-ai 只提供 UUID/Usage 类型

Storage、Entry、Session、ForkOptions、prepareStorageCommit 等都来自 agent-core；uuidv7 和 Usage 来自 pi-ai。数据库驱动直接使用 Node 内置 node:sqlite，因此 manifest 没有第三方 SQLite 包。

源码示例：

~~~ts
import type { Context, Entry, ForkOptions, SessionCreateOptions, StoredValue } from "@earendil-works/pi-agent-core";
import { branchTip, createForkSnapshot, StorageBackedSession } from "@earendil-works/pi-agent-core";
import { uuidv7 } from "@earendil-works/pi-ai";
~~~

~~~json
"dependencies": {
	"@earendil-works/pi-ai": "^0.85.1",
	"@earendil-works/pi-agent-core": "^0.85.1"
}
~~~

证据：[Repo 的内部包导入](../packages/session-backends/sqlite-node/src/sqlite/repo.ts#L3)、[Storage 实现 agent-core 接口](../packages/session-backends/sqlite-node/src/sqlite/storage.ts#L1)、[Usage 类型来源](../packages/session-backends/sqlite-node/src/sqlite/session/session-stats.ts#L1)、[Node SQLite 导入](../packages/session-backends/sqlite-node/src/index.ts#L1)、[manifest](../packages/session-backends/sqlite-node/package.json#L37)。

## 7. @earendil-works/pi-protocol

功能地图：

| 一级分类 | 二级分类 | 具体功能点 | 直接实现证据 |
|---|---|---|---|
| 协议模型 | 版本与身份 | 固定协议版本，验证 serverId 的格式 | [PROTOCOL_VERSION](../packages/protocol/src/protocol.ts#L5)、[isServerId](../packages/protocol/src/protocol.ts#L17) |
| 协议模型 | 客户端消息 | 定义 hello、request、cancel 三类消息及 session/server target | [RpcTarget](../packages/protocol/src/protocol.ts#L45)、[ClientMessageSchema](../packages/protocol/src/protocol.ts#L62) |
| 协议模型 | 服务端消息 | 定义 hello/error、response、service update、attachment 消息 | [ServerMessageSchema](../packages/protocol/src/protocol.ts#L98) |
| 运行时校验 | 入站解析 | 用 typebox `Check` 验证结构，再递归验证其中的 strict JsonValue | [parseClientMessage](../packages/protocol/src/codec.ts#L20)、[parseServerMessage](../packages/protocol/src/codec.ts#L27) |
| 消息编码 | 出站编码 | 先校验消息，再 CBOR 编码并加长度帧 | [encodeClientMessage](../packages/protocol/src/codec.ts#L56)、[encodeServerMessage](../packages/protocol/src/codec.ts#L61) |
| 增量解码 | 客户端入站 | 从任意 bytes chunk 恢复服务端消息，并保留未完成帧 | [ServerMessageDecoder](../packages/protocol/src/codec.ts#L123) |
| 增量解码 | 服务端入站 | 从任意 bytes chunk 恢复客户端消息 | [ClientMessageDecoder](../packages/protocol/src/codec.ts#L106) |
| Framing | 帧编码 | 写入 4 字节大端 payload 长度并限制最大帧 | [encodeFrame](../packages/protocol/src/framing.ts#L28)、[DEFAULT_MAX_FRAME_LENGTH](../packages/protocol/src/framing.ts#L6) |
| Framing | 帧解码 | 累积 header/payload，支持一个 chunk 多帧和跨 chunk 半帧 | [FrameDecoder](../packages/protocol/src/framing.ts#L44) |
| CBOR | 二进制序列化 | 将协议允许值编码/解码为 CBOR，并应用深度、长度等选项 | [encodeCbor](../packages/protocol/src/cbor/encoder.ts#L211)、[decodeCbor](../packages/protocol/src/cbor/decoder.ts#L161) |

### 7.1 功能结论：protocol 只定义和验证 wire 消息，不建立网络连接

协议层定义 hello、request、cancel、response、service_update 和 attachment 消息；codec 先验证 strict JSON/schema，再编码为 CBOR，最后加 4 字节大端长度头。增量 decoder 能从任意字节分块恢复完整消息。

源码示例：

~~~ts
// 源码: packages/protocol/src/protocol.ts:62, 98-104
export const ClientMessageSchema = Type.Union([
	ClientHelloSchema,
	RequestEnvelopeSchema,
	CancelEnvelopeSchema,
]);

export const ServerMessageSchema = Type.Union([
	ServerHelloSchema,
	ServerHelloErrorSchema,
	ResponseEnvelopeSchema,
	ServiceEventEnvelopeSchema,
	AttachmentEnvelopeSchema,
]);
~~~

~~~ts
// 源码: packages/protocol/src/codec.ts:56-58
export function encodeClientMessage(message: ClientMessage, options?: FrameDecoderOptions): Uint8Array {
	return encodeProtocolMessage(message, parseClientMessage, "client", options);
}
~~~

证据：[消息 schema](../packages/protocol/src/protocol.ts#L62)、[服务端消息 schema](../packages/protocol/src/protocol.ts#L98)、[验证、CBOR 与 framing 组合](../packages/protocol/src/codec.ts#L1)、[长度帧编码](../packages/protocol/src/framing.ts#L24)、[增量 FrameDecoder](../packages/protocol/src/framing.ts#L39)。

### 7.2 依赖结论：protocol 依赖 Chord 的 JsonValue 作为服务负载边界，依赖 typebox 做运行时 schema 检查

RequestEnvelope.call、ResponseEnvelope.result 和 ServiceEventEnvelope.update 都是 JsonValue。协议层复用 Chord 的 strict JSON 定义，并用 typebox/value 的 Check 验证消息。

源码示例：

~~~ts
import type { JsonValue } from "@earendil-works/chord";
import Type, { type Static } from "typebox";
import { Check } from "typebox/value";

const OpaqueJsonValueSchema = Type.Unsafe<JsonValue>(Type.Unknown());
~~~

证据：[protocol.ts 导入与 schema](../packages/protocol/src/protocol.ts#L1)、[codec 二次检查 JsonValue](../packages/protocol/src/codec.ts#L1)、[Protocol dependencies](../packages/protocol/package.json#L41)。

## 8. @earendil-works/pi-client

功能地图：

| 一级分类 | 二级分类 | 具体功能点 | 直接实现证据 |
|---|---|---|---|
| Transport | 字节接口 | 抽象 start/send/close 和 data/close/error handlers，不绑定 socket 类型 | [ByteTransport](../packages/client/src/transport.ts#L1)、[ByteTransportFactory](../packages/client/src/transport.ts#L18) |
| Connection | 握手 | 创建 transport、发送 ClientHello，只接受匹配版本/serverId 的首条 ServerHello | [Connection.connect](../packages/client/src/connection.ts#L67)、[握手消息处理](../packages/client/src/connection.ts#L163) |
| Connection | 生命周期 | 维护 disconnected/connecting/connected 状态，统一处理主动断开与 transport 错误 | [Connection](../packages/client/src/connection.ts#L41)、[disconnect](../packages/client/src/connection.ts#L93) |
| RPC | 请求匹配 | 生成 request id，把 resolve/reject/cleanup 放入 pending map，按 response id 完成 Promise | [Client.request](../packages/client/src/client.ts#L155)、[内部请求实现](../packages/client/src/client.ts#L238) |
| RPC | 取消 | AbortSignal 拒绝本地 Promise；消息已发送时追加 cancel envelope | [取消分支](../packages/client/src/client.ts#L252) |
| 服务订阅 | Snapshot 水合 | 先请求 subscription snapshot，在 snapshot 完成前缓存 wire updates | [subscribeService](../packages/client/src/client.ts#L172)、[update 排队](../packages/client/src/client.ts#L313) |
| 服务订阅 | 有序 Update | 激活后按 Promise tail 串行通知 listener，并将异常交给诊断回调 | [激活排队 update](../packages/client/src/client.ts#L216)、[#deliverServiceUpdate](../packages/client/src/client.ts#L417) |
| Attachment | 路由目标 | 接收服务端 attachment 更新，校验 serverId 后更新 session/attachment target | [attachment 处理](../packages/client/src/client.ts#L304) |
| Chord 适配 | Remote transport | 把 `Client.request/subscribeService` 适配为 Chord `RemoteServiceTransport` | [createClientServiceTransport](../packages/client/src/client.ts#L448) |
| Unix Transport | 服务发现 | 扫描路由目录、读取 route metadata 并返回可连接服务 | [discoverUnixServers](../packages/client/src/unix.ts#L37) |
| Unix Transport | Socket 工厂 | 连接 Unix socket/Windows named pipe，并实现 ByteTransport | [createUnixTransportFactory](../packages/client/src/unix.ts#L88) |

### 8.1 功能结论：client 管理握手、请求匹配、取消、attachment 和服务订阅

Connection 把可插拔 ByteTransportFactory 变成 connected 生命周期，并要求第一条服务端消息是匹配 serverId 的 hello。Client 用递增 request id 关联 Promise；AbortSignal 触发 cancel envelope；服务订阅先安装 snapshot，再按顺序投递 update。

源码示例：

~~~ts
// 源码: packages/client/src/connection.ts:67-81
connect(): Promise<ServerHello> {
	if (this.#lifecycle.state !== "disconnected") {
		return Promise.reject(new DisconnectedError(`Client is already ${this.#lifecycle.state}`));
	}
	const id = ++this.#sequence;
	const handshake = createPromiseResolvers<ServerHello>();
	this.#lifecycle = {
		state: "connecting",
		id,
		decoder: new ServerMessageDecoder({ maxFrameLength: this.#maxFrameLength }),
		handshake,
	};
	// ...
}
~~~

~~~ts
// 源码: packages/client/src/client.ts:247-248, 288-301
const id = `request-${++this.#requestSequence}`;
const { promise, resolve, reject } = createPromiseResolvers<T>();
// ...
let frame: Uint8Array;
try {
	frame = encodeClientMessage(
		{ type: "request", id, target, call: parseServiceCall(call) as unknown as JsonValue },
		{ maxFrameLength: this.#connection.maxFrameLength },
	);
} catch (error) {
	this.#takePendingRequest(id)?.reject(toError(error));
	return promise;
}
this.#connection.send(frame);
sent = true;
if (aborted) sendCancel();
return promise;
~~~

证据：[Connection.connect](../packages/client/src/connection.ts#L67)、[握手校验](../packages/client/src/connection.ts#L163)、[Client 请求入口](../packages/client/src/client.ts#L238)、[订阅 snapshot/update 顺序](../packages/client/src/client.ts#L168)、[ByteTransport 抽象](../packages/client/src/transport.ts#L1)。

### 8.2 依赖结论：client 用 protocol 处理 wire，用 Chord 处理服务语义

protocol 提供 envelope、编码器、解码器和目标类型；Chord 提供 ServiceCall、服务目录、订阅 snapshot/update 及 RemoteServiceTransport。createClientServiceTransport 是两层之间的明确适配点。

源码示例：

~~~ts
export function createClientServiceTransport(
	client: Client,
	getTarget: () => RpcTarget | undefined,
): RemoteServiceTransport {
	return {
		invoke: async (call, context) => client.request(target(), call, context.abortSignal),
		async subscribe(serviceId, mode, listener, context) {
			const subscription = await client.subscribeService(
				target(),
				serviceId,
				mode,
				(update) => listener(update, BACKGROUND_CONTEXT),
				context.abortSignal,
			);
			return {
				snapshot: subscription.snapshot,
				activate: () => subscription.start(),
				close: () => subscription.dispose(),
			};
		},
	};
}
~~~

证据：[Client 顶部同时导入 Chord 与 protocol](../packages/client/src/client.ts#L1)、[适配器](../packages/client/src/client.ts#L448)、[Client dependencies](../packages/client/package.json#L49)、[Unix transport 是单独子入口](../packages/client/package.json#L13)。

## 9. @earendil-works/pi-server

功能地图：

| 一级分类 | 二级分类 | 具体功能点 | 直接实现证据 |
|---|---|---|---|
| Listener | 接入抽象 | Listener 只负责 start/close，并把已授权 ByteConnection 交给 Server | [ServerListener](../packages/server/src/listener.ts#L4)、[ByteConnection](../packages/server/src/connection.ts#L1) |
| Server 生命周期 | 启停 | 启动 listener；关闭时停止接入、关闭连接并释放 SessionRouter | [Server.start](../packages/server/src/server.ts#L95)、[Server.close](../packages/server/src/server.ts#L176) |
| 连接状态 | 接纳 | 为每条连接创建 decoder、发送队列、AbortController 和请求表 | [Server.accept](../packages/server/src/server.ts#L136) |
| 协议入口 | 握手 | 要求首条消息是 hello，并校验 protocol version/serverId | [握手处理](../packages/server/src/server.ts#L262) |
| RPC 路由 | Server target | 将无 sessionId 的调用委派给 `serverServices.invokeService` | [请求路由](../packages/server/src/server.ts#L306) |
| RPC 路由 | Session target | 将带 sessionId/attachmentId 的调用委派给 SessionRouter | [请求路由](../packages/server/src/server.ts#L306) |
| RPC 生命周期 | 请求与取消 | 跟踪 request AbortController；cancel envelope 中止对应 context | [handleCancel](../packages/server/src/server.ts#L298)、[请求登记](../packages/server/src/server.ts#L328) |
| SessionRouter | 会话获取 | 通过 `resolveSession/openSession` 获取 HostedSession 并按客户端附件计数复用 | [SessionRouter](../packages/server/src/session-router.ts#L34)、[会话获取](../packages/server/src/session-router.ts#L252) |
| SessionRouter | Attachment 租约 | 为客户端分配 attachmentId，调用 handle.attachClient 并发布 attachment | [attachClientNow](../packages/server/src/session-router.ts#L160) |
| SessionRouter | 调用保护 | 同时核对 sessionId 和 attachmentId，拒绝过期 attachment | [requireAttachment](../packages/server/src/session-router.ts#L224) |
| SessionRouter | 排空释放 | 等待 attachment 上的操作 settled，再释放租约和会话 | [releaseAttachment](../packages/server/src/session-router.ts#L234) |
| Host 契约 | 应用注入点 | 应用实现 session metadata 解析、会话打开和服务 host | [ServerHost](../packages/server/src/types.ts#L59)、[RoutedSessionHandle](../packages/server/src/types.ts#L51) |
| Unix Server | 平台 transport | 建路由文件、监听 socket/pipe、包装 ByteConnection，并提供一键 preset | [createUnixListener](../packages/server/src/transports/unix/listener.ts#L388)、[createUnixServer](../packages/server/src/transports/unix/preset.ts#L8) |

### 9.1 功能结论：server 在字节连接与应用 SessionHost 之间完成握手和路由

ServerListener 只负责交付已经建立且授权的 ByteConnection。Server 为连接创建 ClientMessageDecoder，验证 hello/version/serverId，随后把 server 级调用交给 serverServices，把含 sessionId 的调用交给 SessionRouter。

源码示例：

~~~ts
// 源码: packages/server/src/listener.ts:4-7
export interface ServerListener {
	start(accept: ByteConnectionAcceptor): Promise<void>;
	close(): Promise<void>;
}

// 源码: packages/server/src/server.ts:306-312
if ("sessionId" in envelope.target) {
	result = await this.sessions.executeServiceCall(call, envelope.target, state, publish, context);
} else if (state.serverServices !== undefined) {
	result = await state.serverServices.invokeService(call, publish, context);
}
~~~

证据：[ServerListener](../packages/server/src/listener.ts#L4)、[Server.accept 创建连接状态](../packages/server/src/server.ts#L136)、[握手](../packages/server/src/server.ts#L262)、[请求路由](../packages/server/src/server.ts#L306)。

### 9.2 功能结论：SessionRouter 用 attachmentId 把“持久会话”与“当前客户端租约”分开

attachClientNow 先按 sessionId 获取/打开 HostedSession，再为当前 client 创建随机 attachmentId 和 RoutedSessionAttachment。后续调用必须同时匹配 sessionId 与 attachmentId；释放时先等待已接纳操作，再 release 租约。

源码示例：

~~~ts
// 源码: packages/server/src/session-router.ts:167-196
const attachment: ClientAttachment = {
	id: randomUUID(),
	client,
	session: hosted,
	operations: new Set(),
};
hosted.attachments.add(attachment);
try {
	const acquiring = Promise.resolve(hosted.handle.attachClient(context));
	attachment.acquiring = acquiring;
	attachment.lease = await acquiring;
} catch (error) {
	hosted.attachments.delete(attachment);
	throw error;
}
// ... closing-state checks are omitted here
this.attachmentsByClient.set(client, attachment);
await this.options.publishAttachment(
	client,
	{ serverId: this.options.serverId, sessionId, attachmentId: attachment.id },
	context,
);
~~~

证据：[建立 attachment](../packages/server/src/session-router.ts#L160)、[调用前校验 attachment](../packages/server/src/session-router.ts#L223)、[释放等待在途操作](../packages/server/src/session-router.ts#L234)、[SessionHost 契约](../packages/server/src/types.ts#L59)。

### 9.3 依赖结论：server 依赖 Chord 服务语义、protocol wire 和 agent-core Session 元数据/context

server 不直接依赖 pi-ai，也不创建 Agent。应用通过 ServerHost.resolveSession/openSession 注入实际 Session handle；server 只持有 agent-core 的 SessionMetadata/Context 类型。

源码示例：

~~~json
"dependencies": {
	"@earendil-works/chord": "^0.85.1",
	"@earendil-works/pi-agent-core": "^0.85.1",
	"@earendil-works/pi-protocol": "^0.85.1"
}
~~~

~~~ts
export interface ServerHost<TMetadata extends SessionMetadata = SessionMetadata> {
	readonly serverServices: RoutedServerServiceHost;
	resolveSession(sessionId: string, context: Context): Promise<TMetadata>;
	openSession(metadata: TMetadata, context: Context): Promise<RoutedSessionHandle>;
}
~~~

证据：[Server dependencies](../packages/server/package.json#L49)、[ServerHost](../packages/server/src/types.ts#L59)、[server.ts 导入边界](../packages/server/src/server.ts#L1)。

## 10. @earendil-works/pi-tui

功能地图：

| 一级分类 | 二级分类 | 具体功能点 | 直接实现证据 |
|---|---|---|---|
| 组件模型 | Component | 用 `render(width): string[]` 表示宽度约束下的终端输出，可选处理键鼠 | [Component](../packages/tui/src/tui.ts#L111) |
| 组件模型 | Container | 递归渲染子组件，同时建立鼠标命中所需的高度布局 | [Container](../packages/tui/src/tui.ts#L319) |
| TUI 运行时 | 基类 | 管理 terminal、焦点、overlay、输入 listener、渲染调度与停止 | [TuiBase](../packages/tui/src/tui.ts#L465) |
| TUI 运行时 | 渲染调度 | 合并重复 render 请求，并根据帧间隔决定立即或延迟渲染 | [requestRender](../packages/tui/src/tui.ts#L952) |
| 主屏渲染 | 差分更新 | 对比 previous/new lines，只重写变化区间；必要时 full render | [TuiMainScreen](../packages/tui/src/tui-main-screen.ts#L124)、[变化行比较](../packages/tui/src/tui-main-screen.ts#L362) |
| 全屏渲染 | Alternate screen | 使用终端 alternate screen 和 viewport，提供独立全屏 TUI | [TuiAltScreen](../packages/tui/src/tui-alt-screen.ts#L195) |
| 布局 | Frame/Box | 计算组件矩形、滚动条、点击位置和 ScrollView 命中关系 | [renderLayoutFrame](../packages/tui/src/layout.ts#L379)、[getLayoutBoxesAt](../packages/tui/src/layout.ts#L415) |
| 编辑器 | 文本编辑 | 支持换行、选区、光标、历史、kill ring 和 undo/redo | [Editor](../packages/tui/src/components/editor.ts#L284)、[UndoStack](../packages/tui/src/undo-stack.ts#L7)、[KillRing](../packages/tui/src/kill-ring.ts#L8) |
| 编辑器 | 自动补全 | 合并 slash command、文件路径等 provider 的建议 | [CombinedAutocompleteProvider](../packages/tui/src/autocomplete.ts#L278) |
| 输入 | Keybinding | 维护可配置 action→key 映射并检测冲突 | [KeybindingsManager](../packages/tui/src/keybindings.ts#L231) |
| 富文本 | Markdown | 解析 Markdown token，再按终端宽度和 theme 渲染 | [Markdown](../packages/tui/src/components/markdown.ts#L236) |
| 图片 | 协议探测与编码 | 探测 Kitty/iTerm2，计算图片 cell 尺寸并输出终端控制序列 | [detectCapabilities](../packages/tui/src/terminal-image.ts#L139)、[renderImage](../packages/tui/src/terminal-image.ts#L610) |
| Terminal | 进程适配 | 控制 raw mode、键盘协议、尺寸、stdin/stdout 和关闭恢复 | [ProcessTerminal](../packages/tui/src/terminal.ts#L137) |

### 10.1 功能结论：TUI 的基本单位是把宽度映射为终端行的 Component

Component 只要求 render(width) 和 invalidate，并可选处理键盘、鼠标。Container 递归渲染子组件；TuiBase 管理 terminal、focus、overlay、输入和渲染调度。

源码示例：

~~~ts
// 源码: packages/tui/src/tui.ts:111-121
export interface Component {
	render(width: number): string[];
	handleInput?(data: string): void;
	handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
	invalidate(): void;
}

// 源码: packages/tui/src/tui.ts:319-337
export class Container implements Component {
	children: Component[] = [];
	render(width: number): string[] {
		const lines: string[] = [];
		const mouseChildren: Array<{ component: Component; height: number }> = [];
		for (const child of this.children) {
			const childLines = child.render(width);
			mouseChildren.push({ component: child, height: childLines.length });
			for (const line of childLines) {
				lines.push(line);
			}
		}
		this.mouseLayout = { width, children: mouseChildren };
		return lines;
	}
}
~~~

证据：[Component](../packages/tui/src/tui.ts#L111)、[Container](../packages/tui/src/tui.ts#L319)、[公开组件清单](../packages/tui/src/index.ts#L11)。

### 10.2 功能结论：差分渲染由调度层和主屏比较层共同完成

requestRender 合并同一时段的请求并按最小帧间隔调度 doRender。TuiMainScreen.doRender 先渲染完整新行数组，再查找首尾变化行；终端宽高变化等特殊情况才执行 fullRender。

源码示例：

~~~ts
requestRender(force = false): void {
	if (force) {
		this.resetRenderState();
		this.requestImmediateRender();
		return;
	}
	if (this.renderRequested) return;
	this.renderRequested = true;
	process.nextTick(() => this.scheduleRender());
}
~~~

~~~ts
let firstChanged = -1;
let lastChanged = -1;
const maxLines = Math.max(newLines.length, this.previousLines.length);
for (let i = 0; i < maxLines; i++) {
	const oldLine = i < this.previousLines.length ? this.previousLines[i] : "";
	const newLine = i < newLines.length ? newLines[i] : "";
	if (oldLine !== newLine) {
		if (firstChanged === -1) firstChanged = i;
		lastChanged = i;
	}
}
~~~

证据：[渲染调度](../packages/tui/src/tui.ts#L952)、[doRender](../packages/tui/src/tui-main-screen.ts#L247)、[变化行比较](../packages/tui/src/tui-main-screen.ts#L362)。

### 10.3 依赖结论：TUI 无内部 workspace 依赖，外部运行时只负责 Markdown 和字符宽度

marked 被 Markdown 组件和根入口使用；get-east-asian-width 被 visibleWidth 等终端列宽工具使用。终端、布局、输入、图片协议和 native 加载均在包内。

源码示例：

~~~json
"dependencies": {
	"get-east-asian-width": "1.6.0",
	"marked": "18.0.5"
}
~~~

证据：[TUI dependencies](../packages/tui/package.json#L54)、[Markdown 使用 marked](../packages/tui/src/components/markdown.ts#L1)、[宽度计算依赖](../packages/tui/src/utils.ts#L1)、[根入口导出范围](../packages/tui/src/index.ts#L1)。

## 11. @earendil-works/pi-coding-agent

功能地图：

| 一级分类 | 二级分类 | 具体功能点 | 直接实现证据 |
|---|---|---|---|
| CLI | 参数解析 | 解析运行模式、模型、thinking、session、tool、extension 和输入文件参数 | [parseArgs](../packages/coding-agent/src/cli/args.ts#L71) |
| CLI | 启动编排 | 建立配置/认证/资源/会话服务，选择 RPC、interactive 或 print 模式 | [main](../packages/coding-agent/src/main.ts#L562)、[模式分发](../packages/coding-agent/src/main.ts#L930) |
| 装配层 | 一步创建 | 从 options 创建 ModelRuntime、SessionManager、ResourceLoader、Agent 和 AgentSession | [createAgentSession](../packages/coding-agent/src/core/sdk.ts#L173) |
| 装配层 | 可复用服务 | 将稳定的 model/settings/resource 服务与单次 session 创建拆开 | [createAgentSessionServices](../packages/coding-agent/src/core/agent-session-services.ts#L135)、[createAgentSessionFromServices](../packages/coding-agent/src/core/agent-session-services.ts#L202) |
| 装配层 | Runtime Host | 复用 services，负责 create/resume/import session 和生命周期释放 | [AgentSessionRuntime](../packages/coding-agent/src/core/agent-session-runtime.ts#L74)、[createAgentSessionRuntime](../packages/coding-agent/src/core/agent-session-runtime.ts#L422) |
| 会话编排 | Prompt 入口 | 展开模板/skill、运行扩展 hook、调用 Agent，并持久化生命周期事件 | [AgentSession.prompt](../packages/coding-agent/src/core/agent-session.ts#L1159) |
| 会话编排 | 模型控制 | 切换模型、循环 scoped model，并同步 session model-change entry | [setModel](../packages/coding-agent/src/core/agent-session.ts#L1658)、[cycleModel](../packages/coding-agent/src/core/agent-session.ts#L1700) |
| 会话编排 | 压缩与重载 | 主动压缩当前上下文；重载资源、扩展、prompt 和工具定义 | [compact](../packages/coding-agent/src/core/agent-session.ts#L1946)、[reload](../packages/coding-agent/src/core/agent-session.ts#L2818) |
| 会话持久化 | JSONL 树 | 定义 session header/entry，维护 parentId/leaf，并追加写 JSONL | [SessionManager](../packages/coding-agent/src/core/session-manager.ts#L864)、[_persist](../packages/coding-agent/src/core/session-manager.ts#L1037) |
| 会话上下文 | 上下文恢复 | 沿当前分支选取 entries，处理 compaction/branch summary，构造消息列表 | [buildContextEntries](../packages/coding-agent/src/core/session-manager.ts#L426)、[buildSessionContext](../packages/coding-agent/src/core/session-manager.ts#L469) |
| 会话导出 | JSONL/HTML | 导出筛选后的 session JSONL；将 transcript 和工具结果渲染为 HTML | [exportSessionToJsonl](../packages/coding-agent/src/core/session-export.ts#L7)、[exportSessionToHtml](../packages/coding-agent/src/core/export-html/index.ts#L236) |
| 模型层 | ModelRuntime | 在 pi-ai Models 外增加 provider 组合、runtime credential、header 和网络设置 | [ModelRuntime](../packages/coding-agent/src/core/model-runtime.ts#L130) |
| 模型层 | 请求准备 | 解析认证与 provider，将 stream/streamSimple 委派给最终 provider | [ModelRuntime.stream](../packages/coding-agent/src/core/model-runtime.ts#L610)、[streamSimple](../packages/coding-agent/src/core/model-runtime.ts#L636) |
| 模型层 | 目录刷新 | 重读 model config、重建 provider，再刷新模型目录 | [ModelRuntime.refresh](../packages/coding-agent/src/core/model-runtime.ts#L698) |
| 模型层 | Registry 门面 | 提供 refresh/find/getAvailable 等供 UI 和 CLI 查询 | [ModelRegistry](../packages/coding-agent/src/core/model-registry.ts#L32)、[find](../packages/coding-agent/src/core/model-registry.ts#L56) |
| Prompt 资源 | System prompt | 按工具、工作目录、项目 context、skills 和追加 prompt 组装最终系统提示 | [buildSystemPrompt](../packages/coding-agent/src/core/system-prompt.ts#L35) |
| Prompt 资源 | 项目上下文 | 从 cwd 向上加载项目 instruction/context 文件 | [loadProjectContextFiles](../packages/coding-agent/src/core/resource-loader.ts#L119) |
| Prompt 资源 | ResourceLoader | 汇总 extensions、skills、templates、themes 和 context，并支持 reload | [DefaultResourceLoader](../packages/coding-agent/src/core/resource-loader.ts#L196)、[reload](../packages/coding-agent/src/core/resource-loader.ts#L388) |
| Prompt 资源 | Skills | 扫描目录、验证 frontmatter、处理重名诊断并格式化给模型 | [loadSkillsFromDir](../packages/coding-agent/src/core/skills.ts#L168)、[formatSkillsForPrompt](../packages/coding-agent/src/core/skills.ts#L355) |
| Prompt 资源 | Prompt templates | 解析命令参数和占位符，扫描模板并展开 `/template` | [loadPromptTemplates](../packages/coding-agent/src/core/prompt-templates.ts#L194)、[expandPromptTemplate](../packages/coding-agent/src/core/prompt-templates.ts#L269) |
| Tool 系统 | Definition registry | 统一创建 read/bash/powershell/edit/write/grep/find/ls 的 definition 与实例 | [createToolDefinition](../packages/coding-agent/src/core/tools/index.ts#L118)、[createAllToolDefinitions](../packages/coding-agent/src/core/tools/index.ts#L188) |
| Tool 系统 | 文件工具 | 对 read/write/edit 注入文件操作后端、schema、输出截断和变更队列 | [createReadToolDefinition](../packages/coding-agent/src/core/tools/read.ts#L64)、[createWriteToolDefinition](../packages/coding-agent/src/core/tools/write.ts#L44)、[createEditToolDefinition](../packages/coding-agent/src/core/tools/edit.ts#L143) |
| Tool 系统 | Shell 工具 | 解析 shell 配置，运行进程，流式累计输出并生成结构化 tool result | [createLocalShellOperations](../packages/coding-agent/src/core/tools/bash.ts#L79)、[createShellToolDefinition](../packages/coding-agent/src/core/tools/bash.ts#L222) |
| Extension | 加载 | 使用运行时 API 加载 factory/file/package 扩展，缓存并报告诊断 | [loadExtensionFromFactory](../packages/coding-agent/src/core/extensions/loader.ts#L592)、[discoverAndLoadExtensions](../packages/coding-agent/src/core/extensions/loader.ts#L756) |
| Extension | 事件与 Hook | 注册 tool/command/provider/UI hook，并串行派发 session/tool/provider 事件 | [ExtensionRunner](../packages/coding-agent/src/core/extensions/runner.ts#L269) |
| 配置 | Settings | 合并 global/project 设置，支持文件和内存 storage 及 reload | [SettingsManager](../packages/coding-agent/src/core/settings-manager.ts#L299)、[SettingsManager.reload](../packages/coding-agent/src/core/settings-manager.ts#L522) |
| 包与资源 | Package manager | 解析本地/npm/git source，安装、移除、更新扩展/skill/template/theme | [DefaultPackageManager](../packages/coding-agent/src/core/package-manager.ts#L806)、[resolve](../packages/coding-agent/src/core/package-manager.ts#L912)、[install](../packages/coding-agent/src/core/package-manager.ts#L1005) |
| 运行模式 | Interactive | 创建 TUI，处理输入、overlay、session/model/settings 选择和事件渲染 | [InteractiveMode](../packages/coding-agent/src/modes/interactive/interactive-mode.ts#L375)、[run](../packages/coding-agent/src/modes/interactive/interactive-mode.ts#L1034) |
| 运行模式 | Print/RPC | Print 返回文本/JSON 结果；RPC 通过 stdin/stdout JSONL 提供控制接口 | [runPrintMode](../packages/coding-agent/src/modes/print-mode.ts#L33)、[runRpcMode](../packages/coding-agent/src/modes/rpc/rpc-mode.ts#L54) |
| TUI 选择 | Regular/Fullscreen | 根据配置创建 `TuiMainScreen` 或 `TuiAltScreen` | [createInteractiveTui](../packages/coding-agent/src/modes/interactive/tui-renderer.ts#L18) |
| 实验远程链 | Client runtime | 连接 pi-server，绑定远程服务并激活内建客户端服务 | [openClientRuntime](../packages/coding-agent/src/experimental/client-runtime.ts#L53)、[activateBuiltinClientServices](../packages/coding-agent/src/experimental/client-runtime.ts#L186) |
| 实验远程链 | Server services | 将 coding-agent session/model/controller 能力发布为 Chord services | [createExperimentalServerServices](../packages/coding-agent/src/experimental/services/server.ts#L25) |

### 11.1 功能结论：coding-agent 是产品装配层，CLI 和 SDK 最终都创建 AgentSession

main.ts 负责参数、配置、认证、会话选择和运行模式选择；core/sdk.ts 负责装配 ModelRuntime、SessionManager、SettingsManager、ResourceLoader、Agent 和 AgentSession。模式层再选择 interactive、RPC 或 print。

源码示例：

~~~ts
// 源码: packages/coding-agent/src/core/sdk.ts:306-372, 388-402
agent = new Agent({
	initialState: {
		systemPrompt: "",
		model,
		thinkingLevel,
		tools: [],
	},
	convertToLlm: convertToLlmWithBlockImages,
	streamFn: async (model, context, options) => {
		// ...
		return modelRuntime.streamSimple(model, context, {
			...options,
			timeoutMs,
			websocketConnectTimeoutMs,
			// ...
		});
	},
	// ...
});

const session = new AgentSession({
	agent,
	sessionManager,
	settingsManager,
	cwd,
	resourceLoader,
	modelRuntime,
	// ...
});
~~~

证据：[SDK 创建入口](../packages/coding-agent/src/core/sdk.ts#L173)、[创建 Agent](../packages/coding-agent/src/core/sdk.ts#L306)、[创建 AgentSession](../packages/coding-agent/src/core/sdk.ts#L388)。

~~~ts
// 源码: packages/coding-agent/src/main.ts:930-970
if (appMode === "rpc") {
	printTimings();
	await runRpcMode(runtime);
} else if (appMode === "interactive") {
	const interactiveMode = new InteractiveMode(runtime, {
		// ...
	});
	// ...
	await interactiveMode.run();
} else {
	const exitCode = await runPrintMode(runtime, {
		// ...
	});
}
~~~

证据：[CLI main](../packages/coding-agent/src/main.ts#L562)、[运行模式分发](../packages/coding-agent/src/main.ts#L930)。

主要目录：

| 目录 | 职责 | 入口证据 |
|---|---|---|
| cli | 参数、auth、文件输入、会话选择、启动 UI | [main.ts imports](../packages/coding-agent/src/main.ts#L12) |
| core | AgentSession、session、compaction、prompt、tools、extensions、settings、models | [公共 index](../packages/coding-agent/src/index.ts#L1) |
| modes | interactive、RPC、print/json 输出 | [modes/index.ts](../packages/coding-agent/src/modes/index.ts#L1) |
| extensions | 内建扩展 | [main.ts builtInExtensions](../packages/coding-agent/src/main.ts#L64) |
| utils | shell、图片、语法高亮、路径等平台工具 | [公共 index 的 utils 导出](../packages/coding-agent/src/index.ts#L414) |
| experimental | 远程 client/server、facet plugin 和 mini worker | [experimental client runtime](../packages/coding-agent/src/experimental/client-runtime.ts#L1) |
| bun | Bun 二进制运行时差异适配 | [Bun runtime setup](../packages/coding-agent/src/bun/runtime-setup.ts#L1) |

### 11.2 依赖结论：四个生产期内部依赖分别承担组合、Agent、模型和 UI

agent-core 提供 Agent/AgentMessage；pi-ai 提供模型和 stream；pi-tui 提供交互终端；Chord 主要用于 experimental facet/plugin 与远程服务组合。package.json 中的 client、protocol、server 是 devDependencies，与 files 中排除 experimental/client 相互对应。

源码示例：

~~~json
"dependencies": {
	"@earendil-works/chord": "^0.85.1",
	"@earendil-works/pi-agent-core": "^0.85.1",
	"@earendil-works/pi-ai": "^0.85.1",
	"@earendil-works/pi-tui": "^0.85.1"
},
"devDependencies": {
	"@earendil-works/pi-client": "^0.85.1",
	"@earendil-works/pi-protocol": "^0.85.1",
	"@earendil-works/pi-server": "^0.85.1"
}
~~~

证据：[生产依赖](../packages/coding-agent/package.json#L51)、[开发期内部依赖](../packages/coding-agent/package.json#L79)、[发布文件排除 client/experimental](../packages/coding-agent/package.json#L29)、[SDK 使用 agent 与 ai](../packages/coding-agent/src/core/sdk.ts#L1)、[交互模式使用 TUI](../packages/coding-agent/src/modes/interactive/interactive-mode.ts#L10)、[experimental 使用 Chord/client/protocol](../packages/coding-agent/src/experimental/client-runtime.ts#L1)。

### 11.3 依赖结论：coding-agent 的第三方依赖按功能分成六组

它们不是 Agent 核心循环的同一层依赖：

| 组 | 依赖 | 直接用途证据 |
|---|---|---|
| 终端展示 | chalk、highlight.js、grok-mermaid、diff | [main 使用 chalk](../packages/coding-agent/src/main.ts#L11)、[语法高亮](../packages/coding-agent/src/utils/syntax-highlight.ts#L1)、[Mermaid 组件](../packages/coding-agent/src/modes/interactive/components/mermaid.ts#L1)、[diff 组件](../packages/coding-agent/src/modes/interactive/components/diff.ts#L1) |
| 扩展加载 | jiti、typebox | [extension loader](../packages/coding-agent/src/core/extensions/loader.ts#L17)、[工具/扩展 schema](../packages/coding-agent/src/core/extensions/types.ts#L47) |
| 文件与包匹配 | ignore、minimatch、hosted-git-info、semver、yaml | [package manager imports](../packages/coding-agent/src/core/package-manager.ts#L37)、[git 元数据](../packages/coding-agent/src/utils/git.ts#L1)、[frontmatter YAML 解析](../packages/coding-agent/src/utils/frontmatter.ts#L1) |
| 并发写保护 | proper-lockfile | [settings lock](../packages/coding-agent/src/core/settings-manager.ts#L7) |
| 进程和网络 | cross-spawn、undici | [child process](../packages/coding-agent/src/utils/child-process.ts#L14)、[HTTP dispatcher](../packages/coding-agent/src/core/http-dispatcher.ts#L2) |
| 图片 | @silvia-odwyer/photon-node | [Photon 适配](../packages/coding-agent/src/utils/photon.ts#L25) |

源码示例：

~~~json
"@silvia-odwyer/photon-node": "0.3.4",
"chalk": "5.6.2",
"cross-spawn": "7.0.6",
"diff": "8.0.4",
"grok-mermaid": "0.2.2",
"highlight.js": "10.7.3",
"hosted-git-info": "9.0.3",
"ignore": "7.0.5",
"jiti": "2.7.0",
"minimatch": "10.2.5",
"proper-lockfile": "4.1.2",
"semver": "7.8.0",
"typebox": "1.3.7",
"undici": "8.9.0",
"yaml": "2.9.0"
~~~

证据：[完整第三方 dependencies](../packages/coding-agent/package.json#L56)。

## 12. @earendil-works/pi-evals

功能地图：

| 一级分类 | 二级分类 | 具体功能点 | 直接实现证据 |
|---|---|---|---|
| 评估 Harness | 模型选择 | 把环境或 options 中的 provider/model 配置解析成确定选择 | [resolveModelSelection](../packages/evals/src/pi-harness.ts#L46) |
| 评估 Harness | 隔离运行 | 为每次样本创建临时 workspace/agent/session，装配真实 AgentSession | [runPiCodingAgent](../packages/evals/src/pi-harness.ts#L109) |
| 评估 Harness | 输入驱动 | 依次执行 prompt/reload 输入，处理中止，并返回最终 assistant 文本或变换结果 | [runPiCodingAgent 输入循环](../packages/evals/src/pi-harness.ts#L159)、[结果与 usage](../packages/evals/src/pi-harness.ts#L179) |
| 评估 Harness | 工厂 | 把 coding-agent 执行器包装成 vitest-evals `Harness` | [createPiCodingAgentHarness](../packages/evals/src/pi-harness.ts#L246) |
| 产物 | Session 快照 | 将会话 JSONL、runId、token/cost/timing 等记录为测试 attachment | [recordEvalSessionArtifact](../packages/evals/src/vitest-evals/artifacts.ts#L51) |
| 产物 | 源码引用 | 将评估涉及的源文件作为 attachment 保存，并持久化引用索引 | [recordEvalSourceArtifact](../packages/evals/src/vitest-evals/artifacts.ts#L75)、[persistEvalArtifactReferences](../packages/evals/src/vitest-evals/artifacts.ts#L87) |
| 数据集执行 | Harness table | 将输入、重复次数、baseline/candidate 组合展开为成对评估用例 | [evalHarnessTable](../packages/evals/src/vitest-evals/harness-table.ts#L157) |
| 统计 | 对比汇总 | 按 harness pair 汇总正确率、耗时、token、cost 和 correctness lift | [summarizeHarnessComparisons](../packages/evals/src/vitest-evals/summary.ts#L300) |
| 报告 | 文本格式化 | 把比较结果转成可读报告 | [formatHarnessComparisonReport](../packages/evals/src/vitest-evals/summary.ts#L374) |
| Reporter | Vitest 集成 | 每个 case 追加运行报告；run 结束时收集 observations 并打印比较结果 | [EvalHarnessReporter](../packages/evals/src/vitest-evals/reporter.ts#L87) |

### 12.1 功能结论：evals 是私有评估包，不是被产品运行时引用的库

package.json 标记 private，只有 eval/test 脚本和 devDependencies。pi-harness 创建隔离的 coding-agent services/session，把消息转换成 transcript events，并记录 token、cost、耗时和 session JSONL 产物。

源码示例：

~~~ts
// 源码: packages/evals/src/pi-harness.ts:131-151
const services = await createAgentSessionServices({
	cwd,
	agentDir,
	modelRuntime,
	settingsManager: SettingsManager.inMemory(),
});

session = (
	await createAgentSessionFromServices({
		services,
		sessionManager,
		model,
		thinkingLevel: "off",
		noTools: options.noTools,
	})
).session;
~~~

证据：[Evals private manifest](../packages/evals/package.json#L2)、[runPiCodingAgent](../packages/evals/src/pi-harness.ts#L109)、[构建评估会话](../packages/evals/src/pi-harness.ts#L132)、[记录 session artifact](../packages/evals/src/vitest-evals/artifacts.ts#L44)、[汇总基线/候选指标](../packages/evals/src/vitest-evals/summary.ts#L224)。

### 12.2 依赖结论：evals 的内部依赖全部是开发期依赖

它从 pi-ai 读取消息文本，从 pi-coding-agent 获取 ModelRuntime、SessionManager、SettingsManager 和会话工厂；vitest-evals 提供 harness/judge，Vitest 提供执行与报告接口。

源码示例：

~~~json
"devDependencies": {
	"@earendil-works/pi-ai": "^0.85.1",
	"@earendil-works/pi-coding-agent": "^0.85.1",
	"vitest-evals": "0.15.0",
	"vitest": "4.1.9"
}
~~~

证据：[Evals devDependencies](../packages/evals/package.json#L11)、[pi-harness 导入](../packages/evals/src/pi-harness.ts#L6)、[评估 smoke 定义](../packages/evals/src/smoke.eval.ts#L1)、[自定义 reporter](../packages/evals/src/vitest-evals/reporter.ts#L1)。

## 13. 跨包执行路径

### 13.1 结论：本地 pi 请求的主路径是 coding-agent → agent-core → pi-ai

coding-agent SDK 创建 Agent，并把 ModelRuntime.streamSimple 注入 Agent.streamFn。agent-loop 在唯一模型调用边界把 AgentMessage 转为 pi-ai Context，然后调用该 streamFn。因此 agent-core 不需要知道具体 provider SDK，coding-agent 也不直接实现每轮 tool loop。

源码示例：

~~~ts
// coding-agent
agent = new Agent({
	streamFn: async (model, context, options) => {
		// ...
		return modelRuntime.streamSimple(model, context, {
			...options,
			timeoutMs,
			websocketConnectTimeoutMs,
			maxRetries: options?.maxRetries ?? providerRetrySettings.maxRetries,
			// ...
		});
	},
	// ...
});

// agent-core
const llmContext: Context = {
	systemPrompt: context.systemPrompt,
	messages: llmMessages,
	tools: context.tools,
};
const response = await streamFunction(config.model, llmContext, {
	...config,
	apiKey: resolvedApiKey,
	signal,
});
~~~

证据：[streamFn 注入](../packages/coding-agent/src/core/sdk.ts#L306)、[agent-loop 模型边界](../packages/agent/src/agent-loop.ts#L281)、[Models 委派职责](../packages/ai/src/models.ts#L151)。

~~~mermaid
sequenceDiagram
    participant CLI as coding-agent main/mode
    participant Session as coding-agent AgentSession
    participant Agent as agent-core Agent
    participant Loop as agent-core agent-loop
    participant Models as pi-ai ModelRuntime/Models
    participant Provider as pi-ai Provider
    participant TUI as pi-tui

    CLI->>Session: prompt
    Session->>Agent: prompt
    Agent->>Loop: runAgentLoop
    Loop->>Models: streamFunction(model, Context)
    Models->>Provider: streamSimple
    Provider-->>Loop: AssistantMessageEvent stream
    Loop-->>Agent: message/tool events
    Agent-->>Session: lifecycle events
    Session-->>TUI: render updates
~~~

### 13.2 结论：远程调用路径中，protocol 只搬运消息，Chord 决定服务调用语义

client 把 Chord ServiceCall 编成 protocol request；server 解码后按 RpcTarget 分给 server service 或 SessionRouter；服务订阅 snapshot/update 在两端分别通过 Chord state encoder/decoder 转换。

源码示例：

~~~ts
// client
frame = encodeClientMessage({
	type: "request",
	id,
	target,
	call: parseServiceCall(call) as unknown as JsonValue,
}, { maxFrameLength: this.#connection.maxFrameLength });

// server
call = parseServiceCall(envelope.call);
if ("sessionId" in envelope.target) {
	result = await this.sessions.executeServiceCall(call, envelope.target, state, publish, context);
}
~~~

证据：[Client 编码请求](../packages/client/src/client.ts#L238)、[Server 解析并路由](../packages/server/src/server.ts#L306)、[Chord ServiceCall](../packages/chord/src/types.ts#L130)、[Protocol RequestEnvelope](../packages/protocol/src/protocol.ts#L45)。

~~~mermaid
sequenceDiagram
    participant App as coding-agent experimental/UI
    participant Client as pi-client
    participant Protocol as pi-protocol
    participant Server as pi-server
    participant Router as SessionRouter
    participant Host as Routed Session Host

    App->>Client: Chord ServiceCall
    Client->>Protocol: encodeClientMessage
    Protocol-->>Server: framed CBOR bytes
    Server->>Server: decode + validate
    Server->>Router: executeServiceCall
    Router->>Host: attachment.invokeService
    Host-->>Router: result/update
    Router-->>Server: JsonValue
    Server->>Protocol: encodeServerMessage
    Protocol-->>Client: response/service_update
    Client-->>App: result or ordered update
~~~

### 13.3 结论：SQLite 后端是可替换持久化实现，不在默认 coding-agent JSONL 主路径中硬编码

agent-core 公开 Storage/Session 抽象和默认 JSONL/内存实现；SQLite 包单独实现同一 Storage 接口。coding-agent 的传统 SessionManager 使用自己的 JSONL 文件，因此 SQLite 是另一条可组合后端链，而不是 coding-agent SessionManager 的内部模块。

源码示例：

~~~ts
// agent-core package
export {
	JSONL_STORAGE_VERSION,
	type JsonlSessionCreateOptions,
	type JsonlSessionListOptions,
	type JsonlSessionMetadata,
	JsonlSessionRepo,
	type JsonlSessionRepoOptions,
} from "./jsonl/index.ts";

// SQLite package
export class SqliteStorage implements Storage {
	// ...
}

// coding-agent package
export class SessionManager {
	// ...
	newSession(options?: NewSessionOptions): string | undefined {
		// ...
		if (this.persist) {
			const fileTimestamp = timestamp.replace(/[:.]/g, "-");
			this.sessionFile = join(this.getSessionDir(), `${fileTimestamp}_${this.sessionId}.jsonl`);
		}
		return this.sessionFile;
	}

	_persist(entry: SessionEntry): void {
		if (!this.persist || !this.sessionFile) return;
		// ...
		if (!this.flushed) {
			// ... write all fileEntries and set this.flushed = true
		} else {
			appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`);
		}
	}
}
~~~

证据：[agent-core 导出 JsonlSessionRepo](../packages/agent/src/harness/session/index.ts#L13)、[SqliteStorage 实现 Storage](../packages/session-backends/sqlite-node/src/sqlite/storage.ts#L49)、[coding-agent SessionManager 的 JSONL 说明与建档](../packages/coding-agent/src/core/session-manager.ts#L853)、[coding-agent SessionManager 的追加写入](../packages/coding-agent/src/core/session-manager.ts#L1037)。

## 14. 构建顺序与依赖方向

### 14.1 结论：根构建脚本的顺序与依赖图一致，但它不是新增依赖的定义来源

脚本先构建无内部依赖的 chord、tui、telemetry，再构建 ai、agent、SQLite、protocol、client、server，最后构建装配层 coding-agent。真正决定 npm 关系的仍是各包 dependencies/devDependencies；build 字符串只是仓库选择的串行构建顺序。

源码示例：

~~~json
"build": "cd packages/chord && npm run build && cd ../tui && npm run build && cd ../telemetry && npm run build && cd ../ai && npm run build && cd ../agent && npm run build && cd ../session-backends/sqlite-node && npm run build && cd ../../protocol && npm run build && cd ../client && npm run build && cd ../server && npm run build && cd ../coding-agent && npm run build"
~~~

证据：[根 build 顺序](../package.json#L16)、[各包依赖关系起点](../packages/coding-agent/package.json#L51)。

建议静态阅读顺序由下到上：

1. chord/types.ts、telemetry/index.ts、ai/types.ts：先掌握公共数据边界。
2. ai/models.ts、agent/agent-loop.ts、agent/agent.ts：再看模型委派与 Agent 循环。
3. coding-agent/core/sdk.ts、agent-session.ts、main.ts：最后看产品装配。
4. protocol → client/server：单独学习远程会话链。
5. agent harness session → sqlite-node：单独学习可替换持久化链。

对应证据：[Chord 类型入口](../packages/chord/src/types.ts#L1)、[Telemetry 类型入口](../packages/telemetry/src/index.ts#L1)、[AI 类型入口](../packages/ai/src/types.ts#L1)、[Agent loop](../packages/agent/src/agent-loop.ts#L28)、[SDK 装配](../packages/coding-agent/src/core/sdk.ts#L173)、[Protocol 入口](../packages/protocol/src/index.ts#L1)、[SQLite 入口](../packages/session-backends/sqlite-node/src/index.ts#L1)。

## 15. 嵌套示例、文档实验与安装锁定包

### 15.1 结论：packages 下另外 8 个 package.json 不属于上述 11 个主体实现包

其中 5 个 coding-agent extension 目录由根 workspaces 显式纳入，作用是演示或验证可带自身依赖的扩展；example-plugin 是 Chord facet 示例；agent/docs 下的 isolated-vm 包是设计文档实验；install-lock 是安装器锁文件根，不提供源码 API。

源码示例：

~~~json
// extension package
"private": true,
"pi": {
	"extensions": ["./index.ts"]
}

// install-lock package
"private": true,
"description": "Lockfile root used by the Pi installer and updater.",
"dependencies": {
	"@earendil-works/pi-coding-agent": "0.85.1"
}
~~~

证据：[with-deps 扩展声明](../packages/coding-agent/examples/extensions/with-deps/package.json#L2)、[install-lock](../packages/coding-agent/install-lock/package.json#L2)。

| 嵌套包 | 功能 | 自身 manifest 依赖 | 源码证据 |
|---|---|---|---|
| facet-sandbox-ivm | isolated-vm facet membrane、逃逸审计和 benchmark 的文档实验 | isolated-vm | [manifest](../packages/agent/docs/mobile-handoff/02-plugins/02-sandbox/package.json#L2)、[demo](../packages/agent/docs/mobile-handoff/02-plugins/02-sandbox/src/demo-facet.ts#L1) |
| pi-extension-custom-provider-anthropic | 注册自定义 Anthropic provider | @anthropic-ai/sdk | [manifest](../packages/coding-agent/examples/extensions/custom-provider-anthropic/package.json#L11)、[registerProvider](../packages/coding-agent/examples/extensions/custom-provider-anthropic/index.ts#L575) |
| pi-extension-custom-provider-gitlab-duo | 注册 GitLab Duo provider | manifest 无 dependencies；内部包由 workspace 提供 | [manifest](../packages/coding-agent/examples/extensions/custom-provider-gitlab-duo/package.json#L11)、[registerProvider](../packages/coding-agent/examples/extensions/custom-provider-gitlab-duo/index.ts#L382) |
| pi-extension-gondolin | 把 coding tools 的操作后端替换为 Gondolin VM | @earendil-works/gondolin | [manifest](../packages/coding-agent/examples/extensions/gondolin/package.json#L11)、[VM 创建](../packages/coding-agent/examples/extensions/gondolin/index.ts#L381) |
| pi-extension-sandbox | 用 sandbox-runtime 包装 bash | @anthropic-ai/sandbox-runtime | [manifest](../packages/coding-agent/examples/extensions/sandbox/package.json#L11)、[SandboxManager](../packages/coding-agent/examples/extensions/sandbox/index.ts#L47) |
| pi-extension-with-deps | 验证扩展能从自己的 node_modules 解析依赖，并注册 duration 工具 | ms；@types/ms 为开发依赖 | [manifest](../packages/coding-agent/examples/extensions/with-deps/package.json#L11)、[工具注册](../packages/coding-agent/examples/extensions/with-deps/index.ts#L8) |
| @earendil-works/pi-example-plugin | Chord service + Session facet + TUI facet 示例 | peer: chord、pi-coding-agent | [manifest](../packages/coding-agent/examples/plugins/pi-example-plugin/package.json#L2)、[service contract](../packages/coding-agent/examples/plugins/pi-example-plugin/src/contract.ts#L1)、[Session facet](../packages/coding-agent/examples/plugins/pi-example-plugin/src/session.ts#L1)、[TUI facet](../packages/coding-agent/examples/plugins/pi-example-plugin/src/tui.ts#L1) |
| @earendil-works/pi-coding-agent-install | 只锁定安装器/updater 所需的 coding-agent 版本 | pi-coding-agent 精确版本 | [manifest](../packages/coding-agent/install-lock/package.json#L2) |

## 16. 最终架构判断

### 16.1 结论：包边界按“契约 → 运行时 → 产品装配”分层

Chord、telemetry、TUI 提供与模型无关的底层能力；pi-ai 定义 provider 和消息流；agent-core 在其上实现循环与会话抽象；protocol/client/server/sqlite 是可选的远程和持久化基础设施；coding-agent 把这些能力装配成 CLI/SDK；evals 只从最上层驱动评估。

源码示例：

~~~ts
// coding-agent 装配 Agent
agent = new Agent({
	initialState: {
		systemPrompt: "",
		model,
		thinkingLevel,
		tools: [],
	},
	convertToLlm: convertToLlmWithBlockImages,
	// ...
});

// Agent 在 LLM 边界构造 pi-ai Context
const llmContext: Context = {
	systemPrompt: context.systemPrompt,
	messages: llmMessages,
	tools: context.tools,
};
~~~

证据：[产品装配点](../packages/coding-agent/src/core/sdk.ts#L306)、[Agent/AI 边界](../packages/agent/src/agent-loop.ts#L302)、[完整内部依赖图的 manifest 证据](../packages/coding-agent/package.json#L51)。
