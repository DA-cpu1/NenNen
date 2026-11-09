/** 正式聊天里立即保存模型选出的、用户明确表达的资料，并用数据库回执处理重试。 */
import { createHash, randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { findExactMemory, listCurrentMemories, saveCharacterMemory } from '../data/memories'
import { characters, conversations, messages, toolOperations } from '../data/tables'
import { beginToolOperation, buildOperationKey, completeToolOperation, failToolOperation } from '../data/tool-ops'
import { findMemoryReviewCandidates, type MemoryReviewCandidate } from '../memory/review-candidates'
import { rememberActionSchema, rememberReceiptSchema, type MemoryToolResult, type RememberExplicitInput, type RememberReceipt } from '../shared/memory-tool'
import type { z } from 'zod'

const dayMs = 24 * 60 * 60 * 1_000
const invalidSource = { ok: false, code: 'SOURCE_NOT_ALLOWED', message: '只能用本轮用户原话作为保存来源。', retryable: false } as const
const stale = { ok: false, code: 'STALE_REVISION', message: '已有不同或已失效的记录，无法直接保存。', retryable: false } as const
const unavailable = { ok: false, code: 'STORAGE_UNAVAILABLE', message: '暂时无法确认记忆已保存。', retryable: true } as const
const invalidInput = { ok: false, code: 'INVALID_INPUT', message: '这条记忆的内容或格式无效。', retryable: false } as const
const storedReceiptSchema = rememberReceiptSchema.extend({ proposalHash: rememberReceiptSchema.shape.memoryId.optional() })

type Proposal = Extract<z.infer<typeof rememberActionSchema>, { content: string }>

/** 只留在当前回合内存中的待确认申请，原话和正文以第一次提议为准。 */
export interface PendingMemoryReview {
  proposal: Proposal
  candidates: MemoryReviewCandidate[]
  memoryEpoch: number
}

/**
 * 处理保存提议或确认。有疑似重复时先返回候选，确认后再把来源和回执一起提交。
 * @param db 后台 SQLite 连接
 * @param context 正式回合的实际会话与用户消息编号，来自后台登记
 * @param input 模型的提议或确认动作
 * @param now 保存用的毫秒时间戳
 * @param reviews 当前正式回合的待确认申请
 * @returns 待确认候选、已落库的回执或明确失败
 */
export function rememberExplicit(
  db: BetterSQLite3Database, context: { conversationId: string; userMessageId: string },
  input: RememberExplicitInput, now: number, reviews: Map<string, PendingMemoryReview>,
): MemoryToolResult {
  const parsed = rememberActionSchema.safeParse(input)
  if (!parsed.success) return invalidInput
  const action = parsed.data
  const review = 'reviewId' in action ? reviews.get(action.reviewId) : undefined
  const proposal = 'content' in action ? action : review?.proposal
  if (!proposal) return stale
  const reuse = action.action === 'reuse' ? review?.candidates.find(({ id }) => id === action.memoryId) : undefined
  if (action.action === 'reuse' && !reuse) return stale
  if (proposal.sourceMessageId !== context.userMessageId) return invalidSource
  return db.transaction((tx) => {
    const conversation = tx.select().from(conversations).where(eq(conversations.id, context.conversationId)).get()
    const source = tx.select({ id: messages.id, createdAt: messages.createdAt }).from(messages).where(and(
      eq(messages.id, context.userMessageId), eq(messages.conversationId, context.conversationId),
      eq(messages.role, 'user'), eq(messages.status, 'completed'), eq(messages.excludedFromContext, 0),
    )).get()
    if (conversation?.mode !== 'normal' || !source) return invalidSource

    // 无固定属性时用内容指纹区分同一原话里的两件事。复用旧条时也靠指纹识别重试的原提议。
    const proposalHash = createHash('sha256').update(JSON.stringify([proposal.kind, proposal.content])).digest('hex')
    const targetId = proposal.memoryKey ?? proposalHash
    const operation = { conversationId: conversation.id, requestMessageId: source.id, toolName: 'remember_explicit', targetId }
    const operationKey = buildOperationKey(operation)
    const existing = tx.select().from(toolOperations).where(eq(toolOperations.operationKey, operationKey)).get()
    const current = listCurrentMemories(tx, conversation.characterId, now).filter((row) => row.scope === 'character')
    const saveInput = {
      conversationId: conversation.id, sourceMessageIds: [source.id], origin: 'user_explicit' as const,
      kind: proposal.kind, memoryKey: proposal.memoryKey ?? null, content: proposal.content, now,
      expiresAt: proposal.kind === 'temporary' ? source.createdAt + dayMs : null,
    }
    if (existing?.status === 'committed') {
      const receipt = storedReceiptSchema.safeParse(JSON.parse(existing.resultJson ?? 'null'))
      if (!receipt.success) return unavailable
      const { memoryId, revision, proposalHash: storedHash } = receipt.data
      const old = current.find((row) => row.id === memoryId && row.revision === revision)
      if (!old || (reuse && reuse.id !== memoryId)) return stale
      // 旧版回执只有记忆编号和修订号，仍可按同文验证原操作。
      if (storedHash ? storedHash !== proposalHash : !findExactMemory(tx, [old], { ...saveInput, expiresAt: old.expiresAt })) return stale
      return { memoryId, revision, ok: true, status: 'already_saved' }
    }
    const character = tx.select({ memoryEpoch: characters.memoryEpoch }).from(characters)
      .where(eq(characters.id, conversation.characterId)).get()!
    if (review && action.action === 'add') {
      const latest = findMemoryReviewCandidates(tx, current, saveInput)
      if (character.memoryEpoch !== review.memoryEpoch || JSON.stringify(latest) !== JSON.stringify(review.candidates)) return stale
    }
    if (!review && !findExactMemory(tx, current.filter((row) => row.memoryKey === saveInput.memoryKey), saveInput)) {
      const candidates = findMemoryReviewCandidates(tx, current, saveInput)
      if (candidates.length > 0) {
        const reviewId = randomUUID()
        reviews.set(reviewId, { proposal, candidates, memoryEpoch: character.memoryEpoch })
        return { ok: true, state: 'needs_review', reviewId, sourceCreatedAt: source.createdAt, candidates }
      }
    }
    const begun = beginToolOperation(tx, { ...operation, operationKey, now })
    if (begun.kind !== 'new') return unavailable
    const saved = saveCharacterMemory(tx, { ...saveInput, reuse })
    if (!('memory' in saved)) {
      failToolOperation(tx, begun.operationId, saved.status, now)
      if (saved.status === 'STALE_REVISION') return stale
      if (saved.status === 'SOURCE_NOT_ALLOWED') return invalidSource
      return invalidInput
    }
    const receipt: RememberReceipt = { memoryId: saved.memory.id, revision: saved.memory.revision, status: saved.status }
    completeToolOperation(tx, begun.operationId, JSON.stringify({ ...receipt, proposalHash }), now)
    return { ok: true, ...receipt }
  })
}
