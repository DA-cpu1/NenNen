/** 用临时 SQLite 库检查记忆归属、到期边界、替换和写入失败时的回滚。 */
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openCompanionDatabase, type CompanionDb } from '../src/data/db'
import { listCurrentMemories, saveCharacterMemory, type SaveCharacterMemoryInput } from '../src/data/memories'
import { listManagedMemories, mutateMemory, previewMemoryDeletion } from '../src/data/memory-management'
import { readGlobalMemoryEpoch } from '../src/data/epochs'
import { saveUserMessage } from '../src/data/messages'
import { runMigrations } from '../src/data/migrations'
import { characters, contextExclusions, conversations, memories, memorySources, messages, toolOperations } from '../src/data/tables'

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

describe('纠正与忘记', () => {
  it('A11 纠正后只有新值生效，旧值有时间和来源，重复请求不再写入', () => {
    const { db } = companion
    saveCharacterMemory(db, initial)
    const [old] = listCurrentMemories(db, 'a', now)
    const context = { conversationId: 'normal', requestId: 'edit-1' }
    const change = { action: 'correct', memoryId: old.id, expectedRevision: old.revision, content: '用户希望被称为小陈' } as const
    const first = mutateMemory(db, context, change, now + 1)
    expect(first.conversationIds).toEqual(['normal'])
    expect(mutateMemory(db, context, change, now + 2)).toEqual({ receipt: first.receipt, conversationIds: [] })
    expect(() => mutateMemory(db, { ...context, requestId: 'edit-2' }, change, now + 2)).toThrow('STALE_REVISION')
    expect(listCurrentMemories(db, 'a', now + 2)).toMatchObject([{ content: change.content }])
    expect(listManagedMemories(db, 'a', now + 2)).toMatchObject([
      { status: 'active', content: change.content, supersedesId: old.id, updatedAt: now + 1, origin: 'user_edit' },
      { status: 'superseded', content: initial.content, sources: [{ id: 'original',
        location: { id: 'original', conversationId: 'normal', seq: 1 } }], validFrom: now, updatedAt: now + 1 },
    ])
  })

  it('默认忘记整条属性链、共同来源和请求原话，其他角色的原话不动', () => {
    const { db } = companion
    saveCharacterMemory(db, initial)
    saveCharacterMemory(db, { ...initial, memoryKey: 'other_fact', content: '同一条原话里的事实' })
    saveCharacterMemory(db, { ...initial, conversationId: 'other', sourceMessageIds: ['other-source'] })
    const target = listCurrentMemories(db, 'a', now).find((row) => row.memoryKey === initial.memoryKey)!
    const { receipt } = mutateMemory(db, { conversationId: 'normal', requestId: 'edit-1' }, {
      action: 'correct', memoryId: target.id, expectedRevision: target.revision, content: '用户希望被称为小陈',
    }, now + 1)
    const result = mutateMemory(db, { conversationId: 'normal', requestMessageId: 'new-name' }, {
      action: 'forget', memoryId: receipt.memoryId, expectedRevision: receipt.revision, deleteSources: false,
    }, now + 2)
    expect(result.receipt).toMatchObject({ affectedMemories: 3, removedSources: 0 })
    expect(listManagedMemories(db, 'a', now + 2)).toEqual([])
    expect(listCurrentMemories(db, 'b', now + 2)).toHaveLength(1)
    expect(db.select().from(conversations).where(eq(conversations.id, 'other')).get()?.contextEpoch).toBe(0)
    expect(db.select().from(contextExclusions).all().map((row) => row.messageId).sort()).toEqual(['new-name', 'original', 'reply'])
    expect(db.select().from(messages).where(eq(messages.id, 'original')).get()).toMatchObject({ excludedFromContext: 1, content: '虚构测试原话' })
    expect(db.select().from(toolOperations).all().every((row) => !row.resultJson?.includes('小陈'))).toBe(true)
  })

  it('忘记共享资料作废可能使用它的正式上下文，试聊和各角色私有资料保持独立', () => {
    const { db } = companion
    saveCharacterMemory(db, initial)
    saveCharacterMemory(db, { ...initial, conversationId: 'other', sourceMessageIds: ['other-source'] })
    db.insert(memories).values({ id: 'shared', scope: 'global', kind: 'fact', content: '固定共享内容',
      origin: 'user_edit', validFrom: now, createdAt: now, updatedAt: now }).run()
    const change = { action: 'forget', memoryId: 'shared', expectedRevision: 1, deleteSources: false } as const
    expect(() => mutateMemory(db, { conversationId: 'normal', requestMessageId: 'new-name' }, change, now + 1)).toThrow('NOT_FOUND')
    const result = mutateMemory(db, { conversationId: 'normal', requestId: 'shared-edit' }, change, now + 1)
    expect(result.conversationIds.sort()).toEqual(['normal', 'other'])
    expect(readGlobalMemoryEpoch(db)).toBe(1)
    expect(db.select().from(conversations).where(eq(conversations.id, 'preview')).get()?.contextEpoch).toBe(0)
    expect(listCurrentMemories(db, 'a', now + 1)).toMatchObject([{ scope: 'character', characterId: 'a' }])
    expect(listCurrentMemories(db, 'b', now + 1)).toMatchObject([{ scope: 'character', characterId: 'b' }])
  })

  it('试聊、越权角色、伪造来源和聊天要求删除原文均不落库', () => {
    const { db } = companion
    saveCharacterMemory(db, initial)
    const [target] = listCurrentMemories(db, 'a', now)
    const change = { action: 'forget', memoryId: target.id, expectedRevision: target.revision, deleteSources: true } as const
    expect(() => mutateMemory(db, { conversationId: 'preview', requestMessageId: 'preview-source' }, change, now)).toThrow('SOURCE_NOT_ALLOWED')
    expect(() => mutateMemory(db, { conversationId: 'other', requestId: 'outside' }, change, now)).toThrow('NOT_FOUND')
    expect(() => mutateMemory(db, { conversationId: 'normal', requestMessageId: 'other-source' }, change, now)).toThrow('SOURCE_NOT_ALLOWED')
    expect(() => mutateMemory(db, { conversationId: 'normal', requestMessageId: 'new-name' }, change, now)).toThrow('SOURCE_NOT_ALLOWED')
    expect(db.select().from(toolOperations).all()).toEqual([])
    expect(listCurrentMemories(db, 'a', now)).toEqual([target])
  })

  it('同时删除原文时事务回滚完整，成功后新消息不会落到原整理书签前面', () => {
    const { db, sqlite } = companion
    db.delete(messages).where(eq(messages.id, 'new-name')).run()
    db.delete(messages).where(eq(messages.id, 'reply')).run()
    db.update(conversations).set({ lastProcessedSeq: 1, lastProcessedOffset: 1 }).where(eq(conversations.id, 'normal')).run()
    saveCharacterMemory(db, initial)
    const [target] = listCurrentMemories(db, 'a', now)
    const updated = mutateMemory(db, { conversationId: 'normal', requestId: 'correction-before-erase' }, {
      action: 'correct', memoryId: target.id, expectedRevision: target.revision, content: '更新后的称呼',
    }, now + 1).receipt
    const request = { memoryId: updated.memoryId, expectedRevision: updated.revision }
    expect(() => previewMemoryDeletion(db, 'b', request)).toThrow('NOT_FOUND')
    const preview = previewMemoryDeletion(db, 'a', request)
    expect(preview.sources).toEqual([{ id: 'original', role: 'user', content: '虚构测试原话', createdAt: now }])
    const change = { ...request, action: 'forget', deleteSources: true, sourceFingerprint: preview.sourceFingerprint } as const
    const context = { conversationId: 'normal', requestId: 'erase-1' }
    // 确认期间原话变化时，即使记忆修订号没变，旧清单也不能用于删除。
    db.update(messages).set({ content: '变化后的虚构原话' }).where(eq(messages.id, 'original')).run()
    expect(() => mutateMemory(db, context, change, now + 1)).toThrow('SOURCE_PREVIEW_CHANGED')
    expect(db.select().from(messages).where(eq(messages.id, 'original')).get()).toBeDefined()
    db.update(messages).set({ content: '虚构测试原话' }).where(eq(messages.id, 'original')).run()
    sqlite.exec("CREATE TRIGGER reject_erase BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT, '拒绝删除'); END")
    expect(() => mutateMemory(db, context, change, now + 1)).toThrow()
    expect(listCurrentMemories(db, 'a', now + 1)).toMatchObject([{ id: request.memoryId }])
    expect(db.select().from(contextExclusions).all()).toEqual([])
    expect(db.select().from(toolOperations).all()).toHaveLength(1)
    sqlite.exec('DROP TRIGGER reject_erase')
    expect(mutateMemory(db, context, change, now + 2).receipt.removedSources).toBe(1)
    expect(db.select().from(messages).where(eq(messages.id, 'original')).get()).toBeUndefined()
    expect(db.select().from(conversations).where(eq(conversations.id, 'normal')).get()).toMatchObject({ lastProcessedSeq: 1, lastProcessedOffset: 0 })
    expect(saveUserMessage(db, { conversationId: 'normal', requestId: 'later', content: '新话题' }).message.seq).toBe(2)
  })
})
