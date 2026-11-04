/** 用临时 SQLite 库检查记忆归属、到期边界、替换和写入失败时的回滚。 */
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openCompanionDatabase, type CompanionDb } from '../src/data/db'
import { listCurrentMemories, saveCharacterMemory, type SaveCharacterMemoryInput } from '../src/data/memories'
import { runMigrations } from '../src/data/migrations'
import { characters, conversations, memories, memorySources, messages } from '../src/data/tables'

const now = 1_740_000_000_000
const initial: SaveCharacterMemoryInput = {
  conversationId: 'normal', kind: 'preference', memoryKey: 'preferred_name',
  content: '用户希望被称为阿达', origin: 'user_explicit', sourceMessageIds: ['original'], expiresAt: null, now,
}
let companion: CompanionDb

beforeEach(() => {
  companion = openCompanionDatabase(':memory:')
  runMigrations(companion.sqlite)
  const { db } = companion
  db.insert(characters).values(['a', 'b'].map((id) => ({ id, name: id, createdAt: now, updatedAt: now }))).run()
  db.insert(conversations).values([
    { id: 'normal', characterId: 'a', mode: 'normal' },
    { id: 'preview', characterId: 'a', mode: 'preview' },
    { id: 'other', characterId: 'b', mode: 'normal' },
  ].map((row) => ({ ...row, createdAt: now, lastMessageAt: now }))).run()
  db.insert(messages).values([
    { id: 'original', conversationId: 'normal', seq: 1, role: 'user' },
    { id: 'new-name', conversationId: 'normal', seq: 2, role: 'user' },
    { id: 'reply', conversationId: 'normal', seq: 3, role: 'assistant' },
    { id: 'preview-source', conversationId: 'preview', seq: 1, role: 'user' },
    { id: 'other-source', conversationId: 'other', seq: 1, role: 'user' },
  ].map((row) => ({ ...row, status: 'completed', content: '虚构测试原话', createdAt: now }))).run()
})

afterEach(() => companion.close())

describe('记忆读写', () => {
  it('保存带原话的私有记忆，去重后仍只有一次写入和一次版本变化', () => {
    const { db } = companion
    const result = saveCharacterMemory(db, { ...initial, sourceMessageIds: ['original', 'original'] })
    expect(result.status).toBe('saved')
    expect(saveCharacterMemory(db, { ...initial, content: `  ${initial.content}  ` }))
      .toEqual({ ...result, status: 'already_saved' })
    expect(db.select().from(memorySources).all()).toMatchObject([{ messageId: 'original' }])
    expect(db.select().from(characters).where(eq(characters.id, 'a')).get()?.memoryEpoch).toBe(1)
    expect(db.select().from(characters).where(eq(characters.id, 'b')).get()?.memoryEpoch).toBe(0)
  })

  it('无固定属性的经历按类别与正文去重', () => {
    const input = { ...initial, kind: 'episode' as const, memoryKey: null, content: '谈过桌面项目' }
    expect(saveCharacterMemory(companion.db, input).status).toBe('saved')
    expect(saveCharacterMemory(companion.db, input).status).toBe('already_saved')
    expect(saveCharacterMemory(companion.db, { ...input, content: '谈过动画电影' }).status).toBe('saved')
  })

  it('只读本角色和共享资料，在到期那一刻隐藏仍标作有效的旧值', () => {
    const { db } = companion
    saveCharacterMemory(db, { ...initial, expiresAt: now + 1 })
    db.insert(memories).values({
      id: 'global', scope: 'global', kind: 'fact', content: '共享测试资料', origin: 'user_edit',
      validFrom: now, createdAt: now, updatedAt: now,
    }).run()
    expect(listCurrentMemories(db, 'a', now).map((row) => row.scope)).toEqual(['character', 'global'])
    expect(listCurrentMemories(db, 'b', now).map((row) => row.scope)).toEqual(['global'])
    expect(listCurrentMemories(db, 'a', now + 1).map((row) => row.scope)).toEqual(['global'])
  })

  it('保存新值前释放同属性的过期位置，并保留旧值和递增后的修订号', () => {
    const { db } = companion
    saveCharacterMemory(db, { ...initial, expiresAt: now + 1 })
    const result = saveCharacterMemory(db, {
      ...initial, content: '用户希望被称为小陈', sourceMessageIds: ['new-name'], now: now + 1,
    })
    expect(result.status).toBe('saved')
    expect(db.select().from(memories).where(eq(memories.content, initial.content)).get())
      .toMatchObject({ status: 'expired', revision: 2 })
    expect(listCurrentMemories(db, 'a', now + 1)).toMatchObject([{ content: '用户希望被称为小陈' }])
  })

  it('现值需要匹配编号和修订号才能被替代', () => {
    const { db } = companion
    saveCharacterMemory(db, initial)
    const [old] = listCurrentMemories(db, 'a', now)
    const changed = { ...initial, content: '用户希望被称为小陈', sourceMessageIds: ['new-name'], now: now + 1 }
    expect(saveCharacterMemory(db, changed)).toEqual({ status: 'STALE_REVISION' })
    expect(saveCharacterMemory(db, { ...changed, replacement: { id: old.id, revision: 2 } }))
      .toEqual({ status: 'STALE_REVISION' })
    expect(saveCharacterMemory(db, { ...changed, replacement: { id: old.id, revision: old.revision } }))
      .toMatchObject({ status: 'saved', memory: { supersedesId: old.id } })
    expect(db.select().from(memories).where(eq(memories.id, old.id)).get())
      .toMatchObject({ status: 'superseded', revision: 2 })
  })

  it('拒绝缺失、跨会话、试聊、被排除的来源，以及仅有角色回复的经历', () => {
    const { db } = companion
    expect(saveCharacterMemory(db, { ...initial, conversationId: 'preview', sourceMessageIds: ['preview-source'] }).status)
      .toBe('SOURCE_NOT_ALLOWED')
    for (const sourceMessageIds of [[], ['missing'], ['other-source'], ['preview-source'], ['reply']]) {
      expect(saveCharacterMemory(db, { ...initial, kind: 'episode', sourceMessageIds }).status).toBe('SOURCE_NOT_ALLOWED')
    }
    db.update(messages).set({ excludedFromContext: 1 }).where(eq(messages.id, 'original')).run()
    expect(saveCharacterMemory(db, initial).status).toBe('SOURCE_NOT_ALLOWED')
    expect(db.select().from(memories).all()).toEqual([])
  })

  it('来源登记失败时撤回到期更新和新值', () => {
    const { db, sqlite } = companion
    saveCharacterMemory(db, { ...initial, expiresAt: now + 1 })
    // 人为让来源表拒收，模拟旧状态已更新、新记录已插入后才碰到写入故障。
    sqlite.exec("CREATE TRIGGER reject_source BEFORE INSERT ON memory_sources BEGIN SELECT RAISE(ABORT, '拒绝来源'); END")
    expect(() => saveCharacterMemory(db, { ...initial, content: '新值', now: now + 1 })).toThrow()
    expect(db.select().from(memories).all()).toMatchObject([{ content: initial.content, status: 'active', revision: 1 }])
    expect(db.select().from(characters).where(eq(characters.id, 'a')).get()?.memoryEpoch).toBe(1)
  })
})
