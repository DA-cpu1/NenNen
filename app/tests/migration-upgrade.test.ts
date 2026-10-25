/**
 * 最小旧库升级样例（T04 步骤⑧创建，05 §7；T05① 扩展到 v6）：证明
 * 「老用户升级新版」这条路真的能走通。做法是演一遍历史——
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
import { MIGRATIONS, runMigrations, type Migration } from '../src/data/migrations'
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

    // ── 第二幕：新版程序启动，翻记录本补做 v2～v6 ──
    const upgraded = openCompanionDatabase(dbPath)
    runMigrations(upgraded.sqlite)

    // 记录本登记齐当前全部 6 张单
    const records = upgraded.sqlite
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as Array<{ version: number }>
    expect(records.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6])

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

    // v6 的两根新列真的长在旧表上：PRAGMA table_info 列出表结构，
    // 查得到 = 升级把列加给了已存在的 character_versions（不是只建了新表）
    const columns = upgraded.sqlite
      .prepare('PRAGMA table_info(character_versions)')
      .all() as Array<{ name: string }>
    const columnNames = columns.map((c) => c.name)
    expect(columnNames).toContain('user_nickname')
    expect(columnNames).toContain('save_request_id')

    upgraded.close()
  })

  it('坏单子中途炸：整体回滚，库停在旧版本，正确清单可恢复（05 §7.4）', () => {
    const dbPath = join(dir, 'broken-upgrade.db')

    // 同样的手法造 v1 旧库，老数据版本号 5
    const old = openCompanionDatabase(dbPath)
    runMigrations(old.sqlite, MIGRATIONS.slice(0, 1))
    old.db
      .update(appState)
      .set({ globalMemoryEpoch: 5 })
      .where(eq(appState.id, 1))
      .run()
    old.close()

    const db = openCompanionDatabase(dbPath)
    // 坏清单：v1 照旧；v2 是「半途炸」的单子——第一句建表能成功，
    // 第二句引用不存在的表必然失败。模拟施工队干到一半发现图纸错了。
    // 考验点：第一句已经做成的表，必须跟着第二句的失败一起消失
    const badList: Migration[] = [
      MIGRATIONS[0],
      {
        version: 2,
        summary: '测试用坏单子：前半成功后半必炸',
        sql: `
CREATE TABLE doomed_ok (id INTEGER);
INSERT INTO no_such_table VALUES (1);
`,
      },
    ]
    expect(() => runMigrations(db.sqlite, badList)).toThrow()

    // 1) 库停在 v1：坏单子没记账（记账和施工绑在同一事务，见
    //    migrations.ts 的注释），绝不能出现「记了账没施工」
    const records = db.sqlite
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as Array<{ version: number }>
    expect(records.map((r) => r.version)).toEqual([1])

    // 2) 半套结构没留下：第一句建成的 doomed_ok 也被回滚。
    //    留着它就是「半升级库」——程序以为没升过，表却存在，
    //    下次补做真 v2 时对不上账，是最难查的那种事故
    const leftover = db.sqlite
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='doomed_ok'")
      .get() as { n: number }
    expect(leftover.n).toBe(0)

    // 3) 旧数据完好：升级失败不许伤及用户内容
    const state = db.db.select().from(appState).where(eq(appState.id, 1)).get()
    expect(state?.globalMemoryEpoch).toBe(5)

    // 4) 恢复：换回正确清单重跑，v2～v6 正常补齐——坏单子
    //    没有把升级路堵死
    runMigrations(db.sqlite)
    const fixed = db.sqlite
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as Array<{ version: number }>
    expect(fixed.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6])

    db.close()
  })
})
