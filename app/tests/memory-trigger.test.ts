/** 用内存库和固定时间检查触发整理的三条规则，以及重试和试聊的边界。 */
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openCompanionDatabase, type CompanionDb } from '../src/data/db'
import { ensurePreviewConversation } from '../src/data/conversations'
import { initializeFirstCharacter } from '../src/data/character-init'
import { createAssistantReply, saveUserMessage, updateAssistantReply } from '../src/data/messages'
import { runMigrations } from '../src/data/migrations'
import { conversations, messages } from '../src/data/tables'
import { readMemoryTrigger, readUnprocessedMemoryMessages } from '../src/jobs/memory-trigger'

const now = 1_740_000_000_000
const fiveMinutes = 300_000
let companion: CompanionDb
let conversationId: string

beforeEach(() => {
  companion = openCompanionDatabase(':memory:')
  runMigrations(companion.sqlite)
  conversationId = initializeFirstCharacter(companion.db, {
    name: '测试角色', personaText: '设定', initialRelationship: '朋友', timezone: 'Asia/Hong_Kong', now,
  }).conversationId
})
afterEach(() => companion.close())

/** 保存一条虚构用户原话，时间固定用于检查空闲。 */
function user(id: string, content = '问', conversation = conversationId) {
  return saveUserMessage(companion.db, { conversationId: conversation, requestId: id, content, now }).message
}

/** 写一条完整或失败的固定回复，模拟重试时沿用相同用户消息。 */
function reply(source: string, status: 'completed' | 'cancelled' | 'failed' = 'completed') {
  const row = createAssistantReply(companion.db, { userMessageId: source, now })
  return updateAssistantReply(companion.db, { messageId: row.id, content: '答', status, now })
}

describe('自动整理触发条件', () => {
  it('只数书签之后真正完成的用户轮次，取消和失败不计，成功重试最多计一次', () => {
    const first = user('already')
    const previous = reply(first.id)
    companion.db.update(conversations).set({ lastProcessedSeq: previous.seq }).run()
    for (let index = 0; index < 9; index += 1) reply(user(`turn-${index}`).id)
    const retry = user('retry')
    reply(retry.id, 'cancelled')
    reply(retry.id, 'failed')
    expect(readMemoryTrigger(companion.db, conversationId, now)?.reason).toBe('idle')
    reply(retry.id)
    reply(retry.id)
    expect(readMemoryTrigger(companion.db, conversationId, now)).toEqual({ reason: 'completed-turns', readyAt: now })
  })

  it('未处理文字严格超过 6000 码点才立即触发，排除消息不参与', () => {
    const exact = user('exact', '😀'.repeat(6_000))
    expect(readMemoryTrigger(companion.db, conversationId, now)).toBeNull()
    user('one-more', '中')
    expect(readMemoryTrigger(companion.db, conversationId, now)).toEqual({ reason: 'text-size', readyAt: now })
    companion.db.update(messages).set({ excludedFromContext: 1 }).where(eq(messages.id, exact.id)).run()
    expect(readMemoryTrigger(companion.db, conversationId, now)).toBeNull()
  })

  it('无新消息和只有一条短消息时不空转，两条从最后活动起等五分钟', () => {
    expect(readMemoryTrigger(companion.db, conversationId, now)).toBeNull()
    user('one')
    expect(readMemoryTrigger(companion.db, conversationId, now + fiveMinutes)).toBeNull()
    user('two')
    expect(readMemoryTrigger(companion.db, conversationId, now)).toEqual({ reason: 'idle', readyAt: now + fiveMinutes })
    expect(readMemoryTrigger(companion.db, conversationId, now + fiveMinutes - 1)?.readyAt).toBe(now + fiveMinutes)
  })

  it('试聊长文也不会触发，正式整理跳过主动、被排除来源和不完整回复', () => {
    const characterId = companion.db.select().from(conversations).get()!.characterId
    const preview = ensurePreviewConversation(companion.db, characterId)
    user('preview', '中'.repeat(7_000), preview.id)
    expect(readMemoryTrigger(companion.db, preview.id, now)).toBeNull()
    const skipped = user('skipped')
    reply(skipped.id)
    const kept = user('kept')
    reply(kept.id, 'cancelled')
    companion.db.update(messages).set({ excludedFromContext: 1 }).where(eq(messages.id, skipped.id)).run()
    companion.db.insert(messages).values({ id: 'active', conversationId, seq: 99, role: 'proactive',
      status: 'completed', content: '问候', createdAt: now }).run()
    expect(readUnprocessedMemoryMessages(companion.db, conversationId, 0).map(({ id }) => id)).toEqual([kept.id])
  })
})
