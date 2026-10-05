---
description: "由平台拥有的 Cordis 消费方：为 Agent 附加横向 project/run/task 身份，安装 fail-closed 单调工具策略，并暴露只读运行时观察。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-platform-consumer

[English](README.md) | 中文

## 概述

挂载该消费方即可让 Platform 驱动一个组合：它为所观察的每个 Agent 赋予横向的 `projectId`/`runId`/`taskId` 身份，强制一套已配置的工具策略——该策略 fail-closed 且不能被后续监听器反转——并在一个可寻址服务上记录只读的 lifecycle 事实。当平台层需要为工作打标、为工具调用把关并观察一次运行，而不改动 session 模型或 agent loop 时，选择它。它不添加提示词、schema 或 session 事件；其唯一对模型可见的效果是工具拒绝原因。其策略是显式启用的，因此未配置的挂载不施加任何约束。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在已提供 `ctx.tools` 与 `ctx.agents` 的组合中挂载该插件；subagent、jobs 与 llm 服务存在时会被消费。

### 何时选择它

当 Platform 拥有驱动 runtime 的那次运行，并需要横向身份、fail-closed 工具策略与只读观察时，选择它。不要把它当作终端用户权限系统：强制执行位于 `tools/pre-execute` 与 `ctx.tools.guard()`，而此消费方只安装自身 config 声明的规则。需要交互式批准的部署应改用现有的 approval seam。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-experimental-platform-consumer'
  config:
    projectId: my-project
    policy:
      - tool: bash
        decision: deny
        monotone: true
        reason: 'platform policy: bash is disabled'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `projectId` | `required` | 赋予每个被观察 Agent 的 Platform 项目。 |
| `runId` | 每次挂载时铸造 | 为每个被观察 Agent 复用的运行身份，并由被委派的子级继承。 |
| `policy` | 缺失 | 有序的工具策略规则；缺失时不施加任何约束。 |
| `policy[].tool` | 每个工具 | 规则匹配的工具名称。 |
| `policy[].projectId` / `runId` / `taskId` | 每个值 | 规则要求的横向身份。 |
| `policy[].decision` | — | `allow`、`deny` 或 `ask`。 |
| `policy[].reason` | `platform policy: <decision>` | deny 或 ask 携带的原因，会剥离控制字符并截断至 500 个字符。 |
| `policy[].monotone` | `false` | 对 deny 规则，同时通过 `ctx.tools.guard()` 强制实施。 |
| `observationLimit` | `1000` | 每个观测环保留的最大条目数；必须为正安全整数。 |

生成的[配置目录](../../../docs/config-catalog.zh.md)是每个可接受字段的完备来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

在 `agent/created` 时，消费方通过 `agent.session.header.parentSession` 解析父级：root Agent 采用配置的 `projectId` 与 run 并铸造一个 task；子级继承 project 与 run 并铸造一个不同的 task。身份保存在插件自有的 `Map<SessionId, PlatformMetadata>` 中，绝不进入 session 日志。

策略层评估 `tools/pre-execute`：非空策略首先拒绝任何没有已跟踪 Agent 的调用，随后第一条匹配的规则胜出，`allow` 委托，`deny` 与 `ask` 直接决定，而非空策略在无匹配规则时拒绝。标记为 `monotone` 的 deny 规则还会注册到 `ctx.tools.guard()`，因此后续监听器无法反转它们。

服务 `ctx.platformConsumer` 暴露 `metadataFor`、`tasks` 与已记录的 `observations`，每个环由 `observationLimit` 限制。事实仅来自现有事件：`agent/created`、`agent/status`、`agent/turn-stopping`、`agent/request`、`session/event`、`subagent/start`、`subagent/end`，以及 `ctx.jobs` 事件流；其按 owner 门控的条目仅为消费方跟踪的 session 保留。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [平台边界检查器](../platform-boundary/README.zh.md)——此消费方遵循的导入允许列表。
- [工具管线](../../core/tools/README.zh.md)——`tools/pre-execute`、`ctx.tools.guard()` 与拒绝路径。
- [Agent 服务](../../core/agent/README.zh.md)——消费方所观察的 lifecycle 事件。
- [Subagent 服务](../../subagent/subagent/README.zh.md)——消费方经由其继承的子级 lifecycle。
- [测试策略](../../../docs/testing.zh.md)——其测试所满足的 REAL 组合要求。

<a id="model-experience"></a>
## 模型体验

间接地，经由消费方安装的工具执行策略：拒绝原因通过现有的工具结果路径到达模型。

#### KV Cache 影响

消费方不添加提示词、schema 或消息内容，因此不改变可缓存的请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **仅显式启用**——消费方不随任何默认 profile 发布；部署需显式挂载它。
- **策略由 Config 拥有**——规则是静态 `Config`；目前没有运行时规则注入 API。
- **横向身份在内存中**——它们不被持久化，重启后不保留；任何内容都不进入 session 日志。
- **`ctx.llm` 可用性按 task 采样**——观察记录的是 Agent 首次被看到时已注册的 provider，而非实时订阅。
- **Fail-closed 是一项 pre-execute 决策**——「无匹配规则」的默认结果以及任何未标记 `monotone` 的 `deny` 规则都在 `tools/pre-execute` 上决定。该链中更早注册的监听器可以短路它们；只有标记 `monotone: true` 的 `deny` 规则由 `ctx.tools.guard()` 不可逆地强制执行。
- **没有 Agent 的调用会被拒绝**——一旦配置了非空策略，不携带 Agent 的调用会被拒绝（`platform policy: call has no agent`）；该拒绝是一项 pre-execute 决策，并带有上述限制。
- **`ask` 只是建议性的**——`ask` 决策请求批准，且可能被批准一次；它既非 fail-closed 也非 monotone。需要硬锁定请使用带 `monotone: true` 的 `deny`。
- **观察是有界环**——每个事实列表至多保留 `observationLimit` 个条目（默认 1000）并淘汰最旧的条目；观察是内存中的视图，而非完整历史。
- **仅观察本消费方的 job**——job 流经过滤，仅保留消费方已赋予 task 的 owner；无主 job 与其他消费方的 job 会被忽略。
- **disposal 由 fiber 拥有**——消费方的监听器、guard、所提供的服务以及 job 订阅都随插件 fiber 释放；释放后它们停止记录。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
