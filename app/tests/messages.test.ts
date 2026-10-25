/**
 * 用固定消息检查保存防重：重放不多写、不同会话不串用、写一半失败不留半份数据。
 * 只使用内存及临时文件数据库和固定输入，不调用模型，也不读取用户的正式聊天。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { openCompanionDatabase, type CompanionDb } from '../src/data/db'
import { runMigrations } from '../src/data/migrations'
import { initializeFirstCharacter } from '../src/data/character-init'
import { saveUserMessage } from '../src/data/messages'
import { conversations, messages } from '../src/data/tables'

let companion: CompanionDb
let conversationId: string
const now = 1740000005000

beforeEach(() => {
  companion = openCompanionDatabase(':memory:')
  runMigrations(companion.sqlite)
  const initial = initializeFirstCharacter(companion.db, {
    name: '检查角色', personaText: '检查人设', initialRelationship: '恋人',
    timezone: 'Asia/Hong_Kong', now,
  })
  conversationId = initial.conversationId
})

afterEach(() => companion.close())

describe('用户消息保存与防重（T06②）', () => {
  it('原样保存正文、给首条消息分配顺序，并更新所属会话时间', () => {
    const result = saveUserMessage(companion.db, {
      conversationId, requestId: 'request-1', content: '  今天完成一步\n继续学习。 ', now: now + 1,
    })
    expect(result.created).toBe(true)
    expect(result.message).toMatchObject({
      conversationId, seq: 1, role: 'user', content: '  今天完成一步\n继续学习。 ',
      status: 'completed', clientRequestId: 'request-1', createdAt: now + 1,
    })
    expect(companion.db.select().from(conversations)
      .where(eq(conversations.id, conversationId)).get()?.lastMessageAt).toBe(now + 1)
  })

  it('同请求重放复用原消息，不改变编号、顺序或会话时间', () => {
    const input = { conversationId, requestId: 'request-1', content: '今天好开心', now: now + 1 }
    const first = saveUserMessage(companion.db, input)
    const replay = saveUserMessage(companion.db, { ...input, now: now + 100 })
    expect(replay).toEqual({ message: first.message, created: false })
    expect(companion.db.select().from(messages).all()).toHaveLength(1)
    expect(companion.db.select().from(conversations)
      .where(eq(conversations.id, conversationId)).get()?.lastMessageAt).toBe(now + 1)
  })

  it('同会话同请求号换了正文时拒绝，不覆盖第一次保存的话', () => {
    const input = { conversationId, requestId: 'request-1', content: '第一句话', now }
    saveUserMessage(companion.db, input)
    expect(() => saveUserMessage(companion.db, { ...input, content: '另一句话' }))
      .toThrow('E_REQUEST_CONFLICT')
    expect(companion.db.select().from(messages).all().map((row) => row.content))
      .toEqual(['第一句话'])
  })

  it('正文相同但请求号不同，仍是用户主动发送的两条消息', () => {
    const input = { conversationId, content: '你好', now }
    const first = saveUserMessage(companion.db, { ...input, requestId: 'request-1' })
    const second = saveUserMessage(companion.db, { ...input, requestId: 'request-2' })
    expect(second.created).toBe(true)
    expect(second.message.id).not.toBe(first.message.id)
    expect(second.message.seq).toBe(2)
  })

  it('另一会话可独立使用相同请求号，顺序也各自从 1 开始', () => {
    const initial = companion.db.select().from(conversations).get()!
    companion.db.insert(conversations).values({ ...initial, id: 'preview-check', mode: 'preview' }).run()
    const formal = saveUserMessage(companion.db, {
      conversationId, requestId: 'request-1', content: '正式消息', now,
    })
    const preview = saveUserMessage(companion.db, {
      conversationId: 'preview-check', requestId: 'request-1', content: '试聊消息', now,
    })
    expect(formal.message.id).not.toBe(preview.message.id)
    expect([formal.message.seq, preview.message.seq]).toEqual([1, 1])
    expect(companion.db.select().from(messages).all()).toHaveLength(2)
  })

  it('下一条用户消息排在已有角色回复之后，不与它抢顺序号', () => {
    const first = saveUserMessage(companion.db, {
      conversationId, requestId: 'request-1', content: '你好', now,
    })
    companion.db.insert(messages).values({
      id: 'reply-check', conversationId, seq: 2, role: 'assistant', content: '晚上好',
      status: 'completed', replyToId: first.message.id, createdAt: now,
    }).run()
    const next = saveUserMessage(companion.db, {
      conversationId, requestId: 'request-2', content: '继续聊', now,
    })
    expect(next.message.seq).toBe(3)
  })

  it('不存在的会话或空白输入不会写入消息', () => {
    expect(() => saveUserMessage(companion.db, {
      conversationId: 'missing', requestId: 'request-1', content: '你好', now,
    })).toThrow('E_CONVERSATION_NOT_FOUND')
    for (const invalid of [{ content: ' \n ' }, { requestId: ' ' }, { conversationId: '' }]) {
      expect(() => saveUserMessage(companion.db, {
        conversationId, requestId: 'request-1', content: '你好', now, ...invalid,
      })).toThrow('E_INVALID_MESSAGE')
    }
    expect(companion.db.select().from(messages).all()).toHaveLength(0)
  })

  it('会话时间更新失败时，刚插入的消息一起撤销；修好后原编号仍可保存', () => {
    // 触发器是数据库在指定写入发生时自动执行的规则；这里故意让第二次写入失败。
    companion.sqlite.exec(`CREATE TRIGGER reject_message_time BEFORE UPDATE OF last_message_at
      ON conversations BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`)
    const input = { conversationId, requestId: 'request-1', content: '你好', now: now + 1 }
    expect(() => saveUserMessage(companion.db, input)).toThrow()
    expect(companion.db.select().from(messages).all()).toHaveLength(0)
    expect(companion.db.select().from(conversations)
      .where(eq(conversations.id, conversationId)).get()?.lastMessageAt).toBe(now)
    companion.sqlite.exec('DROP TRIGGER reject_message_time')
    expect(saveUserMessage(companion.db, input).message.seq).toBe(1)
  })

  it('数据库关掉重开后仍能认出原请求，防重不依赖内存记录', () => {
    const directory = mkdtempSync(join(tmpdir(), 'companion-message-test-'))
    let disk: CompanionDb | undefined
    try {
      const path = join(directory, 'messages.db')
      disk = openCompanionDatabase(path)
      runMigrations(disk.sqlite)
      const initial = initializeFirstCharacter(disk.db, {
        name: '检查角色', personaText: '检查人设', initialRelationship: '恋人',
        timezone: 'Asia/Hong_Kong', now,
      })
      const input = {
        conversationId: initial.conversationId, requestId: 'disk-request', content: '重开后继续', now,
      }
      const first = saveUserMessage(disk.db, input)
      disk.close()
      disk = openCompanionDatabase(path)
      expect(saveUserMessage(disk.db, input)).toEqual({ message: first.message, created: false })
      expect(disk.db.select().from(messages).all()).toHaveLength(1)
    } finally {
      disk?.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
