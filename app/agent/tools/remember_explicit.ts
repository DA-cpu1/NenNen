/** 保存当前用户明确要求以后记住的资料，由业务后台提交并返回真实回执。 */
import { defineTool } from 'eve/tools'
import { rememberExplicitInputSchema } from '../../src/shared/memory-tool'
import { callMemoryTool } from '../lib/memory-tool-client'

export default defineTool({
  description: '仅在当前用户明确要求长期记住时使用，包括以后怎么称呼或怎么相处。称呼偏好用 memoryKey=preferred_name。用应用给出的当前用户消息编号作 sourceMessageId。引用、假设、第三方事实、密钥和验证码都不能保存。等待真实结果再告诉用户是否已保存。',
  inputSchema: rememberExplicitInputSchema,
  /** 转交保存请求；数据库、有效来源和实际回执都由业务后台负责。 */
  execute(input, ctx) {
    return callMemoryTool({ sessionId: ctx.session.id, tool: 'remember_explicit', input }, ctx.abortSignal)
  },
})
