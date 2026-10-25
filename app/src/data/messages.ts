/**
 * 保存用户发来的消息，防止网络重试让同一句话在历史里出现两次。
 * 请求编号只在所属会话内认领；正文和编号已经对应后，不允许换正文冒充重试。
 * 角色回复另存一行，通过 replyToId 关联用户消息；重试保留旧回复，再建新版本。
 * 此处只管落库，不启动模型，也不把「用户消息已保存」当成「角色回复已完成」。
 */
import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray } from 'drizzle-orm'
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

/** 创建角色回复时只认用户消息编号，不能由调用方另选会话。 */
export interface CreateAssistantReplyInput {
  userMessageId: string
  now?: number
}

/** 尚未结束的回复可继续显示文字，也可结束为成功、失败或取消。 */
export type AssistantReplyStatus = 'streaming' | 'completed' | 'failed' | 'cancelled'

/** 每次更新保存当前完整正文；重复收到同一段结果不会把文字拼接两遍。 */
export interface UpdateAssistantReplyInput {
  messageId: string
  content: string
  status: AssistantReplyStatus
  now?: number
}

/**
 * 为一条已保存的用户消息建立空回复，失败后的下一次尝试另建新行。
 * @param db 后台数据库连接
 * @param input 原用户消息编号及可选检查时间
 * @returns 新建的 pending 回复，正文暂时为空
 * @throws E_USER_MESSAGE_NOT_FOUND 没有对应用户消息；E_REPLY_IN_PROGRESS 原回复尚未结束
 */
export function createAssistantReply(db: BetterSQLite3Database, input: CreateAssistantReplyInput) {
  return db.transaction((tx) => {
    const user = tx.select().from(messages).where(and(
      eq(messages.id, input.userMessageId), eq(messages.role, 'user'),
    )).get()
    if (!user) throw new Error('E_USER_MESSAGE_NOT_FOUND')
    const active = tx.select({ id: messages.id }).from(messages).where(and(
      eq(messages.replyToId, user.id), eq(messages.role, 'assistant'),
      inArray(messages.status, ['pending', 'streaming']),
    )).get()
    if (active) throw new Error('E_REPLY_IN_PROGRESS')

    const last = tx.select({ seq: messages.seq }).from(messages)
      .where(eq(messages.conversationId, user.conversationId))
      .orderBy(desc(messages.seq)).limit(1).get()
    // 会话来自数据库里的原消息，不能把 A 角色的回复挂进 B 的聊天。
    return tx.insert(messages).values({
      id: `msg-${randomUUID()}`, conversationId: user.conversationId,
      seq: (last?.seq ?? 0) + 1, role: 'assistant', content: '', status: 'pending',
      replyToId: user.id, createdAt: input.now ?? Date.now(),
    }).returning().get()
  })
}

/**
 * 保存角色当前回复全文和状态，已结束的回复不能被迟到片段重新打开。
 * @param db 后台数据库连接
 * @param input 回复编号、当前全文、目标状态及可选检查时间
 * @returns 保存后的回复；完全相同的结束通知重放时返回原记录
 * @throws E_EMPTY_REPLY 没有正文却报告完成；E_REPLY_NOT_FOUND 没有该角色回复；
 * E_REPLY_ALREADY_FINISHED 已结束却收到不同结果
 */
export function updateAssistantReply(db: BetterSQLite3Database, input: UpdateAssistantReplyInput) {
  if (input.status === 'completed' && !input.content.trim()) throw new Error('E_EMPTY_REPLY')
  return db.transaction((tx) => {
    const reply = tx.select().from(messages).where(and(
      eq(messages.id, input.messageId), eq(messages.role, 'assistant'),
    )).get()
    if (!reply) throw new Error('E_REPLY_NOT_FOUND')
    if (reply.status !== 'pending' && reply.status !== 'streaming') {
      if (reply.status === input.status && reply.content === input.content) return reply
      throw new Error('E_REPLY_ALREADY_FINISHED')
    }
    const updated = tx.update(messages).set({ content: input.content, status: input.status })
      .where(eq(messages.id, reply.id)).returning().get()!
    tx.update(conversations).set({ lastMessageAt: input.now ?? Date.now() })
      .where(eq(conversations.id, reply.conversationId)).run()
    return updated
  })
}
