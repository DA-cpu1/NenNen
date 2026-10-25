/**
 * 保存用户发来的消息，防止网络重试让同一句话在历史里出现两次。
 * 请求编号只在所属会话内认领；正文和编号已经对应后，不允许换正文冒充重试。
 * 此处只管落库，不启动模型，也不把「用户消息已保存」当成「角色回复已完成」。
 */
import { randomUUID } from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { conversations, messages } from './tables'

/** 用户发送一次消息所需的资料；消息身份和状态由程序填写，调用方不能自选。 */
export interface SaveUserMessageInput {
  conversationId: string
  requestId: string
  content: string
  /** 检查时可传固定时间；正式发送时省略。 */
  now?: number
}

/** created=false 表示原请求已保存，message 原样返回第一次落库的消息。 */
export interface SaveUserMessageResult {
  message: typeof messages.$inferSelect
  created: boolean
}

/**
 * 保存用户消息；重试同一请求时返回已有记录，不再占一个消息顺序号。
 * 事务表示下面几次读写一起成功、一起撤销，防止只更新了会话时间却没存下消息。
 * @param db 后台唯一的数据库写连接
 * @param input 会话、请求编号、未经改写的正文及可选检查时间
 * @returns 消息行以及本次是否新建
 * @throws E_INVALID_MESSAGE 输入为空白；E_CONVERSATION_NOT_FOUND 会话不存在；
 * E_REQUEST_CONFLICT 同一编号被用于不同内容；数据库失败原样抛给服务层处理
 */
export function saveUserMessage(
  db: BetterSQLite3Database,
  input: SaveUserMessageInput,
): SaveUserMessageResult {
  if (!input.conversationId.trim() || !input.requestId.trim() || !input.content.trim()) {
    throw new Error('E_INVALID_MESSAGE')
  }

  return db.transaction((tx) => {
    const conversation = tx.select().from(conversations)
      .where(eq(conversations.id, input.conversationId)).get()
    if (!conversation) throw new Error('E_CONVERSATION_NOT_FOUND')

    const existing = tx.select().from(messages).where(and(
      eq(messages.conversationId, input.conversationId),
      eq(messages.clientRequestId, input.requestId),
    )).get()
    if (existing) {
      // 不用新正文覆盖旧消息；否则回复可能仍对应旧内容，界面却显示另一句话。
      if (existing.role !== 'user' || existing.content !== input.content) {
        throw new Error('E_REQUEST_CONFLICT')
      }
      return { message: existing, created: false }
    }

    // 角色回复也占顺序号，所以找整个会话的最后一条，而不是只数用户消息。
    const last = tx.select({ seq: messages.seq }).from(messages)
      .where(eq(messages.conversationId, input.conversationId))
      .orderBy(desc(messages.seq)).limit(1).get()
    const now = input.now ?? Date.now()
    const message = tx.insert(messages).values({
      id: `msg-${randomUUID()}`,
      conversationId: input.conversationId,
      seq: (last?.seq ?? 0) + 1,
      role: 'user',
      content: input.content,
      // 用户的话已完整收到；角色是否回复成功将由独立的回复消息记录。
      status: 'completed',
      clientRequestId: input.requestId,
      createdAt: now,
    }).returning().get()
    tx.update(conversations).set({ lastMessageAt: now })
      .where(eq(conversations.id, input.conversationId)).run()
    return { message, created: true }
  })
}
