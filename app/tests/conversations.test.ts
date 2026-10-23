/**
 * 会话解析与框架会话 ID 分离的自动检查（04 §1、04 §3）：
 * 解析只回正式会话（试聊不串进来）、换框架 ID 时应用会话不动——
 * 「联系方式」变了，「同一段聊天」不变。固定输入、临时假库（07 §3）。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { openCompanionDatabase, type CompanionDb } from '../src/data/db'
import { runMigrations } from '../src/data/migrations'
import { initializeFirstCharacter } from '../src/data/character-init'
import { getFormalConversation, setRuntimeSessionId } from '../src/data/conversations'
import { conversations } from '../src/data/tables'

let dir: string
let companion: CompanionDb
/** 初始化结果，各用例共用同一批 ID */
let initial: { characterId: string; conversationId: string }

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'companion-conv-test-'))
  companion = openCompanionDatabase(join(dir, 'test.db'))
  runMigrations(companion.sqlite)
  initial = initializeFirstCharacter(companion.db, {
    name: '六花',
    personaText: '占位人设',
    initialRelationship: '恋人',
    timezone: 'Asia/Shanghai',
    now: 1740000005000,
  })
})

afterAll(async () => {
  companion.close()
  await rm(dir, { recursive: true, force: true })
})

describe('正式会话解析（T04 步骤⑥）', () => {
  it('初始化后解析到唯一正式会话，与初始化返回的是同一个 ID', () => {
    const found = getFormalConversation(companion.db, initial.characterId)
    expect(found?.id).toBe(initial.conversationId)
    expect(found?.mode).toBe('normal')
  })

  it('存在 preview 试聊会话时，解析仍然只回正式会话（05 §3 隔离）', () => {
    // 手工插一条试聊会话（T06 才有正式的创建路径）
    companion.db
      .insert(conversations)
      .values({
        id: 'conv-preview-test',
        characterId: initial.characterId,
        mode: 'preview',
        createdAt: 1740000005000,
        lastMessageAt: 1740000005000,
      })
      .run()

    // 解析拿到的还是 normal 那条——preview 绝不能从这里漏出去，
    // 否则试聊内容会被当成正式聊天续接
    const found = getFormalConversation(companion.db, initial.characterId)
    expect(found?.id).toBe(initial.conversationId)
    expect(found?.mode).toBe('normal')
  })

  it('查不存在的角色返回 undefined，不抛错', () => {
    expect(getFormalConversation(companion.db, 'char-no-such')).toBeUndefined()
  })
})

describe('框架会话 ID 分离（T04 步骤⑥）', () => {
  it('换新框架 ID：便签换了，应用会话 ID、类型、内容版本原样不动', () => {
    setRuntimeSessionId(companion.db, initial.conversationId, 'eve-session-abc')

    const row = companion.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, initial.conversationId))
      .get()
    // 框架 ID 更新成功
    expect(row?.runtimeSessionId).toBe('eve-session-abc')
    // 关键不变量：应用会话还是同一行、还是正式会话、内容版本没动——
    // 换「联系方式」不许动「聊天本身」
    expect(row?.id).toBe(initial.conversationId)
    expect(row?.mode).toBe('normal')
    expect(row?.contextEpoch).toBe(0)
  })

  it('框架 ID 可以再换或清空（重建上下文就是反复换便签）', () => {
    setRuntimeSessionId(companion.db, initial.conversationId, 'eve-session-xyz')
    expect(
      companion.db
        .select()
        .from(conversations)
        .where(eq(conversations.id, initial.conversationId))
        .get()?.runtimeSessionId,
    ).toBe('eve-session-xyz')

    setRuntimeSessionId(companion.db, initial.conversationId, null)
    expect(
      companion.db
        .select()
        .from(conversations)
        .where(eq(conversations.id, initial.conversationId))
        .get()?.runtimeSessionId,
    ).toBeNull()
  })

  it('对不存在的会话换 ID 直接抛错，不装成功', () => {
    expect(() =>
      setRuntimeSessionId(companion.db, 'conv-no-such', 'eve-session-x'),
    ).toThrow('会话不存在')
  })
})
