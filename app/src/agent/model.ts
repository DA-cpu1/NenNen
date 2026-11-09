/**
 * 用同一份配置创建 AI SDK 模型，供连接测试、正式聊天、试聊和后台整理复用。
 * 供应商需要额外参数时集中在这里设置，避免测试能通过而正式聊天用另一份参数。
 * 旧探针可以只传本机地址；自定义供应商是否支持工具仍要实际检查。
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { generateText } from 'ai'
import {
  DEFAULT_MODEL_CONNECTION, isDeepSeekService, modelConnectionSchema,
  reasoningEnabledFor, type ModelConnection,
} from '../shared/model-settings'

/**
 * 用现有配置建立模型连接。密钥只留在调用进程内存中。
 * 温度、Top P、思考开关和档位都在这里统一写进请求体，保证连接测试、聊天和试聊发同一套参数。
 * @param apiKey 配置提供的密钥
 * @param connection 公开模型配置；旧固定检查可只传本机模拟地址
 * @returns 可交给 AI SDK 的语言模型
 */
export function createCompanionLanguageModel(apiKey: string, connection: ModelConnection | string = DEFAULT_MODEL_CONNECTION) {
  const checked = modelConnectionSchema.parse(typeof connection === 'string'
    ? { ...DEFAULT_MODEL_CONNECTION, baseUrl: connection } : connection)
  // 自定义配置也可能直接填 DeepSeek 官方地址。origin 比较协议、主机和端口，不比较路径。
  const deepSeek = isDeepSeekService(checked)
  const zhipu = checked.provider === 'zhipu'
  const thinkingEnabled = reasoningEnabledFor(checked)
  // DeepSeek 思考模式下温度不生效（官方文档：设置也不会报错，但没有作用）。
  // 与其发出去让用户以为生效，不如不发，和界面上的「由模型决定」保持一致。
  const temperatureIgnored = deepSeek && thinkingEnabled
  return createOpenAICompatible({
    name: checked.provider,
    baseURL: checked.baseUrl,
    apiKey,
    includeUsage: true,
    // 请求体就是发给供应商的那包资料，最后一步统一改写成用户保存的参数。
    transformRequestBody: (body) => {
      const next: Record<string, unknown> = { ...body }
      // DeepSeek 无论开关都显式发送 thinking，避免默认思考导致行为和界面不一致。
      // 智谱只在保存过思考设置时发送：GLM-5.3 只能 enabled，旧配置不带这个字段时交给服务商默认值。
      if (deepSeek || (zhipu && checked.reasoning !== undefined)) {
        next.thinking = { type: thinkingEnabled ? 'enabled' : 'disabled' }
      }
      // 档位只在思考开启时发送；「跟随模型」用空值表示，不写进请求体。
      if (thinkingEnabled && checked.reasoning?.effort) next.reasoning_effort = checked.reasoning.effort
      if (!temperatureIgnored && checked.temperature != null) next.temperature = checked.temperature
      if (checked.topP != null) next.top_p = checked.topP
      return next
    },
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
