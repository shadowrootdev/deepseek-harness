---
description: "Textual platform-boundary checker that classifies a consumer's imports against explicit DeepSeek Runtime Service Definition and package-utility allowlists."
kind: "package-library"
---

# @deepseek-ai/dsh-experimental-platform-boundary

English | [中文](README.zh.md)

## Summary

`platform-boundary` classifies a platform-owned consumer's module imports against explicit allowlists of DeepSeek Runtime Service Definitions and `packages/util/*` packages. `extractModuleSpecifiers` reads source text, `classifyPlatformImport` decides whether a specifier may cross into the Runtime, and `findPlatformBoundaryViolations` returns each `@deepseek-ai/dsh-*` import that names a concrete package. The checker imports nothing at runtime. This private experimental package is a verification artifact for the Platform-to-Runtime boundary; the shipped `@deepseek-ai/dsh-experimental-platform-consumer` is the consumer it validates, and that package carries the real composition tests for lifecycle, identity, cancellation, fail-closed policy, and monotonic denial.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Architecture check](#architecture-check)
- [Related documentation](#related-documentation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Classifying one specifier

`classifyPlatformImport(specifier)` returns `allowed` or `forbidden`. It allows relative specifiers, `node:*` builtins, packages outside `@deepseek-ai/dsh-*`, the published `packages/util/*` packages listed in `PLATFORM_UTILITY_PACKAGES`, and the Service Definitions in `PLATFORM_SERVICE_DEFINITIONS` (`@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-jobs`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-subagent`, `@deepseek-ai/dsh-tools`). Every other `@deepseek-ai/dsh-*` package is forbidden, including its subpaths, so a concrete provider such as `@deepseek-ai/dsh-llm-deepseek` cannot become importable by accident.

### Checking a source file

`findPlatformBoundaryViolations(source)` extracts every specifier from the source text and returns one `PlatformBoundaryViolation` per forbidden package:

```ts
import { findPlatformBoundaryViolations } from '@deepseek-ai/dsh-experimental-platform-boundary'

const violations = findPlatformBoundaryViolations("import { a } from '@deepseek-ai/dsh-agent-loop'")
// [{ packageName: '@deepseek-ai/dsh-agent-loop', specifier: '@deepseek-ai/dsh-agent-loop' }]
```

`extractModuleSpecifiers(source)` is the extraction step on its own. It recognizes static `import` and `export ... from`, side-effect `import`, dynamic `import()`, and CommonJS `require()`, and returns each unique specifier once in first-appearance order.

### Scope of the check

The scan is diagnostic. It reads authored source text and never observes runtime values, so it is a lint and architecture check, never a runtime authorization barrier. Enforcement of tool permission stays on the runtime path (`tools/pre-execute` and `ctx.tools.guard()`), where the actual values are known.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`PLATFORM_SERVICE_DEFINITIONS` and `PLATFORM_UTILITY_PACKAGES` are the single reviewable lists; the checker treats an absent name as a concrete package rather than importing a second registry. `packageNameOf` reduces a specifier to its npm package name (dropping any subpath), and `forbiddenPackageName` decides in one place whether that name is out of the DSH scope, an allowlisted Service Definition, an allowlisted utility package, or a violation. Both public entry points call it, so the classification and the violation list cannot drift. Extraction runs four regular expressions and orders their matches by the specifier's own source offset.

</details>

-----

<a id="architecture-check"></a>
## Architecture check

`tests/architecture/platform-boundary.spec.ts` runs `findPlatformBoundaryViolations` over the shipped consumer's source, `packages/experimental/platform-consumer/src/index.ts`, and requires zero violations. The consumer imports only Service Definitions, Cordis, `schemastery`, and `dsh-brand`.

The real Loader composition lives in that package, `packages/experimental/platform-consumer/tests/integration/platform-consumer-composition.spec.ts`. It boots a real Loader composition from a temporary `cordis.yml`, mounts the consumer beside the runtime, and proves lifecycle and identity, cancellation, fail-closed policy, monotonic denial, lateral-identity inheritance through a real in-process subagent, and background-job observation.

-----

<a id="related-documentation"></a>
## Related documentation

- [Platform consumer architecture note](../../../.agents/notes/implemented/architecture/2026-10-05-platform-consumer-depends-on-service-definitions.md) — why the Platform consumes Service Definitions and not a new runtime abstraction.
- [Experimental packages](../README.md) — the group this private verification package belongs to.
- [Testing policy](../../../docs/testing.md) — the REAL-composition requirement these tests satisfy.
- [Publication policy](../../../scripts/experimental-package-policy.ts) — the private-exception list that keeps this package out of npm publication.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **Textual extraction and its false negatives** — `extractModuleSpecifiers` scans source text, not a parsed module graph, and anchors its patterns at line starts. A specifier inside a comment or string literal is reported, while an unquoted `import(name)`, a concatenated specifier, and `import x = require(...)` are missed. The checker is diagnostic: it never observes runtime values and is not an authorization barrier.
- **The utility allowlist is an explicit snapshot** — `PLATFORM_UTILITY_PACKAGES` lists the published `packages/util/*` names, several of which carry no `dsh-util-` prefix; a new utility package must be added there or the checker rejects a legitimate import.
- **Verification artifact, no runtime consumer of its own** — the package pins the Platform-to-Runtime import boundary; the shipped `@deepseek-ai/dsh-experimental-platform-consumer` is the consumer it validates, and promoting or removing this checker revisits `PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES`.
- **Diagnostic only** — the checker scans source text and never enforces runtime permission; enforcement stays on `tools/pre-execute` and `ctx.tools.guard()`.
- **Kept out of npm publication** — this package is listed in `PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES`, so its manifest sets `private: true` and declares no `publishConfig`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
