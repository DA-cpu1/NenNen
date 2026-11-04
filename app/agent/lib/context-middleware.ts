/**
 * 在请求真正送到供应商前，还原 SQLite 准备的消息身份并检查完整预算。
 * middleware 是调用前的拦截函数；不读 eve 旧历史，不让框架提示覆盖本轮人设。
 * 工具续轮保留本次新产生的 assistant/tool 消息，并重新计入工具说明和结果。
 */
import type { LanguageModelMiddleware } from 'ai'
import { checkModelInputBudget } from '../../src/agent/context-budget'
import { decodeEveTurnEnvelope } from '../../src/shared/eve-turn-envelope'
import { MODEL_CONTEXT_WINDOW_TOKENS, MODEL_OUTPUT_RESERVE_TOKENS } from '../../src/shared/model-limits'

type ModelCallOptions = Parameters<NonNullable<LanguageModelMiddleware['transformParams']>>[0]['params']
type ModelPrompt = ModelCallOptions['prompt']

/** 只保留后台给本轮授权的记忆工具；服务端还会独立核对每次调用。 */
function filterMemoryTools(params: ModelCallOptions, allowSearch = false, allowRemember = false): ModelCallOptions {
  if (!params.tools) return params
  const tools = params.tools.filter((tool) => (tool.name !== 'search_memories' || allowSearch) &&
    (tool.name !== 'remember_explicit' || allowRemember))
  if (tools.length === params.tools.length) return params
  return { ...params, tools: tools.length ? tools : undefined, toolChoice: tools.length ? params.toolChoice : undefined }
}

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
          if (envelope.rememberSourceMessageId) {
            // 放在应用规则段，编号只给工具定位，用户原话仍单独在最后一条消息。
            prompt[0] = { role: 'system', content: envelope.prompt[0].content +
              '\n当前用户消息编号（仅供立即记忆工具使用）：' + envelope.rememberSourceMessageId }
          }
          const prepared = {
            ...params, prompt: [...prompt, ...continuation], maxOutputTokens: envelope.maxOutputTokens,
          }
          const transformed = filterMemoryTools(prepared, envelope.allowMemoryTools, !!envelope.rememberSourceMessageId)
          // 未设上限时连字段也删除，防止继承框架旧的1,000额度；供应商自行决定输出。
          if (envelope.maxOutputTokens === undefined) delete transformed.maxOutputTokens
          try {
            // 数还原后的实际输入，不数信封；工具说明、结果和响应格式也一并计入。
            checkModelInputBudget(transformed, envelope)
            return transformed
          } catch (error) {
            const group = envelope.optionalPromptGroups[groupIndex]
            if (!(error instanceof Error) || error.message !== 'E_CONTEXT_BUDGET_EXCEEDED' || !group) throw error
            // 先示例、再旧历史、最后记忆；规则、人设、当前消息和本轮工具续接不能移除。
            for (const position of group) removed.add(position)
          }
        }
      }
      // 保留 T01 唯一固定连通探针；其他没有后台信封的输入一律拒绝，包括摘要请求。
      const users = params.prompt.filter((message) => message.role === 'user')
      if (users.length !== 1 || userText(users[0]) !== '请只回复两个字：收到') {
        throw new Error('E_EVE_CONTEXT_REQUIRED')
      }
      const transformed = filterMemoryTools({ ...params })
      delete transformed.maxOutputTokens
      checkModelInputBudget(transformed, {
        modelWindowTokens: MODEL_CONTEXT_WINDOW_TOKENS, outputReserveTokens: MODEL_OUTPUT_RESERVE_TOKENS,
      })
      return transformed
    },
  }
}
