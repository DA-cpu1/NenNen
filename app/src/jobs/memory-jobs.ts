/** 登记 SQLite 整理任务，在真正调用模型前复核正式会话、来源和三个数据版本。 */
import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { readGlobalMemoryEpoch } from '../data/epochs'
import { characters, conversations, memoryJobs } from '../data/tables'
import { planMemoryBatch, type MemoryBatch } from './memory-batch'
import { readMemoryTrigger, readUnprocessedMemoryMessages } from './memory-trigger'

/** 修改提取规则或批次尺寸时换版本，以免旧批次沿用新规则。 */
export const memoryExtractorVersion = '1'
const leaseMs = 90_000

/** 已登记的任务，以及核对后可用的角色和原话。 */
export type MemoryJob = typeof memoryJobs.$inferSelect
export interface MemoryJobWork { job: MemoryJob; characterId: string; batch: MemoryBatch }

/** 读当前版本和进度。试聊即使被伪造任务引用也拿不到工作资料。 */
function readMemoryState(db: BetterSQLite3Database, conversationId: string) {
  const conversation = db.select().from(conversations).where(eq(conversations.id, conversationId)).get()
  if (conversation?.mode !== 'normal') return null
  const character = db.select({ epoch: characters.memoryEpoch }).from(characters)
    .where(eq(characters.id, conversation.characterId)).get()
  if (!character) return null
  return {
    characterId: conversation.characterId,
    cursor: { seq: conversation.lastProcessedSeq, offset: conversation.lastProcessedOffset },
    characterEpoch: character.epoch, globalEpoch: readGlobalMemoryEpoch(db), contextEpoch: conversation.contextEpoch,
  }
}

/**
 * 复查任务锁定的版本和来源范围。后来聊天超出范围的文字不会挤进原批次。
 * @param db 后台连接；提交时传入正在使用的事务
 * @param job 调用方刚从数据库读出的任务
 * @returns 当前仍有效的任务资料，或 null 说明必须放弃旧结果
 */
export function readMemoryJobWork(db: BetterSQLite3Database, job: MemoryJob): MemoryJobWork | null {
  const state = readMemoryState(db, job.conversationId)
  if (!state || job.extractorVersion !== memoryExtractorVersion || job.characterEpoch !== state.characterEpoch ||
      job.globalEpoch !== state.globalEpoch || job.contextEpoch !== state.contextEpoch) return null
  const after = state.cursor.seq - (state.cursor.offset > 0 ? 1 : 0)
  const rows = readUnprocessedMemoryMessages(db, job.conversationId, after, job.endSeq)
  const batch = planMemoryBatch(rows, state.cursor)
  if (!batch || batch.start.seq !== job.startSeq || batch.start.offset !== job.startOffset ||
      batch.end.seq !== job.endSeq || batch.end.offset !== job.endOffset) return null
  return { job, characterId: state.characterId, batch }
}

/**
 * 到达触发条件后登记一批，重复检查复用同一有效任务。
 * @param db 后台数据库连接
 * @param conversationId 正式会话编号
 * @param now 当前毫秒时间戳
 * @returns 已存在或新建的待执行任务；无合格工作时返回 null
 */
export function registerMemoryJob(db: BetterSQLite3Database, conversationId: string, now: number): MemoryJob | null {
  return db.transaction((tx) => {
    const state = readMemoryState(tx, conversationId)
    if (!state) return null
    const active = tx.select().from(memoryJobs).where(and(eq(memoryJobs.conversationId, conversationId),
      inArray(memoryJobs.status, ['pending', 'running']))).get()
    if (active) {
      if (active.status === 'running' || readMemoryJobWork(tx, active)) return active
      tx.update(memoryJobs).set({ status: 'stale', leaseUntil: null, updatedAt: now })
        .where(eq(memoryJobs.id, active.id)).run()
    }
    const trigger = readMemoryTrigger(tx, conversationId, now)
    if (!trigger || trigger.readyAt > now) return null
    const after = state.cursor.seq - (state.cursor.offset > 0 ? 1 : 0)
    const batch = planMemoryBatch(readUnprocessedMemoryMessages(tx, conversationId, after), state.cursor)
    if (!batch) return null
    return tx.insert(memoryJobs).values({
      id: `memjob-${randomUUID()}`, conversationId, startSeq: batch.start.seq, startOffset: batch.start.offset,
      endSeq: batch.end.seq, endOffset: batch.end.offset, characterEpoch: state.characterEpoch,
      globalEpoch: state.globalEpoch, contextEpoch: state.contextEpoch, extractorVersion: memoryExtractorVersion,
      availableAt: now, createdAt: now, updatedAt: now,
    }).onConflictDoNothing().returning().get() ?? null
  })
}

/**
 * 领取到期的任务。只有成功登记为执行中才可向模型发请求。
 * @param db 后台连接，也可传外层预算事务
 * @param jobId 先前登记的批次编号
 * @param now 当前毫秒时间戳
 * @returns 领取成功后的任务和原话；过期或已领取的任务返回 null
 */
export function claimMemoryJob(db: BetterSQLite3Database, jobId: string, now: number): MemoryJobWork | null {
  return db.transaction((tx) => {
    const pending = tx.select().from(memoryJobs).where(eq(memoryJobs.id, jobId)).get()
    if (!pending || pending.status !== 'pending' || pending.availableAt > now) return null
    const work = readMemoryJobWork(tx, pending)
    if (!work) {
      tx.update(memoryJobs).set({ status: 'stale', leaseUntil: null, updatedAt: now })
        .where(eq(memoryJobs.id, pending.id)).run()
      return null
    }
    const job = tx.update(memoryJobs).set({ status: 'running', attempts: pending.attempts + 1,
      leaseUntil: now + leaseMs, updatedAt: now }).where(eq(memoryJobs.id, pending.id)).returning().get()!
    return { ...work, job }
  })
}
