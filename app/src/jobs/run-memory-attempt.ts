/** 执行一次已预占额度的整理请求，退出或超时后不再等待模型响应。 */
import type { LanguageModel } from 'ai'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { memoryJobs } from '../data/tables'
import { extractCandidates, type ExtractionResult, type PreparedMemoryExtraction } from './extract-candidates'
import { finishMemoryAttempt, type MemoryAttempt } from './memory-budget'
import { readMemoryJobWork } from './memory-jobs'

/** 模型收到取消后仍可能晚到。用信号结束等待，已经发出的请求保留预占用量。 */
async function extractUntilAbort(
  model: LanguageModel, prepared: PreparedMemoryExtraction, signal: AbortSignal,
): Promise<ExtractionResult> {
  if (signal.aborted) return { ok: false, code: 'E_CANCELLED', usage: {
    inputTokens: 0, outputTokens: 0, estimated: false,
  } }
  const cancelled: ExtractionResult = { ok: false, code: 'E_CANCELLED', usage: {
    inputTokens: prepared.estimatedInputTokens, outputTokens: prepared.outputLimit, estimated: true,
  } }
  let onAbort!: () => void
  const interruption = new Promise<ExtractionResult>((resolve) => {
    onAbort = () => resolve(cancelled)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    const result = await Promise.race([interruption, extractCandidates(model, prepared, signal)])
    return signal.aborted ? { ...cancelled, usage: result.usage } : result
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * 在本次任务的有效时间内提取并保存候选。需要补判时沿用同一个截止时间。
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
  try {
    let request: MemoryAttempt | undefined = attempt
    while (request) {
      if (Date.now() >= deadline) deadlineController.abort()
      const result = await extractUntilAbort(model, request.prepared, signal)
      // 取结果和保存之间也可能收到取消。已有用量仍照实入账。
      request = finishMemoryAttempt(db, request, signal.aborted
        ? { ok: false, code: 'E_CANCELLED', usage: result.usage } : result, Date.now())
    }
  } finally {
    clearTimeout(timer)
  }
}
