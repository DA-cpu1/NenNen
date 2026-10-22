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
import { appState } from '../src/data/tables'
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
  it('全新库执行迁移：版本登记 2 条，app_state 初始单行', () => {
    runMigrations(companion.sqlite)
    const records = companion.sqlite
      .prepare('SELECT version FROM schema_migrations')
      .all() as Array<{ version: number }>
    expect(records).toEqual([{ version: 1 }, { version: 2 }])
    const rows = companion.db.select().from(appState).all()
    expect(rows).toEqual([{ id: 1, globalMemoryEpoch: 0 }])
  })

  it('重复执行不重复应用（幂等）', () => {
    runMigrations(companion.sqlite)
    const count = companion.sqlite
      .prepare('SELECT COUNT(*) AS n FROM schema_migrations')
      .get() as { n: number }
    expect(count.n).toBe(2)
  })

  it('重开同一数据库文件后再跑迁移仍不重复', () => {
    const second = openCompanionDatabase(dbPath)
    try {
      runMigrations(second.sqlite)
      const count = second.sqlite
        .prepare('SELECT COUNT(*) AS n FROM schema_migrations')
        .get() as { n: number }
      expect(count.n).toBe(2)
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
