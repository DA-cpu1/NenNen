/** 正式聊天里立即保存用户明确提出的记忆，并用数据库回执处理重试。 */
import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { saveCharacterMemory } from '../data/memories'
import { conversations, memories, messages } from '../data/tables'
import { beginToolOperation, buildOperationKey, completeToolOperation, failToolOperation } from '../data/tool-ops'
import { rememberReceiptSchema, type MemoryToolResult, type RememberExplicitInput, type RememberReceipt } from '../shared/memory-tool'

const dayMs = 24 * 60 * 60 * 1_000
const invalidSource = { ok: false, code: 'SOURCE_NOT_ALLOWED', message: '只能用本轮用户原话作为保存来源。', retryable: false } as const
const stale = { ok: false, code: 'STALE_REVISION', message: '已有不同或已失效的记录，无法直接保存。', retryable: false } as const
const unavailable = { ok: false, code: 'STORAGE_UNAVAILABLE', message: '暂时无法确认记忆已保存。', retryable: true } as const

/**
 * 把本轮明确提出的内容与回执一起保存。回执写失败，记忆也一起撤回。
 * @param db 后台 SQLite 连接
 * @param context 正式回合的实际会话与用户消息编号，来自后台登记
 * @param input 模型填写的候选记录和来源编号
 * @param now 保存用的毫秒时间戳
 * @returns 已保存、已存过或失败的明确结果
 */
export function rememberExplicit(
  db: BetterSQLite3Database, context: { conversationId: string; userMessageId: string },
  input: RememberExplicitInput, now: number,
): MemoryToolResult {
  if (input.sourceMessageId !== context.userMessageId) return invalidSource
  return db.transaction((tx) => {
    const conversation = tx.select().from(conversations).where(eq(conversations.id, context.conversationId)).get()
    const source = tx.select({ id: messages.id }).from(messages).where(and(
      eq(messages.id, context.userMessageId), eq(messages.conversationId, context.conversationId),
      eq(messages.role, 'user'), eq(messages.status, 'completed'), eq(messages.excludedFromContext, 0),
    )).get()
    if (conversation?.mode !== 'normal' || !source) return invalidSource

    // 无固定属性时用内容指纹区分同一原话中的两件事，回执表也不需要保存正文副本。
    const targetId = input.memoryKey ?? createHash('sha256').update(JSON.stringify([input.kind, input.content])).digest('hex')
    const operation = { conversationId: conversation.id, requestMessageId: source.id, toolName: 'remember_explicit', targetId }
    const begun = beginToolOperation(tx, { ...operation, operationKey: buildOperationKey(operation), now })
    if (begun.kind === 'in-progress') return unavailable
    if (begun.kind === 'already-committed') {
      const receipt = rememberReceiptSchema.safeParse(JSON.parse(begun.resultJson ?? 'null'))
      if (!receipt.success) return unavailable
      const current = tx.select().from(memories).where(eq(memories.id, receipt.data.memoryId)).get()
      if (!current || current.characterId !== conversation.characterId || current.status !== 'active' ||
          (current.expiresAt !== null && current.expiresAt <= now) || current.kind !== input.kind || current.content !== input.content) return stale
      return { ...receipt.data, ok: true, status: 'already_saved' }
    }
    const saved = saveCharacterMemory(tx, {
      conversationId: conversation.id, sourceMessageIds: [source.id], origin: 'user_explicit',
      kind: input.kind, memoryKey: input.memoryKey ?? null, content: input.content, now,
      expiresAt: input.kind === 'temporary' ? now + dayMs : null,
    })
    if (!('memory' in saved)) {
      failToolOperation(tx, begun.operationId, saved.status, now)
      if (saved.status === 'STALE_REVISION') return stale
      if (saved.status === 'SOURCE_NOT_ALLOWED') return invalidSource
      return { ok: false, code: 'INVALID_INPUT', message: '这条记忆的内容或格式无效。', retryable: false }
    }
    const receipt: RememberReceipt = { memoryId: saved.memory.id, revision: saved.memory.revision, status: saved.status }
    completeToolOperation(tx, begun.operationId, JSON.stringify(receipt), now)
    return { ok: true, ...receipt }
  })
}
