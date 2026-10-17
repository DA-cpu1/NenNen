/**
 * 负责「打开数据库文件」这件事——全项目只有这一个入口。
 *
 * 为什么要收拢成一个入口？用户的聊天记录、角色记忆全都存在一个 SQLite
 * 文件里（SQLite：把整套数据库装进一个普通文件的技术）。开门时要带两道
 * 保险（见函数里两行 pragma）。如果各模块自己开门，只要有一处忘了带保险，
 * 坏数据就从那个口子溜进去了。全项目只走这一个函数，保险一处也不会漏。
 * 文件路径由调用方传入（将来传 Electron 给的用户数据目录），这里不写死。
 */
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

/** 一个打开的数据库连接：两样东西打包在一起 */
export interface CompanionDb {
  /** 原生连接——真正干活的"司机"。建表、改设置这类直接说 SQL 的事找它 */
  sqlite: Database.Database
  /** Drizzle 查询对象——站在司机上面的"翻译"。日常读写用它，字段打错编辑器会红线 */
  db: BetterSQLite3Database
  /** 关闭连接；程序退出时调用，不关的话文件会被一直占用 */
  close(): void
}

/**
 * 打开（文件不存在就新建）数据库，并带上两道保险。
 * @param path 数据库文件的完整路径
 * @returns 连接句柄
 */
export function openCompanionDatabase(path: string): CompanionDb {
  const sqlite = new Database(path)
  // 保险一：WAL 模式。不开的话，后台写数据的那一瞬间界面读数据会被挡住，
  // 表现就是聊天窗口时不时卡一下。开了之后，写入先记到旁边的小本子文件里，
  // 读的人永远看完整稳定的主文件——读写互不阻塞（05 §1）
  sqlite.pragma('journal_mode = WAL')
  // 保险二：外键检查。比如某条记录写着「我的依据是消息 #52」——开了它，
  // 删掉消息 #52 时数据库会当场拒绝留下这种指向空号的记录，错误立刻暴露，
  // 而不是几个月后数据悄悄烂掉。SQLite 为了兼容老项目默认把它关着，而且
  // 每个连接各自开关——所以必须在这唯一的入口打开（05 §1）
  sqlite.pragma('foreign_keys = ON')
  return {
    sqlite,
    db: drizzle(sqlite),
    close: () => sqlite.close(),
  }
}
