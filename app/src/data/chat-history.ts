/**
 * 从正式会话读取供用户查看的历史，按顺序分批返回，避免长聊一次搬出全部文字。
 * 这里保留被排除出模型上下文的原文；「用户仍能查看」与「可以发给模型」是两件事。
 */
import { and, desc, eq, lt } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { conversations, messages } from './tables'
import type { ChatHistoryPage, ChatHistoryQuery, ChatMessage } from '../shared/chat-history'

/**
 * 读取指定正式会话的一页消息，试聊不能通过此正式历史入口读取。
 * @param db 后台数据库连接
 * @param query 已通过格式检查的会话编号、翻页边界和条数
 * @returns 从旧到新的一页历史及是否还有更早记录
 * @throws E_CONVERSATION_NOT_FOUND 会话不存在；E_PREVIEW_NOT_ALLOWED 误传试聊会话
 */
export function readChatHistory(db: BetterSQLite3Database, query: ChatHistoryQuery): ChatHistoryPage {
  const conversation = db.select().from(conversations)
    .where(eq(conversations.id, query.conversationId)).get()
  if (!conversation) throw new Error('E_CONVERSATION_NOT_FOUND')
  if (conversation.mode !== 'normal') throw new Error('E_PREVIEW_NOT_ALLOWED')
  const rows = db.select().from(messages).where(and(
    eq(messages.conversationId, conversation.id),
    query.beforeSeq === undefined ? undefined : lt(messages.seq, query.beforeSeq),
  )).orderBy(desc(messages.seq)).limit(query.limit + 1).all()
  return {
    conversationId: conversation.id, characterId: conversation.characterId,
    // 多取一条只为判断有没有更早记录；真正返回时反转成阅读顺序。
    messages: rows.slice(0, query.limit).reverse().map((row) => ({
      ...row,
      // 两列值已受数据库 CHECK 限定，下面只收窄 TypeScript 看到的字符串类型。
      role: row.role as ChatMessage['role'], status: row.status as ChatMessage['status'],
      excludedFromContext: row.excludedFromContext === 1,
    })),
    hasMore: rows.length > query.limit,
  }
}
