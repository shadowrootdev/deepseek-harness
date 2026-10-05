/**
 * Real Loader composition: a Platform-owned consumer mounted from `cordis.yml`
 * beside the shipped runtime plugins.
 *
 * The composition harness names concrete runtime packages (`dsh-agent-loop`,
 * `dsh-session-projection`, `dsh-system-prompt`, the Cordis Loader and Include)
 * because it assembles the runtime. The consumer under test is
 * `tests/support/platform-observer.ts`, and it imports only Service Definitions.
 *
 * @module
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture, type PreToolDecision } from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from '../../../../core/agent-loop/tests/mock-adapter.ts'
import type { Config, PlatformObserver } from '../support/platform-observer.ts'

let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  context = undefined
  root = undefined
})

/** The platform consumer's read model, asserted present after the composition mounts. */
function observerOf(ctx: Context): PlatformObserver {
  const observer = ctx.get('platformObserver') as PlatformObserver | undefined
  if (observer === undefined) throw new Error('platform observer was not provided by the composition')
  return observer
}

/**
 * Boot the real Loader composition from a temporary `cordis.yml`.
 * @param config - optional policy config for the mounted platform consumer.
 * @returns the mounted context, owned by the caller's teardown.
 */
async function mountComposition(config?: Config): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-platform-boundary-'))
  const configPath = join(root, 'cordis.yml')
  const observerPath = pathToFileURL(resolve(import.meta.dirname, '..', 'support', 'platform-observer.ts')).href
  const lines = [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-agent-loop'",
    `- name: '${observerPath}'`,
  ]
  if (config !== undefined) {
    lines.push('  config:')
    for (const [key, value] of Object.entries(config)) lines.push(`    ${key}: ${JSON.stringify(value)}`)
  }
  await writeFile(configPath, `${lines.join('\n')}\n`)

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = `${pathToFileURL(root).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  // Without a Node internal loader the Loader imports bare names through this
  // test runner's module graph, which resolves workspace packages to `src`.
  ctx.loader.internal = undefined
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  return ctx
}

/** Send one ordinary user turn. */
function send(agent: { followup(message: ReturnType<typeof createUserMessage>): void }, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

it('loads the real composition and the platform consumer', { timeout: 60_000 }, async () => {
  const ctx = await mountComposition()
  expect(ctx.get('agentLoop')).toBeDefined()
  expect(ctx.get('platformObserver')).toBeDefined()
  expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
})

it('observes lifecycle and the Agent identity reached at the tools extension point', { timeout: 60_000 }, async () => {
  const ctx = await mountComposition()
  const adapter = new MockAdapter([toolCallResponse('c1', 'observe', {}), textResponse('done')])
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.tools.register(defineContentToolFixture({
    name: 'observe',
    description: 'observe the identity reached from policy',
    parameters: {},
    async execute() { return [{ type: 'text', text: 'observed' }] },
  }))

  const agent = await ctx.agentLoop.create(SessionId('platform-agent'), { provider: 'mock', model: 'mock' })
  send(agent, 'observe yourself')
  await agent.whenIdle()

  const { observations } = observerOf(ctx)
  expect(agent.id).toBe(agent.session.id)
  expect(observations.created).toHaveLength(1)
  expect(observations.created[0]).toMatchObject({ agentId: 'platform-agent', sessionId: 'platform-agent' })
  expect(observations.statuses.map(observation => observation.status)).toContain('running')
  expect(observations.statuses.map(observation => observation.status)).toContain('idle')
  expect(observations.sessionEvents.map(observation => observation.type)).toContain('turn/start')
  expect(observations.sessionEvents.map(observation => observation.type)).toContain('turn/end')
  expect(observations.turnStopping).toContainEqual({ agentId: 'platform-agent', turn: 1 })
  expect(observations.toolCalls).toContainEqual({ toolName: 'observe', agentId: 'platform-agent' })
})

it('observes cancellation through the turn signal and the durable turn end', { timeout: 60_000 }, async () => {
  const ctx = await mountComposition()
  const adapter = new MockAdapter(['hang'])
  ctx.llm.registerAdapter(['mock'], adapter)

  const agent = await ctx.agentLoop.create(SessionId('platform-cancel'), { provider: 'mock', model: 'mock' })
  send(agent, 'cancel me')
  await expect.poll(() => adapter.requests.length).toBe(1)
  agent.cancel({ kind: 'user' })
  await agent.whenIdle()

  const { observations } = observerOf(ctx)
  expect(observations.turnEnds).toContainEqual({
    sessionId: 'platform-cancel',
    reason: { kind: 'aborted', reason: { kind: 'user' } },
  })
  expect(observations.requestAborts).toContainEqual({ agentId: 'platform-cancel', reason: { kind: 'user' } })
})

it('fails closed when an ask has no approval seam: the tool body never runs', { timeout: 60_000 }, async () => {
  const ctx = await mountComposition({ tool: 'guarded', decision: 'ask', reason: 'needs a human' })
  let executions = 0
  ctx.tools.register(defineContentToolFixture({
    name: 'guarded',
    description: 'must not run without an approval seam',
    parameters: {},
    async execute() { executions += 1; return [{ type: 'text', text: 'ran' }] },
  }))

  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('ask-1'),
    name: 'guarded',
    arguments: {},
  })

  expect(executions).toBe(0)
  expect(result.isError).toBe(true)
  const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
  expect(text).toContain('needs a human')
  expect(observerOf(ctx).observations.policy).toContainEqual({ toolName: 'guarded', decision: 'ask' })
})

it('keeps a guard denial monotonic when a later pre-execute listener allows', { timeout: 60_000 }, async () => {
  const ctx = await mountComposition({ tool: 'guarded', guardReason: 'platform guard: denied' })
  let executions = 0
  ctx.tools.register(defineContentToolFixture({
    name: 'guarded',
    description: 'must not run under the platform guard',
    parameters: {},
    async execute() { executions += 1; return [{ type: 'text', text: 'ran' }] },
  }))
  // A later listener that tries to allow the call cannot reverse the guard.
  ctx.on('tools/pre-execute', async (): Promise<PreToolDecision> => ({ kind: 'allow' }))

  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('guard-1'),
    name: 'guarded',
    arguments: {},
  })

  expect(executions).toBe(0)
  expect(result.isError).toBe(true)
  const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
  expect(text).toContain('platform guard: denied')
  expect(observerOf(ctx).observations.guardDenials).toContainEqual({ toolName: 'guarded', reason: 'platform guard: denied' })
})
