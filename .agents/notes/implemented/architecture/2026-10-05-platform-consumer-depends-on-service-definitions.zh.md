# Agent Note: Platform 消费 Runtime Service Definition

Status: implemented

[English](2026-10-05-platform-consumer-depends-on-service-definitions.md) | 中文

## Problem

平台自有的组件必须驱动 DeepSeek Runtime：创建并观察 Agent、安装一项工具策略决策、并观察 cancellation。仓库规则要求扩展代码依赖 Service Definition、绝不依赖具体 provider，但该规则既没有可执行的检查，也没有任何证据表明平台消费方能在遵守它的同时操作 Runtime。

## Decision

Platform 只依赖 Runtime Service Definition：`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-session` 与 `@deepseek-ai/dsh-tools`。它不引入 `AgentRuntime`、`AgentDefinition`、`ExecutionContext`、`RuntimeEvent`、`ModelProvider`、`Capability`、`PolicyEngine` 或 `EventBus`；Cordis context 与既有扩展点就是接口。角色词汇仍以[能力 seam](2026-06-13-capability-seams.zh.md)所记录者为准。

`@deepseek-ai/dsh-experimental-platform-boundary` 是该规则的验证包。`PLATFORM_SERVICE_DEFINITIONS` 列出被允许的 Service Definition，`PLATFORM_UTILITY_PACKAGES` 列出已发布的 `packages/util/*` 包（其中若干不带 `dsh-util-` 前缀，因此允许范围是一份显式列表，而非前缀匹配）；`findPlatformBoundaryViolations` 报告源码文本中其他所有 `@deepseek-ai/dsh-*` 导入。检查器是无依赖的文本式扫描：它识别静态 `import` 与 `export ... from`、副作用 `import`、动态 `import()` 与 CommonJS `require()`，将模式锚定在行首，并会漏掉未加引号的 `import(name)`、拼接的 specifier 以及 `import x = require(...)`。它是诊断性的——对手写源码的 lint 与架构检查——绝不是运行时授权屏障；工具权限由运行时路径上的 `tools/pre-execute` 与 `ctx.tools.guard()` 强制执行。

本包是私有的实验性验证产物。其消费方是已交付的 `@deepseek-ai/dsh-experimental-platform-consumer`：它在插件自有状态中附加横向的 `projectId`/`runId`/`taskId` 身份，在 `tools/pre-execute` 与 `ctx.tools.guard()` 上安装 fail-closed 的单调工具策略，并在 `ctx.platformConsumer` 上暴露只读观察结果。`PLATFORM_SERVICE_DEFINITIONS` 还允许 `dsh-jobs` 与 `dsh-subagent`。真实的组合测试位于消费方包中，若该检查器被提升或移除，则重新审视 [`scripts/experimental-package-policy.ts`](../../../../scripts/experimental-package-policy.ts) 中的私有例外。

## Alternatives considered

**引入 Platform runtime 抽象。** 否决：它只是重述 Runtime 已暴露的服务、context 与扩展点，并且还需要自带 lifecycle、cancellation 与 policy 语义。

**导入具体 provider。** 否决：它把 Platform 绑定到某一种实现，以及该 provider 的模型、凭证与生命周期。

**做运行时授权检查。** 否决：工具路径已经承担强制执行，而源码扫描无法观察运行时值。把该扫描呈现为权限边界，既错置了权威，也会诱使人们经由它漏掉的任一导入形式绕过。

**做语法感知扫描。** 延期：无依赖的文本式扫描让检查器保持为零依赖库，上述假阴性已被记录。若真实消费方产生假阳性，则以解析式扫描替换。

## Consequences

边界规则可对源码文本执行，但只覆盖扫描器识别的导入形式；工具类允许范围是 `packages/util/*` 的一份快照，新增工具包必须更新它。组合测试证明消费方能够加载、观察 lifecycle 与身份、观察 cancellation、在无批准通道的 ask 上 fail closed，且无法反转 monotonic guard。这些测试位于消费方包中，并挂载真实的 Loader 组合；该消费方为可选启用，未由任何默认 profile 挂载。

已交付消费方的策略分两个阶段执行。`tools/pre-execute` 安装 fail-closed 默认：未匹配的调用或没有 Agent 的调用会被拒绝，而已配置的 `allow`/`deny`/`ask` 规则按首个匹配决定。只有标记 `monotone` 的 `deny` 规则会额外注册到 `ctx.tools.guard()`，它在 pre-execute 链之后运行且无法被反转；非 monotone 的 `deny` 与 fail-closed 默认都可能被更早的 pre-execute 监听器短路，因此需要硬边界的部署会将其 deny 规则标记为 monotone。面向模型的策略原因会剥离控制字符并截断至 500 个字符。每个观察列表是一个由 `observationLimit` 个条目（默认 1000）构成的有界环。消费方只观察由其自身 task 拥有的 job。
