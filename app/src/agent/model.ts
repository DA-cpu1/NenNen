/**
 * 模型连接层：全项目唯一知道"供应商"存在的地方。
 * 换供应商（比如 DeepSeek）只改这里的 baseURL 和模型名——人设、记忆、
 * 界面、数据库都不知道供应商是谁，一行不用动（03 §5/§6 的稳定边界）。
 * 智谱走 OpenAI 兼容协议；DeepSeek 等同类接口换地址即可。
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { generateText } from 'ai'

/** T01 开发期临时写死的连接参数；正式版从设置页读、密钥走加密存储（T11） */
const ZHIPU_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4'
const DEV_MODEL = 'glm-5.3-flash'

/** 一次模型调用的结果：回复文本 + 用量（用量给费用记录用，可能缺失） */
export interface ModelCallResult {
  text: string
  usage: { inputTokens: number | undefined; outputTokens: number | undefined } | undefined
}

/**
 * 用密钥调一次模型，说完就返回（非流式、不带上下文）。
 * 只用于 T01 管道验证；正式聊天要走 04 §3 的 CompanionRuntime。
 * @param apiKey 模型密钥——只在后台进程内存里，用完即弃
 * @param prompt 提示词（自测时是固定短句）
 * @param signal 取消信号（比如 30 秒超时自动掐断）
 */
export async function callModelOnce(
  apiKey: string,
  prompt: string,
  signal?: AbortSignal,
): Promise<ModelCallResult> {
  // apiKey 会变成请求头 Authorization: Bearer <key>，智谱认这种方式
  const provider = createOpenAICompatible({
    name: 'zhipu',
    baseURL: ZHIPU_BASE_URL,
    apiKey,
  })
  const result = await generateText({
    model: provider(DEV_MODEL),
    prompt,
    abortSignal: signal,
  })
  return {
    text: result.text,
    usage: result.usage
      ? { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens }
      : undefined,
  }
}
