/**
 * 计算已经完整聊完的轮数：用户一句话有成功回复才算一轮，重试成功也只算一次。
 * 直接查询 SQLite 的消息关系，不另存容易在取消或重试时多加一次的计数器。
 */
import { and, countDistinct, eq } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { conversations, messages } from './tables'

/**
 * 数出正式会话中已有完整回复的用户消息数；试聊不计入正式整理依据。
 * @param db 后台数据库连接
 * @param conversationId 应用自己的会话编号
 * @returns 已完成轮数；没有完整回复或属于试聊时为 0
 * @throws E_CONVERSATION_NOT_FOUND 会话不存在
 */
export function countCompletedTurns(db: BetterSQLite3Database, conversationId: string): number {
  const conversation = db.select().from(conversations)
    .where(eq(conversations.id, conversationId)).get()
  if (!conversation) throw new Error('E_CONVERSATION_NOT_FOUND')
  if (conversation.mode !== 'normal') return 0

  // 同一张消息表同时承担「用户原话」和「角色回复」两种角色，所以给原话取查询别名。
  // 仍然读同一张表，没有复制数据。DISTINCT 表示同一用户编号只数一次。
  const user = alias(messages, 'user_message')
  const result = db.select({ total: countDistinct(user.id) }).from(messages)
    .innerJoin(user, and(eq(messages.replyToId, user.id), eq(messages.conversationId, user.conversationId)))
    .where(and(
      eq(user.conversationId, conversationId), eq(user.role, 'user'), eq(user.status, 'completed'),
      eq(messages.role, 'assistant'), eq(messages.status, 'completed'),
    )).get()
  return result?.total ?? 0
}
