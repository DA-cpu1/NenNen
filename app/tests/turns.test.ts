/** 使用固定消息关系检查轮数，保证重试、失败、取消和主动问候不把整理触发次数算错。 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openCompanionDatabase, type CompanionDb } from '../src/data/db'
import { runMigrations } from '../src/data/migrations'
import { initializeFirstCharacter } from '../src/data/character-init'
import { createAssistantReply, saveUserMessage, updateAssistantReply } from '../src/data/messages'
import { countCompletedTurns } from '../src/data/turns'
import { conversations, messages } from '../src/data/tables'

let companion: CompanionDb
let conversationId: string
const now = 1740000005000

beforeEach(() => {
  companion = openCompanionDatabase(':memory:')
  runMigrations(companion.sqlite)
  conversationId = initializeFirstCharacter(companion.db, {
    name: '检查角色', personaText: '检查人设', initialRelationship: '恋人',
    timezone: 'Asia/Hong_Kong', now,
  }).conversationId
})

afterEach(() => companion.close())

describe('完成轮数（T06⑤）', () => {
  it('只有用户消息且没有完整回复时，失败、取消和流式都不计轮数', () => {
    const user = saveUserMessage(companion.db, { conversationId, requestId: 'request-1', content: '你好', now }).message
    expect(countCompletedTurns(companion.db, conversationId)).toBe(0)
    for (const status of ['failed', 'cancelled'] as const) {
      const reply = createAssistantReply(companion.db, { userMessageId: user.id, now })
      updateAssistantReply(companion.db, { messageId: reply.id, content: '半截', status, now })
      expect(countCompletedTurns(companion.db, conversationId)).toBe(0)
    }
    const reply = createAssistantReply(companion.db, { userMessageId: user.id, now })
    updateAssistantReply(companion.db, { messageId: reply.id, content: '继续', status: 'streaming', now })
    expect(countCompletedTurns(companion.db, conversationId)).toBe(0)
    updateAssistantReply(companion.db, { messageId: reply.id, content: '继续聊吧', status: 'completed', now })
    expect(countCompletedTurns(companion.db, conversationId)).toBe(1)
  })

  it('同一用户消息多次成功回复只算一次，新的用户消息另算一轮', () => {
    for (const requestId of ['request-1', 'request-2']) {
      const user = saveUserMessage(companion.db, { conversationId, requestId, content: '你好', now }).message
      for (let attempt = 0; attempt < 2; attempt++) {
        const reply = createAssistantReply(companion.db, { userMessageId: user.id, now })
        updateAssistantReply(companion.db, { messageId: reply.id, content: '晚上好', status: 'completed', now })
      }
    }
    expect(countCompletedTurns(companion.db, conversationId)).toBe(2)
  })

  it('主动问候不是用户发起的一轮，即使有角色回复也不计数', () => {
    companion.db.insert(messages).values({
      id: 'proactive-check', conversationId, seq: 1, role: 'proactive', content: '晚上好', status: 'completed', createdAt: now,
    }).run()
    companion.db.insert(messages).values({
      id: 'assistant-check', conversationId, seq: 2, role: 'assistant', content: '晚安', status: 'completed',
      replyToId: 'proactive-check', createdAt: now,
    }).run()
    expect(countCompletedTurns(companion.db, conversationId)).toBe(0)
  })

  it('正式会话不会计入试聊已完成消息，试聊本身也返回零', () => {
    const formal = companion.db.select().from(conversations).get()!
    companion.db.insert(conversations).values({ ...formal, id: 'preview-check', mode: 'preview' }).run()
    const user = saveUserMessage(companion.db, {
      conversationId: 'preview-check', requestId: 'request-1', content: '试聊', now,
    }).message
    const reply = createAssistantReply(companion.db, { userMessageId: user.id, now })
    updateAssistantReply(companion.db, { messageId: reply.id, content: '试聊回复', status: 'completed', now })
    expect(countCompletedTurns(companion.db, conversationId)).toBe(0)
    expect(countCompletedTurns(companion.db, 'preview-check')).toBe(0)
    expect(() => countCompletedTurns(companion.db, 'missing')).toThrow('E_CONVERSATION_NOT_FOUND')
  })
})
