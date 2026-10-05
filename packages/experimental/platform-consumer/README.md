---
description: "A platform-owned Cordis consumer that attaches lateral project/run/task identities to Agents, installs a fail-closed monotonic tool policy, and exposes read-only runtime observations."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-platform-consumer

English | [中文](README.zh.md)

## Summary

Mount this consumer to drive a composition from a Platform: it gives every Agent it observes lateral `projectId`/`runId`/`taskId` identities, enforces a configured tool policy that fails closed and cannot be reversed by a later listener, and records read-only lifecycle facts on an addressable service. Choose it when a platform layer needs to label work, gate tool calls, and observe a run without changing the session model or the agent loop. It adds no prompt, schema, or session event; its only model-visible effect is a tool denial reason. Its policy is opt-in, so an unconfigured mount imposes nothing.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin in a composition that already provides `ctx.tools` and `ctx.agents`; the subagent, jobs, and llm services are consumed when present.

### When to choose it

Choose it when a Platform owns the run that drives the runtime and needs lateral identities, a fail-closed tool policy, and read-only observations. Do not choose it as an end-user permission system: enforcement lives on `tools/pre-execute` and `ctx.tools.guard()`, and this consumer only installs the rules its own config declares. A deployment that needs interactive approvals keeps the existing approval seam instead.

### Minimal configuration

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

| Field | Default | Meaning |
|---|---|---|
| `projectId` | `required` | Platform project assigned to every observed Agent. |
| `runId` | minted per mount | Run identity reused for every observed Agent and inherited by delegated children. |
| `policy` | absent | Ordered tool-policy rules; absent imposes nothing. |
| `policy[].tool` | every tool | Tool name the rule matches. |
| `policy[].projectId` / `runId` / `taskId` | every value | Lateral identity a rule requires. |
| `policy[].decision` | — | `allow`, `deny`, or `ask`. |
| `policy[].reason` | `platform policy: <decision>` | Reason carried by a deny or ask, control characters stripped and capped at 500 characters. |
| `policy[].monotone` | `false` | On a deny rule, also enforce it through `ctx.tools.guard()`. |
| `observationLimit` | `1000` | Maximum retained entries per observation ring; must be a positive safe integer. |

The generated [configuration catalog](../../../docs/config-catalog.md) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

On `agent/created` the consumer resolves the parent through `agent.session.header.parentSession`: a root Agent takes the configured `projectId` and run and mints a task; a child inherits project and run and mints a distinct task. Identities live in a plugin-owned `Map<SessionId, PlatformMetadata>` and never enter the session log.

The policy layer evaluates `tools/pre-execute`: a non-empty policy first denies any call with no tracked Agent, then the first matching rule wins, `allow` delegates, `deny` and `ask` decide, and a non-empty policy with no matching rule denies. Deny rules marked `monotone` are also registered with `ctx.tools.guard()`, so a later listener cannot reverse them.

The service `ctx.platformConsumer` exposes `metadataFor`, `tasks`, and the recorded `observations`, each ring bounded by `observationLimit`. Facts come only from existing events: `agent/created`, `agent/status`, `agent/turn-stopping`, `agent/request`, `session/event`, `subagent/start`, `subagent/end`, and the `ctx.jobs` event stream, whose owner-gated entries are kept only for sessions the consumer tracks.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Platform-boundary checker](../platform-boundary/README.md) — the import allowlist this consumer obeys.
- [Tools pipeline](../../core/tools/README.md) — `tools/pre-execute`, `ctx.tools.guard()`, and the denial path.
- [Agent service](../../core/agent/README.md) — the lifecycle events the consumer observes.
- [Subagent service](../../subagent/subagent/README.md) — the child lifecycle the consumer inherits through.
- [Testing policy](../../../docs/testing.md) — the REAL-composition requirement its tests satisfy.

<a id="model-experience"></a>
## Model Experience

Indirectly, through the tool-execution policy the consumer installs: a denial reason reaches the model on the existing tool-result path.

#### KV Cache effect

The consumer adds no prompt, schema, or message content, so it does not change the cacheable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Opt-in only** — the consumer ships in no default profile; a deployment mounts it explicitly.
- **Config-owned policy** — rules are static `Config`; there is no runtime rule-injection API yet.
- **Lateral identities are in-memory** — they are not persisted and do not survive a restart; nothing enters the session log.
- **`ctx.llm` availability is sampled per task** — the observation records providers registered when an Agent was first seen, not a live subscription.
- **Fail-closed is a pre-execute decision** — the "no matching rule" default and any `deny` rule not marked `monotone` are decided on `tools/pre-execute`. A listener registered earlier in that chain can short-circuit them; only `deny` rules marked `monotone: true` are enforced irreversibly by `ctx.tools.guard()`.
- **Calls without an agent are refused** — once a non-empty policy is configured, a call carrying no Agent is denied (`platform policy: call has no agent`); this refusal is a pre-execute decision and shares the limitation above.
- **`ask` is advisory** — an `ask` decision requests approval and may be granted once; it is neither fail-closed nor monotone. Use `deny` with `monotone: true` for a hard lock.
- **Observations are bounded rings** — each fact list retains at most `observationLimit` entries (default 1000) and evicts the oldest; the observation is an in-memory view, not a complete history.
- **Only this consumer's jobs are observed** — the job stream is filtered to owners the consumer has assigned a task to; unowned jobs and other consumers' jobs are ignored.
- **Disposal is fiber-owned** — the consumer's listeners, guard, provided service, and job subscription are released with the plugin fiber; they stop recording after disposal.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
