// A platform-owned consumer may import Service Definitions, Cordis, dsh-util-*
// packages, Node builtins, and its own relative modules.
import * as agent from '@deepseek-ai/dsh-agent'
import * as llm from '@deepseek-ai/dsh-llm'
import * as session from '@deepseek-ai/dsh-session'
import * as tools from '@deepseek-ai/dsh-tools'
import * as cordis from '@deepseek-ai/cordis'
import * as utilValues from '@deepseek-ai/dsh-util-values'
import { readFileSync } from 'node:fs'
import { helperMarker } from './helper.ts'

export const validConsumerBindings = [
  agent,
  llm,
  session,
  tools,
  cordis,
  utilValues,
  readFileSync,
  helperMarker,
]
