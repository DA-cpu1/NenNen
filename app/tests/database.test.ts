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
  it('全新库执行迁移：版本登记 1 条，app_state 初始单行', () => {
    runMigrations(companion.sqlite)
    const records = companion.sqlite
      .prepare('SELECT version FROM schema_migrations')
      .all() as Array<{ version: number }>
    expect(records).toEqual([{ version: 1 }])
    const rows = companion.db.select().from(appState).all()
    expect(rows).toEqual([{ id: 1, globalMemoryEpoch: 0 }])
  })

  it('重复执行不重复应用（幂等）', () => {
    runMigrations(companion.sqlite)
    const count = companion.sqlite
      .prepare('SELECT COUNT(*) AS n FROM schema_migrations')
      .get() as { n: number }
    expect(count.n).toBe(1)
  })

  it('重开同一数据库文件后再跑迁移仍不重复', () => {
    const second = openCompanionDatabase(dbPath)
    try {
      runMigrations(second.sqlite)
      const count = second.sqlite
        .prepare('SELECT COUNT(*) AS n FROM schema_migrations')
        .get() as { n: number }
      expect(count.n).toBe(1)
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

describe('迁移安全检查', () => {
  it('已应用脚本被改动（摘要不一致）时拒绝写入', () => {
    const tampered: Migration[] = MIGRATIONS.map((m) =>
      m.version === 1 ? { ...m, sql: m.sql + '\n-- 被改动的脚本' } : m,
    )
    expect(() => runMigrations(companion.sqlite, tampered)).toThrow('不一致')
  })

  it('库版本比程序新（未知迁移版本）时拒绝写入（05 §7）', () => {
    // 构造一个「已应用 version 2」的库状态：先注入自定义清单应用 v2，再用只认 v1 的默认清单去开
    const withV2: Migration[] = [
      ...MIGRATIONS,
      { version: 2, summary: '测试用新版本', sql: 'CREATE TABLE test_newer (id INTEGER);' },
    ]
    runMigrations(companion.sqlite, withV2)
    expect(() => runMigrations(companion.sqlite)).toThrow('未知迁移版本')
  })
})
