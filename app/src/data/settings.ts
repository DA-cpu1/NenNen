/**
 * app_settings 表的读写小工具：窗口位置这类「非机密的杂项设置」按
 * 「键 → JSON 值」存放（05 §2）。SQL 细节收在这一层，服务层只管调用。
 * 读出的值类型是 unknown：窗口位置该长什么样由服务层用 Zod 校验，
 * 这层不做主——数据库里存过什么形状，只有用的人自己知道。
 */
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { appSettings } from './tables'

/**
 * 读一个设置项。
 * @param db 数据库连接
 * @param key 设置项的名字
 * @returns 解析后的 JSON 值；没有这一项返回 undefined
 */
export function readSetting(db: BetterSQLite3Database, key: string): unknown {
  const row = db.select().from(appSettings).where(eq(appSettings.key, key)).get()
  if (!row) return undefined
  return JSON.parse(row.valueJson)
}

/**
 * 写一个设置项：没有就插入，有就整体替换（同键覆盖）。
 * 为什么用 ON CONFLICT 而不是「先查再决定插还是改」：查完到动手之间有条缝，
 * 两次并发写同一键可能各插一行（主键会拦，但结果是写入失败）；ON CONFLICT
 * 把「撞键就改为更新」交给数据库在一步内完成，没有缝。
 * @param db 数据库连接
 * @param key 设置项的名字
 * @param value 要存的值（任意可转成 JSON 的东西）
 */
export function writeSetting(db: BetterSQLite3Database, key: string, value: unknown): void {
  const valueJson = JSON.stringify(value)
  const now = Date.now()
  db.insert(appSettings)
    .values({ key, valueJson, updatedAt: now })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { valueJson, updatedAt: now },
    })
    .run()
}
