/**
 * 会话解析与「联系方式」管理（04 §1、04 §3）：
 * - getFormalConversation：解析某角色唯一的正式会话——打开聊天窗口时
 *   用它「找到老聊天接着聊」，而不是每次新建；
 * - setRuntimeSessionId：单独更换框架（eve）会话 ID。
 *
 * 为什么换框架 ID 是独立函数、单独一列：框架会话 ID 只是「当前用哪个
 * 框架会话」的便签——重建运行上下文（比如忘记某事后要干净上下文）就
 * 要换新便签。聊天记录挂在应用自己的会话 ID 上，换便签不动记录，
 * 用户看到的还是同一段聊天（04 §3「应用会话 ID 与框架会话 ID 分离」）。
 */
import { and, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { conversations } from './tables'

/**
 * 找某角色的正式会话（mode='normal'）。
 * @param db 数据库连接
 * @param characterId 角色 ID
 * @returns 会话行；没有返回 undefined。注意只回正式会话——试聊的
 *  preview 会话即使存在也不会从这里漏出去（05 §3 隔离）
 */
export function getFormalConversation(
  db: BetterSQLite3Database,
  characterId: string,
) {
  return db
    .select()
    .from(conversations)
    .where(
      and(eq(conversations.characterId, characterId), eq(conversations.mode, 'normal')),
    )
    .get()
}

/**
 * 更换（或设置）一段会话当前使用的框架会话 ID。
 * @param db 数据库连接
 * @param conversationId 应用自己的会话 ID——找的是「这段聊天」，
 *  跟框架 ID 无关，换联系方式前先认对人
 * @param runtimeSessionId 新的框架会话 ID；传 null 表示清空
 *  （比如旧框架会话作废、新的还没建）
 * @throws 会话不存在时抛错，不装作成功——多半是调用方拿错 ID
 */
export function setRuntimeSessionId(
  db: BetterSQLite3Database,
  conversationId: string,
  runtimeSessionId: string | null,
): void {
  const result = db
    .update(conversations)
    .set({ runtimeSessionId })
    .where(eq(conversations.id, conversationId))
    .run()
  // run() 回报实际改了几行；0 行就是没这段会话
  if (result.changes === 0) throw new Error(`会话不存在：${conversationId}`)
}
