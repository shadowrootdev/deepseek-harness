# Agent Note: Platform consumes Runtime Service Definitions

Status: implemented

English | [中文](2026-10-05-platform-consumer-depends-on-service-definitions.zh.md)

## Problem

A Platform-owned component must drive the DeepSeek Runtime: create and observe an Agent, install a tool-policy decision, and observe cancellation. The repository rule that extension code depends on Service Definitions, never concrete providers, had no executable check, and nothing proved that a Platform consumer could operate the Runtime while obeying it.

## Decision

The Platform depends on Runtime Service Definitions only: `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-session`, and `@deepseek-ai/dsh-tools`. It introduces no `AgentRuntime`, `AgentDefinition`, `ExecutionContext`, `RuntimeEvent`, `ModelProvider`, `Capability`, `PolicyEngine`, or `EventBus`; the Cordis context and the existing extension points are the interface. The role vocabulary stays as recorded in [capability seams](2026-06-13-capability-seams.md).

`@deepseek-ai/dsh-experimental-platform-boundary` is the verification package for this rule. `PLATFORM_SERVICE_DEFINITIONS` names the permitted Service Definitions and `PLATFORM_UTILITY_PACKAGES` names the published `packages/util/*` packages (several lack the `dsh-util-` prefix, so the allowance is an explicit list, not a prefix match); `findPlatformBoundaryViolations` reports every other `@deepseek-ai/dsh-*` import in a source text. The checker is a dependency-free textual scan: it recognizes static `import` and `export ... from`, side-effect `import`, dynamic `import()`, and CommonJS `require()`, anchors its patterns at line starts, and misses an unquoted `import(name)`, a concatenated specifier, and `import x = require(...)`. It is diagnostic — a lint and architecture check over authored source — and never a runtime authorization barrier; tool permission is enforced on the runtime path by `tools/pre-execute` and `ctx.tools.guard()`.

The package is a private experimental verification artifact with no production consumer. Its consumer, `tests/support/platform-observer.ts`, is test support mounted through the Loader by file URL, and the `platformObserver` service exists only in the composition tests. When a production Platform consumer exists, this package is promoted into a product role or removed, and the private exception in [`scripts/experimental-package-policy.ts`](../../../../scripts/experimental-package-policy.ts) is revisited.

## Alternatives considered

**A Platform runtime abstraction.** Rejected: it would restate the services, context, and extension points the Runtime already exposes, and it would need its own lifecycle, cancellation, and policy semantics.

**Importing concrete providers.** Rejected: it binds the Platform to one implementation and to that provider's models, credentials, and lifecycle.

**A runtime authorization check.** Rejected: the tool path already owns enforcement, and a source scanner cannot observe runtime values. Presenting the scan as a permission boundary would both misplace authority and invite bypass through any import form it misses.

**A syntax-aware scan.** Deferred: a dependency-free textual scan keeps the checker a zero-dependency library, and the false negatives above are recorded. A parsed scan replaces it if a real consumer produces false positives.

## Consequences

The boundary rule is executable over source text, but only for the import forms the scanner recognizes, and the utility allowance is a snapshot of `packages/util/*` that a new utility package must update. The composition tests prove that a consumer loads, observes lifecycle and identity, observes cancellation, fails closed on an ask with no approval seam, and cannot reverse a monotonic guard. Those tests mount the observer by file URL, so the `platformObserver` service is test-only, and no production consumer yet exists to justify promotion.
