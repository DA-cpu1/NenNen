/** 约定 eve 向本机业务后台查询或保存记忆时的消息格式，模型只填写工具参数。 */
import { z } from 'zod'
import type { MemoryMatch } from '../memory/search'
import { memoryContentSchema, memoryTargetSchema } from './memory-management'

/** 只有在本机后台有正在运行的正式回合时，才使用这个内部路径。 */
export const memoryToolPath = '/internal/memory-tool'

/** 记忆的类别，供数据写入、聊天工具和后台整理共用。 */
export const memoryKinds = ['fact', 'preference', 'episode', 'temporary', 'interaction_request'] as const

/** 检索参数只接受问句和条数，拒绝模型添加角色编号等自选范围。 */
export const searchMemoriesInputSchema = z.strictObject({
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(8).optional(),
})

/** 立即记忆只接受短记录和当前用户原话编号。 */
export const rememberExplicitInputSchema = z.strictObject({
  content: z.string().trim().min(1).max(400),
  kind: z.enum(memoryKinds),
  memoryKey: z.string().trim().regex(/^[a-z][a-z0-9_]{0,79}$/).optional(),
  sourceMessageId: z.string().min(1).max(200),
})

/** 纠正、忘记必须指向先查到的修订，并带上实际触发操作的用户消息。 */
export const correctMemoryInputSchema = memoryTargetSchema.extend({
  content: memoryContentSchema, sourceMessageId: z.string().min(1).max(200),
})
export const forgetMemoryInputSchema = memoryTargetSchema.extend({ requestMessageId: z.string().min(1).max(200) })

/** 外层会话号由 eve 读取自身运行身份后填写，不出现在给模型的参数里。 */
const sessionId = z.string().min(1).max(200)
export const memoryToolRequestSchema = z.discriminatedUnion('tool', [
  z.strictObject({ sessionId, tool: z.literal('search_memories'), input: searchMemoriesInputSchema }),
  z.strictObject({ sessionId, tool: z.literal('remember_explicit'), input: rememberExplicitInputSchema }),
  z.strictObject({ sessionId, tool: z.literal('correct_memory'), input: correctMemoryInputSchema }),
  z.strictObject({ sessionId, tool: z.literal('forget_memory'), input: forgetMemoryInputSchema }),
])

/** 后台复查后的内部请求和结果。 */
export type MemoryToolRequest = z.infer<typeof memoryToolRequestSchema>
export type RememberExplicitInput = z.infer<typeof rememberExplicitInputSchema>

/** 回执只记录编号与状态，重试和历史查询不会通过回执找回原文。 */
export const rememberReceiptSchema = z.strictObject({
  memoryId: z.string().min(1), revision: z.number().int().positive(), status: z.enum(['saved', 'already_saved']),
})
export type RememberReceipt = z.infer<typeof rememberReceiptSchema>
export type MemoryToolResult =
  | { ok: true; memories: MemoryMatch[] }
  | ({ ok: true } & RememberReceipt)
  | { ok: false; code: 'NOT_FOUND' | 'CANCELLED' | 'BUDGET_EXCEEDED' | 'STORAGE_UNAVAILABLE' |
      'INVALID_INPUT' | 'SOURCE_NOT_ALLOWED' | 'STALE_REVISION' | 'AMBIGUOUS' | 'MEMORY_CLEANUP_PENDING';
      message: string; retryable: boolean }

/**
 * 标出可能要求长期记住的消息，只让这类回合考虑立即写入。
 * @param content 当前用户原话，不能由模型提供
 * @returns 是否要提供立即保存能力；引用和假设仍由模型按共同规则判断
 */
export function mayRequestImmediateMemory(content: string): boolean {
  return /记住|记下|记一下|记一记|记好了|帮我记|请记|保存|存下来|存一下|别忘了|牢记|叫我|称呼我|以后|今后|从今|往后|从现在开始/u.test(content)
}

/**
 * 识别需要提供记忆修改工具的常见中文表达。模型还要区分引用、假设与实际请求。
 * @param content 本轮已保存的用户原话
 * @returns 要开放的修改工具，普通聊天返回 undefined
 */
export function requestedMemoryChange(content: string): 'correct' | 'forget' | undefined {
  if (/忘掉|忘记|别再记|不必记|不要再记|删除.{0,20}记忆|删掉.{0,20}记忆/u.test(content) &&
      !/别忘[记掉]?|不要忘[记掉]?|不能忘[记掉]?|不许忘[记掉]?|忘记了/u.test(content)) return 'forget'
  if (/纠正|更正|改成|改一下|换一下|换成|记错了|说错了|不再叫/u.test(content) ||
      /(?:以前|原来|之前).{0,100}(?:现在|如今)/u.test(content)) return 'correct'
  return undefined
}

/**
 * 单独说「忘掉那件事」时，程序也要挡住模型猜目标。
 * @param content 本轮用户原话
 * @returns 是否应先请用户说明具体是哪条
 */
export function hasBareForgetReference(content: string): boolean {
  return /^(?:请|帮我|你|把|就|先|给我|忘掉|忘记|删掉|这个|这件事|这个事|那个|那件事|那个事|它|吧|了|一下|的|记忆|[。！？，,.!?\s])+$/u.test(content)
}
