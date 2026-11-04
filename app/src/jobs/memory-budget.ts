/** 在模型调用前按本地日历预占整理次数与 token，和实际调用使用同一份账本。 */
import { randomUUID } from 'node:crypto'
import { and, count, eq, gte, lt, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import { listCurrentMemories } from '../data/memories'
import { readSetting } from '../data/settings'
import { agentRuns, memoryJobs } from '../data/tables'
import { prepareMemoryExtraction, type PreparedMemoryExtraction } from './extract-candidates'
import { claimMemoryJob, readMemoryJobWork, type MemoryJobWork } from './memory-jobs'

const defaults = { requests: 20, tokens: 40_000 }
const limitsSchema = z.strictObject({ requests: z.number().int().positive(), tokens: z.number().int().positive() })

/** 已准备并预占额度的模型尝试；runId 用于结束时结算同一笔账。 */
export interface MemoryAttempt { work: MemoryJobWork; prepared: PreparedMemoryExtraction; runId: string }

/** 预算或任务状态不允许发送时，调用方无需构造模型请求。 */
export type BeginMemoryAttemptResult = { status: 'ready'; attempt: MemoryAttempt } |
  { status: 'delayed'; retryAt: number } | { status: 'unavailable' }

/**
 * 在同一事务中检查额度、领取任务并预占用量，防止两个任务同时花掉最后一个名额。
 * @param db 后台数据库连接
 * @param jobId 已登记的任务编号
 * @param model 实际配置的模型和供应商名
 * @param now 当前毫秒时间戳，用本地午夜划分每日账本
 * @returns 可发送的请求及运行编号，或延迟与拒绝状态
 */
export function beginMemoryAttempt(
  db: BetterSQLite3Database, jobId: string, model: { name: string; provider: string }, now: number,
): BeginMemoryAttemptResult {
  return db.transaction((tx) => {
    const job = tx.select().from(memoryJobs).where(eq(memoryJobs.id, jobId)).get()
    if (!job || job.status !== 'pending' || job.availableAt > now) return { status: 'unavailable' }
    const snapshot = readMemoryJobWork(tx, job)
    if (!snapshot) {
      claimMemoryJob(tx, jobId, now) // 让失效任务退出待执行状态。
      return { status: 'unavailable' }
    }
    const prepared = prepareMemoryExtraction(snapshot.batch, listCurrentMemories(tx, snapshot.characterId, now))
    const configured = limitsSchema.safeParse(readSetting(tx, 'memory.daily-limits'))
    const limits = configured.success ? configured.data : defaults
    const start = new Date(now).setHours(0, 0, 0, 0)
    const next = new Date(now).setHours(24, 0, 0, 0)
    // 只数整理调用；正在跑的记录已经含预占值，关闭应用也不会让这次消费凭空消失。
    const used = tx.select({ requests: count(), tokens: sql<number>`COALESCE(SUM(
      COALESCE(${agentRuns.inputTokens}, 0) + COALESCE(${agentRuns.outputTokens}, 0)), 0)` })
      .from(agentRuns).where(and(eq(agentRuns.triggerType, 'memory'), gte(agentRuns.startedAt, start), lt(agentRuns.startedAt, next))).get()!
    if (used.requests >= limits.requests || used.tokens + prepared.estimatedInputTokens + prepared.outputLimit > limits.tokens) {
      tx.update(memoryJobs).set({ availableAt: next, updatedAt: now }).where(eq(memoryJobs.id, job.id)).run()
      return { status: 'delayed', retryAt: next }
    }
    const work = claimMemoryJob(tx, jobId, now)
    if (!work) return { status: 'unavailable' }
    const runId = `run-${randomUUID()}`
    tx.insert(agentRuns).values({
      id: runId, conversationId: work.job.conversationId, characterId: work.characterId, characterVersionId: null,
      triggerType: 'memory', model: model.name, provider: model.provider, status: 'running',
      inputTokens: prepared.estimatedInputTokens, outputTokens: prepared.outputLimit, usageEstimated: 1, startedAt: now,
    }).run()
    return { status: 'ready', attempt: { work, prepared, runId } }
  })
}
