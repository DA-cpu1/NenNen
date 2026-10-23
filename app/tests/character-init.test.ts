/**
 * 首个角色初始化的自动检查：四件套是否一次建齐、重入是否复用同一批
 * 记录、半套状态能否自愈（05 §8）。时间戳注入固定值（07 §3），
 * 临时目录建假库，不碰真实数据。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { openCompanionDatabase, type CompanionDb } from '../src/data/db'
import { runMigrations } from '../src/data/migrations'
import { initializeFirstCharacter } from '../src/data/character-init'
import {
  characters,
  characterVersions,
  companionSettings,
  conversations,
} from '../src/data/tables'

let dir: string
let companion: CompanionDb

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'companion-init-test-'))
  companion = openCompanionDatabase(join(dir, 'test.db'))
  runMigrations(companion.sqlite)
})

afterAll(async () => {
  companion.close()
  await rm(dir, { recursive: true, force: true })
})

/** 固定时间与固定占位内容：每次跑出的「结构」完全一致，
 *  只有随机 ID 不同——ID 本来就该每次不同 */
const fixedNow = 1740000004000
const baseOptions = {
  name: '六花',
  personaText: '占位人设：正式角色卡 T06 接入',
  initialRelationship: '恋人',
  timezone: 'Asia/Shanghai',
  now: fixedNow,
}

describe('首个角色初始化（T04 步骤⑤）', () => {
  it('全新库：四件套一个事务建齐，返回 created=true', () => {
    const result = initializeFirstCharacter(companion.db, baseOptions)
    expect(result.created).toBe(true)
    expect(result.characterId).toMatch(/^char-/)
    expect(result.conversationId).toMatch(/^conv-/)

    // 角色行：名字对、记忆版本从 0 开始
    const character = companion.db
      .select()
      .from(characters)
      .where(eq(characters.id, result.characterId))
      .get()
    expect(character?.name).toBe('六花')
    expect(character?.memoryEpoch).toBe(0)

    // 人设版本：第 1 版、当前生效、正文原样落库
    const versions = companion.db
      .select()
      .from(characterVersions)
      .where(eq(characterVersions.characterId, result.characterId))
      .all()
    expect(versions).toHaveLength(1)
    expect(versions[0]?.versionNo).toBe(1)
    expect(versions[0]?.isActive).toBe(1)
    expect(versions[0]?.personaText).toBe(baseOptions.personaText)

    // 正式会话：唯一一条、mode=normal、框架会话 ID 为空（还没开始聊天）
    const conversation = companion.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, result.conversationId))
      .get()
    expect(conversation?.mode).toBe('normal')
    expect(conversation?.runtimeSessionId).toBeNull()

    // 主动陪伴设置行：存在且总开关默认关
    const settings = companion.db
      .select()
      .from(companionSettings)
      .where(eq(companionSettings.characterId, result.characterId))
      .get()
    expect(settings?.enabled).toBe(0)
  })

  it('重入：换参数再调也不重建，复用同一角色与正式会话（05 §8）', () => {
    const again = initializeFirstCharacter(companion.db, {
      // 故意换一套内容：证明重入认「库里有没有角色」，不认参数
      name: '换个名字也不该建新角色',
      personaText: '换的人设也不该生效',
      initialRelationship: '朋友',
      timezone: 'Asia/Tokyo',
      now: fixedNow + 1000,
    })
    expect(again.created).toBe(false)
    // 还是原来那批 ID
    const first = initializeFirstCharacter(companion.db, baseOptions)
    expect(first.characterId).toBe(again.characterId)
    expect(first.conversationId).toBe(again.conversationId)

    // 库里仍然只有一个角色、一条正式会话、一个版本、一行设置
    expect(companion.db.select().from(characters).all()).toHaveLength(1)
    expect(
      companion.db.select().from(characterVersions).all(),
    ).toHaveLength(1)
    const normalCount = companion.db
      .select()
      .from(conversations)
      .all()
      .filter((c) => c.mode === 'normal')
    expect(normalCount).toHaveLength(1)
    expect(companion.db.select().from(companionSettings).all()).toHaveLength(1)
  })

  it('半套自愈：正式会话被外力删掉后，初始化补建、角色 ID 不变', () => {
    const before = initializeFirstCharacter(companion.db, baseOptions)
    // 模拟事故：外部工具直接删了正式会话行（正常代码不该这么干）
    companion.db
      .delete(conversations)
      .where(eq(conversations.id, before.conversationId))
      .run()

    const healed = initializeFirstCharacter(companion.db, baseOptions)
    // 角色没换、会话补了新的、不算新建角色
    expect(healed.created).toBe(false)
    expect(healed.characterId).toBe(before.characterId)
    expect(healed.conversationId).not.toBe(before.conversationId)

    // 补建后库里又恰好一条正式会话，挂在原角色名下
    const normal = companion.db
      .select()
      .from(conversations)
      .all()
      .filter((c) => c.mode === 'normal')
    expect(normal).toHaveLength(1)
    expect(normal[0]?.characterId).toBe(before.characterId)
  })
})
