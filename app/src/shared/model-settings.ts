/**
 * 约定界面、主进程和后台怎样交换模型设置。
 * 普通配置只放地址和随机凭据引用；保存的新密钥单独接收，不能混进 SQLite。
 */
import { z } from 'zod'
import { MODEL_CONTEXT_WINDOW_TOKENS, MODEL_OUTPUT_RESERVE_TOKENS } from './model-limits'

/** 同一模型的配置放在一个键里，避免只保存了一半地址就开始使用。 */
export const MODEL_SETTINGS_KEY = 'modelConnection'
export const INITIAL_SETUP_KEY = 'initialSetupCompleted'

/** 地址只允许服务入口，禁止把密码或令牌塞进网址的账号、查询参数中。 */
const serviceAddressSchema = z.string().trim().max(2048).refine((value) => {
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      && !url.search && !url.hash
  } catch { return false }
}, '请填写不含账号、查询参数和片段的 HTTP 服务地址').transform((value) => value.replace(/\/+$/, ''))

/** 思考档位：两家服务商都用 reasoning_effort 的 low/high/max。 */
export const reasoningEffortSchema = z.enum(['low', 'high', 'max'])
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>

/** 这里只支持已安装的 OpenAI 兼容适配器；供应商名字用于区分配置和用量记录。 */
export const modelConnectionSchema = z.object({
  provider: z.enum(['zhipu', 'deepseek', 'openai-compatible']),
  model: z.string().trim().min(1).max(200).regex(/^[^\s\x00-\x1f]+$/),
  baseUrl: serviceAddressSchema,
  // 显示名称只用于界面；旧配置没有这个字段，读取时按预设推导。
  displayName: z.string().trim().min(1).max(60).optional(),
  // 空值表示交给服务商默认值；温度上限按 OpenAI 兼容接口的通用范围。
  temperature: z.number().min(0).max(2).nullable().optional(),
  topP: z.number().min(0).max(1).nullable().optional(),
  // 思考开关和档位分开存：关掉思考时保留档位，下次打开不用重选。
  reasoning: z.object({ enabled: z.boolean(), effort: reasoningEffortSchema.nullable() }).strict().optional(),
  // 模型窗口是一次输入和输出的总容量；回复预留是在放历史前先留出的空位。
  contextWindowTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  outputReserveTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict().refine((value) => value.outputReserveTokens < value.contextWindowTokens,
  '回复预留必须小于模型总容量')
export type ModelConnection = z.infer<typeof modelConnectionSchema>

/** 新表单的起点沿用项目既有实测配置，不表示该用户已连接成功。 */
export const DEFAULT_MODEL_CONNECTION: ModelConnection = {
  provider: 'zhipu', model: 'glm-5.3-flash', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  contextWindowTokens: MODEL_CONTEXT_WINDOW_TOKENS,
  outputReserveTokens: MODEL_OUTPUT_RESERVE_TOKENS,
}

/** DeepSeek 官方预设。关闭思考后，服务端未指定输出上限时默认可回 8,192 token。 */
export const DEEPSEEK_MODEL_CONNECTION: ModelConnection = {
  provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com',
  contextWindowTokens: 1_000_000, outputReserveTokens: 8_192,
}

type ModelService = Pick<ModelConnection, 'provider' | 'baseUrl'>

/**
 * 是否指向 DeepSeek 服务：供应商选了 DeepSeek，或自定义配置直接填官方地址。
 * 两种写法的参数规则一样（温度、top_p、思考开关都按 DeepSeek 的限制处理）。
 * @param connection 当前配置
 * @returns 是否按 DeepSeek 的协议发送参数
 */
export function isDeepSeekService(connection: ModelService): boolean {
  if (connection.provider === 'deepseek') return true
  try { return new URL(connection.baseUrl).origin === new URL(DEEPSEEK_MODEL_CONNECTION.baseUrl).origin }
  catch { return false }
}

/**
 * 智谱 GLM-5.3 系列强制思考：传 disabled 会直接报错，界面必须锁成开启。
 * @param connection 当前配置
 * @returns 是否属于不能关闭思考的模型
 */
export function isThinkingForced(connection: Pick<ModelConnection, 'provider' | 'model'>): boolean {
  return connection.provider === 'zhipu' && /^glm-5\.3/i.test(connection.model)
}

/**
 * 这份配置实际是否开启思考；旧配置没有 reasoning 字段时按服务商默认值判断。
 * @param connection 当前配置
 * @returns 发送请求时是否启用思考
 */
export function reasoningEnabledFor(connection: Pick<ModelConnection, 'provider' | 'model' | 'reasoning'>): boolean {
  return isThinkingForced(connection) || connection.reasoning?.enabled === true
}

/**
 * 后台整理任务用的配置：DeepSeek 临时关闭思考，避免结构化输出被思考拖慢、加价。
 * 智谱 GLM-5.3 关不掉，只能保持原样。
 * @param connection 正式聊天保存的配置
 * @returns 适合记忆整理等后台任务的配置
 */
export function withoutReasoning(connection: ModelConnection): ModelConnection {
  if (!isDeepSeekService(connection)) return connection
  return { ...connection, reasoning: { enabled: false, effort: null } }
}

/**
 * 看本次配置能否沿用原服务的密钥。改模型名可以沿用，换供应商或地址就要重填。
 * @param next 用户正在填写的供应商和地址，可以带首尾空白或末尾斜线
 * @param saved 已通过配置检查并保存的供应商和地址
 * @returns 是否指向同一份服务配置
 */
export function isSameModelService(next: ModelService, saved: ModelService): boolean {
  const address = serviceAddressSchema.safeParse(next.baseUrl)
  return next.provider === saved.provider && address.success && address.data === saved.baseUrl
}

/**
 * 读取 eve 启动时收到的公开配置；旧固定探针仍可单独指定本机地址。
 * @param serialized 不含密钥的 JSON 配置，正式设置由业务后台明确传入
 * @param legacyBaseUrl 旧探针的本机模拟服务地址
 * @returns 通过格式和容量检查的配置；损坏时只抛固定错误码
 */
export function readRuntimeModelConnection(serialized?: string, legacyBaseUrl?: string): ModelConnection {
  try {
    return modelConnectionSchema.parse(serialized ? JSON.parse(serialized)
      : { ...DEFAULT_MODEL_CONNECTION, baseUrl: legacyBaseUrl || DEFAULT_MODEL_CONNECTION.baseUrl })
  } catch { throw new Error('E_MODEL_CONFIGURATION') }
}

/** 密钥禁止换行，防止一把密钥被管道误读成多条启动消息。 */
export const modelApiKeySchema = z.string().trim().min(1).max(8192).regex(/^[^\x00-\x20\x7f]+$/)

/** SQLite 保存的是凭据编号；编号不能被当作任意文件路径使用。 */
export const credentialReferenceSchema = z.uuid()
export const storedModelSettingsSchema = z.object({
  connection: modelConnectionSchema,
  credentialRef: credentialReferenceSchema.nullable(),
  testStatus: z.enum(['untested', 'passed', 'unsupported', 'failed']),
}).strict()
export type StoredModelSettings = z.infer<typeof storedModelSettingsSchema>

/** 同一次保存重试沿用编号；改了表单后必须换编号，避免覆盖另一次保存。 */
export const saveModelSettingsSchema = z.object({
  requestId: z.uuid(), connection: modelConnectionSchema, apiKey: modelApiKeySchema.optional(),
}).strict()
export type SaveModelSettings = z.infer<typeof saveModelSettingsSchema>

/** 手动测试也有独立编号，网络断开后的同编号重试不能重复产生用量。 */
export const modelTestRequestSchema = z.object({ requestId: z.uuid() }).strict()
export const MODEL_TEST_LEDGER_PREFIX = 'modelConnectionTest:'

/** 这个内部消息只经带会话令牌的本机通道，绝不能原样返回界面或写日志。 */
export const applyModelSettingsSchema = z.object({
  settings: storedModelSettingsSchema, apiKey: modelApiKeySchema.nullable(),
}).strict().refine((value) => (value.settings.credentialRef === null) === (value.apiKey === null))
export type ApplyModelSettings = z.infer<typeof applyModelSettingsSchema>

/** 页面只拿到保管方式和就绪状态，不会收到已保存的密钥。 */
export interface ModelSettingsOverview {
  onboardingCompleted: boolean
  settings: StoredModelSettings | null
  ready: boolean
  credentialStorage: 'encrypted' | 'memory' | 'missing' | 'unavailable'
  code?: string
}

/** 测试返回能力结论和用量，不把供应商回复、请求头或错误原文交给页面。 */
export interface ModelConnectionTest {
  status: 'passed' | 'unsupported'
  usage: { inputTokens?: number; outputTokens?: number }
}
