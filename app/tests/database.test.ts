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
import {
  appState,
  characters,
  characterVersions,
  companionSettings,
  conversations,
  messages,
  toolOperations,
} from '../src/data/tables'
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
  it('全新库执行迁移：版本登记 7 条，app_state 初始单行', () => {
    runMigrations(companion.sqlite)
    const records = companion.sqlite
      .prepare('SELECT version FROM schema_migrations')
      .all() as Array<{ version: number }>
    expect(records).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
      { version: 6 },
      { version: 7 },
    ])
    const rows = companion.db.select().from(appState).all()
    expect(rows).toEqual([{ id: 1, globalMemoryEpoch: 0 }])
  })

  it('重复执行不重复应用（幂等）', () => {
    runMigrations(companion.sqlite)
    const count = companion.sqlite
      .prepare('SELECT COUNT(*) AS n FROM schema_migrations')
      .get() as { n: number }
    expect(count.n).toBe(7)
  })

  it('重开同一数据库文件后再跑迁移仍不重复', () => {
    const second = openCompanionDatabase(dbPath)
    try {
      runMigrations(second.sqlite)
      const count = second.sqlite
        .prepare('SELECT COUNT(*) AS n FROM schema_migrations')
        .get() as { n: number }
      expect(count.n).toBe(7)
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

describe('会话与消息表结构（T04 v4）', () => {
  // 固定输入（07 §3）。为了不跟「角色表结构」块的数据搅在一起，
  // 这里给测试单独建一个新角色和它的会话
  const characterId = 'char-test-conv-001'
  const conversationId = 'conv-test-001'
  const now = 1740000001000

  it('角色、正式会话、一问一答四层落库并回读', () => {
    companion.db
      .insert(characters)
      .values({ id: characterId, name: '测试角色', createdAt: now, updatedAt: now })
      .run()
    // 正式会话（mode 用默认值 normal），框架会话 ID 先留空——
    // 没聊过天时还没有 eve 会话，「联系方式」可以后补（04 §3）
    companion.db
      .insert(conversations)
      .values({
        id: conversationId,
        characterId,
        createdAt: now,
        lastMessageAt: now,
      })
      .run()
    // 用户消息带唯一请求编号 clientRequestId
    companion.db
      .insert(messages)
      .values({
        id: 'msg-test-001',
        conversationId,
        seq: 1,
        role: 'user',
        content: '在吗？',
        status: 'completed',
        clientRequestId: 'req-test-001',
        createdAt: now,
      })
      .run()
    // 角色回复没有请求编号（编号只防「用户重复发送」这一种事故）
    companion.db
      .insert(messages)
      .values({
        id: 'msg-test-002',
        conversationId,
        seq: 2,
        role: 'assistant',
        content: '在的。',
        status: 'completed',
        createdAt: now,
      })
      .run()

    const conversation = companion.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .get()
    expect(conversation?.mode).toBe('normal')
    expect(conversation?.runtimeSessionId).toBeNull()
    expect(conversation?.contextEpoch).toBe(0)
    const rows = companion.db.select().from(messages).all()
    // 只数本会话的消息——角色表结构块没有插过消息，但按会话过滤更稳
    const own = rows.filter((m) => m.conversationId === conversationId)
    expect(own).toHaveLength(2)
    expect(own.find((m) => m.seq === 1)?.clientRequestId).toBe('req-test-001')
    expect(own.find((m) => m.seq === 2)?.clientRequestId).toBeNull()
  })

  it('同一请求编号重复插入被 UNIQUE(conversation_id, client_request_id) 拦下', () => {
    // 事故场景：网络卡了，界面把同一条用户输入（同一个请求编号）发了两次。
    // 第二条插不进来，库里的聊天记录不会出现两段一模一样的话（05 §5）
    expect(() =>
      companion.db
        .insert(messages)
        .values({
          id: 'msg-test-003',
          conversationId,
          seq: 3,
          role: 'user',
          content: '在吗？（重试重复发的那份）',
          status: 'completed',
          clientRequestId: 'req-test-001',
          createdAt: now,
        })
        .run(),
    ).toThrow(/UNIQUE/)
  })

  it('同一会话重复顺序号被 UNIQUE(conversation_id, seq) 拦下', () => {
    // 事故场景：并发时两条消息都算出自己是「第 1 条」。顺序号唯一，
    // 聊天历史顺序才可信
    expect(() =>
      companion.db
        .insert(messages)
        .values({
          id: 'msg-test-004',
          conversationId,
          seq: 1,
          role: 'user',
          content: '抢第 1 条位置的消息',
          status: 'completed',
          clientRequestId: 'req-test-002',
          createdAt: now,
        })
        .run(),
    ).toThrow(/UNIQUE/)
  })

  it('会话类型只认 normal/preview，写别的值被 CHECK 拦下', () => {
    // 事故场景：代码里把 mode 拼错成 'casual'。CHECK 约束当场报错，
    // 而不是让一个谁都不认识的类型混进数据里，后面到处判空
    expect(() =>
      companion.db
        .insert(conversations)
        .values({
          id: 'conv-test-002',
          characterId,
          mode: 'casual',
          createdAt: now,
          lastMessageAt: now,
        })
        .run(),
    ).toThrow(/CHECK/)
  })

  it('消息角色只认 user/assistant/proactive，写别的值被 CHECK 拦下', () => {
    expect(() =>
      companion.db
        .insert(messages)
        .values({
          id: 'msg-test-005',
          conversationId,
          seq: 4,
          role: 'system',
          content: '不该出现的角色',
          status: 'completed',
          createdAt: now,
        })
        .run(),
    ).toThrow(/CHECK/)
  })
})

describe('设置与工具操作表结构（T04 v5）', () => {
  // 固定输入（07 §3）。设置表用自己的新角色；工具操作登记挂在
  // v4 块建过的 conv-test-001 会话上（外键要求会话真实存在）
  const characterId = 'char-test-settings-001'
  const now = 1740000002000

  it('主动陪伴默认行落库：总开关关、免打扰开（02 默认值）', () => {
    companion.db
      .insert(characters)
      .values({ id: characterId, name: '设置测试角色', createdAt: now, updatedAt: now })
      .run()
    // 刻意不传有默认值的字段，验证数据库默认值真的落了地
    companion.db
      .insert(companionSettings)
      .values({ characterId, timezone: 'Asia/Shanghai', updatedAt: now })
      .run()

    const row = companion.db
      .select()
      .from(companionSettings)
      .where(eq(companionSettings.characterId, characterId))
      .get()
    // 总开关默认关：没人主动打开，角色绝不主动说话
    expect(row?.enabled).toBe(0)
    // 免打扰默认开（23:00～8:00）：宁可少说话，不半夜吵人
    expect(row?.quietEnabled).toBe(1)
    expect(row?.quietStartMinute).toBe(1380)
    expect(row?.quietEndMinute).toBe(480)
    expect(row?.intervalMinutes).toBe(120)
  })

  it('设置开关只认 0/1，写别的值被 CHECK 拦下', () => {
    // 事故场景：把 enabled 当数字开关算出 2（比如布尔值和数字相加）
    expect(() =>
      companion.db
        .insert(companionSettings)
        .values({
          characterId: 'char-test-001', // 复用 v3 块的角色（外键要求存在）
          enabled: 2,
          timezone: 'Asia/Shanghai',
          updatedAt: now,
        })
        .run(),
    ).toThrow(/CHECK/)
  })

  it('工具操作登记一行 pending，重复 operation_key 被 UNIQUE 拦下', () => {
    companion.db
      .insert(toolOperations)
      .values({
        id: 'op-test-001',
        conversationId: 'conv-test-001',
        operationKey: 'conv-test-001|msg-test-001|remember_explicit',
        toolName: 'remember_explicit',
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      })
      .run()

    // 事故场景：网络卡了，同一个「记住」请求重放。第二个同编号登记
    // 插不进来——防重不靠调用方自觉，靠数据库约束兜底（05 §5）
    expect(() =>
      companion.db
        .insert(toolOperations)
        .values({
          id: 'op-test-002',
          conversationId: 'conv-test-001',
          operationKey: 'conv-test-001|msg-test-001|remember_explicit',
          toolName: 'remember_explicit',
          status: 'pending',
          createdAt: now,
          updatedAt: now,
        })
        .run(),
    ).toThrow(/UNIQUE/)
  })

  it('工具操作状态只认 pending/committed/failed，写别的值被 CHECK 拦下', () => {
    expect(() =>
      companion.db
        .insert(toolOperations)
        .values({
          id: 'op-test-003',
          conversationId: 'conv-test-001',
          operationKey: 'conv-test-001|msg-test-001|forget_memory',
          toolName: 'forget_memory',
          status: 'done',
          createdAt: now,
          updatedAt: now,
        })
        .run(),
    ).toThrow(/CHECK/)
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
