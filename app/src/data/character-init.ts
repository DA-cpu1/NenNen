/**
 * 「首个角色」的初始化（05 §8）：首次启动时，在一个事务里建齐四件套——
 * 角色行、第 1 版人设、一条正式会话（mode='normal'）、主动陪伴设置行。
 *
 * 为什么四件套必须在同一个事务里？想象只建到一半程序崩了（角色有了、
 * 正式会话没有）：下次启动一看「已有角色」就跳过初始化，这个角色从此
 * 没有正式会话，聊天没地方挂。事务保证四件要么全有、要么全无，
 * 崩了下次重来，不会卡在半套状态。
 *
 * 重入（再调一次）时不重建，复用已有角色和它的正式会话（05 §3）——
 * 「不假设角色 ID 永远是 1」：ID 是随机字符串，重入靠查库认人，不靠猜。
 * 人设占位文本由调用方传入：T04 阶段传占位内容，T03 的正式角色卡
 * 在 T06 接入。
 */
import { and, asc, eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import {
  characters,
  characterVersions,
  companionSettings,
  conversations,
} from './tables'

/** 初始化需要调用方提供的内容。名字、人设、关系设定都从角色卡/占位
 *  文本来；时区按用户系统取（如 Asia/Shanghai），主动陪伴按它算作息 */
export interface InitializeCharacterOptions {
  /** 角色名字 */
  name: string
  /** 第 1 版人设正文（占位或角色卡内容） */
  personaText: string
  /** 初始关系设定（如「恋人」） */
  initialRelationship: string
  /** 用户时区名，写入主动陪伴设置行 */
  timezone: string
  /** 时间戳仅供自动检查注入固定值（07 §3）；正式调用不传、用当前时间 */
  now?: number
}

/** 初始化结果：告诉调用方用哪个角色、哪段会话，以及是不是这次新建的 */
export interface InitializedCharacter {
  characterId: string
  /** 该角色唯一的正式会话 ID（重入时与首次相同） */
  conversationId: string
  /** true=本次新建了角色；false=库中已有，直接复用（重入） */
  created: boolean
}

/**
 * 取库中最早创建的角色（首版只有一个角色，它就是「当前角色」）。
 * 服务层解析正式会话前先问它；返回 undefined 表示还没初始化过。
 * 参数类型用 drizzle 的基类型 BaseSQLiteDatabase：普通连接和事务里的
 * tx 都能传（事务对象就是「去掉了嵌套开事务能力的连接」）。
 * 返回整行（含名字、图片路径）：T05 编辑页要读这些字段。
 */
export function getFirstCharacter(
  db: BaseSQLiteDatabase<'sync', unknown>,
): typeof characters.$inferSelect | undefined {
  return db.select().from(characters).orderBy(asc(characters.createdAt)).get()
}

/**
 * 初始化首个角色；库中已有角色时什么都不建、直接复用。
 * @param db 数据库连接（需已跑过迁移）
 * @param options 角色内容与时区
 * @returns 角色 ID 与其正式会话 ID
 */
export function initializeFirstCharacter(
  db: BetterSQLite3Database,
  options: InitializeCharacterOptions,
): InitializedCharacter {
  const now = options.now ?? Date.now()

  // 整个「查 + 建」包在事务里：两个后台流程同时启动都调初始化时，
  // 不会两个都查到「没有角色」然后各建一套（事务把查和建焊成一步）
  return db.transaction((tx) => {
    // 首版只有一个角色：按创建时间取最早的那个。重入认「库里有没有」，
    // 不认参数——参数变了（比如占位人设换正式卡）也不会建第二个角色
    const existing = getFirstCharacter(tx)
    if (existing) {
      // 复用已有角色，但要确认它有正式会话：万一上次初始化被外力删过
      // 半套，这里当场补上，让「每个角色必有正式会话」永远成立
      const normal = findNormalConversation(tx, existing.id)
      if (normal) {
        return { characterId: existing.id, conversationId: normal.id, created: false }
      }
      const conversationId = `conv-${randomUUID()}`
      tx.insert(conversations)
        .values({
          id: conversationId,
          characterId: existing.id,
          mode: 'normal',
          createdAt: now,
          lastMessageAt: now,
        })
        .run()
      return { characterId: existing.id, conversationId, created: false }
    }

    // 全新库：四件套一次建齐。ID 用随机 UUID（撞车概率约等于零），
    // 前缀 char-/conv- 只是让人在日志里一眼认出它是哪类 ID
    const characterId = `char-${randomUUID()}`
    const conversationId = `conv-${randomUUID()}`
    tx.insert(characters)
      .values({ id: characterId, name: options.name, createdAt: now, updatedAt: now })
      .run()
    // 第 1 版人设，标记为当前生效（is_active=1）；对话示例先空着（默认 '[]'）
    tx.insert(characterVersions)
      .values({
        id: `charver-${randomUUID()}`,
        characterId,
        versionNo: 1,
        personaText: options.personaText,
        initialRelationship: options.initialRelationship,
        isActive: 1,
        createdAt: now,
      })
      .run()
    // 唯一的正式会话；试聊 preview 会话到 T06 才建，这里不碰
    tx.insert(conversations)
      .values({
        id: conversationId,
        characterId,
        mode: 'normal',
        createdAt: now,
        lastMessageAt: now,
      })
      .run()
    // 主动陪伴设置行：只传必填的时区，开关/间隔等靠数据库默认值
    // （enabled=0 默认关——没用户点头绝不主动说话，见 02）
    tx.insert(companionSettings)
      .values({ characterId, timezone: options.timezone, updatedAt: now })
      .run()
    return { characterId, conversationId, created: true }
  })
}

/** 在事务里找某角色的正式会话。抽成小函数是因为重入路径要用两次判断 */
function findNormalConversation(
  tx: Parameters<Parameters<BetterSQLite3Database['transaction']>[0]>[0],
  characterId: string,
) {
  return tx
    .select()
    .from(conversations)
    .where(and(eq(conversations.characterId, characterId), eq(conversations.mode, 'normal')))
    .get()
}
