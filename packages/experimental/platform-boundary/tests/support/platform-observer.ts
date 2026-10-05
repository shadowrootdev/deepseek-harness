/**
 * Platform-owned consumer used by the real composition tests.
 *
 * This plugin stands in for a Platform component: it observes the Agent
 * lifecycle, installs one tool-policy decision, reaches the Agent identity at
 * the tools extension point, and watches turn cancellation. It imports only
 * Service Definitions (`dsh-agent`, `dsh-tools`), Cordis, and a configuration
 * schema, never a concrete runtime package.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AgentStatus } from '@deepseek-ai/dsh-agent'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

/** Policy the observer installs in the composed tool registry. */
export interface Config {
  /** Tool name the policy applies to; absent means every call. */
  readonly tool?: string
  /** Pre-execute decision to return for the configured tool. */
  readonly decision?: 'allow' | 'deny' | 'ask'
  /** Reason carried by a configured deny or ask decision. */
  readonly reason?: string
  /** When present, install a monotonic guard denying the configured tool. */
  readonly guardReason?: string
}

/**
 * Schemastery schema the Loader validates the mounted config against.
 *
 * Every field is optional — schemastery treats an object field as optional
 * unless it is marked required — so the explicit optional fields on
 * {@link Config} match the schema: a mount configures only the policy it needs.
 */
export const Config = z.object({
  tool: z.string(),
  decision: z.union(['allow', 'deny', 'ask'] as const),
  reason: z.string(),
  guardReason: z.string(),
})

/** One lifecycle fact the observer recorded from its extension points. */
export interface PlatformObservation {
  /** Facts recorded on `agent/created`. */
  readonly created: Array<{ agentId: string; sessionId: string; source: string }>
  /** Status values observed on `agent/status`. */
  readonly statuses: Array<{ agentId: string; status: AgentStatus }>
  /** Session event types observed on `session/event`. */
  readonly sessionEvents: Array<{ sessionId: string; type: string }>
  /** Turn boundaries observed on `agent/turn-stopping`. */
  readonly turnStopping: Array<{ agentId: string; turn: number }>
  /** Durable turn endings, including their cancellation cause. */
  readonly turnEnds: Array<{ sessionId: string; reason: unknown }>
  /** Aborts observed on the turn signal, with the signal's abort cause. */
  readonly requestAborts: Array<{ agentId: string; reason: unknown }>
  /** Tool calls observed at `tools/pre-execute`, with the reached Agent identity. */
  readonly toolCalls: Array<{ toolName: string; agentId?: string }>
  /** Policy decisions the observer returned to `tools/pre-execute`. */
  readonly policy: Array<{ toolName: string; decision: string }>
  /** Denials the observer's monotonic guard returned. */
  readonly guardDenials: Array<{ toolName: string; reason: string }>
}

/** Read model the observer exposes on `ctx.platformObserver`. */
export interface PlatformObserver {
  /** Every fact recorded since the plugin loaded. */
  readonly observations: PlatformObservation
}

/** Function-plugin name the Loader mounts this consumer under. */
export const name = 'platform-observer'

/** The tool registry the observer's policy contribution requires. */
export const inject = ['tools']

/**
 * Mount the platform consumer's observation and policy contributions.
 * @param ctx - plugin context whose fiber owns every listener and guard.
 * @param config - policy the Loader validated against {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const observations: PlatformObservation = {
    created: [],
    statuses: [],
    sessionEvents: [],
    turnStopping: [],
    turnEnds: [],
    requestAborts: [],
    toolCalls: [],
    policy: [],
    guardDenials: [],
  }
  ctx.provide('platformObserver', { observations })

  ctx.on('agent/created', ({ agent, source }) => {
    observations.created.push({ agentId: agent.id, sessionId: agent.session.id, source })
  })
  ctx.on('agent/status', ({ agent, status }) => {
    observations.statuses.push({ agentId: agent.id, status })
  })
  ctx.on('session/event', (session, event) => {
    observations.sessionEvents.push({ sessionId: session.id, type: event.type })
    if (event.type === 'turn/end') observations.turnEnds.push({ sessionId: session.id, reason: event.data.reason })
  })
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    observations.turnStopping.push({ agentId: agent.id, turn })
  })
  ctx.on('agent/request', async ({ agent, signal }, next) => {
    signal.addEventListener('abort', () => {
      observations.requestAborts.push({ agentId: agent.id, reason: signal.reason })
    }, { once: true })
    return next()
  })

  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const agentId = exec.agent?.id
    observations.toolCalls.push(agentId === undefined ? { toolName: exec.name } : { toolName: exec.name, agentId })
    if (config.decision === undefined || config.tool !== undefined && exec.name !== config.tool) return next()
    const reason = config.reason ?? `platform policy: ${config.decision}`
    observations.policy.push({ toolName: exec.name, decision: config.decision })
    return { kind: config.decision, reason }
  })

  const guardReason = config.guardReason
  if (guardReason !== undefined) {
    ctx.tools.guard((exec) => {
      if (config.tool !== undefined && exec.name !== config.tool) return undefined
      observations.guardDenials.push({ toolName: exec.name, reason: guardReason })
      return guardReason
    })
  }
}
