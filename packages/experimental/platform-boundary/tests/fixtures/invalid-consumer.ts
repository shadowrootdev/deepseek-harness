// A platform-owned consumer must not import a concrete internal package. The
// checker rejects the agent loop and the concrete model provider while allowing
// the Service Definitions in the same file.
import * as agent from '@deepseek-ai/dsh-agent'
import * as agentLoop from '@deepseek-ai/dsh-agent-loop'
import * as deepseekLlm from '@deepseek-ai/dsh-llm-deepseek'
import * as session from '@deepseek-ai/dsh-session'

export const invalidConsumerBindings = [agent, agentLoop, deepseekLlm, session]
