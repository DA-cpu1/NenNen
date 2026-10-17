/**
 * 数据库里的表，在这里用 TypeScript 描述一遍（Drizzle 的用法：它照着这份
 * 描述生成类型安全的读写代码——字段名打错，编辑器直接红线，不用等运行时才炸）。
 * 结构和 docs/sdd/schema.sql 样稿保持一致。
 * 目前只定义了 app_state 一张：其余表跟着各自的功能任务再加，
 * 一次铺 15 张只会留下一堆没人用、没法验证的死代码。
 */
import { integer, sqliteTable } from 'drizzle-orm/sqlite-core'

/** 「共享记忆版本」表：整个库只有一行、一个数字，像电梯里的检修标签——
 *  用户改了跨角色共享的资料，数字就 +1；后台任务看到数字变了，
 *  就知道自己手里的旧共享信息作废、要重新取（05 §4） */
export const appState = sqliteTable('app_state', {
  id: integer('id').primaryKey(),
  /** 共享记忆的版本号，从 0 开始，改一次共享资料 +1 */
  globalMemoryEpoch: integer('global_memory_epoch').notNull().default(0),
})
