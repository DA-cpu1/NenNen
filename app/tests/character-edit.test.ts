/**
 * 角色编辑数据层（T05③，data/character-edit.ts）的固定输入检查：
 * 保存版本、防重、回退、概览读取、图片更新。全部用临时文件库 +
 * 固定时间戳，不碰真实用户数据（07 §3）。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openCompanionDatabase, type CompanionDb } from '../src/data/db'
import { runMigrations } from '../src/data/migrations'
import { initializeFirstCharacter } from '../src/data/character-init'
import {
  activateCharacterVersion,
  getCharacterOverview,
  saveCharacterVersion,
  updateCharacterImages,
} from '../src/data/character-edit'
import type { DialogueExample } from '../src/shared/character-schema'

let dir: string
let db: CompanionDb

/** 两组固定示例：验证「保存的示例原样读回」 */
const examplesA: DialogueExample[] = [
  { scene: '分享开心的事', user: '今天终于把界面弄完了。', character: '哼哼，今天的结界突破了。' },
]
const examplesB: DialogueExample[] = [
  { scene: '想认真倾诉', user: '别开玩笑，我今天真的挺难受。', character: '……嗯，这次认真听。' },
]

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'companion-character-edit-test-'))
  db = openCompanionDatabase(join(dir, 'edit.db'))
  runMigrations(db.sqlite)
  initializeFirstCharacter(db.db, {
    name: '六花',
    personaText: '（占位人设：T03 正式角色卡在 T06 接入）',
    initialRelationship: '恋人',
    timezone: 'Asia/Shanghai',
    now: 1740000000000,
  })
})

afterAll(async () => {
  db.close()
  await rm(dir, { recursive: true, force: true })
})

describe('getCharacterOverview 概览读取', () => {
  it('初始化后的库：名字、图片空、v1 生效、版本列表一条', () => {
    const overview = getCharacterOverview(db.db)
    expect(overview).toBeDefined()
    expect(overview?.name).toBe('六花')
    expect(overview?.desktopImagePath).toBeNull()
    expect(overview?.portraitImagePath).toBeNull()
    // v1 占位人设：T04 建的行没有分区标题，界面会按完整文本展示
    expect(overview?.activeVersion?.versionNo).toBe(1)
    expect(overview?.activeVersion?.personaText).toContain('占位人设')
    expect(overview?.activeVersion?.userNickname).toBeNull()
    expect(overview?.activeVersion?.dialogueExamples).toEqual([])
    expect(overview?.versions).toEqual([
      { versionNo: 1, isActive: true, createdAt: 1740000000000 },
    ])
  })
})

describe('saveCharacterVersion 保存版本', () => {
  it('第一次保存：v2 生效、v1 保留、名字与示例同批更新', () => {
    const result = saveCharacterVersion(db.db, {
      name: '六花',
      personaText: '【核心性格】\n认真维护幻想小世界。\n\n【语言习惯】\n自然中文。\n\n【背景边界】\n沿用动画版。',
      initialRelationship: '已经确定恋人关系',
      userNickname: '阿达',
      dialogueExamples: examplesA,
      saveRequestId: 'req-save-001',
      now: 1740000100000,
    })
    expect(result).toEqual({ characterId: expect.any(String), versionNo: 2, created: true })

    const overview = getCharacterOverview(db.db)
    expect(overview?.activeVersion?.versionNo).toBe(2)
    expect(overview?.activeVersion?.userNickname).toBe('阿达')
    expect(overview?.activeVersion?.dialogueExamples).toEqual(examplesA)
    // 旧版本原样保留，只是不再生效
    expect(overview?.versions.map((v) => v.versionNo)).toEqual([2, 1])
    expect(overview?.versions.find((v) => v.versionNo === 1)?.isActive).toBe(false)
  })

  it('同一请求编号重复到达：不建新版，返回已存的那版（05 §5 防重）', () => {
    const again = saveCharacterVersion(db.db, {
      name: '六花',
      personaText: '【核心性格】\n内容无关紧要，不应被写入\n',
      initialRelationship: '恋人',
      userNickname: null,
      dialogueExamples: [],
      saveRequestId: 'req-save-001', // 同一个编号
      now: 1740000200000,
    })
    expect(again.created).toBe(false)
    expect(again.versionNo).toBe(2)
    // 版本列表没有长出第三版；生效内容仍是第一次保存的
    const overview = getCharacterOverview(db.db)
    expect(overview?.versions.map((v) => v.versionNo)).toEqual([2, 1])
    expect(overview?.activeVersion?.dialogueExamples).toEqual(examplesA)
  })

  it('新请求编号：正常递增到 v3，名字同步改', () => {
    const result = saveCharacterVersion(db.db, {
      name: '六花酱',
      personaText: '【核心性格】\n略。\n\n【语言习惯】\n略。\n\n【背景边界】\n略。',
      initialRelationship: '恋人',
      userNickname: '小陈',
      dialogueExamples: examplesB,
      saveRequestId: 'req-save-002',
      now: 1740000300000,
    })
    expect(result.versionNo).toBe(3)
    const overview = getCharacterOverview(db.db)
    expect(overview?.name).toBe('六花酱')
    expect(overview?.activeVersion?.versionNo).toBe(3)
    expect(overview?.activeVersion?.dialogueExamples).toEqual(examplesB)
    // 三个版本全在，只有 v3 生效
    expect(overview?.versions.filter((v) => v.isActive)).toEqual([
      { versionNo: 3, isActive: true, createdAt: 1740000300000 },
    ])
  })
})

describe('activateCharacterVersion 回退', () => {
  it('回退到 v2：v2 生效、v1/v3 原样保留、名字不变', () => {
    const result = activateCharacterVersion(db.db, 2)
    expect(result).toEqual({ characterId: expect.any(String), versionNo: 2 })

    const overview = getCharacterOverview(db.db)
    expect(overview?.activeVersion?.versionNo).toBe(2)
    expect(overview?.activeVersion?.userNickname).toBe('阿达')
    expect(overview?.versions.map((v) => v.versionNo)).toEqual([3, 2, 1])
    // 回退不动名字：名字在 characters 表，不属于人设版本
    expect(overview?.name).toBe('六花酱')
  })

  it('回退到当前已生效版本：幂等无害', () => {
    expect(() => activateCharacterVersion(db.db, 2)).not.toThrow()
    expect(getCharacterOverview(db.db)?.activeVersion?.versionNo).toBe(2)
  })

  it('回退到不存在的版本号：抛错，不装作成功（01 R17）', () => {
    expect(() => activateCharacterVersion(db.db, 99)).toThrow('E_VERSION_NOT_FOUND')
    // 失败的回退不产生副作用：生效版本仍是 v2
    expect(getCharacterOverview(db.db)?.activeVersion?.versionNo).toBe(2)
  })
})

describe('updateCharacterImages 图片路径', () => {
  it('分别设置两张图，再单独换桌面图：另一张不受影响', () => {
    updateCharacterImages(db.db, {
      desktopImagePath: 'characters/char-x/desktop.png',
      portraitImagePath: 'characters/char-x/portrait.png',
    })
    let overview = getCharacterOverview(db.db)
    expect(overview?.desktopImagePath).toBe('characters/char-x/desktop.png')
    expect(overview?.portraitImagePath).toBe('characters/char-x/portrait.png')

    updateCharacterImages(db.db, { desktopImagePath: 'characters/char-x/desktop-v2.png' })
    overview = getCharacterOverview(db.db)
    expect(overview?.desktopImagePath).toBe('characters/char-x/desktop-v2.png')
    expect(overview?.portraitImagePath).toBe('characters/char-x/portrait.png')
  })

  it('传 null 清除图片', () => {
    updateCharacterImages(db.db, { portraitImagePath: null })
    expect(getCharacterOverview(db.db)?.portraitImagePath).toBeNull()
  })
})
