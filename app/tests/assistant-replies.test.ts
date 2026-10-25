/**
 * 检查半截回复、结束通知与重试版本：旧片段不改写已结束的回复，新尝试不覆盖旧记录。
 * 使用内存数据库和固定文字，验证的是落库规则，不使用真实模型回复判断正确性。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { openCompanionDatabase, type CompanionDb } from '../src/data/db'
import { runMigrations } from '../src/data/migrations'
import { initializeFirstCharacter } from '../src/data/character-init'
import { createAssistantReply, saveUserMessage, updateAssistantReply } from '../src/data/messages'
import { conversations, messages } from '../src/data/tables'

let companion: CompanionDb
let userMessageId: string
const now = 1740000005000

beforeEach(() => {
  companion = openCompanionDatabase(':memory:')
  runMigrations(companion.sqlite)
  const initial = initializeFirstCharacter(companion.db, {
    name: '检查角色', personaText: '检查人设', initialRelationship: '恋人',
    timezone: 'Asia/Hong_Kong', now,
  })
  userMessageId = saveUserMessage(companion.db, {
    conversationId: initial.conversationId, requestId: 'request-1', content: '你好', now,
  }).message.id
})

afterEach(() => companion.close())

describe('角色回复保存与状态（T06③）', () => {
  it('新建空回复关联原用户消息，不能指定别的会话或用户请求编号', () => {
    const reply = createAssistantReply(companion.db, { userMessageId, now })
    const user = companion.db.select().from(messages).where(eq(messages.id, userMessageId)).get()!
    expect(reply).toMatchObject({
      conversationId: user.conversationId, seq: 2, role: 'assistant', content: '',
      status: 'pending', replyToId: userMessageId, clientRequestId: null,
    })
  })

  it('流式阶段保存当前全文，不会把相同片段重复拼接', () => {
    const reply = createAssistantReply(companion.db, { userMessageId, now })
    const input = { messageId: reply.id, content: '晚上好', status: 'streaming' as const, now: now + 1 }
    updateAssistantReply(companion.db, input)
    expect(updateAssistantReply(companion.db, input)).toMatchObject({ content: '晚上好', status: 'streaming' })
    const completed = updateAssistantReply(companion.db, { ...input, content: '晚上好。', status: 'completed' })
    expect(completed).toMatchObject({ content: '晚上好。', status: 'completed' })
  })

  it.each(['failed', 'cancelled'] as const)('%s 保留已经显示的半截文字', (status) => {
    const reply = createAssistantReply(companion.db, { userMessageId, now })
    updateAssistantReply(companion.db, {
      messageId: reply.id, content: '我刚才想到', status: 'streaming', now,
    })
    expect(updateAssistantReply(companion.db, {
      messageId: reply.id, content: '我刚才想到', status, now,
    })).toMatchObject({ content: '我刚才想到', status })
  })

  it.each(['failed', 'cancelled'] as const)('首字未到便 %s 可以保留空正文，但不能把空白标为完成', (status) => {
    const reply = createAssistantReply(companion.db, { userMessageId, now })
    expect(() => updateAssistantReply(companion.db, {
      messageId: reply.id, content: ' \n ', status: 'completed', now,
    })).toThrow('E_EMPTY_REPLY')
    expect(updateAssistantReply(companion.db, { messageId: reply.id, content: '', status, now }))
      .toMatchObject({ content: '', status })
  })

  it.each(['completed', 'failed', 'cancelled'] as const)('%s 后拒绝晚到文字，但原结果重放可复用', (status) => {
    const reply = createAssistantReply(companion.db, { userMessageId, now })
    const input = { messageId: reply.id, content: '本次结果', status, now }
    const ended = updateAssistantReply(companion.db, input)
    expect(updateAssistantReply(companion.db, { ...input, now: now + 10 })).toEqual(ended)
    expect(() => updateAssistantReply(companion.db, { ...input, content: '晚到的文字', status: 'streaming' }))
      .toThrow('E_REPLY_ALREADY_FINISHED')
  })

  it('原回复没结束时拒绝再建，结束后重试另建版本并保留旧文', () => {
    const old = createAssistantReply(companion.db, { userMessageId, now })
    expect(() => createAssistantReply(companion.db, { userMessageId, now })).toThrow('E_REPLY_IN_PROGRESS')
    updateAssistantReply(companion.db, { messageId: old.id, content: '半截', status: 'failed', now })
    const retry = createAssistantReply(companion.db, { userMessageId, now: now + 1 })
    expect(retry).toMatchObject({ seq: 3, replyToId: userMessageId, status: 'pending' })
    expect(retry.id).not.toBe(old.id)
    expect(companion.db.select().from(messages).where(eq(messages.id, old.id)).get()?.content).toBe('半截')
  })

  it('不存在的消息和角色回复不能冒充用户来源，用户消息也不能被当成回复改写', () => {
    expect(() => createAssistantReply(companion.db, { userMessageId: 'missing', now }))
      .toThrow('E_USER_MESSAGE_NOT_FOUND')
    const reply = createAssistantReply(companion.db, { userMessageId, now })
    expect(() => createAssistantReply(companion.db, { userMessageId: reply.id, now }))
      .toThrow('E_USER_MESSAGE_NOT_FOUND')
    for (const messageId of [userMessageId, 'missing']) {
      expect(() => updateAssistantReply(companion.db, { messageId, content: '改写', status: 'completed', now }))
        .toThrow('E_REPLY_NOT_FOUND')
    }
  })

  it('会话更新时间失败时，正文和完成状态一起回滚', () => {
    const reply = createAssistantReply(companion.db, { userMessageId, now })
    companion.sqlite.exec(`CREATE TRIGGER reject_reply_time BEFORE UPDATE OF last_message_at
      ON conversations BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`)
    expect(() => updateAssistantReply(companion.db, {
      messageId: reply.id, content: '晚上好', status: 'completed', now: now + 1,
    })).toThrow()
    expect(companion.db.select().from(messages).where(eq(messages.id, reply.id)).get())
      .toMatchObject({ content: '', status: 'pending' })
    expect(companion.db.select().from(conversations).get()?.lastMessageAt).toBe(now)
  })
})
