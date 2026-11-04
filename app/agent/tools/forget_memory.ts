/** 把当前用户明确点名的私有记忆交给后台忘记，聊天原话保留。 */
import { defineTool } from 'eve/tools'
import { forgetMemoryInputSchema } from '../../src/shared/memory-tool'
import { callMemoryTool } from '../lib/memory-tool-client'

export default defineTool({
  description: '仅在当前用户明确要求忘记一项信息时使用。先用 search_memories 找到唯一的私有记忆和修订号，再用应用给出的当前消息编号发请求。找不到或不确定是哪条时先问具体指哪件事。保留聊天原话，应用完成清理后自行确认。',
  inputSchema: forgetMemoryInputSchema,
  endsTurn: true,
  /** 转交忘记请求；工具没有删除聊天原话的权限。 */
  async execute(input, ctx) {
    const result = await callMemoryTool({ sessionId: ctx.session.id, tool: 'forget_memory', input }, ctx.abortSignal)
    // 原话已进入排除流程，旧回合不再请求模型。目标不清楚时仍让模型追问。
    if (!result.ok && !(result.code === 'MEMORY_CLEANUP_PENDING' && !result.retryable)) throw new Error(result.message)
    return result
  },
})
