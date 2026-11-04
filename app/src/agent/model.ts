/**
 * AI SDK 的本地模型连接配置和直连探针，供固定后台整理复用。
 * eve 运行探针另在作者目录创建模型；两处暂用同一供应商和模型配置，
 * 正式配置入口留待设置与运行层实现，界面和数据库不直接依赖供应商。
 * 智谱当前使用 OpenAI 兼容接口；其他供应商仍需各自验证。
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { generateText } from 'ai'

/** T01 开发期临时写死的连接参数；正式版从设置页读、密钥走加密存储（T11） */
const ZHIPU_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4'
const DEV_MODEL = 'glm-5.3-flash'

/**
 * 用现有配置建立模型连接。密钥只留在调用进程内存中。
 * @param apiKey 配置提供的密钥
 * @param baseURL 供应商地址，固定检查可传本机模拟地址
 * @returns 可交给 AI SDK 的语言模型
 */
export function createCompanionLanguageModel(apiKey: string, baseURL = ZHIPU_BASE_URL) {
  return createOpenAICompatible({ name: 'zhipu', baseURL, apiKey })(DEV_MODEL)
}

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
  const result = await generateText({
    model: createCompanionLanguageModel(apiKey),
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
