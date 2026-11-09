/**
 * 用固定内容检查模型能否返回合法工具调用，不发送角色人设、聊天或记忆。
 * 普通文字回复不能算能力通过；这里不执行真实记忆工具，也不自动重试付费请求。
 */
import { APICallError, generateText, tool, ToolChoiceViolationError } from 'ai'
import { z } from 'zod'
import { createCompanionLanguageModel } from './model'
import { isDeepSeekService, type ModelConnection, type ModelConnectionTest } from '../shared/model-settings'

/**
 * 发一次明确的工具能力测试；密钥只交给当前适配器的内存配置。
 * @param connection 用户保存的服务地址、模型和容量
 * @param apiKey 主进程交付的模型密钥
 * @param signal 用户取消、退出或超时的统一信号
 * @returns 实测的工具能力和供应商用量；连接失败只抛固定码
 */
export async function testModelConnection(connection: ModelConnection, apiKey: string, signal: AbortSignal): Promise<ModelConnectionTest> {
  try {
    // DeepSeek 的思考模式会拒绝「强制指定工具」的检查（T11 实测）。
    // 所以测试时临时关闭思考，只验证地址、密钥、模型和工具能力；
    // 正式聊天仍按用户保存的思考设置发送，不会偷偷改掉用户的配置。
    const tested = isDeepSeekService(connection)
      ? { ...connection, reasoning: { enabled: false, effort: null } }
      : connection
    const inputSchema = z.object({ confirmation: z.literal('ok') }).strict()
    const result = await generateText({
      model: createCompanionLanguageModel(apiKey, tested),
      prompt: '这是软件连接测试。请调用 connection_check 工具，confirmation 填写 ok。',
      tools: { connection_check: tool({ description: '确认可以返回工具调用，不修改任何用户资料。',
        inputSchema }) },
      toolChoice: { type: 'tool', toolName: 'connection_check' },
      maxOutputTokens: 256,
      maxRetries: 0,
      abortSignal: signal,
    })
    const passed = result.toolCalls.some((call) => call.toolName === 'connection_check' && inputSchema.safeParse(call.input).success)
    return { status: passed ? 'passed' : 'unsupported', usage: {
      inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens,
    } }
  } catch (error) {
    if (signal.aborted) throw new Error('E_MODEL_TEST_CANCELLED')
    // AI SDK 7 会主动拒绝“强制工具但只回文字”，这证明能回话却没有完成工具检查。
    if (ToolChoiceViolationError.isInstance(error)) return { status: 'unsupported', usage: {} }
    // 某些兼容服务明确拒绝 tools 参数。只据明确的能力拒绝分类，认证错误不能被算成可连接。
    if (APICallError.isInstance(error) && [400, 422].includes(error.statusCode ?? 0)
      && /tool|function/i.test(error.message) && /unsupported|not.support|not.available|unknown.parameter/i.test(error.message)) {
      return { status: 'unsupported', usage: {} }
    }
    throw new Error('E_MODEL_CONNECTION')
  }
}
