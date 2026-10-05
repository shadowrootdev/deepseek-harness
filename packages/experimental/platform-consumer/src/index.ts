/**
 * Platform-owned consumer over the DeepSeek Runtime Service Definitions.
 *
 * The consumer attaches lateral `projectId`/`runId`/`taskId` identities to the
 * Agents it observes, installs a fail-closed monotonic tool policy on
 * `tools/pre-execute` and `ctx.tools.guard()`, and records read-only facts from
 * the runtime's existing events. It imports only Service Definitions, Cordis,
 * `schemastery`, and `dsh-brand`, never a concrete implementation package.
 *
 * @module
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentStatus } from '@deepseek-ai/dsh-agent'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { JobEvent, JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentRunEndInfo, SubagentRunInfo } from '@deepseek-ai/dsh-subagent'
import type { PreToolDecision, ToolExecution, ToolGuard } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

/** Platform project identity, distinct from a Session or Agent id. */
export type PlatformProjectId = Branded<'PlatformProjectId'>
/** Platform run identity: minted once per mounted consumer, inherited by delegated children. */
export type PlatformRunId = Branded<'PlatformRunId'>
/** Platform task identity, minted per Agent. */
export type PlatformTaskId = Branded<'PlatformTaskId'>

/**
 * Brand a raw string as a {@link PlatformProjectId}.
 * @param id - the raw platform project id.
 * @returns the same string with the project-id brand.
 */
export function PlatformProjectId(id: string): PlatformProjectId {
  return brandString<PlatformProjectId>(id)
}

/**
 * Brand a raw string as a {@link PlatformRunId}.
 * @param id - the raw platform run id.
 * @returns the same string with the run-id brand.
 */
export function PlatformRunId(id: string): PlatformRunId {
  return brandString<PlatformRunId>(id)
}

/**
 * Brand a raw string as a {@link PlatformTaskId}.
 * @param id - the raw platform task id.
 * @returns the same string with the task-id brand.
 */
export function PlatformTaskId(id: string): PlatformTaskId {
  return brandString<PlatformTaskId>(id)
}

/** Lateral identities the consumer attaches to one Agent/Session. */
export interface PlatformMetadata {
  readonly projectId: PlatformProjectId
  readonly runId: PlatformRunId
  readonly taskId: PlatformTaskId
}

/** One tool-policy rule, evaluated on `tools/pre-execute` and, when monotone, as a guard. */
export interface PlatformPolicyRule {
  /** Tool name the rule applies to; absent matches every call. */
  readonly tool?: string
  /** Required project id; absent matches every project. */
  readonly projectId?: string
  /** Required run id; absent matches every run. */
  readonly runId?: string
  /** Required task id; absent matches every task. */
  readonly taskId?: string
  /** Pre-execute decision the rule installs. */
  readonly decision: 'allow' | 'deny' | 'ask'
  /** Reason carried by a deny or ask decision. */
  readonly reason?: string
  /** When true on a deny rule, the denial is also enforced monotonically by a guard. */
  readonly monotone?: boolean
}

/** One task's lateral identities and its owning session. */
export interface PlatformTaskView extends PlatformMetadata {
  readonly sessionId: SessionId
}

/** Facts the consumer recorded from the runtime's existing extension points. */
export interface PlatformObservation {
  readonly created: Array<{ agentId: string; sessionId: string; source: string; projectId: string; runId: string; taskId: string }>
  readonly statuses: Array<{ agentId: string; status: AgentStatus }>
  readonly sessionEvents: Array<{ sessionId: string; type: string }>
  readonly turnStopping: Array<{ agentId: string; turn: number }>
  readonly turnEnds: Array<{ sessionId: string; reason: unknown }>
  readonly requestAborts: Array<{ agentId: string; reason: unknown }>
  readonly toolCalls: Array<{ toolName: string; agentId?: string }>
  readonly policyDecisions: Array<{ toolName: string; decision: 'deny' | 'ask' }>
  readonly guardDenials: Array<{ toolName: string; reason: string }>
  readonly subagentRuns: Array<{ runId: string; provider: string; id: string; local: boolean }>
  readonly subagentEnds: Array<{ runId: string; stopReason: unknown }>
  readonly jobs: Array<{ jobId: string; owner?: string; type: string }>
  /** Provider routes available when each task was first observed. */
  readonly llmProviders: string[]
}

/** Read-only service the consumer provides on `ctx.platformConsumer`. */
export interface PlatformConsumer {
  /** Lateral identities for a session, or undefined when the consumer has not seen it. */
  metadataFor(sessionId: SessionId): PlatformMetadata | undefined
  /** Every task the consumer has assigned identities to. */
  tasks(): readonly PlatformTaskView[]
  /** Every fact recorded since the plugin loaded. */
  readonly observations: PlatformObservation
}

/** One pre-execute outcome the policy layer delivers for a call. */
export interface PlatformPolicyDecision {
  readonly decision: 'deny' | 'ask'
  readonly reason: string
}

/** Plugin config the Loader validates against {@link Config}. */
export interface Config {
  /** Platform project this mounted consumer drives. */
  readonly projectId: string
  /** Run identity to reuse; absent mints one per mount. */
  readonly runId?: string
  /** Fail-closed policy rules; absent installs no policy and imposes nothing. */
  readonly policy?: readonly PlatformPolicyRule[]
  /** Maximum retained entries per observation ring; defaults to 1000. */
  readonly observationLimit?: number
}

/** Schemastery schema the Loader validates the mounted config against. */
export const Config = z.object({
  projectId: z.string().required(),
  runId: z.string(),
  policy: z.array(z.object({
    tool: z.string(),
    projectId: z.string(),
    runId: z.string(),
    taskId: z.string(),
    decision: z.union(['allow', 'deny', 'ask'] as const).required(),
    reason: z.string(),
    monotone: z.boolean(),
  })),
  observationLimit: z.number(),
})

/** Function-plugin name the Loader mounts this consumer under. */
export const name = 'platform-consumer'

/** Services the consumer's policy and identity contributions require. */
export const inject = ['tools', 'agents']

/**
 * Whether a rule matches one call's tool name and lateral identities.
 * @param rule - the policy rule to test.
 * @param metadata - the call agent's identities, or undefined when the agent is untracked.
 * @param toolName - the tool name of the call.
 * @returns true when every filter the rule declares matches.
 */
export function matchesPolicyRule(rule: PlatformPolicyRule, metadata: PlatformMetadata | undefined, toolName: string): boolean {
  if (rule.tool !== undefined && rule.tool !== toolName) return false
  if (metadata === undefined) {
    return rule.projectId === undefined && rule.runId === undefined && rule.taskId === undefined
  }
  if (rule.projectId !== undefined && rule.projectId !== metadata.projectId) return false
  if (rule.runId !== undefined && rule.runId !== metadata.runId) return false
  if (rule.taskId !== undefined && rule.taskId !== metadata.taskId) return false
  return true
}

/**
 * Append one observation, evicting the oldest entry when the ring is full.
 * @param list - the bounded observation ring.
 * @param entry - the entry to append.
 * @param limit - maximum retained entries.
 * @returns nothing.
 */
export function appendObservation<T>(list: T[], entry: T, limit: number): void {
  if (list.length >= limit) list.shift()
  list.push(entry)
}

/** Maximum length of a model-facing policy reason. */
const MAX_REASON_LENGTH = 500

/**
 * Strip control characters and cap a model-facing policy reason.
 * @param reason - configured or generated reason text.
 * @returns the bounded, control-character-free reason.
 */
export function boundReason(reason: string): string {
  const stripped = reason.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
  return stripped.length > MAX_REASON_LENGTH ? `${stripped.slice(0, MAX_REASON_LENGTH - 1)}…` : stripped
}

/**
 * Decide one call from the configured policy.
 *
 * A non-empty policy refuses every call with no tracked agent, before any rule
 * is matched, so a filterless allow rule cannot admit an untracked caller.
 *
 * @param policy - configured rules; absent or empty imposes nothing.
 * @param metadata - the call agent's identities, or undefined when untracked.
 * @param toolName - the tool name of the call.
 * @returns a deny/ask decision, or undefined to delegate to the next listener.
 */
export function policyDecision(
  policy: readonly PlatformPolicyRule[] | undefined,
  metadata: PlatformMetadata | undefined,
  toolName: string,
): PlatformPolicyDecision | undefined {
  if (policy === undefined || policy.length === 0) return undefined
  if (metadata === undefined) return { decision: 'deny', reason: boundReason('platform policy: call has no agent') }
  for (const rule of policy) {
    if (!matchesPolicyRule(rule, metadata, toolName)) continue
    if (rule.decision === 'allow') return undefined
    return { decision: rule.decision, reason: boundReason(rule.reason ?? `platform policy: ${rule.decision}`) }
  }
  return { decision: 'deny', reason: boundReason('platform policy: no matching rule') }
}

/**
 * Select the rules enforced monotonically by a guard.
 * @param policy - configured rules.
 * @returns the deny rules marked monotone.
 */
export function monotoneGuardRules(policy: readonly PlatformPolicyRule[] | undefined): readonly PlatformPolicyRule[] {
  return (policy ?? []).filter(rule => rule.decision === 'deny' && rule.monotone === true)
}

/**
 * Derive a child's identities from its parent's.
 * @param parent - the parent task's identities, or undefined for a root agent.
 * @param base - project and run identities assigned to a root agent.
 * @param mintTaskId - mints a fresh task identity.
 * @returns the assigned identities, always with a fresh task id.
 */
export function derivePlatformMetadata(
  parent: PlatformMetadata | undefined,
  base: { readonly projectId: PlatformProjectId; readonly runId: PlatformRunId },
  mintTaskId: () => PlatformTaskId,
): PlatformMetadata {
  return {
    projectId: parent?.projectId ?? base.projectId,
    runId: parent?.runId ?? base.runId,
    taskId: mintTaskId(),
  }
}

/**
 * Resolve an execution's lateral identities from its Agent.
 * @param metadata - the tracked-identity map.
 * @param agent - the executing Agent, or undefined for an unattributed call.
 * @returns the Agent's identities, or undefined when it is absent or untracked.
 */
export function metadataFor(
  metadata: ReadonlyMap<SessionId, PlatformMetadata>,
  agent: { readonly id: SessionId } | undefined,
): PlatformMetadata | undefined {
  return agent === undefined ? undefined : metadata.get(agent.id)
}

/**
 * Provider route ids currently registered with the optional llm service.
 * @param llm - the llm service, or undefined when none is mounted.
 * @returns the registered provider ids, or an empty list.
 */
export function providerIds(llm: { listProviders(): readonly { readonly id: string }[] } | undefined): string[] {
  return llm === undefined ? [] : llm.listProviders().map(provider => provider.id)
}

/**
 * Mount the consumer's identity, policy, and observation contributions.
 * @param ctx - plugin context whose fiber owns every listener and guard.
 * @param config - policy the Loader validated against {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const baseProjectId = PlatformProjectId(config.projectId)
  const baseRunId = PlatformRunId(config.runId ?? randomUUID())
  const policy = config.policy ?? []
  if (config.observationLimit !== undefined
    && (!Number.isSafeInteger(config.observationLimit) || config.observationLimit <= 0)) {
    throw new Error(`platform-consumer: observationLimit must be a positive safe integer, got ${config.observationLimit}`)
  }
  const observationLimit = config.observationLimit ?? 1000
  const metadata = new Map<SessionId, PlatformMetadata>()
  const observations: PlatformObservation = {
    created: [], statuses: [], sessionEvents: [], turnStopping: [], turnEnds: [],
    requestAborts: [], toolCalls: [], policyDecisions: [], guardDenials: [],
    subagentRuns: [], subagentEnds: [], jobs: [], llmProviders: [],
  }

  ctx.provide('platformConsumer', {
    metadataFor: (sessionId: SessionId): PlatformMetadata | undefined => metadata.get(sessionId),
    tasks: (): readonly PlatformTaskView[] => [...metadata.entries()].map(([sessionId, value]) => ({ sessionId, ...value })),
    get observations(): PlatformObservation { return observations },
  } satisfies PlatformConsumer)

  ctx.on('agent/created', ({ agent, source }) => {
    const parentId = agent.session.header.parentSession
    const parent = parentId === undefined ? undefined : metadata.get(parentId)
    const assigned = derivePlatformMetadata(parent, { projectId: baseProjectId, runId: baseRunId }, () => PlatformTaskId(randomUUID()))
    metadata.set(agent.id, assigned)
    appendObservation(observations.created, {
      agentId: agent.id,
      sessionId: agent.session.id,
      source,
      projectId: assigned.projectId,
      runId: assigned.runId,
      taskId: assigned.taskId,
    }, observationLimit)
    for (const provider of providerIds(ctx.get('llm'))) {
      if (!observations.llmProviders.includes(provider)) appendObservation(observations.llmProviders, provider, observationLimit)
    }
  })
  ctx.on('agent/status', ({ agent, status }) => {
    appendObservation(observations.statuses, { agentId: agent.id, status }, observationLimit)
  })
  ctx.on('session/event', (session, event: SessionEvent) => {
    appendObservation(observations.sessionEvents, { sessionId: session.id, type: event.type }, observationLimit)
    if (event.type === 'turn/end') {
      appendObservation(observations.turnEnds, { sessionId: session.id, reason: event.data.reason }, observationLimit)
    }
  })
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    appendObservation(observations.turnStopping, { agentId: agent.id, turn }, observationLimit)
  })
  ctx.on('agent/request', async ({ agent, signal }, next) => {
    signal.addEventListener('abort', () => {
      appendObservation(observations.requestAborts, { agentId: agent.id, reason: signal.reason }, observationLimit)
    }, { once: true })
    return next()
  })

  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const callMetadata = metadataFor(metadata, exec.agent)
    const call = exec.agent === undefined
      ? { toolName: exec.name }
      : { toolName: exec.name, agentId: exec.agent.id }
    appendObservation(observations.toolCalls, call, observationLimit)
    const decision = policyDecision(policy, callMetadata, exec.name)
    if (decision === undefined) return next()
    appendObservation(observations.policyDecisions, { toolName: exec.name, decision: decision.decision }, observationLimit)
    return { kind: decision.decision, reason: decision.reason }
  })

  for (const rule of monotoneGuardRules(policy)) {
    const guard: ToolGuard = (exec: Readonly<ToolExecution>) => {
      const callMetadata = metadataFor(metadata, exec.agent)
      if (!matchesPolicyRule(rule, callMetadata, exec.name)) return undefined
      const reason = boundReason(rule.reason ?? `platform policy: ${rule.decision}`)
      appendObservation(observations.guardDenials, { toolName: exec.name, reason }, observationLimit)
      return reason
    }
    ctx.tools.guard(guard)
  }

  ctx.on('subagent/start', (info: SubagentRunInfo) => {
    appendObservation(observations.subagentRuns, {
      runId: info.runId,
      provider: info.provider,
      id: info.id,
      local: info.local,
    }, observationLimit)
  })
  ctx.on('subagent/end', (info: SubagentRunEndInfo) => {
    appendObservation(observations.subagentEnds, { runId: info.runId, stopReason: info.stopReason }, observationLimit)
  })

  const jobs: JobRegistry | undefined = ctx.get('jobs')
  jobs?.events.subscribe({ owners: 'all' }, (event: JobEvent) => {
    const owner = event.type === 'output' ? event.owner : event.job.owner
    if (owner === undefined || !metadata.has(owner)) return
    const jobId = event.type === 'output' ? event.id : event.job.id
    appendObservation(observations.jobs, { jobId, owner, type: event.type }, observationLimit)
  })

}
