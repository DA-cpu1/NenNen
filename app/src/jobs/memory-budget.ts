/** 按本地日历预占整理额度，并把用量结算与候选或退避状态一起写入 SQLite。 */
import { and, count, eq, gte, lt, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import { finishAgentRun } from '../data/agent-runs'
import { listCurrentMemories } from '../data/memories'
import { readSetting } from '../data/settings'
import { agentRuns, memoryJobs } from '../data/tables'
import { findMemoryReviewCandidates } from '../memory/review-candidates'
import { commitMemoryCandidates } from './commit-candidates'
import { prepareMemoryExtraction, prepareMemoryReview, type ExtractionResult, type PreparedMemoryExtraction } from './extract-candidates'
import { claimMemoryJob, readMemoryJobWork, type MemoryJob, type MemoryJobWork } from './memory-jobs'

const defaults = { requests: 20, tokens: 40_000 }
const limitsSchema = z.strictObject({ requests: z.number().int().positive(), tokens: z.number().int().positive() })
const retryDelays = [30_000, 120_000, 600_000]

/** 用任务号和尝试次数找到同一笔用量，进程重启后也能找到。 */
function runIdFor(job: MemoryJob): string {
  return `run-${job.id}-${job.attempts}`
}

/** 补判单独占一次调用，也能在进程重启时按原任务编号找到。 */
function reviewRunIdFor(job: MemoryJob): string {
  return `${runIdFor(job)}-review`
}

/** 已准备并预占额度的模型尝试；runId 用于结束时结算同一笔账。 */
export interface MemoryAttempt { work: MemoryJobWork; prepared: PreparedMemoryExtraction; runId: string }

/** 预算或任务状态不允许发送时，调用方无需构造模型请求。 */
export type BeginMemoryAttemptResult = { status: 'ready'; attempt: MemoryAttempt } |
  { status: 'delayed'; retryAt: number } | { status: 'unavailable' }

/** 读本地当天已用和预占的额度，放不下整次请求时返回次日开始时间。 */
function budgetRetryAt(db: BetterSQLite3Database, prepared: PreparedMemoryExtraction, now: number): number | undefined {
  const configured = limitsSchema.safeParse(readSetting(db, 'memory.daily-limits'))
  const limits = configured.success ? configured.data : defaults
  const start = new Date(now).setHours(0, 0, 0, 0)
  const next = new Date(now).setHours(24, 0, 0, 0)
  // 正在跑的记录已经含预占值，关闭应用也不会让这次消费凭空消失。
  const used = db.select({ requests: count(), tokens: sql<number>`COALESCE(SUM(
    COALESCE(${agentRuns.inputTokens}, 0) + COALESCE(${agentRuns.outputTokens}, 0)), 0)` })
    .from(agentRuns).where(and(eq(agentRuns.triggerType, 'memory'), gte(agentRuns.startedAt, start), lt(agentRuns.startedAt, next))).get()!
  if (used.requests >= limits.requests || used.tokens + prepared.estimatedInputTokens + prepared.outputLimit > limits.tokens) return next
}

/** 先把模型请求和预估用量记入账本，调用返回后才换成实际用量。 */
function reserveMemoryRun(
  db: BetterSQLite3Database, attempt: MemoryAttempt, model: { name: string; provider: string }, now: number,
): void {
  const { work, runId, prepared } = attempt
  db.insert(agentRuns).values({
    id: runId, conversationId: work.job.conversationId, characterId: work.characterId, characterVersionId: null,
    triggerType: 'memory', model: model.name, provider: model.provider, status: 'running',
    inputTokens: prepared.estimatedInputTokens, outputTokens: prepared.outputLimit, usageEstimated: 1, startedAt: now,
  }).run()
}

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
    const { batch, characterId } = snapshot
    const previous = findMemoryReviewCandidates(tx, listCurrentMemories(tx, characterId, now), {
      sourceMessageIds: batch.sources.map((source) => source.id), memoryKey: null,
      content: batch.sources.map((source) => source.content).join('\n'),
    })
    const prepared = prepareMemoryExtraction(batch, previous)
    const retryAt = budgetRetryAt(tx, prepared, now)
    if (retryAt !== undefined) {
      tx.update(memoryJobs).set({ availableAt: retryAt, updatedAt: now }).where(eq(memoryJobs.id, job.id)).run()
      return { status: 'delayed', retryAt }
    }
    const work = claimMemoryJob(tx, jobId, now)
    if (!work) return { status: 'unavailable' }
    const attempt = { work, prepared, runId: runIdFor(work.job) }
    reserveMemoryRun(tx, attempt, model, now)
    return { status: 'ready', attempt }
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
 * @returns 已单独预占额度的补判请求；正常结束、失败或等额度时返回 undefined
 */
export function finishMemoryAttempt(
  db: BetterSQLite3Database, attempt: MemoryAttempt, result: ExtractionResult, now: number,
): MemoryAttempt | undefined {
  return db.transaction((tx) => {
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
      if (committed.status === 'needs_review') {
        if (attempt.prepared.review) {
          // 补判最多一次。若候选仍有变化，留着书签让正常重试重新读取资料。
          errorCode = 'E_INVALID_CANDIDATES'
        } else {
          const prepared = prepareMemoryReview(attempt.work.batch, result.candidates, committed.reviews, attempt.prepared.previousRevisions)
          finishAgentRun(tx, { runId: run.id, status: 'completed', usage: result.usage, now })
          const retryAt = budgetRetryAt(tx, prepared, now)
          if (retryAt !== undefined) {
            tx.update(memoryJobs).set({ status: 'pending', availableAt: retryAt, leaseUntil: null, updatedAt: now })
              .where(eq(memoryJobs.id, job.id)).run()
            return
          }
          const followUp = { work: attempt.work, prepared, runId: reviewRunIdFor(job) }
          reserveMemoryRun(tx, followUp, { name: run.model, provider: run.provider }, now)
          return followUp
        }
      }
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
      for (const id of [runIdFor(job), reviewRunIdFor(job)]) {
        tx.update(agentRuns).set({ status: 'failed', errorCode: 'E_INTERRUPTED', usageEstimated: 1, finishedAt: now })
          .where(and(eq(agentRuns.id, id), eq(agentRuns.status, 'running'))).run()
      }
    }
    return nextLease
  })
}
