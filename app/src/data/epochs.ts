/**
 * 三个「记忆/内容版本号」（规格叫 epoch）的读写与提升，全项目只有这一个文件
 * 负责这件事（05 §4）。三个版本号各管一段地盘，谁也不能替谁：
 *
 * - app_state.global_memory_epoch：跨角色共享资料的版本——用户改了共享
 *   资料，全库这一个数字 +1；
 * - characters.memory_epoch：某个角色私有记忆的版本——只有这个角色的
 *   记忆变了才 +1，别的角色不受牵连；
 * - conversations.context_epoch：某段会话「可用内容」的版本——忘记、
 *   排除来源时 +1，依赖旧内容的后台任务据此作废。
 *
 * 为什么需要它们？后台整理任务开工时会抄下当时的版本号，落库前再核对
 * 一次：数字没变说明「我干活期间没人动过数据」，结果可以放心写入；
 * 数字变了说明记忆被改过，旧结果必须丢弃重做。没有这套对账，就会把
 * 基于过期记忆算出的结果写进新状态里（05 §5）。
 */
import { eq, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { appState, characters, conversations } from './tables'

/** 读共享记忆版本。app_state 全库只有一行（迁移 v1 保证建库时插入），
 *  读不到说明库被人动过手脚，宁可抛错也不默默当 0——当 0 会让后台任务
 *  把「版本未知」误判成「一切没变」，把脏结果写进去 */
export function readGlobalMemoryEpoch(db: BetterSQLite3Database): number {
  const row = db.select().from(appState).where(eq(appState.id, 1)).get()
  if (!row) throw new Error('app_state 缺少初始行')
  return row.globalMemoryEpoch
}

/**
 * 共享记忆版本 +1，返回加完的新值。
 * 用 SQL 自增（`数字 + 1` 在数据库里一步完成）而不是「先读出来再加」：
 * 读和加合并成一条原子操作，两个调用者同时提升时不会都从 3 加到 4、
 * 少算一次（05 §5 每次记忆变动都要提版本，丢一次等于漏作废一批任务）
 */
export function bumpGlobalMemoryEpoch(db: BetterSQLite3Database): number {
  db.update(appState)
    .set({ globalMemoryEpoch: sql`${appState.globalMemoryEpoch} + 1` })
    .where(eq(appState.id, 1))
    .run()
  return readGlobalMemoryEpoch(db)
}

/**
 * 某个角色的私有记忆版本 +1，返回新值。
 * @param characterId 要提升哪个角色；不存在时抛错而不是装作成功——
 *  调用方多半是拿错了角色 ID，装成功会让那次记忆变更「没人作废得了」
 */
export function bumpCharacterMemoryEpoch(
  db: BetterSQLite3Database,
  characterId: string,
): number {
  const result = db
    .update(characters)
    .set({ memoryEpoch: sql`${characters.memoryEpoch} + 1` })
    .where(eq(characters.id, characterId))
    .run()
  // better-sqlite3 的 run() 回报「实际改了几行」：0 行说明这个角色不存在
  if (result.changes === 0) throw new Error(`角色不存在：${characterId}`)
  const row = db.select().from(characters).where(eq(characters.id, characterId)).get()
  return row!.memoryEpoch
}

/**
 * 某段会话的内容版本 +1，返回新值。忘记、删除来源、改来源可用范围时调用
 * （05 §4）；同一事务里配合数据变更一起提交，见文件头注释。
 * @param conversationId 要提升哪段会话；不存在时抛错，理由同上
 */
export function bumpContextEpoch(
  db: BetterSQLite3Database,
  conversationId: string,
): number {
  const result = db
    .update(conversations)
    .set({ contextEpoch: sql`${conversations.contextEpoch} + 1` })
    .where(eq(conversations.id, conversationId))
    .run()
  if (result.changes === 0) throw new Error(`会话不存在：${conversationId}`)
  const row = db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .get()
  return row!.contextEpoch
}
