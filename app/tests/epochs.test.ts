/**
 * 版本号（epoch）提升函数的自动检查：加得对不对、加错对象会不会被发现、
 * 「事务里多个版本一起变时要么全变要么全不变」（05 §5 的地基——
 * 忘记操作要同时提升记忆版本和会话内容版本，缺一半就作废不了旧任务）。
 * 固定输入、临时目录建假库，不碰真实数据（07 §3）。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { openCompanionDatabase, type CompanionDb } from '../src/data/db'
import { runMigrations } from '../src/data/migrations'
import {
  bumpCharacterMemoryEpoch,
  bumpContextEpoch,
  bumpGlobalMemoryEpoch,
  readGlobalMemoryEpoch,
} from '../src/data/epochs'
import { characters, conversations } from '../src/data/tables'

let dir: string
let companion: CompanionDb

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'companion-epochs-test-'))
  companion = openCompanionDatabase(join(dir, 'test.db'))
  runMigrations(companion.sqlite)
})

afterAll(async () => {
  companion.close()
  await rm(dir, { recursive: true, force: true })
})

describe('版本号提升（T04 步骤④）', () => {
  // 两个角色、一段会话：验证「各管各的」需要至少两个角色对照
  const now = 1740000003000

  it('三个版本号都从 0 开始，各自提升一次到 1', () => {
    companion.db
      .insert(characters)
      .values({ id: 'char-ep-001', name: '甲', createdAt: now, updatedAt: now })
      .run()
    companion.db
      .insert(characters)
      .values({ id: 'char-ep-002', name: '乙', createdAt: now, updatedAt: now })
      .run()
    companion.db
      .insert(conversations)
      .values({
        id: 'conv-ep-001',
        characterId: 'char-ep-001',
        createdAt: now,
        lastMessageAt: now,
      })
      .run()

    expect(bumpGlobalMemoryEpoch(companion.db)).toBe(1)
    expect(bumpCharacterMemoryEpoch(companion.db, 'char-ep-001')).toBe(1)
    expect(bumpContextEpoch(companion.db, 'conv-ep-001')).toBe(1)
  })

  it('连续提升累积；甲提升不影响乙和全局（05 §4 各管各的）', () => {
    expect(bumpCharacterMemoryEpoch(companion.db, 'char-ep-001')).toBe(2)

    // 乙从没被提升过，仍是 0——甲的私人记忆变化不许作废乙的旧任务
    const yi = companion.db
      .select()
      .from(characters)
      .where(eq(characters.id, 'char-ep-002'))
      .get()
    expect(yi?.memoryEpoch).toBe(0)
    // 全局版本也停在 1：私有变更不提升共享版本（05 §5）
    expect(readGlobalMemoryEpoch(companion.db)).toBe(1)
  })

  it('提升不存在的角色或会话直接抛错，不装作成功', () => {
    // 事故场景：调用方拿错 ID。装成功的话，那次记忆变更「没人作废得了」
    expect(() => bumpCharacterMemoryEpoch(companion.db, 'char-no-such')).toThrow(
      '角色不存在',
    )
    expect(() => bumpContextEpoch(companion.db, 'conv-no-such')).toThrow('会话不存在')
  })

  it('事务里两个版本一起变、中途失败时一起回滚（05 §5）', () => {
    // 记下动手前的值：甲角色版本 2（上个测试提到）、会话内容版本 1
    const characterBefore = companion.db
      .select()
      .from(characters)
      .where(eq(characters.id, 'char-ep-001'))
      .get()!.memoryEpoch
    const conversationBefore = companion.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, 'conv-ep-001'))
      .get()!.contextEpoch

    // better-sqlite3 的 transaction()：里面的函数抛错时自动回滚再抛出，
    // 所以函数体内的两个提升 + 一个故意的崩溃 = 三个操作全部作废
    const attempt = companion.sqlite.transaction(() => {
      bumpCharacterMemoryEpoch(companion.db, 'char-ep-001')
      bumpContextEpoch(companion.db, 'conv-ep-001')
      throw new Error('模拟第二个版本提升后、业务数据落库前崩溃')
    })
    expect(() => attempt()).toThrow('模拟第二个版本提升后、业务数据落库前崩溃')

    // 回滚后两个版本都停在旧值：不存在「记忆版本变了、会话版本没变」
    // 的半套状态——半套状态会让一部分旧任务作废、另一部分漏网
    expect(
      companion.db
        .select()
        .from(characters)
        .where(eq(characters.id, 'char-ep-001'))
        .get()!.memoryEpoch,
    ).toBe(characterBefore)
    expect(
      companion.db
        .select()
        .from(conversations)
        .where(eq(conversations.id, 'conv-ep-001'))
        .get()!.contextEpoch,
    ).toBe(conversationBefore)
  })
})
