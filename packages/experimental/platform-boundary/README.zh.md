---
description: "文本式平台边界检查器：按显式的 DeepSeek Runtime Service Definition 与包工具类允许列表对消费方导入进行分类。"
kind: "package-library"
---

# @deepseek-ai/dsh-experimental-platform-boundary

[English](README.md) | 中文

## 概述

`platform-boundary` 按两份显式允许列表——DeepSeek Runtime Service Definition 与 `packages/util/*` 包——对平台自有消费方的模块导入进行分类。`extractModuleSpecifiers` 读取源码文本，`classifyPlatformImport` 判定某个 specifier 能否穿越到 Runtime，`findPlatformBoundaryViolations` 则返回每个指向具体包、而非允许列表项的 `@deepseek-ai/dsh-*` 导入。检查器在运行时没有任何导入。这个私有实验包是 Platform 到 Runtime 边界的验证产物，尚不存在生产消费方；它还承载真实组合测试，覆盖 lifecycle、身份、cancellation、fail-closed policy 与 monotonic deny。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [组合测试](#composition-tests)
- [相关文档](#related-documentation)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 对单个 specifier 分类

`classifyPlatformImport(specifier)` 返回 `allowed` 或 `forbidden`。它允许相对 specifier、`node:*` 内建模块、`@deepseek-ai/dsh-*` 之外的包、`PLATFORM_UTILITY_PACKAGES` 中列出的已发布 `packages/util/*` 包，以及 `PLATFORM_SERVICE_DEFINITIONS` 中的 Service Definition（`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-tools`）。其他所有 `@deepseek-ai/dsh-*` 包（包括其子路径）都被禁止，因此诸如 `@deepseek-ai/dsh-llm-deepseek` 这样的具体 provider 不会在无意间变为可导入。

### 检查一个源码文件

`findPlatformBoundaryViolations(source)` 从源码文本中提取每个 specifier，并为每个被禁止的包返回一条 `PlatformBoundaryViolation`：

```ts
import { findPlatformBoundaryViolations } from '@deepseek-ai/dsh-experimental-platform-boundary'

const violations = findPlatformBoundaryViolations("import { a } from '@deepseek-ai/dsh-agent-loop'")
// [{ packageName: '@deepseek-ai/dsh-agent-loop', specifier: '@deepseek-ai/dsh-agent-loop' }]
```

`extractModuleSpecifiers(source)` 就是独立的提取步骤。它识别静态 `import` 与 `export ... from`、副作用 `import`、动态 `import()` 以及 CommonJS `require()`，并按首次出现顺序返回去重后的 specifier。

### 检查的适用范围

扫描是诊断性的。它只读取手写源码文本，从不观察运行时值，因此是 lint 与架构检查，而绝不是运行时授权屏障。工具权限的强制执行仍位于运行时路径（`tools/pre-execute` 与 `ctx.tools.guard()`），那里才能看到真实值。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`PLATFORM_SERVICE_DEFINITIONS` 与 `PLATFORM_UTILITY_PACKAGES` 是唯一两份可供审查的列表；检查器把不在其中的名称视为具体包，而不是再去引入第二个注册表。`packageNameOf` 把 specifier 归约为其 npm 包名（丢弃子路径），`forbiddenPackageName` 在一处判定该名称属于 DSH 范围之外、允许列表中的 Service Definition、允许列表中的工具包，还是违规。两个公开入口都调用它，因此分类结果与违规列表不会发生偏移。提取阶段运行四个正则表达式，并按 specifier 自身的源码偏移对其匹配结果排序。

</details>

-----

<a id="composition-tests"></a>
## 组合测试

`tests/integration/platform-boundary-composition.spec.ts` 从临时 `cordis.yml` 启动真实 Loader 组合，并把平台消费方挂在 runtime 旁边。harnais 与消费方遵循不同的规则：

- **组合 harnais** 负责组装 runtime，因此会点名具体包——`dsh-agent-loop`、`dsh-session-projection`、`dsh-system-prompt`、Cordis Loader 与 Include——就像部署时组合它们那样。在此点名它们并非 Platform 导入。
- **平台消费方**是 [`tests/support/platform-observer.ts`](tests/support/platform-observer.ts)。它只导入 Service Definition、Cordis 与一个配置 schema，并有架构测试对其源码运行 `findPlatformBoundaryViolations`，要求零违规。

消费方观察 `agent/created`、`agent/status`、`session/event`、`agent/turn-stopping` 与轮次 `AbortSignal`；安装一个 `tools/pre-execute` 决策与一个可选的 `ctx.tools.guard()`；并在 `platformObserver` 服务上暴露其记录的事实。测试证明：

- **加载**——组合成功挂载，消费方被加载。
- **Lifecycle 与身份**——无密钥 `MockAdapter` 轮次记录 `turn/start` 与 `turn/end`，消费方在 `agent/created` 与 `tools/pre-execute` 两处都得到 `agent.id === agent.session.id`。
- **Cancellation**——`agent.cancel({ kind: 'user' })` 中止轮次 signal，消费方在 signal 与持久 `turn/end` 两处都记录该 cause。
- **Fail-closed ask**——无批准通道时 `ask` 拒绝该调用，tool 主体从不执行。
- **Monotonic deny**——即使后续 `tools/pre-execute` 监听器允许该调用，`ctx.tools.guard()` 的拒绝依然成立。

消费方是本包的验证支持，而非已交付插件：它通过文件 URL 挂载，因此 `platformObserver` 服务只存在于这些测试中。目前尚不存在生产 Platform 消费方；一旦出现，本包会被提升为产品角色或被移除，并重新审视[私有例外](../../../scripts/experimental-package-policy.ts)。

-----

<a id="related-documentation"></a>
## 相关文档

- [Platform 消费方架构备注](../../../.agents/notes/implemented/architecture/2026-10-05-platform-consumer-depends-on-service-definitions.zh.md)——为何 Platform 消费 Service Definition，而不引入新的 runtime 抽象。
- [实验性包](../README.zh.md)——这个私有验证包所属的组。
- [测试策略](../../../docs/testing.zh.md)——这些测试所满足的 REAL 组合要求。
- [发布策略](../../../scripts/experimental-package-policy.ts)——把本包排除在 npm 发布之外的私有例外列表。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **文本式提取及其假阴性**——`extractModuleSpecifiers` 扫描源码文本而非已解析的模块图，并将模式锚定在行首。注释或字符串字面量里的 specifier 会被报告，而未加引号的 `import(name)`、拼接的 specifier 以及 `import x = require(...)` 会漏掉。检查器是诊断性的：它从不观察运行时值，也不是授权屏障。
- **工具类允许列表是显式快照**——`PLATFORM_UTILITY_PACKAGES` 列出已发布的 `packages/util/*` 名称，其中若干不带 `dsh-util-` 前缀；新增工具包必须加入该列表，否则检查器会拒绝合法导入。
- **无生产消费方的验证产物**——本包用于锚定 Platform 到 Runtime 的边界，且没有生产消费方；生产级 Platform 集成会将其提升为产品角色或将其移除，两条路径都会重新审视 `PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES`。
- **消费方是测试支持，而非已交付插件**——`tests/support/platform-observer.ts` 通过文件 URL 挂载，并不是包的导出，因此 `platformObserver` 服务只存在于组合测试中。
- **不进入 npm 发布**——本包列在 `PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES` 中，因此其 manifest 设置 `private: true` 且不声明 `publishConfig`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
