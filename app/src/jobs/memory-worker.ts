/** 按聊天、空闲、预算和重试时间唤醒整理；进程同时只运行一次后台提取。 */
import type { LanguageModel } from 'ai'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { conversations } from '../data/tables'
import { beginMemoryAttempt, recoverExpiredMemoryJobs } from './memory-budget'
import { registerMemoryJob, type MemoryJob } from './memory-jobs'
import { readMemoryTrigger } from './memory-trigger'
import { runMemoryAttempt } from './run-memory-attempt'

const storageRetryMs = 30_000

/**
 * 建立后台调度器。聊天有变动时唤醒，空闲时只等 SQLite 算出的下一个时刻。
 * @param db 后台数据库连接，退出前须先等待调度器停下
 * @param getModel 取当前密钥配置的模型，无配置时仅恢复过期任务
 * @returns 唤醒、取消当前尝试与停止的入口
 */
export function createMemoryWorker(db: BetterSQLite3Database, getModel: () => Exclude<LanguageModel, string> | undefined) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let running: Promise<void> | undefined
  let controller: AbortController | undefined
  let stopped = false

  /** 一个定时器始终只约下一次检查。新的聊天事件可以把这次检查提前。 */
  function schedule(delay: number): void {
    if (stopped) return
    clearTimeout(timer)
    // 系统时间调早后，原时间戳可能在很远的将来。超出 Node 的定时范围会被当成 1 毫秒。
    timer = setTimeout(tick, Math.min(2_147_483_647, Math.max(0, delay)))
  }

  /** 数据库暂时不可写时留着原任务，间隔一段时间再读；日志只报固定错误码。 */
  function retryStorage(): void {
    process.stderr.write('E_MEMORY_WORKER_STORAGE\n')
    schedule(storageRetryMs)
  }

  /** 先收过期任务，再找最早可运行的批次。一次执行完成后重新从库读取。 */
  function tick(): void {
    try {
      const now = Date.now()
      let next = recoverExpiredMemoryJobs(db, now) ?? Infinity
      const model = getModel()
      let ready: MemoryJob | undefined
      if (model) {
        const formal = db.select({ id: conversations.id }).from(conversations).where(eq(conversations.mode, 'normal')).all()
        for (const { id } of formal) {
          const job = registerMemoryJob(db, id, now)
          if (job?.status === 'pending') {
            if (job.availableAt > now) next = Math.min(next, job.availableAt)
            else if (!ready || job.availableAt < ready.availableAt) ready = job
          } else if (!job) {
            const trigger = readMemoryTrigger(db, id, now)
            if (trigger && trigger.readyAt > now) next = Math.min(next, trigger.readyAt)
          }
        }
      }
      if (!model || !ready) {
        if (Number.isFinite(next)) schedule(next - now)
        return
      }
      const result = beginMemoryAttempt(db, ready.id, { name: model.modelId, provider: model.provider }, now)
      if (result.status !== 'ready') {
        schedule(0) // 本批预算不足或已失效时，仍可检查其他会话。
        return
      }
      controller = new AbortController()
      running = runMemoryAttempt(db, result.attempt, model, controller.signal).then(() => {
        running = undefined
        controller = undefined
        schedule(0)
      }, () => {
        running = undefined
        controller = undefined
        retryStorage()
      })
    } catch {
      retryStorage()
    }
  }

  return {
    /** 有新消息、回复终态或可用模型时，请后台重新检查。 */
    wake: () => { if (!running) schedule(0) },
    /** 更换密钥时停止当前调用。新的密钥可用后再唤醒。 */
    cancelCurrent: () => controller?.abort(),
    /** 禁止新任务并等待当前取消写入 SQLite。 */
    stop: async () => {
      stopped = true
      clearTimeout(timer)
      controller?.abort()
      await running
    },
  }
}
