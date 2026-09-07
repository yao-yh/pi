# Pi 核心代码专题学习索引

本目录下的六份专题文档只依据当前仓库源码，不引用网络资料或通用理论。每个结论后都给出两类证据：直接摘录的源码示例，以及指向原文件具体行号的链接。

## 专题

1. [会话管理](./CORE_SESSION_MANAGEMENT.zh-CN.md)：JSONL 格式、追加式树、分支、延迟持久化、会话恢复。
2. [上下文管理](./CORE_CONTEXT_MANAGEMENT.zh-CN.md)：四层消息表示、Agent 状态、事件归约、队列和 provider 请求边界。
3. [上下文压缩](./CORE_CONTEXT_COMPACTION.zh-CN.md)：token 计算、切点算法、摘要请求、自动压缩和 overflow 恢复。
4. [Prompt 管理](./CORE_PROMPT_MANAGEMENT.zh-CN.md)：项目指令、system prompt、skill、模板、扩展 hook 和优先级。
5. [Tool 管理](./CORE_TOOL_MANAGEMENT.zh-CN.md)：definition registry、活动工具、执行阶段、并行策略、错误回灌和文件写并发。
6. [Packages 功能与依赖关系](./CORE_PACKAGES_ARCHITECTURE.zh-CN.md)：11 个主体实现包的“一级能力域 → 二级模块 → 具体功能点”源码地图、内部依赖图、跨包调用链、外部依赖用途和 8 个嵌套辅助包。

## 证据阅读规则

- “源码示例”保持与仓库实现一致，只截取证明当前结论所需的最小片段。
- 省略的无关代码用注释说明，不改变被讨论分支的含义。
- 所有流程图节点均能在相邻结论的源码示例中找到对应实现。
- 行号以当前工作区版本为准。
- 文档描述的是默认 `pi` CLI 经过 `AgentSession`、`Agent` 和 `agent-loop.ts` 的主路径，不把 `packages/agent/src/harness/` 的替代实现混入结论。

主路径边界的源码示例：

```ts
const sessionManager = createSessionManager(args, cwd);
const services = await createAgentSessionServices({
	// ...
	sessionManager,
});
const runtime = createAgentSessionRuntime(services);
```

证据：[CLI 创建会话服务和运行时](../packages/coding-agent/src/main.ts#L713)。

```ts
const { session, modelFallbackMessage } = await runtime.createSession({
	// ...
});
```

证据：[CLI 创建默认 AgentSession](../packages/coding-agent/src/main.ts#L841)。
