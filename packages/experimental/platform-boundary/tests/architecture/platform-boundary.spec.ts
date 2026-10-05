import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  PLATFORM_SERVICE_DEFINITIONS,
  PLATFORM_UTILITY_PACKAGES,
  classifyPlatformImport,
  extractModuleSpecifiers,
  findPlatformBoundaryViolations,
} from '../../src/index.ts'

/** Read one fixture beside this spec as source text. */
function readFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8')
}

describe('findPlatformBoundaryViolations', () => {
  it('rejects a consumer that imports a concrete internal package', () => {
    const violations = findPlatformBoundaryViolations(readFixture('invalid-consumer.ts'))
    const names = violations.map(violation => violation.packageName)
    expect(names).toContain('@deepseek-ai/dsh-agent-loop')
    expect(names).toContain('@deepseek-ai/dsh-llm-deepseek')
    // The allowlisted Service Definitions in the same file are not reported.
    expect(names).not.toContain('@deepseek-ai/dsh-agent')
    expect(violations.find(violation => violation.packageName === '@deepseek-ai/dsh-agent-loop')?.specifier)
      .toBe('@deepseek-ai/dsh-agent-loop')
  })

  it('accepts a consumer that imports only Service Definitions, Cordis, node: builtins, and relative modules', () => {
    expect(findPlatformBoundaryViolations(readFixture('valid-consumer.ts'))).toEqual([])
  })

  it('accepts the shipped platform consumer source', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../platform-consumer/src/index.ts', import.meta.url)),
      'utf8',
    )
    expect(findPlatformBoundaryViolations(source)).toEqual([])
  })

  it('reports one entry per forbidden package and ignores allowed packages', () => {
    const source = [
      "import { a } from '@deepseek-ai/dsh-agent-loop'",
      "import { b } from '@deepseek-ai/dsh-agent-loop/internal'",
      "import { c } from '@deepseek-ai/dsh-agent'",
      "import { d } from '@deepseek-ai/cordis'",
    ].join('\n')
    expect(findPlatformBoundaryViolations(source)).toEqual([
      { packageName: '@deepseek-ai/dsh-agent-loop', specifier: '@deepseek-ai/dsh-agent-loop' },
    ])
  })
})

describe('classifyPlatformImport', () => {
  it('allows every Service Definition', () => {
    for (const definition of PLATFORM_SERVICE_DEFINITIONS) {
      expect(classifyPlatformImport(definition)).toBe('allowed')
    }
  })

  it('allows Service Definition subpaths', () => {
    expect(classifyPlatformImport('@deepseek-ai/dsh-session/types')).toBe('allowed')
  })

  it('allows every published packages/util/* package, including the ones without the util- prefix', () => {
    for (const utility of PLATFORM_UTILITY_PACKAGES) {
      expect(classifyPlatformImport(utility)).toBe('allowed')
    }
    expect(PLATFORM_UTILITY_PACKAGES).toContain('@deepseek-ai/dsh-brand')
    expect(PLATFORM_UTILITY_PACKAGES).toContain('@deepseek-ai/dsh-atomic-write')
    expect(PLATFORM_UTILITY_PACKAGES).toContain('@deepseek-ai/dsh-util-values')
  })

  it('allows Cordis, schemastery, and utility subpaths', () => {
    expect(classifyPlatformImport('@deepseek-ai/cordis')).toBe('allowed')
    expect(classifyPlatformImport('@deepseek-ai/schemastery')).toBe('allowed')
    expect(classifyPlatformImport('@deepseek-ai/dsh-util-time/types')).toBe('allowed')
  })

  it('allows builtins, relative modules, and packages outside the DSH scope', () => {
    expect(classifyPlatformImport('node:fs')).toBe('allowed')
    expect(classifyPlatformImport('react')).toBe('allowed')
    expect(classifyPlatformImport('./helper.ts')).toBe('allowed')
    expect(classifyPlatformImport('../src/index.ts')).toBe('allowed')
  })

  it('allows a bare scope with no package name', () => {
    expect(classifyPlatformImport('@deepseek-ai')).toBe('allowed')
  })

  it('forbids every other dsh package, including subpaths', () => {
    expect(classifyPlatformImport('@deepseek-ai/dsh-agent-loop')).toBe('forbidden')
    expect(classifyPlatformImport('@deepseek-ai/dsh-agent-loop/internal')).toBe('forbidden')
    expect(classifyPlatformImport('@deepseek-ai/dsh-llm-deepseek')).toBe('forbidden')
  })
})

describe('extractModuleSpecifiers', () => {
  it('recognizes static, side-effect, re-export, dynamic, and require forms in appearance order', () => {
    const source = [
      "import value from 'spec-static'",
      "import 'spec-side-effect'",
      "export { value } from 'spec-export'",
      "export * from 'spec-export-star'",
      "const lazy = import('spec-dynamic')",
      "const required = require('spec-require')",
    ].join('\n')
    expect(extractModuleSpecifiers(source)).toEqual([
      'spec-static',
      'spec-side-effect',
      'spec-export',
      'spec-export-star',
      'spec-dynamic',
      'spec-require',
    ])
  })

  it('returns each specifier once and reports an empty source as empty', () => {
    const source = [
      "import { a } from 'duplicate'",
      "import { b } from 'duplicate'",
      'const value = 1',
    ].join('\n')
    expect(extractModuleSpecifiers(source)).toEqual(['duplicate'])
    expect(extractModuleSpecifiers('')).toEqual([])
  })

  it('handles a multiline named import and double quotes', () => {
    const source = [
      'import {',
      '  one,',
      '  two,',
      '} from "multiline-target"',
    ].join('\n')
    expect(extractModuleSpecifiers(source)).toEqual(['multiline-target'])
  })

  it('returns nothing for source with no import forms', () => {
    expect(extractModuleSpecifiers('const value = 1\nexport const other = value\n')).toEqual([])
  })
})
