/**
 * Real Loader composition: the shipped platform consumer mounted from a
 * test-only `cordis.yml` beside the runtime Service Definitions it drives.
 *
 * The harness names concrete runtime packages because it assembles the
 * runtime; the consumer is mounted by file URL and imports only Service
 * Definitions. Only the model (`MockAdapter`) is mocked.
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
import type { JobHooks } from '@deepseek-ai/dsh-jobs'
import { defineContentToolFixture, type PreToolDecision } from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from '../../../../core/agent-loop/tests/mock-adapter.ts'
import type { Config, PlatformConsumer } from '../../src/index.ts'

let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  context = undefined
  root = undefined
})

/** The consumer's read model, asserted present after the composition mounts. */
function consumerOf(ctx: Context): PlatformConsumer {
  const consumer: PlatformConsumer | undefined = ctx.get('platformConsumer')
  if (consumer === undefined) throw new Error('platform consumer was not provided by the composition')
  return consumer
}

/** Send one ordinary user turn. */
function send(agent: { followup(message: ReturnType<typeof createUserMessage>): void }, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

/** Boot the real Loader composition from a temporary `cordis.yml`. */
async function mountComposition(config?: Config): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-platform-consumer-'))
  const configPath = join(root, 'cordis.yml')
  const consumerPath = pathToFileURL(resolve(import.meta.dirname, '..', '..', 'src', 'index.ts')).href
  const lines = [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-agent-loop'",
    "- name: '@deepseek-ai/dsh-subagent'",
    "- name: '@deepseek-ai/dsh-subagent-spawn-in-process'",
    '  config:',
    '    providerName: spawn',
    "- name: '@deepseek-ai/dsh-jobs-local'",
    "- name: '@deepseek-ai/dsh-tool-jobs'",
    `- name: '${consumerPath}'`,
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

it('loads the real composition and provides the platform consumer', { timeout: 60_000 }, async () => {
  const ctx = await mountComposition({ projectId: 'project-a' })
  expect(ctx.get('agentLoop')).toBeDefined()
  expect(ctx.get('platformConsumer')).toBeDefined()
  expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
})

it('assigns lateral identities and records read-only lifecycle facts', { timeout: 60_000 }, async () => {
  const ctx = await mountComposition({ projectId: 'project-a', runId: 'run-fixed' })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([toolCallResponse('c1', 'observe', {}), textResponse('done')]))
  ctx.tools.register(defineContentToolFixture({
    name: 'observe',
    description: 'observe the identity reached from policy',
    parameters: {},
    async execute() { return [{ type: 'text', text: 'observed' }] },
  }))

  const agent = await ctx.agentLoop.create(SessionId('platform-agent'), { provider: 'mock', model: 'mock' })
  send(agent, 'observe yourself')
  await agent.whenIdle()

  const consumer = consumerOf(ctx)
  const identity = consumer.metadataFor(agent.id)
  expect(identity).toBeDefined()
  expect(identity).toMatchObject({ projectId: 'project-a', runId: 'run-fixed' })
  expect(identity?.taskId).toBeTruthy()
  expect(consumer.observations.created[0]).toMatchObject({ agentId: 'platform-agent', projectId: 'project-a', runId: 'run-fixed' })
  expect(consumer.observations.sessionEvents.map(entry => entry.type)).toContain('turn/start')
  expect(consumer.observations.sessionEvents.map(entry => entry.type)).toContain('turn/end')
  expect(consumer.observations.toolCalls).toContainEqual({ toolName: 'observe', agentId: 'platform-agent' })
  expect(consumer.observations.llmProviders).toContain('mock')

  // Lateral identities never enter the durable session log.
  const eventKeys = agent.session.snapshotEvents().flatMap(event => Object.keys(event.data))
  expect(eventKeys).not.toContain('projectId')
  expect(eventKeys).not.toContain('runId')
  expect(eventKeys).not.toContain('taskId')
})

it('propagates project and run to a real in-process child and mints a distinct task', { timeout: 60_000 }, async () => {
  const ctx = await mountComposition({ projectId: 'project-a', runId: 'run-fixed' })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('child answer')]))
  const parent = await ctx.agentLoop.create(SessionId('parent-agent'), { provider: 'mock', model: 'mock' })
  const run = await ctx.subagents.start('spawn', {
    prompt: [{ type: 'text', text: 'child task' }],
    parent,
    signal: new AbortController().signal,
  })
  await run.result

  const consumer = consumerOf(ctx)
  const parentIdentity = consumer.metadataFor(parent.id)
  const childIdentity = consumer.metadataFor(run.id)
  expect(parentIdentity).toBeDefined()
  expect(childIdentity).toBeDefined()
  expect(childIdentity?.projectId).toBe('project-a')
  expect(childIdentity?.runId).toBe('run-fixed')
  expect(childIdentity?.runId).toBe(parentIdentity?.runId)
  expect(childIdentity?.taskId).not.toBe(parentIdentity?.taskId)
  expect(consumer.observations.subagentRuns.some(info => info.provider === 'spawn')).toBe(true)
  await run.dispose()
})

it('denies fail-closed an unmatched call while a matching ask stops the body', { timeout: 60_000 }, async () => {
  const ctx = await mountComposition({
    projectId: 'project-a',
    policy: [{ tool: 'guarded', decision: 'ask', reason: 'needs a human' }],
  })
  let executions = 0
  for (const name of ['guarded', 'other']) {
    ctx.tools.register(defineContentToolFixture({
      name,
      description: name,
      parameters: {},
      async execute() { executions += 1; return [{ type: 'text', text: 'ran' }] },
    }))
  }
  const agent = await ctx.agentLoop.create(SessionId('policy-agent'), { provider: 'mock', model: 'mock' })
  const signal = new AbortController().signal

  const asked = await ctx.tools.execute({ signal, callId: ToolCallId('ask-1'), name: 'guarded', arguments: {}, agent })
  expect(asked.isError).toBe(true)
  const askedText = asked.content[0]?.type === 'text' ? asked.content[0].text : ''
  expect(askedText).toContain('needs a human')

  const unmatched = await ctx.tools.execute({ signal, callId: ToolCallId('deny-1'), name: 'other', arguments: {}, agent })
  expect(unmatched.isError).toBe(true)
  const unmatchedText = unmatched.content[0]?.type === 'text' ? unmatched.content[0].text : ''
  expect(unmatchedText).toContain('no matching rule')

  expect(executions).toBe(0)
})

it('keeps a monotone guard denial despite a later allow listener', { timeout: 60_000 }, async () => {
  const ctx = await mountComposition({
    projectId: 'project-a',
    policy: [
      { tool: 'guarded', decision: 'allow' },
      { tool: 'guarded', decision: 'deny', monotone: true, reason: 'platform guard: denied' },
    ],
  })
  let executions = 0
  ctx.tools.register(defineContentToolFixture({
    name: 'guarded',
    description: 'must not run under the monotone guard',
    parameters: {},
    async execute() { executions += 1; return [{ type: 'text', text: 'ran' }] },
  }))
  // A later listener that allows the call cannot reverse the guard.
  ctx.on('tools/pre-execute', async (): Promise<PreToolDecision> => ({ kind: 'allow' }))

  const agent = await ctx.agentLoop.create(SessionId('guard-agent'), { provider: 'mock', model: 'mock' })
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('guard-1'),
    name: 'guarded',
    arguments: {},
    agent,
  })

  expect(executions).toBe(0)
  expect(result.isError).toBe(true)
  const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
  expect(text).toContain('platform guard: denied')
  expect(consumerOf(ctx).observations.guardDenials).toContainEqual({ toolName: 'guarded', reason: 'platform guard: denied' })
})

it('attributes an owned background job in the read-only observation', { timeout: 60_000 }, async () => {
  const ctx = await mountComposition({ projectId: 'project-a' })
  await ctx.agentLoop.create(SessionId('job-owner'), { provider: 'mock', model: 'mock' })
  const jobId = ctx.jobs.start({
    kind: 'subagent',
    label: 'platform job',
    owner: SessionId('job-owner'),
    run: (): JobHooks => ({ cancel: () => {}, done: Promise.resolve({ status: 'completed' }) }),
  })
  expect(ctx.jobs.get(jobId, SessionId('job-owner'))).toBeDefined()
  expect(consumerOf(ctx).observations.jobs).toContainEqual({ jobId, owner: 'job-owner', type: 'registered' })
})

it('ignores a background job whose owner the consumer does not track', { timeout: 60_000 }, async () => {
  const ctx = await mountComposition({ projectId: 'project-a' })
  const jobId = ctx.jobs.start({
    kind: 'subagent',
    label: 'unowned job',
    run: (): JobHooks => ({ cancel: () => {}, done: Promise.resolve({ status: 'completed' }) }),
  })
  expect(ctx.jobs.get(jobId)).toBeDefined()
  expect(consumerOf(ctx).observations.jobs.some(entry => entry.jobId === jobId)).toBe(false)
})

it('records cancellation on the turn signal and the durable turn end', { timeout: 60_000 }, async () => {
  const ctx = await mountComposition({ projectId: 'project-a' })
  const adapter = new MockAdapter(['hang'])
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('cancel-agent'), { provider: 'mock', model: 'mock' })
  send(agent, 'cancel me')
  await expect.poll(() => adapter.requests.length).toBe(1)
  agent.cancel({ kind: 'user' })
  await agent.whenIdle()

  const consumer = consumerOf(ctx)
  expect(consumer.observations.turnEnds).toContainEqual({
    sessionId: 'cancel-agent',
    reason: { kind: 'aborted', reason: { kind: 'user' } },
  })
  expect(consumer.observations.requestAborts).toContainEqual({ agentId: 'cancel-agent', reason: { kind: 'user' } })
})

it('applies the fail-closed default to a call without an agent', { timeout: 60_000 }, async () => {
  const ctx = await mountComposition({ projectId: 'project-a', policy: [{ tool: 'guarded', decision: 'allow' }] })
  ctx.tools.register(defineContentToolFixture({
    name: 'other',
    description: 'other',
    parameters: {},
    async execute() { return [{ type: 'text', text: 'ran' }] },
  }))
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('no-agent-1'),
    name: 'other',
    arguments: {},
  })
  expect(result.isError).toBe(true)
  const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
  expect(text).toContain('no agent')
})

it('refuses a call without an agent even when a filterless allow rule would match', { timeout: 60_000 }, async () => {
  const ctx = await mountComposition({ projectId: 'project-a', policy: [{ decision: 'allow' }] })
  ctx.tools.register(defineContentToolFixture({
    name: 'other',
    description: 'other',
    parameters: {},
    async execute() { return [{ type: 'text', text: 'ran' }] },
  }))
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('no-agent-allow-1'),
    name: 'other',
    arguments: {},
  })
  expect(result.isError).toBe(true)
  const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
  expect(text).toContain('no agent')
})

it('exposes every task with its lateral identities', { timeout: 60_000 }, async () => {
  const ctx = await mountComposition({ projectId: 'project-a', runId: 'run-fixed' })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('done')]))
  await ctx.agentLoop.create(SessionId('task-agent'), { provider: 'mock', model: 'mock' })
  const task = consumerOf(ctx).tasks().find(entry => entry.sessionId === 'task-agent')
  expect(task).toMatchObject({ projectId: 'project-a', runId: 'run-fixed' })
  expect(task?.taskId).toBeTruthy()
})

it('rejects an invalid observation limit at load', { timeout: 60_000 }, async () => {
  await expect(mountComposition({ projectId: 'project-a', observationLimit: 0 }))
    .rejects.toThrow(/observationLimit must be a positive safe integer/)
})

it('rejects a non-integer observation limit at load', { timeout: 60_000 }, async () => {
  await expect(mountComposition({ projectId: 'project-a', observationLimit: 1.5 }))
    .rejects.toThrow(/observationLimit must be a positive safe integer/)
})

it('skips a non-matching monotone rule and applies the default guard reason', { timeout: 60_000 }, async () => {
  const ctx = await mountComposition({
    projectId: 'project-a',
    policy: [
      { tool: 'elsewhere', decision: 'deny', monotone: true, reason: 'never matches' },
      { tool: 'guarded', decision: 'allow' },
      { tool: 'guarded', decision: 'deny', monotone: true },
    ],
  })
  let executions = 0
  ctx.tools.register(defineContentToolFixture({
    name: 'guarded',
    description: 'must not run under the monotone guard',
    parameters: {},
    async execute() { executions += 1; return [{ type: 'text', text: 'ran' }] },
  }))
  const agent = await ctx.agentLoop.create(SessionId('guard-branch-agent'), { provider: 'mock', model: 'mock' })
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('guard-branch-1'),
    name: 'guarded',
    arguments: {},
    agent,
  })
  expect(executions).toBe(0)
  expect(result.isError).toBe(true)
  const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
  expect(text).toContain('platform policy: deny')
})
