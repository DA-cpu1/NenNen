/** 按本地日历预占整理额度，并把用量结算与候选或退避状态一起写入 SQLite。 */
import { and, count, eq, gte, lt, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import { finishAgentRun } from '../data/agent-runs'
import { listCurrentMemories } from '../data/memories'
import { readSetting } from '../data/settings'
import { agentRuns, memoryJobs } from '../data/tables'
import { commitMemoryCandidates } from './commit-candidates'
import { prepareMemoryExtraction, type ExtractionResult, type PreparedMemoryExtraction } from './extract-candidates'
import { claimMemoryJob, readMemoryJobWork, type MemoryJob, type MemoryJobWork } from './memory-jobs'

const defaults = { requests: 20, tokens: 40_000 }
const limitsSchema = z.strictObject({ requests: z.number().int().positive(), tokens: z.number().int().positive() })
const retryDelays = [30_000, 120_000, 600_000]

/** 用任务号和尝试次数找到同一笔用量，进程重启后也能找到。 */
function runIdFor(job: MemoryJob): string {
  return `run-${job.id}-${job.attempts}`
}

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
    const runId = runIdFor(work.job)
    tx.insert(agentRuns).values({
      id: runId, conversationId: work.job.conversationId, characterId: work.characterId, characterVersionId: null,
      triggerType: 'memory', model: model.name, provider: model.provider, status: 'running',
      inputTokens: prepared.estimatedInputTokens, outputTokens: prepared.outputLimit, usageEstimated: 1, startedAt: now,
    }).run()
    return { status: 'ready', attempt: { work, prepared, runId } }
  })
}

/** 当前批次还有效时，给下一次尝试留出等待时间。耗尽重试后保留失败记录和原书签。 */
function endFailedJob(db: BetterSQLite3Database, job: MemoryJob, now: number, errorCode: string): void {
  const retryDelay = retryDelays[job.attempts - 1]
  db.update(memoryJobs).set({ status: retryDelay === undefined ? 'failed' : 'pending',
    availableAt: retryDelay === undefined ? job.availableAt : now + retryDelay,
    leaseUntil: null, updatedAt: now, lastErrorCode: errorCode }).where(eq(memoryJobs.id, job.id)).run()
}

/** 收起来源或版本失效的旧任务，给仍可整理的新批次留位置。 */
function markStaleJob(db: BetterSQLite3Database, job: MemoryJob, now: number): void {
  db.update(memoryJobs).set({ status: 'stale', leaseUntil: null, updatedAt: now, lastErrorCode: 'E_MEMORY_STALE' })
    .where(eq(memoryJobs.id, job.id)).run()
}

/**
 * 结算一次整理。候选、书签和用量一起落库，重复通知不会再写候选或再记一次用量。
 * @param db 后台数据库连接
 * @param attempt 调用前领取的任务和运行号
 * @param result 模型结果或固定错误码及用量
 * @param now 结束时的毫秒时间戳
 * @returns 无返回值，结果记录在 SQLite
 */
export function finishMemoryAttempt(db: BetterSQLite3Database, attempt: MemoryAttempt, result: ExtractionResult, now: number): void {
  db.transaction((tx) => {
    const run = tx.select().from(agentRuns).where(eq(agentRuns.id, attempt.runId)).get()
    if (run?.status !== 'running') return
    const job = tx.select().from(memoryJobs).where(eq(memoryJobs.id, attempt.work.job.id)).get()
    const ownsJob = job?.status === 'running' && job.attempts === attempt.work.job.attempts
    let errorCode: string | undefined
    if (!ownsJob || !readMemoryJobWork(tx, job)) {
      errorCode = 'E_MEMORY_STALE'
      if (ownsJob) markStaleJob(tx, job, now)
    } else if (job.leaseUntil !== null && job.leaseUntil <= now) {
      errorCode = 'E_MEMORY_TIMEOUT'
    } else if (!result.ok) {
      errorCode = result.code
    } else {
      const committed = commitMemoryCandidates(tx, attempt.work, result.candidates, attempt.prepared.previousRevisions, now)
      if (committed.status === 'invalid_candidates') errorCode = 'E_INVALID_CANDIDATES'
      if (committed.status === 'stale') errorCode = 'E_MEMORY_STALE'
    }
    if (ownsJob && errorCode && errorCode !== 'E_MEMORY_STALE') endFailedJob(tx, job, now, errorCode)
    const cancelled = errorCode === 'E_CANCELLED' || errorCode === 'E_MEMORY_STALE'
    finishAgentRun(tx, { runId: run.id, status: cancelled ? 'cancelled' : errorCode ? 'failed' : 'completed',
      usage: result.usage, errorCode, now })
  })
}

/**
 * 回收已过期的整理任务。租约是任务的占用截止时间，未到点仍视为原尝试占用。
 * @param db 后台数据库连接
 * @param now 当前毫秒时间戳
 * @returns 最早尚未到期的租约时间，没有则返回 undefined
 */
export function recoverExpiredMemoryJobs(db: BetterSQLite3Database, now: number): number | undefined {
  return db.transaction((tx) => {
    let nextLease: number | undefined
    const running = tx.select().from(memoryJobs).where(eq(memoryJobs.status, 'running')).all()
    for (const job of running) {
      if (job.leaseUntil !== null && job.leaseUntil > now) {
        nextLease = Math.min(nextLease ?? job.leaseUntil, job.leaseUntil)
        continue
      }
      const valid = readMemoryJobWork(tx, job)
      if (valid) endFailedJob(tx, job, now, 'E_INTERRUPTED')
      else markStaleJob(tx, job, now)
      // 上次可能已经发出请求。用量未收到时保留那次预占，不当成免费。
      const run = tx.select().from(agentRuns).where(eq(agentRuns.id, runIdFor(job))).get()
      if (run?.status === 'running') {
        tx.update(agentRuns).set({ status: 'failed', errorCode: 'E_INTERRUPTED', usageEstimated: 1, finishedAt: now })
          .where(eq(agentRuns.id, run.id)).run()
      }
    }
    return nextLease
  })
}
