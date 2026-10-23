/**
 * 数据库这层的自动检查：每个测试对应一个真实事故场景——忘开保险、
 * 迁移重复执行、旧程序开新库、单子被事后改过……
 * 全部在系统临时目录里建假库来测，不碰真实数据；
 * 输入全是写死的，每次跑结果一致（07 §3：自动检查不用随机输入）。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openCompanionDatabase, type CompanionDb } from '../src/data/db'
import { MIGRATIONS, runMigrations, type Migration } from '../src/data/migrations'
import { appState, characters, characterVersions } from '../src/data/tables'
import { readSetting, writeSetting } from '../src/data/settings'
import { eq } from 'drizzle-orm'

/** 临时目录与连接；每个测试自行决定用哪个连接 */
let dir: string
let dbPath: string
let companion: CompanionDb

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'companion-db-test-'))
  dbPath = join(dir, 'test.db')
  companion = openCompanionDatabase(dbPath)
})

afterAll(async () => {
  companion.close()
  await rm(dir, { recursive: true, force: true })
})

describe('基础设置', () => {
  it('WAL 与外键均已启用（05 §1）', () => {
    expect(companion.sqlite.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(companion.sqlite.pragma('foreign_keys', { simple: true })).toBe(1)
  })
})

describe('迁移执行', () => {
  it('全新库执行迁移：版本登记 3 条，app_state 初始单行', () => {
    runMigrations(companion.sqlite)
    const records = companion.sqlite
      .prepare('SELECT version FROM schema_migrations')
      .all() as Array<{ version: number }>
    expect(records).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }])
    const rows = companion.db.select().from(appState).all()
    expect(rows).toEqual([{ id: 1, globalMemoryEpoch: 0 }])
  })

  it('重复执行不重复应用（幂等）', () => {
    runMigrations(companion.sqlite)
    const count = companion.sqlite
      .prepare('SELECT COUNT(*) AS n FROM schema_migrations')
      .get() as { n: number }
    expect(count.n).toBe(3)
  })

  it('重开同一数据库文件后再跑迁移仍不重复', () => {
    const second = openCompanionDatabase(dbPath)
    try {
      runMigrations(second.sqlite)
      const count = second.sqlite
        .prepare('SELECT COUNT(*) AS n FROM schema_migrations')
        .get() as { n: number }
      expect(count.n).toBe(3)
    } finally {
      second.close()
    }
  })
})

describe('读写贯通（Drizzle）', () => {
  it('更新共享记忆版本并回读', () => {
    companion.db
      .update(appState)
      .set({ globalMemoryEpoch: 3 })
      .where(eq(appState.id, 1))
      .run()
    const row = companion.db.select().from(appState).where(eq(appState.id, 1)).get()
    expect(row?.globalMemoryEpoch).toBe(3)
  })
})

describe('app_settings 读写（T02 窗口位置）', () => {
  it('写入后能按键读回，值保持对象形状', () => {
    writeSetting(companion.db, 'petWindow', { x: 100, y: 200, width: 200, height: 260 })
    expect(readSetting(companion.db, 'petWindow')).toEqual({
      x: 100,
      y: 200,
      width: 200,
      height: 260,
    })
  })

  it('同键再写是覆盖不是新增——保存窗口位置会反复发生', () => {
    writeSetting(companion.db, 'petWindow', { x: 300, y: 400, width: 200, height: 260 })
    expect(readSetting(companion.db, 'petWindow')).toEqual({
      x: 300,
      y: 400,
      width: 200,
      height: 260,
    })
    const count = companion.sqlite
      .prepare("SELECT COUNT(*) AS n FROM app_settings WHERE key = 'petWindow'")
      .get() as { n: number }
    expect(count.n).toBe(1)
  })

  it('没写过的键读回 undefined', () => {
    expect(readSetting(companion.db, 'no-such-key')).toBeUndefined()
  })
})

describe('角色表结构（T04 v3）', () => {
  // 固定输入（07 §3）：固定的 ID、固定的时间戳，每次跑结果一致。
  // 这些行会留在共享测试库里，后面的测试不受影响——它们各自用别的键
  const characterId = 'char-test-001'
  /** 固定时间戳：2025-02-19 前后的某个整毫秒，只是个写死的常数 */
  const now = 1740000000000

  it('角色与两个版本可正常落库：一版生效、一版备用', () => {
    companion.db
      .insert(characters)
      .values({ id: characterId, name: '六花', createdAt: now, updatedAt: now })
      .run()
    // 第一版人设标记为当前生效（is_active: 1）
    companion.db
      .insert(characterVersions)
      .values({
        id: 'cv-test-001',
        characterId,
        versionNo: 1,
        personaText: '占位人设第一版（正式角色卡 T06 接入）',
        initialRelationship: '恋人',
        isActive: 1,
        createdAt: now,
      })
      .run()
    // 第二版先存着、不生效（is_active: 0）——历史版本都这么留
    companion.db
      .insert(characterVersions)
      .values({
        id: 'cv-test-002',
        characterId,
        versionNo: 2,
        personaText: '占位人设第二版',
        initialRelationship: '恋人',
        isActive: 0,
        createdAt: now,
      })
      .run()

    // 回读核对：角色一行、版本两行，版本号和生效标记没串位
    const character = companion.db
      .select()
      .from(characters)
      .where(eq(characters.id, characterId))
      .get()
    expect(character?.name).toBe('六花')
    expect(character?.memoryEpoch).toBe(0)
    const versions = companion.db
      .select()
      .from(characterVersions)
      .all()
    expect(versions).toHaveLength(2)
    expect(versions.filter((v) => v.isActive === 1)).toHaveLength(1)
  })

  it('同一角色出现第二个生效版本时，被部分唯一索引当场拦下', () => {
    // 事故场景：程序有 bug，忘了先把旧版改成「不生效」就想直接激活新版。
    // 部分唯一索引（只对 is_active=1 的行生效的唯一约束）保证数据库兜底
    expect(() =>
      companion.db
        .insert(characterVersions)
        .values({
          id: 'cv-test-003',
          characterId,
          versionNo: 3,
          personaText: '不该出现的第三版',
          initialRelationship: '恋人',
          isActive: 1,
          createdAt: now,
        })
        .run(),
    ).toThrow(/UNIQUE/)
  })

  it('同一角色重复版本号被 UNIQUE(character_id, version_no) 拦下', () => {
    // 事故场景：版本号算重了，两个「第 1 版」。即使旧版已不生效也不允许
    expect(() =>
      companion.db
        .insert(characterVersions)
        .values({
          id: 'cv-test-004',
          characterId,
          versionNo: 1,
          personaText: '重复的第 1 版',
          initialRelationship: '恋人',
          isActive: 0,
          createdAt: now,
        })
        .run(),
    ).toThrow(/UNIQUE/)
  })

  it('人设版本指向不存在的角色时，被外键检查拦下（05 §1）', () => {
    // 事故场景：手滑把 character_id 打错。外键（这行的主人必须在角色表里
    // 真实存在）让错误当场暴露，而不是留下一条查无此人的孤儿人设
    expect(() =>
      companion.db
        .insert(characterVersions)
        .values({
          id: 'cv-test-005',
          characterId: 'char-no-such',
          versionNo: 1,
          personaText: '没有主人的版本',
          initialRelationship: '恋人',
          isActive: 0,
          createdAt: now,
        })
        .run(),
    ).toThrow(/FOREIGN KEY/)
  })
})

describe('迁移安全检查', () => {
  it('已应用脚本被改动（摘要不一致）时拒绝写入', () => {
    const tampered: Migration[] = MIGRATIONS.map((m) =>
      m.version === 1 ? { ...m, sql: m.sql + '\n-- 被改动的脚本' } : m,
    )
    expect(() => runMigrations(companion.sqlite, tampered)).toThrow('不一致')
  })

  it('库版本比程序新（未知迁移版本）时拒绝写入（05 §7）', () => {
    // 构造一个「已应用 version 99」的库状态：99 故意选得比真实清单的版本都大，
    // 保证它永远代表「未来的单子」；真实迁移号增长也不会和它撞车
    const withFuture: Migration[] = [
      ...MIGRATIONS,
      { version: 99, summary: '测试用未来版本', sql: 'CREATE TABLE test_newer (id INTEGER);' },
    ]
    runMigrations(companion.sqlite, withFuture)
    expect(() => runMigrations(companion.sqlite)).toThrow('未知迁移版本')
  })
})
