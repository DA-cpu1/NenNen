/** 管理页和聊天工具共用的记忆操作格式，后台会再检查目标的归属。 */
import { z } from 'zod'
import { memoryKinds } from './memory-tool'

/** 对象编号和修订号必须一起提交，防止旧页面覆盖刚更新的记忆。 */
export const memoryTargetSchema = z.strictObject({
  memoryId: z.string().min(1).max(200),
  expectedRevision: z.number().int().positive(),
})

/** 保存纠正后的简短文字。空白内容必须走单独的忘记操作。 */
export const memoryContentSchema = z.string().trim().min(1).max(400)

/** 后台只接受界面明示选择的操作，删除原文不能由聊天模型代选。 */
export const memoryChangeSchema = z.discriminatedUnion('action', [
  memoryTargetSchema.extend({ action: z.literal('correct'), requestId: z.uuid(), content: memoryContentSchema }),
  memoryTargetSchema.extend({ action: z.literal('forget'), requestId: z.uuid(), deleteSources: z.boolean() }),
])

export type MemoryChange = z.infer<typeof memoryChangeSchema>

/** 管理页可看的资料。聊天上下文不能使用这个列表，因为它也包含过去的值。 */
export interface ManagedMemory {
  id: string
  revision: number
  scope: 'character' | 'global'
  kind: typeof memoryKinds[number]
  content: string
  status: 'active' | 'superseded' | 'expired'
  validFrom: number
  expiresAt: number | null
  sources: Array<{ id: string; content: string; createdAt: number; excluded: boolean }>
}

/** 只用编号和计数记录回执，重放操作时不会从回执读回已忘记正文。 */
export const memoryChangeReceiptSchema = z.strictObject({
  action: z.enum(['correct', 'forget']), memoryId: z.string(), revision: z.number().int().positive(),
  removedSources: z.number().int().nonnegative(), affectedMemories: z.number().int().nonnegative(),
  personaContainsContent: z.boolean(),
})

export type MemoryChangeReceipt = z.infer<typeof memoryChangeReceiptSchema>
