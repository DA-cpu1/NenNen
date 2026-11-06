/**
 * AI SDK 的本地模型连接配置和直连探针，供固定后台整理复用。
 * 正式聊天、试聊和后台整理都使用后台给出的公开配置，密钥只留在内存。
 * 旧探针可以只传本机地址；自定义供应商是否支持工具仍要实际检查。
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { generateText } from 'ai'
import { DEFAULT_MODEL_CONNECTION, modelConnectionSchema, type ModelConnection } from '../shared/model-settings'

/**
 * 用现有配置建立模型连接。密钥只留在调用进程内存中。
 * @param apiKey 配置提供的密钥
 * @param connection 公开模型配置；旧固定检查可只传本机模拟地址
 * @returns 可交给 AI SDK 的语言模型
 */
export function createCompanionLanguageModel(apiKey: string, connection: ModelConnection | string = DEFAULT_MODEL_CONNECTION) {
  const checked = modelConnectionSchema.parse(typeof connection === 'string'
    ? { ...DEFAULT_MODEL_CONNECTION, baseUrl: connection } : connection)
  return createOpenAICompatible({ name: checked.provider, baseURL: checked.baseUrl, apiKey, includeUsage: true })(checked.model)
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
