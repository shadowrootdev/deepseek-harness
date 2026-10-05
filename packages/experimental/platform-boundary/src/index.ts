/**
 * Textual platform-boundary checker for a platform-owned consumer.
 *
 * A consumer that belongs to the Platform may depend on DeepSeek Runtime
 * Service Definitions and must never import a concrete internal provider or
 * implementation package. This module extracts the module specifiers of a
 * source file and classifies each `@deepseek-ai/dsh-*` import against explicit
 * allowlists. It has no runtime dependency and never touches the filesystem:
 * callers pass source text.
 *
 * The scan is diagnostic. It reads text, not a parsed module graph, so it
 * reports a specifier inside a comment or string and misses forms such as an
 * unquoted `import(name)`, a concatenated specifier, or `import x = require(...)`.
 * It is a lint and architecture check over authored source, never a runtime
 * authorization barrier.
 *
 * @module
 */

/**
 * Service Definition packages a platform-owned consumer may import directly.
 *
 * The list is deliberately explicit: every other `@deepseek-ai/dsh-*` package
 * is treated as a concrete internal package, so a new provider or
 * implementation does not silently become importable.
 */
export const PLATFORM_SERVICE_DEFINITIONS: readonly string[] = [
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-jobs',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-tools',
]

/** Verdict for one module specifier at the Platform to Runtime boundary. */
export type PlatformImportVerdict = 'allowed' | 'forbidden'

/** One forbidden `@deepseek-ai/dsh-*` import found in a consumer source file. */
export interface PlatformBoundaryViolation {
  /** Offending package name, without its subpath. */
  readonly packageName: string
  /** Complete module specifier as written in the import or export. */
  readonly specifier: string
}

/**
 * Packages published from `packages/util/*`, importable by any consumer.
 *
 * The group's npm names are not uniform: only some carry the `dsh-util-`
 * prefix, so the allowance is the explicit list of published names rather than
 * a prefix match. Add a new utility package here when it lands.
 */
export const PLATFORM_UTILITY_PACKAGES: readonly string[] = [
  '@deepseek-ai/dsh-atomic-write',
  '@deepseek-ai/dsh-brand',
  '@deepseek-ai/dsh-chunked-list',
  '@deepseek-ai/dsh-deque',
  '@deepseek-ai/dsh-home-paths',
  '@deepseek-ai/dsh-http-proxy',
  '@deepseek-ai/dsh-launch-environment',
  '@deepseek-ai/dsh-lazy-require',
  '@deepseek-ai/dsh-native-command',
  '@deepseek-ai/dsh-output-retention',
  '@deepseek-ai/dsh-package-manifest',
  '@deepseek-ai/dsh-timeout',
  '@deepseek-ai/dsh-util-code-language',
  '@deepseek-ai/dsh-util-crypto',
  '@deepseek-ai/dsh-util-time',
  '@deepseek-ai/dsh-util-values',
  '@deepseek-ai/dsh-util-workspace-path',
]

/** Package-name prefix shared by every DeepSeek Harness package. */
const DSH_PACKAGE_PREFIX = '@deepseek-ai/dsh-'

/** Matches `import ... from '<spec>'` and `export ... from '<spec>'`. */
const STATIC_FROM_PATTERN = /^[ \t]*(?:import|export)\b[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/gm

/** Matches a side-effect `import '<spec>'`. */
const SIDE_EFFECT_IMPORT_PATTERN = /^[ \t]*import\s*['"]([^'"]+)['"]/gm

/** Matches a dynamic `import('<spec>')`. */
const DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g

/** Matches a CommonJS `require('<spec>')`. */
const REQUIRE_PATTERN = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g

/** Every recognized import form, scanned in source order per form. */
const SPECIFIER_PATTERNS: readonly RegExp[] = [
  STATIC_FROM_PATTERN,
  SIDE_EFFECT_IMPORT_PATTERN,
  DYNAMIC_IMPORT_PATTERN,
  REQUIRE_PATTERN,
]

/** One recognized specifier and its offset in the scanned source. */
interface FoundSpecifier {
  readonly index: number
  readonly specifier: string
}

/**
 * Reduce a module specifier to the npm package name it targets.
 * @param specifier - module specifier as written in an import or export.
 * @returns the `@scope/name` or `name` package identity, or undefined for a
 * relative specifier or a bare scope with no package name.
 */
function packageNameOf(specifier: string): string | undefined {
  if (specifier.startsWith('.')) return undefined
  if (!specifier.startsWith('@')) return specifier.split('/')[0]
  const parts = specifier.split('/')
  if (parts.length < 2) return undefined
  return parts.slice(0, 2).join('/')
}

/**
 * Return the package name an import must not cross into, or undefined when the
 * specifier is allowed at the boundary.
 * @param specifier - module specifier as written in an import or export.
 * @returns the forbidden `@deepseek-ai/dsh-*` package name, or undefined when
 * the specifier is relative, out of the DSH scope, a published `packages/util/*`
 * utility package, or an allowlisted Service Definition.
 */
function forbiddenPackageName(specifier: string): string | undefined {
  const name = packageNameOf(specifier)
  if (name === undefined) return undefined
  if (!name.startsWith(DSH_PACKAGE_PREFIX)) return undefined
  if (PLATFORM_SERVICE_DEFINITIONS.includes(name)) return undefined
  if (PLATFORM_UTILITY_PACKAGES.includes(name)) return undefined
  return name
}

/**
 * Determine whether a platform-owned consumer may import one module specifier.
 * @param specifier - module specifier as written in an import or export.
 * @returns `forbidden` for a `@deepseek-ai/dsh-*` package outside the Service
 * Definition allowlist and the `dsh-util-*` prefix; `allowed` otherwise.
 */
export function classifyPlatformImport(specifier: string): PlatformImportVerdict {
  return forbiddenPackageName(specifier) === undefined ? 'allowed' : 'forbidden'
}

/**
 * Extract every module specifier from a source text.
 *
 * Recognized forms are static `import`/`export ... from`, side-effect `import`,
 * dynamic `import()`, and CommonJS `require()`. The scan is textual: it does not
 * parse comments, string literals, or template literals, so a quoted or
 * commented lookalike is reported. Specifiers are returned once each, ordered
 * by first appearance.
 *
 * @param source - complete TypeScript or JavaScript source text.
 * @returns unique specifiers ordered by first appearance.
 */
export function extractModuleSpecifiers(source: string): string[] {
  const found: FoundSpecifier[] = []
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1] as string
      // Index the specifier itself, not the leading keyword: a multiline static
      // match may begin on an earlier statement than the `from` it reaches.
      found.push({ index: match.index + match[0].lastIndexOf(specifier), specifier })
    }
  }
  found.sort((left, right) => left.index - right.index)
  const specifiers: string[] = []
  for (const { specifier } of found) {
    if (specifiers.includes(specifier)) continue
    specifiers.push(specifier)
  }
  return specifiers
}

/**
 * Find every forbidden `@deepseek-ai/dsh-*` import in a consumer source file.
 * @param source - complete TypeScript or JavaScript source text.
 * @returns one entry per forbidden package, in first-appearance order.
 */
export function findPlatformBoundaryViolations(source: string): PlatformBoundaryViolation[] {
  const violations: PlatformBoundaryViolation[] = []
  const seen = new Set<string>()
  for (const specifier of extractModuleSpecifiers(source)) {
    const packageName = forbiddenPackageName(specifier)
    if (packageName === undefined || seen.has(packageName)) continue
    seen.add(packageName)
    violations.push({ packageName, specifier })
  }
  return violations
}
