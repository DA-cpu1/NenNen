/** 根据正式会话剩余的可用文字和完成轮数，计算下一次整理何时可以开始。 */
import { and, asc, eq, gt, lte } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { usableHistory, type ContextMessage } from '../agent/turn-context'
import { conversations, messages } from '../data/tables'
import { countCompletedTurns } from '../data/turns'

const completedTurnLimit = 10
const textLimit = 6_000
const idleMs = 5 * 60 * 1_000

/** 可以开始检查批次的条件。空闲条件也会给出尚未来到的就绪时间。 */
export type MemoryTrigger = { reason: 'completed-turns' | 'text-size' | 'idle'; readyAt: number }

/**
 * 读取进度书签之后可当来源的消息，复用聊天历史的筛选规则。
 * @param db 后台数据库连接
 * @param conversationId 已核对是正式会话的编号
 * @param afterSeq 已整理到的消息顺序号
 * @param endSeq 已登记任务最多读到的位置；登记新任务时省略
 * @returns 按顺序排列的用户原话和对应完整回复，主动问候不参加整理
 */
export function readUnprocessedMemoryMessages(
  db: BetterSQLite3Database, conversationId: string, afterSeq: number, endSeq?: number,
): ContextMessage[] {
  const rows = db.select().from(messages).where(and(
    eq(messages.conversationId, conversationId), gt(messages.seq, afterSeq),
    endSeq === undefined ? undefined : lte(messages.seq, endSeq),
  )).orderBy(asc(messages.seq)).all()
  return usableHistory(rows).filter((row) => row.role !== 'proactive')
}

/**
 * 计算整理触发条件。失败或取消的回复不会凑满十轮，但其用户原话仍可参加文本或空闲整理。
 * @param db 后台数据库连接
 * @param conversationId 要检查的应用会话编号
 * @param now 当前毫秒时间戳，测试可固定
 * @returns 整理理由与最早时刻，或没有满足条件时的 null
 */
export function readMemoryTrigger(db: BetterSQLite3Database, conversationId: string, now: number): MemoryTrigger | null {
  const conversation = db.select().from(conversations).where(eq(conversations.id, conversationId)).get()
  if (conversation?.mode !== 'normal') return null
  const afterSeq = conversation.lastProcessedSeq - (conversation.lastProcessedOffset > 0 ? 1 : 0)
  const pending = readUnprocessedMemoryMessages(db, conversationId, afterSeq)
  const userCount = pending.filter((message) => message.role === 'user').length
  if (userCount === 0) return null
  // 已开始的一条原话要把剩余部分读完，无须重新累积十轮或等待用户再说一句。
  if (conversation.lastProcessedOffset > 0) return { reason: 'text-size', readyAt: now }
  if (countCompletedTurns(db, conversationId, afterSeq) >= completedTurnLimit) {
    return { reason: 'completed-turns', readyAt: now }
  }
  // 按 Unicode 码点数原文，中文和单个 emoji 各算一个，和聊天输入的口径一致。
  const characters = pending.reduce((total, message) => total + [...message.content].length, 0)
  if (characters > textLimit) return { reason: 'text-size', readyAt: now }
  if (userCount >= 2) return { reason: 'idle', readyAt: conversation.lastMessageAt + idleMs }
  return null
}
