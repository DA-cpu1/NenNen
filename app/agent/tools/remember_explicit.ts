/** 由模型挑选当前用户明确表达且未来有用的资料，业务后台检查后保存并返回真实回执。 */
import { defineTool } from 'eve/tools'
import { rememberExplicitInputSchema } from '../../src/shared/memory-tool'
import { callMemoryTool } from '../lib/memory-tool-client'

export default defineTool({
  description: '判断当前用户明确表达的事实、偏好、经历或近期状态是否有依据、未来有用，值得记住就使用，无需用户说“记住”；没有值得保存的内容或意思不确定时跳过。一次性要求不能推导为长期互动要求，短期状态用 temporary，默认 24 小时后不再当作当前状态。称呼偏好用 memoryKey=preferred_name。用应用给出的当前用户消息编号作 sourceMessageId。引用、假设、第三方事实、角色编造、密钥和验证码都不能保存。已有不同记录时不要绕过冲突检查；纠正和忘记使用相应工具。等待真实结果再告诉用户是否已保存。',
  inputSchema: rememberExplicitInputSchema,
  /**
   * 把模型的保存申请交给后台，避免模型自己声称写成就当成成功。
   * @param input 模型挑选的短记录与当前用户原话编号
   * @param ctx eve 提供的本轮身份和取消信号，模型不能自选会话
   * @returns 后台核对并实际执行后的成功回执或失败说明
   */
  execute(input, ctx) {
    return callMemoryTool({ sessionId: ctx.session.id, tool: 'remember_explicit', input }, ctx.abortSignal)
  },
})
