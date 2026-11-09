/**
 * 最小旧库升级样例（T04 步骤⑧创建，05 §7；T05① 扩展到 v6，T07① 扩展到
 * v8，⑧扩展到 v9，T08 扩展到 v10）：证明「老用户升级新版」这条路真的能走通。做法是演一遍历史——
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
import {
  agentRuns,
  appState,
  characterVersions,
  conversations,
  memories,
  memoryJobs,
  memorySources,
  messages,
} from '../src/data/tables'
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

    // ── 第二幕：新版程序启动，翻记录本补做 v2～v10 ──
    const upgraded = openCompanionDatabase(dbPath)
    runMigrations(upgraded.sqlite)

    // 记录本登记齐当前全部 10 张单
    const records = upgraded.sqlite
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as Array<{ version: number }>
    expect(records.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])

    // 旧数据一行不丢：老用户的版本号还是 3，没有被初始化逻辑重置成 0
    const state = upgraded.db.select().from(appState).where(eq(appState.id, 1)).get()
    expect(state?.globalMemoryEpoch).toBe(3)

    // 新表全部就位：抽查 v2～v5、v7、v8、v9 各一张代表表
    for (const table of ['app_settings', 'characters', 'conversations', 'tool_operations', 'agent_runs', 'memories', 'memory_jobs']) {
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

    // v7 的运行记录表不是「看起来有表」而是真能记账：沿真实外键链
    // （角色 → 人设版本 → 会话 → 运行）插一行，字段类型全部走一遍
    const version = upgraded.db
      .select()
      .from(characterVersions)
      .where(eq(characterVersions.characterId, initial.characterId))
      .get()
    upgraded.db
      .insert(agentRuns)
      .values({
        id: 'run-upgrade-001',
        conversationId: initial.conversationId,
        characterId: initial.characterId,
        characterVersionId: version?.id ?? null,
        triggerType: 'chat',
        model: 'glm-5.3-flash',
        provider: 'zhipu',
        status: 'completed',
        inputTokens: 120,
        outputTokens: 45,
        usageEstimated: 0,
        startedAt: 1740000008000,
        finishedAt: 1740000009000,
      })
      .run()
    // 读回来对得上，说明列名、类型、约束都没写歪
    const runs = upgraded.db.select().from(agentRuns).all()
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ id: 'run-upgrade-001', triggerType: 'chat', status: 'completed' })
    // CHECK 约束兜底：程序写漏校验、塞进不认识的触发类型时数据库当场报错
    expect(() =>
      upgraded.db
        .insert(agentRuns)
        .values({ ...runs[0], id: 'run-upgrade-002', triggerType: 'not-a-type' })
        .run(),
    ).toThrow()
    // 预算用的索引也跟着表一起建出来了（按「触发类型+时间」查每天用量）
    const index = upgraded.sqlite
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name='runs_for_budget'")
      .get() as { n: number }
    expect(index.n).toBe(1)

    // v8 的记忆两表不是「看起来有表」而是真能用：沿真实外键链
    // （角色 → 会话 → 消息 → 记忆 → 来源）各插一行，列名类型全走一遍。
    // 先补一条用户消息——记忆必须能指回真实消息，不能凭空出现
    const conversation = upgraded.db
      .select()
      .from(conversations)
      .where(eq(conversations.characterId, initial.characterId))
      .get()
    upgraded.db
      .insert(messages)
      .values({
        id: 'msg-upgrade-001',
        conversationId: conversation?.id ?? '',
        seq: 1,
        role: 'user',
        content: '以后叫我阿达',
        status: 'completed',
        clientRequestId: 'upgrade-memory-request-1',
        createdAt: 1740000010000,
      })
      .run()
    upgraded.db
      .insert(memories)
      .values({
        id: 'mem-upgrade-001',
        scope: 'character',
        characterId: initial.characterId,
        kind: 'preference',
        memoryKey: 'preferred_name',
        content: '用户希望被称为阿达',
        origin: 'user_explicit',
        validFrom: 1740000010000,
        createdAt: 1740000010000,
        updatedAt: 1740000010000,
      })
      .run()
    upgraded.db
      .insert(memorySources)
      .values({ memoryId: 'mem-upgrade-001', messageId: 'msg-upgrade-001' })
      .run()
    // 读回来对得上，说明 Drizzle 定义和迁移 SQL 的列名没写歪
    const saved = upgraded.db.select().from(memories).all()
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({
      id: 'mem-upgrade-001',
      status: 'active',
      revision: 1,
    })

    // 三个数据库级防线逐个点名（写漏程序检查时由它们兜底，05 §3/§5/§6）：
    // 1) 复合主键：同一对「记忆 × 消息」不许登记第二遍
    expect(() =>
      upgraded.db
        .insert(memorySources)
        .values({ memoryId: 'mem-upgrade-001', messageId: 'msg-upgrade-001' })
        .run(),
    ).toThrow()
    // 2) 部分唯一索引：同角色同属性键只许一条有效记录（第二个「当前称呼」）
    expect(() =>
      upgraded.db
        .insert(memories)
        .values({
          ...saved[0],
          id: 'mem-upgrade-002',
          content: '用户希望被称为小陈',
        })
        .run(),
    ).toThrow()
    // 3) scope 配套 CHECK：global 记忆不许挂角色（「说不清属于谁」直接拒）
    expect(() =>
      upgraded.db
        .insert(memories)
        .values({
          ...saved[0],
          id: 'mem-upgrade-003',
          scope: 'global',
        })
        .run(),
    ).toThrow()
    // 4) 忘记清正文 CHECK：标 deleted 却留着内容，当场拒绝（05 §6）
    expect(() =>
      upgraded.db
        .update(memories)
        .set({ status: 'deleted' })
        .where(eq(memories.id, 'mem-upgrade-001'))
        .run(),
    ).toThrow()

    // 检索用的索引也跟着建出来了（有效记忆的按归属+状态+类别查找）
    const lookupIndex = upgraded.sqlite
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name='memories_lookup'")
      .get() as { n: number }
    expect(lookupIndex.n).toBe(1)

    upgraded.close()
  })

  it('v8 正式会话升级后保留原书签，v9 用偏移区分分段并只允许一个活跃任务', () => {
    const dbPath = join(dir, 'old-v8.db')
    const old = openCompanionDatabase(dbPath)
    runMigrations(old.sqlite, MIGRATIONS.slice(0, 8))
    // 旧版没有偏移列，用当时的列清单写样本，再关库模拟旧程序退出。
    old.sqlite.exec(`INSERT INTO characters (id, name, created_at, updated_at) VALUES ('char-v8', '旧角色', 1, 1);
      INSERT INTO conversations (id, character_id, last_processed_seq, created_at, last_message_at)
        VALUES ('chat-v8', 'char-v8', 5, 1, 2);`)
    old.close()
    const upgraded = openCompanionDatabase(dbPath)
    try {
      runMigrations(upgraded.sqlite)
      expect(upgraded.db.select().from(conversations).get()).toMatchObject({ lastProcessedSeq: 5, lastProcessedOffset: 0 })
      const job = { conversationId: 'chat-v8', startSeq: 6, endSeq: 6, endOffset: 20, characterEpoch: 0,
        globalEpoch: 0, contextEpoch: 0, extractorVersion: 'test', availableAt: 2, createdAt: 2, updatedAt: 2 }
      upgraded.db.insert(memoryJobs).values({ ...job, id: 'first' }).run()
      expect(() => upgraded.db.insert(memoryJobs).values({ ...job, id: 'competing', endOffset: 21 }).run()).toThrow()
      upgraded.db.update(memoryJobs).set({ status: 'completed' }).run()
      expect(() => upgraded.db.insert(memoryJobs).values({ ...job, id: 'replayed' }).run()).toThrow()
      upgraded.db.insert(memoryJobs).values({ ...job, id: 'second', startOffset: 20, endOffset: 0 }).run()
      expect(upgraded.db.select().from(memoryJobs).where(eq(memoryJobs.id, 'second')).get())
        .toMatchObject({ startOffset: 20, endOffset: 0, status: 'pending' })
    } finally { upgraded.close() }
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

    // 4) 恢复：换回正确清单重跑，v2～v10 正常补齐——坏单子
    //    没有把升级路堵死
    runMigrations(db.sqlite)
    const fixed = db.sqlite
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as Array<{ version: number }>
    expect(fixed.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])

    db.close()
  })
})
