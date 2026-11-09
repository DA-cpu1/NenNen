/**
 * 用同一份配置创建 AI SDK 模型，供连接测试、正式聊天、试聊和后台整理复用。
 * 供应商需要额外参数时集中在这里设置，避免测试能通过而正式聊天用另一份参数。
 * 旧探针可以只传本机地址；自定义供应商是否支持工具仍要实际检查。
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { generateText } from 'ai'
import { DEEPSEEK_MODEL_CONNECTION, DEFAULT_MODEL_CONNECTION, modelConnectionSchema, type ModelConnection } from '../shared/model-settings'

/**
 * 用现有配置建立模型连接。密钥只留在调用进程内存中。
 * @param apiKey 配置提供的密钥
 * @param connection 公开模型配置；旧固定检查可只传本机模拟地址
 * @returns 可交给 AI SDK 的语言模型
 */
export function createCompanionLanguageModel(apiKey: string, connection: ModelConnection | string = DEFAULT_MODEL_CONNECTION) {
  const checked = modelConnectionSchema.parse(typeof connection === 'string'
    ? { ...DEFAULT_MODEL_CONNECTION, baseUrl: connection } : connection)
  // 自定义配置也可能直接填 DeepSeek 官方地址。origin 比较协议、主机和端口，不比较路径。
  const isDeepSeek = checked.provider === 'deepseek' || new URL(checked.baseUrl).origin === DEEPSEEK_MODEL_CONNECTION.baseUrl
  return createOpenAICompatible({
    name: checked.provider,
    baseURL: checked.baseUrl,
    apiKey,
    includeUsage: true,
    // 请求体就是发给供应商的那包资料。DeepSeek 默认思考，思考模式下会拒绝测试指定的工具。
    transformRequestBody: isDeepSeek ? (body) => ({ ...body, thinking: { type: 'disabled' } }) : undefined,
  })(checked.model)
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
