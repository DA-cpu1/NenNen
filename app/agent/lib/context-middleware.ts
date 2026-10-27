/**
 * 在请求真正送到供应商前，还原 SQLite 准备的消息身份并检查完整预算。
 * middleware 是调用前的拦截函数；不读 eve 旧历史，不让框架提示覆盖本轮人设。
 * 工具续轮保留本次新产生的 assistant/tool 消息，并重新计入工具说明和结果。
 */
import type { LanguageModelMiddleware } from 'ai'
import { checkModelInputBudget } from '../../src/agent/context-budget'
import { decodeEveTurnEnvelope } from '../../src/shared/eve-turn-envelope'

type ModelCallOptions = Parameters<NonNullable<LanguageModelMiddleware['transformParams']>>[0]['params']
type ModelPrompt = ModelCallOptions['prompt']

/** 只接受纯文字用户消息；图片、文件等尚不在本版输入约定中。 */
function userText(message: ModelPrompt[number]): string | null {
  if (message.role !== 'user' || message.content.some((part) => part.type !== 'text')) return null
  return message.content.map((part) => part.type === 'text' ? part.text : '').join('')
}

/**
 * 创建实际模型参数的关卡；SDK 的生成和流式路径都会调用 transformParams。
 * @returns 无用户数据缓存的 AI SDK middleware，参数检查失败时不发供应商请求
 */
export function createCompanionContextMiddleware(): LanguageModelMiddleware {
  return {
    transformParams: async ({ params }) => {
      for (let index = 0; index < params.prompt.length; index += 1) {
        const text = userText(params.prompt[index])
        if (text === null) continue
        const envelope = decodeEveTurnEnvelope(text)
        if (!envelope) continue
        const continuation = params.prompt.slice(index + 1)
        // 后台每轮新建框架会话；信封后的用户/系统消息不是应用认可的续轮资料。
        if (continuation.some((message) => message.role !== 'assistant' && message.role !== 'tool')) {
          throw new Error('E_EVE_CONTEXT_CHANGED')
        }
        const removed = new Set<number>()
        for (let groupIndex = 0; ; groupIndex += 1) {
          const prompt: ModelPrompt = envelope.prompt.filter((_message, position) => !removed.has(position))
            .map((message) => message.role === 'system'
              ? { role: 'system', content: message.content }
              : { role: message.role, content: [{ type: 'text', text: message.content }] })
          const transformed = {
            ...params, prompt: [...prompt, ...continuation], maxOutputTokens: envelope.maxOutputTokens,
          }
          try {
            // 数还原后的实际输入，不数信封；工具说明、结果和响应格式也一并计入。
            checkModelInputBudget(transformed, envelope)
            return transformed
          } catch (error) {
            const group = envelope.optionalPromptGroups[groupIndex]
            if (!(error instanceof Error) || error.message !== 'E_CONTEXT_BUDGET_EXCEEDED' || !group) throw error
            // 先示例、后旧历史；规则、人设、当前消息和本轮工具续接内容永不在移除清单里。
            for (const position of group) removed.add(position)
          }
        }
      }
      // 保留 T01 唯一固定连通探针；其他没有后台信封的输入一律拒绝，包括摘要请求。
      const users = params.prompt.filter((message) => message.role === 'user')
      if (users.length !== 1 || userText(users[0]) !== '请只回复两个字：收到') {
        throw new Error('E_EVE_CONTEXT_REQUIRED')
      }
      const transformed = { ...params, maxOutputTokens: 1_000 }
      checkModelInputBudget(transformed, { modelWindowTokens: 13_000 })
      return transformed
    },
  }
}
