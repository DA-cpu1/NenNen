/** 把本轮明确纠正的值交给后台，待新上下文准备好后由应用确认。 */
import { defineTool } from 'eve/tools'
import { correctMemoryInputSchema } from '../../src/shared/memory-tool'
import { callMemoryTool } from '../lib/memory-tool-client'

export default defineTool({
  description: '当前用户明确纠正已保存的信息时，先用 search_memories 找到唯一的私有记录和修订号，再提交新值。使用应用给出的当前消息编号。不要从引用、假设或模糊指代猜目标。后台重建上下文后由应用确认成功。',
  inputSchema: correctMemoryInputSchema,
  endsTurn: true,
  /** 把本轮的修订和新值转交后台，由它核对会话身份和来源。 */
  async execute(input, ctx) {
    const result = await callMemoryTool({ sessionId: ctx.session.id, tool: 'correct_memory', input }, ctx.abortSignal)
    // 申请已被后台受理时就结束旧回合。没受理才给模型机会补问或报告失败。
    if (!result.ok && !(result.code === 'MEMORY_CLEANUP_PENDING' && !result.retryable)) throw new Error(result.message)
    return result
  },
})
