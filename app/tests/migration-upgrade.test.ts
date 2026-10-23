/**
 * 最小旧库升级样例（T04 步骤⑧，05 §7）：证明「老用户升级新版」这条路
 * 真的能走通。做法是演一遍历史——
 * 第一幕用「只含第一张装修单」的清单造出 v1 旧库（这正是当年 v1 版
 * 程序留下的库的样子），塞一行老数据、关库（旧程序退出）；
 * 第二幕重新打开（新版程序启动），用完整清单升级，检查：
 * 旧数据一行不丢、新表全部就位、升级出的库立刻能用。
 * 不是空库启动——空库没走过「旧结构+旧数据」这条路（05 §7）。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { openCompanionDatabase, type CompanionDb } from '../src/data/db'
import { MIGRATIONS, runMigrations } from '../src/data/migrations'
import { initializeFirstCharacter } from '../src/data/character-init'
import { appState } from '../src/data/tables'
import { readSetting, writeSetting } from '../src/data/settings'

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'companion-upgrade-test-'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('最小旧库升级样例（T04 步骤⑧）', () => {
  it('v1 旧库升到当前版本：旧数据保留、新表齐全、升级后可正常使用', () => {
    const dbPath = join(dir, 'old-v1.db')

    // ── 第一幕：造出真实的 v1 旧库 ──
    // 当年程序只发布到 v1：它手里的清单只有第一张单子
    const old = openCompanionDatabase(dbPath)
    runMigrations(old.sqlite, MIGRATIONS.slice(0, 1))
    // 老用户攒下的数据：共享记忆版本已经提到 3（改过三次共享资料）
    old.db
      .update(appState)
      .set({ globalMemoryEpoch: 3 })
      .where(eq(appState.id, 1))
      .run()
    // v1 旧库里没有 app_settings / characters 这些后来的表——
    // 顺手验证这一点，确认「旧库」造得货真价实
    expect(
      old.sqlite
        .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='characters'")
        .get(),
    ).toEqual({ n: 0 })
    old.close() // 旧版程序退出，数据落盘

    // ── 第二幕：新版程序启动，翻记录本补做 v2～v5 ──
    const upgraded = openCompanionDatabase(dbPath)
    runMigrations(upgraded.sqlite)

    // 记录本登记齐当前全部 5 张单
    const records = upgraded.sqlite
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as Array<{ version: number }>
    expect(records.map((r) => r.version)).toEqual([1, 2, 3, 4, 5])

    // 旧数据一行不丢：老用户的版本号还是 3，没有被初始化逻辑重置成 0
    const state = upgraded.db.select().from(appState).where(eq(appState.id, 1)).get()
    expect(state?.globalMemoryEpoch).toBe(3)

    // 新表全部就位：抽查 v2～v5 各一张代表表
    for (const table of ['app_settings', 'characters', 'conversations', 'tool_operations']) {
      const row = upgraded.sqlite
        .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?")
        .get(table) as { n: number }
      expect(row.n, `升级后应存在表 ${table}`).toBe(1)
    }

    // 升级出的库不是「看起来有表」而是真的能用：设置读写、角色初始化
    // 一次通过（初始化会碰到 v3/v4/v5 的全部四张新表）
    writeSetting(upgraded.db, 'smoke', { ok: true })
    expect(readSetting(upgraded.db, 'smoke')).toEqual({ ok: true })
    const initial = initializeFirstCharacter(upgraded.db, {
      name: '六花',
      personaText: '占位人设',
      initialRelationship: '恋人',
      timezone: 'Asia/Shanghai',
      now: 1740000007000,
    })
    expect(initial.created).toBe(true)

    upgraded.close()
  })
})
