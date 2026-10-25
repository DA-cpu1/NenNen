/**
 * 角色编辑的数据库读写（T05，01 R05）：读角色概览、保存新人设版本、
 * 回退到旧版本、更新图片路径。
 *
 * 「保存生成版本」的规矩（05 §2）：人设从不覆盖——每次保存新增一行
 * character_versions（版本号 +1），旧版本全部保留；同一时刻只有一行
 * is_active=1（数据库的部分唯一索引兜底，程序写漏了也会被拦）。
 * 名字和图片不随版本走：它们存在 characters 表，直接改当前值
 * （设计稿 full-ui-v1 明确「不暗示名字/图片与人设一起版本化」）。
 *
 * 防重复保存（05 §5 精神）：每次界面保存带一个 saveRequestId；同一个
 * 编号第二次到达（网络卡时用户连点「保存」），直接返回已建的那版，
 * 不再建新版本。数据库的复合唯一索引 (character_id, save_request_id)
 * 是最后兜底——就算两次请求撞进同一事务间隙，第二行也插不进去。
 */
import { and, desc, eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { characters, characterVersions } from './tables'
import { getFirstCharacter } from './character-init'
import type { DialogueExample } from '../shared/character-schema'
import type {
  ActiveVersionContent,
  CharacterOverview,
  CharacterVersionSummary,
} from '../shared/data-types'

// 概览形状的定义已挪到 shared/data-types.ts（界面也要用同一份）；
// 这里 re-export 一次，服务层等既有引用不用改路径
export type { ActiveVersionContent, CharacterOverview, CharacterVersionSummary }

/** 一次「保存人设版本」的输入。人设正文是拼好的纯文本
 *  （分区 ↔ 文本的互转在上游完成，见 shared/persona-format.ts），
 *  这一层只管存取，不关心它是分区拼的还是整段写的 */
export interface SaveCharacterVersionInput {
  /** 角色名字（随保存更新到 characters 表；不进版本行） */
  name: string
  /** 人设正文（personaText） */
  personaText: string
  /** 初始关系设定 */
  initialRelationship: string
  /** 称呼设定；null = 未设定（聊天里自然称呼） */
  userNickname: string | null
  /** 情境对话示例列表 */
  dialogueExamples: DialogueExample[]
  /** 本次保存的界面请求编号：重试沿用同一个号防重复建版 */
  saveRequestId: string
  /** 时间戳仅供自动检查注入固定值（07 §3）；正式调用不传、用当前时间 */
  now?: number
}

/** 保存结果：created=false 表示同一请求编号已保存过，返回的是已建版本 */
export interface SaveCharacterVersionResult {
  characterId: string
  /** 保存后的版本号（新号或重复到达的旧号） */
  versionNo: number
  /** true=本次新建了版本；false=同编号重复到达，复用已有版本 */
  created: boolean
}

/**
 * 读首个角色的编辑概览（首版只有一个角色，它就是「当前角色」，
 * 与服务层 readFormalConversation 的取法一致）。
 * @param db 数据库连接
 * @returns 概览；还没初始化过角色时返回 undefined
 */
export function getCharacterOverview(db: BetterSQLite3Database): CharacterOverview | undefined {
  const character = getFirstCharacter(db)
  if (!character) return undefined

  const all = db
    .select()
    .from(characterVersions)
    .where(eq(characterVersions.characterId, character.id))
    .orderBy(desc(characterVersions.versionNo))
    .all()

  const activeRow = all.find((row) => row.isActive === 1)
  return {
    characterId: character.id,
    name: character.name,
    desktopImagePath: character.desktopImagePath,
    portraitImagePath: character.portraitImagePath,
    activeVersion: activeRow
      ? {
          versionNo: activeRow.versionNo,
          personaText: activeRow.personaText,
          initialRelationship: activeRow.initialRelationship,
          userNickname: activeRow.userNickname,
          // 示例是程序写入的 JSON；库被外力改坏时不让整个编辑页打不开，
          // 当作没有示例处理（数据仍在库里，可人工排查）
          dialogueExamples: parseExamples(activeRow.dialogueExamplesJson),
        }
      : null,
    versions: all.map((row) => ({
      versionNo: row.versionNo,
      isActive: row.isActive === 1,
      createdAt: row.createdAt,
    })),
  }
}

/** 解析 dialogue_examples_json；坏数据当空列表，不炸整个读取 */
function parseExamples(json: string): DialogueExample[] {
  try {
    const parsed = JSON.parse(json) as unknown
    return Array.isArray(parsed) ? (parsed as DialogueExample[]) : []
  } catch {
    return []
  }
}

/**
 * 保存一版新人设（01 R05「保存生成版本」）。
 * 一个事务里做三件事，缺一不可：
 * ① 旧版本全部下岗（is_active=0）→ ② 插入新版本行（is_active=1）→
 * ③ 名字同步更新到 characters。只做一半会出现「两版都生效」或
 * 「新版生效但名字还是旧的」的撕裂状态。
 * @param db 数据库连接
 * @param input 保存内容与请求编号
 * @returns 版本号与是否新建
 * @throws 库中还没有角色时抛错——初始化保证必有角色，走到这里说明库不正常
 */
export function saveCharacterVersion(
  db: BetterSQLite3Database,
  input: SaveCharacterVersionInput,
): SaveCharacterVersionResult {
  const now = input.now ?? Date.now()

  return db.transaction((tx) => {
    const character = getFirstCharacter(tx)
    if (!character) throw new Error('E_NO_CHARACTER')

    // 防重第一道：同角色同请求编号已保存过 → 原样返回那版，不再新建。
    // 网络卡顿时界面重试的场景：用户点了一次「保存」，第二次到达的
    // 是同一件事，不该长出两个内容相同的版本
    const existing = tx
      .select()
      .from(characterVersions)
      .where(
        and(
          eq(characterVersions.characterId, character.id),
          eq(characterVersions.saveRequestId, input.saveRequestId),
        ),
      )
      .get()
    if (existing) {
      return {
        characterId: character.id,
        versionNo: existing.versionNo,
        created: false,
      }
    }

    // 旧版本全部下岗。先下岗再上岗：直接给新行 is_active=1 会撞
    // one_active_character_version 部分唯一索引（同角色同时两行 1）
    tx.update(characterVersions)
      .set({ isActive: 0 })
      .where(eq(characterVersions.characterId, character.id))
      .run()

    // 新版本号 = 当前最大 +1。事务内同步算，没有并发插队的缝
    const maxRow = tx
      .select({ versionNo: characterVersions.versionNo })
      .from(characterVersions)
      .where(eq(characterVersions.characterId, character.id))
      .orderBy(desc(characterVersions.versionNo))
      .limit(1)
      .get()
    const nextVersionNo = (maxRow?.versionNo ?? 0) + 1

    tx.insert(characterVersions)
      .values({
        id: `charver-${randomUUID()}`,
        characterId: character.id,
        versionNo: nextVersionNo,
        personaText: input.personaText,
        initialRelationship: input.initialRelationship,
        userNickname: input.userNickname,
        dialogueExamplesJson: JSON.stringify(input.dialogueExamples),
        isActive: 1,
        createdAt: now,
        saveRequestId: input.saveRequestId,
      })
      .run()

    // 名字直接改当前值（不版本化）；顺手刷新 updated_at
    tx.update(characters)
      .set({ name: input.name, updatedAt: now })
      .where(eq(characters.id, character.id))
      .run()

    return { characterId: character.id, versionNo: nextVersionNo, created: true }
  })
}

/**
 * 回退：把指定版本号重新设为当前生效（01 R05「保存版本可回退」）。
 * 事务内两步：该角色全部版本先下岗、目标版本上岗——顺序不能反，
 * 反了会撞「同角色只许一行生效」的唯一索引。
 * 回退只改 is_active，不复制行、不生成新版本号：回到 v1 之后列表里
 * 仍是「v1 生效」，v2 原样留着，想再切回去随时可以（对称操作）。
 * @param db 数据库连接
 * @param versionNo 要生效的版本号
 * @returns 生效的版本号
 * @throws 没有角色、或该版本号不存在时抛错——调用方转成明确的错误码，
 *  不装作回退成功（01 R17）
 */
export function activateCharacterVersion(
  db: BetterSQLite3Database,
  versionNo: number,
): { characterId: string; versionNo: number } {
  return db.transaction((tx) => {
    const character = getFirstCharacter(tx)
    if (!character) throw new Error('E_NO_CHARACTER')

    // 先确认目标版本真的存在：不存在时下面的 UPDATE 会「成功改 0 行」，
    // 不查清楚就把「没回退」错报成「回退成功」
    const target = tx
      .select({ id: characterVersions.id })
      .from(characterVersions)
      .where(
        and(
          eq(characterVersions.characterId, character.id),
          eq(characterVersions.versionNo, versionNo),
        ),
      )
      .get()
    if (!target) throw new Error('E_VERSION_NOT_FOUND')

    tx.update(characterVersions)
      .set({ isActive: 0 })
      .where(eq(characterVersions.characterId, character.id))
      .run()
    tx.update(characterVersions)
      .set({ isActive: 1 })
      .where(
        and(
          eq(characterVersions.characterId, character.id),
          eq(characterVersions.versionNo, versionNo),
        ),
      )
      .run()

    return { characterId: character.id, versionNo }
  })
}

/** 图片更新参数：只写要改的字段；null = 清除该图，不传 = 保持不动 */
export interface CharacterImagesUpdate {
  desktopImagePath?: string | null
  portraitImagePath?: string | null
}

/**
 * 更新角色图片路径（T05「图片设置」）。路径只是「文件在哪」的记录——
 * 文件本身的复制由主进程完成（界面进程没有文件能力，03 §7），这里
 * 只把结果记到 characters 表。图片不进人设版本（设计稿明确两者分开）。
 * @param db 数据库连接
 * @param update 要改的字段
 * @throws 没有角色时抛错
 */
export function updateCharacterImages(
  db: BetterSQLite3Database,
  update: CharacterImagesUpdate,
): void {
  const character = getFirstCharacter(db)
  if (!character) throw new Error('E_NO_CHARACTER')

  // Drizzle 的 set：值为 undefined 的字段不出现在 UPDATE 语句里，
  // 天然做到「不传 = 不动」；null 是明确的「清除」
  db.update(characters)
    .set({
      ...(update.desktopImagePath !== undefined
        ? { desktopImagePath: update.desktopImagePath }
        : {}),
      ...(update.portraitImagePath !== undefined
        ? { portraitImagePath: update.portraitImagePath }
        : {}),
      updatedAt: Date.now(),
    })
    .where(eq(characters.id, character.id))
    .run()
}
