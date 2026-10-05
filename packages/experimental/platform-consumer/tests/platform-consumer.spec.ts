import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  PlatformProjectId,
  PlatformRunId,
  PlatformTaskId,
  apply,
  appendObservation,
  boundReason,
  derivePlatformMetadata,
  matchesPolicyRule,
  metadataFor,
  monotoneGuardRules,
  policyDecision,
  providerIds,
  type PlatformConsumer,
  type PlatformMetadata,
  type PlatformPolicyRule,
} from '../src/index.ts'

const metadata: PlatformMetadata = {
  projectId: PlatformProjectId('project-1'),
  runId: PlatformRunId('run-1'),
  taskId: PlatformTaskId('task-1'),
}

/** A fresh task-id minter whose ids reveal call order. */
function taskMinter(): () => ReturnType<typeof PlatformTaskId> {
  let count = 0
  return () => PlatformTaskId(`task-${++count}`)
}

describe('matchesPolicyRule', () => {
  it('matches on the tool name and on each lateral identity', () => {
    expect(matchesPolicyRule({ decision: 'allow', tool: 'bash' }, metadata, 'bash')).toBe(true)
    expect(matchesPolicyRule({ decision: 'allow', tool: 'bash' }, metadata, 'read')).toBe(false)
    expect(matchesPolicyRule({ decision: 'deny', projectId: 'project-1' }, metadata, 'bash')).toBe(true)
    expect(matchesPolicyRule({ decision: 'deny', projectId: 'project-2' }, metadata, 'bash')).toBe(false)
    expect(matchesPolicyRule({ decision: 'deny', runId: 'run-1', taskId: 'task-1' }, metadata, 'bash')).toBe(true)
    expect(matchesPolicyRule({ decision: 'deny', taskId: 'task-9' }, metadata, 'bash')).toBe(false)
    expect(matchesPolicyRule({ decision: 'deny', runId: 'other-run' }, metadata, 'bash')).toBe(false)
    expect(matchesPolicyRule({ decision: 'deny', projectId: 'project-1', runId: 'run-1', taskId: 'other-task' }, metadata, 'bash')).toBe(false)
  })

  it('requires every declared identity filter the rule carries', () => {
    expect(matchesPolicyRule({ decision: 'deny', tool: 'bash' }, undefined, 'bash')).toBe(true)
    expect(matchesPolicyRule({ decision: 'deny', taskId: 'task-1' }, undefined, 'bash')).toBe(false)
  })
})

describe('policyDecision', () => {
  it('imposes nothing when the policy is absent or empty', () => {
    expect(policyDecision(undefined, metadata, 'bash')).toBeUndefined()
    expect(policyDecision([], metadata, 'bash')).toBeUndefined()
  })

  it('delegates on a matching allow rule', () => {
    const policy: PlatformPolicyRule[] = [{ decision: 'allow', tool: 'bash' }]
    expect(policyDecision(policy, metadata, 'bash')).toBeUndefined()
  })

  it('returns the matching deny or ask decision with its reason', () => {
    expect(policyDecision([{ decision: 'deny', tool: 'bash', reason: 'blocked' }], metadata, 'bash'))
      .toEqual({ decision: 'deny', reason: 'blocked' })
    expect(policyDecision([{ decision: 'ask', tool: 'bash' }], metadata, 'bash'))
      .toEqual({ decision: 'ask', reason: 'platform policy: ask' })
  })

  it('fails closed when a non-empty policy has no matching rule', () => {
    const policy: PlatformPolicyRule[] = [{ decision: 'allow', tool: 'bash' }]
    expect(policyDecision(policy, metadata, 'read'))
      .toEqual({ decision: 'deny', reason: 'platform policy: no matching rule' })
  })

  it('lets the first matching rule win', () => {
    const policy: PlatformPolicyRule[] = [
      { decision: 'allow', tool: 'bash' },
      { decision: 'deny', tool: 'bash', reason: 'later' },
    ]
    expect(policyDecision(policy, metadata, 'bash')).toBeUndefined()
  })

  it('refuses a call with no agent under a non-empty policy, even against a filterless allow rule', () => {
    expect(policyDecision([{ decision: 'allow' }], undefined, 'bash'))
      .toEqual({ decision: 'deny', reason: 'platform policy: call has no agent' })
    expect(policyDecision([{ decision: 'allow', tool: 'bash' }], undefined, 'bash'))
      .toEqual({ decision: 'deny', reason: 'platform policy: call has no agent' })
  })
})

describe('appendObservation', () => {
  it('retains every entry while the ring is under its limit', () => {
    const list: number[] = []
    appendObservation(list, 1, 2)
    appendObservation(list, 2, 2)
    expect(list).toEqual([1, 2])
  })

  it('evicts the oldest entry once the ring reaches its limit', () => {
    const list: number[] = []
    appendObservation(list, 1, 2)
    appendObservation(list, 2, 2)
    appendObservation(list, 3, 2)
    expect(list).toEqual([2, 3])
  })
})

describe('boundReason', () => {
  it('strips control characters', () => {
    expect(boundReason('a\u0000b\nc\u001bd')).toBe('a b c d')
  })

  it('caps a reason longer than 500 characters without splitting the cap', () => {
    const bounded = boundReason('x'.repeat(600))
    expect(bounded).toHaveLength(500)
    expect(bounded.endsWith('…')).toBe(true)
  })
})

describe('monotoneGuardRules', () => {
  it('selects only deny rules marked monotone', () => {
    const policy: PlatformPolicyRule[] = [
      { decision: 'deny', tool: 'a', monotone: true },
      { decision: 'deny', tool: 'b' },
      { decision: 'allow', tool: 'c', monotone: true },
      { decision: 'ask', tool: 'd', monotone: true },
    ]
    expect(monotoneGuardRules(policy).map(rule => rule.tool)).toEqual(['a'])
    expect(monotoneGuardRules(undefined)).toEqual([])
  })
})

describe('derivePlatformMetadata', () => {
  it('assigns the base identities and a fresh task to a root agent', () => {
    const mint = taskMinter()
    expect(derivePlatformMetadata(undefined, { projectId: metadata.projectId, runId: metadata.runId }, mint))
      .toEqual({ projectId: 'project-1', runId: 'run-1', taskId: 'task-1' })
  })

  it('inherits project and run from the parent but mints a distinct task', () => {
    const mint = taskMinter()
    expect(derivePlatformMetadata(
      metadata,
      { projectId: PlatformProjectId('other-project'), runId: PlatformRunId('other-run') },
      mint,
    )).toEqual({ projectId: 'project-1', runId: 'run-1', taskId: 'task-1' })
  })
})

describe('metadataFor', () => {
  it('resolves a tracked agent and ignores an unattributed call', () => {
    const tracked = new Map([[SessionId('session-1'), metadata]])
    expect(metadataFor(tracked, { id: SessionId('session-1') })).toBe(metadata)
    expect(metadataFor(tracked, undefined)).toBeUndefined()
  })
})

describe('providerIds', () => {
  it('lists registered provider ids and handles an absent llm service', () => {
    expect(providerIds(undefined)).toEqual([])
    expect(providerIds({ listProviders: () => [{ id: 'mock' }, { id: 'other' }] })).toEqual(['mock', 'other'])
  })
})

describe('apply without a policy', () => {
  it('mounts the identity-only service when no policy is configured', () => {
    const ctx = new Context()
    apply(ctx, { projectId: 'project-x' })
    const consumer: PlatformConsumer | undefined = ctx.get('platformConsumer')
    expect(consumer).toBeDefined()
    expect(consumer?.tasks()).toEqual([])
  })
})
