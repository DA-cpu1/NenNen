/**
 * 后台把预算内输入装进带版本号的 JSON，交给 eve 内部适配器解开。
 * 这份信封只走已认证的本机通道，不接受界面直接指定系统规则或模型容量。
 * schema 是格式关卡：字段缺失、多出未知字段或身份不合法时明确拒绝。
 */
import { z } from 'zod'

const prefix = 'companion.turn.v1\n'
const envelopeSchema = z.strictObject({
  version: z.literal(1),
  prompt: z.array(z.strictObject({
    role: z.enum(['system', 'user', 'assistant']), content: z.string(),
  })).min(3),
  modelWindowTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maxOutputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  outputReserveTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  optionalPromptGroups: z.array(z.array(z.number().int().min(2)).min(1)).default([]),
}).refine((value) => {
  const indexes = value.optionalPromptGroups.flat()
  return value.prompt[0].role === 'system' && value.prompt[1].role === 'system' &&
    value.prompt.at(-1)?.role === 'user' && indexes.every((index) => index < value.prompt.length - 1) &&
    new Set(indexes).size === indexes.length
})

/** 信封里的字段都由后台准备；容量值不是模型或用户对话中声称的数字。 */
export type EveTurnEnvelope = z.infer<typeof envelopeSchema>

/**
 * 为一次正式回合生成内部文字信封，不把人设和历史混成当前用户说过的话。
 * @param input 预算内消息和已经核对的有效窗口、输出预留
 * @returns 带固定标识与协议版本的 JSON 文字
 * @throws E_INVALID_EVE_CONTEXT 资料格式不符合内部约定
 */
export function encodeEveTurnEnvelope(
  input: Omit<EveTurnEnvelope, 'version' | 'optionalPromptGroups'> & { optionalPromptGroups?: number[][] },
): string {
  const checked = envelopeSchema.safeParse({ ...input, version: 1 })
  if (!checked.success) throw new Error('E_INVALID_EVE_CONTEXT')
  return prefix + JSON.stringify(checked.data)
}

/**
 * 识别并检查内部信封；坏 JSON 的原文不会出现在抛出的错误中。
 * @param text eve 收到的单条用户身份文字
 * @returns 正常信封资料；普通文字返回 null，留给调用方决定是否允许
 * @throws E_INVALID_EVE_CONTEXT 有信封标识但内容损坏
 */
export function decodeEveTurnEnvelope(text: string): EveTurnEnvelope | null {
  if (!text.startsWith(prefix)) return null
  try {
    const checked = envelopeSchema.safeParse(JSON.parse(text.slice(prefix.length)))
    if (checked.success) return checked.data
  } catch { /* 统一返回固定错误，不能把包含人设或聊天的解析错误转发出去。 */ }
  throw new Error('E_INVALID_EVE_CONTEXT')
}
