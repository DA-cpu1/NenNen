/** 执行一次已预占额度的整理请求，退出或超时后不再等待模型响应。 */
import type { LanguageModel } from 'ai'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { memoryJobs } from '../data/tables'
import { extractCandidates, type ExtractionResult } from './extract-candidates'
import { finishMemoryAttempt, type MemoryAttempt } from './memory-budget'
import { readMemoryJobWork } from './memory-jobs'

/**
 * 在本次任务的有效时间内提取并保存候选。即使模型忽略取消，晚到的回复也进不了保存步骤。
 * @param db 后台数据库连接
 * @param attempt 已领取且写入用量预占的任务
 * @param model 当前配置的模型
 * @param stopSignal 后台退出、更换密钥或本批依赖失效时发出的取消信号
 * @returns 结算完成后返回，数据库无法写入时由调度层处理
 */
export async function runMemoryAttempt(
  db: BetterSQLite3Database, attempt: MemoryAttempt, model: LanguageModel, stopSignal: AbortSignal,
): Promise<void> {
  // 领取后还可能等在调度层，真正发请求前再看一次当前版本。没请求过就记实际用量为零。
  const job = db.select().from(memoryJobs).where(eq(memoryJobs.id, attempt.work.job.id)).get()
  if (stopSignal.aborted || job?.status !== 'running' || job.attempts !== attempt.work.job.attempts || !readMemoryJobWork(db, job)) {
    finishMemoryAttempt(db, attempt, { ok: false, code: 'E_CANCELLED', usage: {
      inputTokens: 0, outputTokens: 0, estimated: false,
    } }, Date.now())
    return
  }
  const deadline = attempt.work.job.leaseUntil!
  const deadlineController = new AbortController()
  const remaining = deadline - Date.now()
  const timer = remaining > 0 ? setTimeout(() => deadlineController.abort(), remaining) : undefined
  if (remaining <= 0) deadlineController.abort()
  const signal = AbortSignal.any([stopSignal, deadlineController.signal])
  const cancelled: ExtractionResult = { ok: false, code: 'E_CANCELLED', usage: {
    inputTokens: attempt.prepared.estimatedInputTokens, outputTokens: attempt.prepared.outputLimit, estimated: true,
  } }

  // 两边谁先结束就采用谁。模型收到取消后仍可能晚到，只有这里可以写入候选。
  let onAbort!: () => void
  const interruption = new Promise<ExtractionResult>((resolve) => {
    onAbort = () => resolve(cancelled)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    const result = signal.aborted ? cancelled : await Promise.race([
      interruption, extractCandidates(model, attempt.prepared, signal),
    ])
    // 取结果和保存之间也可能收到取消。已有用量仍照实入账。
    finishMemoryAttempt(db, attempt, signal.aborted ? { ...cancelled, usage: result.usage } : result, Date.now())
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}
