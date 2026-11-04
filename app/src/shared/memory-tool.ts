/** 约定 eve 向本机业务后台查询或保存记忆时的消息格式，模型只填写工具参数。 */
import { z } from 'zod'
import type { MemoryMatch } from '../memory/search'

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

/** 外层会话号由 eve 读取自身运行身份后填写，不出现在给模型的参数里。 */
const sessionId = z.string().min(1).max(200)
export const memoryToolRequestSchema = z.discriminatedUnion('tool', [
  z.strictObject({ sessionId, tool: z.literal('search_memories'), input: searchMemoriesInputSchema }),
  z.strictObject({ sessionId, tool: z.literal('remember_explicit'), input: rememberExplicitInputSchema }),
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
      'INVALID_INPUT' | 'SOURCE_NOT_ALLOWED' | 'STALE_REVISION'; message: string; retryable: boolean }

/**
 * 标出可能要求长期记住的消息，只让这类回合考虑立即写入。
 * @param content 当前用户原话，不能由模型提供
 * @returns 是否要提供立即保存能力；引用和假设仍由模型按共同规则判断
 */
export function mayRequestImmediateMemory(content: string): boolean {
  return /记住|记下|记一下|记一记|记好了|帮我记|请记|保存|存下来|存一下|别忘了|牢记|叫我|称呼我|以后|今后|从今|往后|从现在开始/u.test(content)
}
