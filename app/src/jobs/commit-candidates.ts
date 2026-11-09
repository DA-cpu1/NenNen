/** 在一个事务内重新核对来源和版本，写入候选并推进整理书签。 */
import { and, eq, gte } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { findExactMemory, listCurrentMemories, saveCharacterMemory } from '../data/memories'
import { conversations, memories, memoryJobs, memorySources, messages } from '../data/tables'
import { findMemoryReviewCandidates } from '../memory/review-candidates'
import { candidatesSchema, type MemoryAddReview, type MemoryCandidate } from './extract-candidates'
import { readMemoryJobWork, type MemoryJobWork } from './memory-jobs'

const dayMs = 24 * 60 * 60 * 1_000
class InvalidCandidates extends Error {}

/** 提交结果区分待补判、旧任务、可重试错误和已经办完的批次。 */
export type CommitMemoryResult = { status: 'completed'; saved: number } |
  { status: 'needs_review'; reviews: MemoryAddReview[] } |
  { status: 'already_completed' | 'stale' | 'invalid_candidates' }

/** 核对模型点名的旧记录属于同一角色、仍是当时的版本，且原话没有比新候选更新。 */
function readReplacement(
  db: BetterSQLite3Database, work: MemoryJobWork, candidate: Extract<MemoryCandidate, { action: 'replace' }>,
  revisions: ReadonlyMap<string, number>, newestSourceSeq: number, newestSourceAt: number, now: number,
) {
  const old = db.select().from(memories).where(eq(memories.id, candidate.replacesMemoryId)).get()
  if (!old || old.scope !== 'character' || old.characterId !== work.characterId || old.status !== 'active' ||
      old.memoryKey !== candidate.memoryKey || old.revision !== revisions.get(old.id)) throw new InvalidCandidates()
  const newerSource = db.select({ id: messages.id }).from(memorySources).innerJoin(messages, eq(messages.id, memorySources.messageId))
    .where(and(eq(memorySources.memoryId, old.id), eq(messages.conversationId, work.job.conversationId),
      gte(messages.seq, newestSourceSeq))).get()
  if (newerSource || (old.origin === 'user_edit' && old.updatedAt >= newestSourceAt)) throw new InvalidCandidates()
  // 有键的旧值刚好在请求期间到期时，普通新增路径会先把它标成过期。
  if (old.expiresAt !== null && old.expiresAt <= now) return undefined
  return { id: old.id, revision: old.revision }
}

/**
 * 只提交仍归本次尝试且通过规则的一批候选。一项失败就撤回这一批的所有改动。
 * @param db 后台 SQLite 连接
 * @param work 发请求前得到的任务与实际原话片段
 * @param candidates 模型返回的候选数组，提交入口会再检查格式
 * @param revisions 实际给模型看的旧记忆编号与修订号
 * @param now 落库时间，测试可固定
 * @returns 实际提交、待补判、重复、失效或格式及来源错误
 */
export function commitMemoryCandidates(
  db: BetterSQLite3Database, work: MemoryJobWork, candidates: unknown,
  revisions: ReadonlyMap<string, number>, now: number,
): CommitMemoryResult {
  try {
    return db.transaction((tx) => {
      const job = tx.select().from(memoryJobs).where(eq(memoryJobs.id, work.job.id)).get()
      if (job?.status === 'completed') return { status: 'already_completed' }
      if (!job || job.status !== 'running' || job.attempts !== work.job.attempts) return { status: 'stale' }
      const current = readMemoryJobWork(tx, job)
      if (!current || (job.leaseUntil !== null && job.leaseUntil <= now) ||
          JSON.stringify(current.batch.sources) !== JSON.stringify(work.batch.sources)) {
        tx.update(memoryJobs).set({ status: 'stale', leaseUntil: null, updatedAt: now }).where(eq(memoryJobs.id, job.id)).run()
        return { status: 'stale' }
      }
      const parsed = candidatesSchema.safeParse({ candidates })
      if (!parsed.success) throw new InvalidCandidates()
      const allowedSources = new Map(current.batch.sources.map((source) => [source.id, source]))
      const changes = parsed.data.candidates.flatMap((candidate, index) => {
        if (candidate.action === 'skip') return []
        let newestSourceAt = 0
        let newestSourceSeq = 0
        for (const sourceId of candidate.sourceMessageIds) {
          const source = allowedSources.get(sourceId)
          if (!source) throw new InvalidCandidates()
          newestSourceAt = Math.max(newestSourceAt, source.createdAt)
          newestSourceSeq = Math.max(newestSourceSeq, source.seq)
        }
        const expiresAt = candidate.action === 'reuse' ? null
          : candidate.expiresAt ?? (candidate.kind === 'temporary' ? newestSourceAt + dayMs : null)
        if (expiresAt !== null && expiresAt <= newestSourceAt) throw new InvalidCandidates()
        return [{ index, candidate, newestSourceAt, newestSourceSeq, expiresAt }]
      })

      // 整批先查再写。只要有一项需要补判，其他项和整理书签也留在原处。
      const active = listCurrentMemories(tx, current.characterId, now).filter((row) => row.scope === 'character')
      const reviews: MemoryAddReview[] = []
      for (const { index, candidate, expiresAt } of changes) {
        if (candidate.action !== 'add' || (expiresAt !== null && expiresAt <= now)) continue
        const sameKey = active.filter((row) => row.memoryKey === candidate.memoryKey)
        if (findExactMemory(tx, sameKey, { ...candidate, expiresAt })) continue
        const previous = findMemoryReviewCandidates(tx, active, candidate)
        if (previous.some((old) => revisions.get(old.id) !== old.revision)) reviews.push({ index, previous })
      }
      if (reviews.length > 0) return { status: 'needs_review', reviews }

      let saved = 0
      for (const { candidate, newestSourceAt, newestSourceSeq, expiresAt } of changes) {
        if (candidate.action === 'reuse') {
          // 模型只能选它实际看过的旧条，类别、正文和时效以 SQLite 里的旧条为准。
          const old = tx.select().from(memories).where(eq(memories.id, candidate.memoryId)).get()
          if (!old || old.revision !== revisions.get(old.id)) throw new InvalidCandidates()
          const reused = saveCharacterMemory(tx, {
            conversationId: job.conversationId, kind: old.kind, memoryKey: old.memoryKey, content: old.content,
            sourceMessageIds: candidate.sourceMessageIds, expiresAt: old.expiresAt, reuse: { id: old.id, revision: old.revision },
            origin: 'user_explicit', now,
          })
          if (reused.status !== 'already_saved') throw new InvalidCandidates()
          continue
        }
        const replacement = candidate.action === 'replace'
          ? readReplacement(tx, current, candidate, revisions, newestSourceSeq, newestSourceAt, now) : undefined
        // 例如昨天说「今天很累」，即使后来才处理，也不能当成今天的状态。
        if (expiresAt !== null && expiresAt <= now) continue
        const result = saveCharacterMemory(tx, {
          conversationId: job.conversationId, kind: candidate.kind, memoryKey: candidate.memoryKey,
          content: candidate.content, sourceMessageIds: candidate.sourceMessageIds, expiresAt, replacement,
          origin: candidate.kind === 'episode' ? 'conversation_event' : 'user_explicit', now,
        })
        if (!('memory' in result)) throw new InvalidCandidates()
        if (result.status === 'saved') saved += 1
      }
      tx.update(conversations).set({ lastProcessedSeq: current.batch.end.seq, lastProcessedOffset: current.batch.end.offset })
        .where(eq(conversations.id, job.conversationId)).run()
      tx.update(memoryJobs).set({ status: 'completed', leaseUntil: null, lastErrorCode: null, updatedAt: now })
        .where(eq(memoryJobs.id, job.id)).run()
      return { status: 'completed', saved }
    })
  } catch (error) {
    if (error instanceof InvalidCandidates) return { status: 'invalid_candidates' }
    throw error
  }
}
