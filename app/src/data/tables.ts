/**
 * 数据库里的表，在这里用 TypeScript 描述一遍（Drizzle 的用法：它照着这份
 * 描述生成类型安全的读写代码——字段名打错，编辑器直接红线，不用等运行时才炸）。
 * 结构和 docs/sdd/schema.sql 样稿保持一致。
 * 表跟着各自的功能任务再加，一次铺 15 张只会留下一堆没人用、没法验证的死代码。
 */
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** 「共享记忆版本」表：整个库只有一行、一个数字，像电梯里的检修标签——
 *  用户改了跨角色共享的资料，数字就 +1；后台任务看到数字变了，
 *  就知道自己手里的旧共享信息作废、要重新取（05 §4） */
export const appState = sqliteTable('app_state', {
  id: integer('id').primaryKey(),
  /** 共享记忆的版本号，从 0 开始，改一次共享资料 +1 */
  globalMemoryEpoch: integer('global_memory_epoch').notNull().default(0),
})

/** 「应用设置」表：键 → JSON 值 的杂项抽屉，存窗口位置这类非机密设置
 *  （05 §2）。机密（模型密钥等）绝不放这里——这张表会随备份导出（T11） */
export const appSettings = sqliteTable('app_settings', {
  /** 设置项的名字，如 petWindow；同键只有一行 */
  key: text('key').primaryKey(),
  /** 值按 JSON 文本存放：读出来再解析回对象/数字 */
  valueJson: text('value_json').notNull(),
  /** 最后写入时间（UTC 毫秒数字，05 §1） */
  updatedAt: integer('updated_at').notNull(),
})

/** 「角色」表：一个角色一行，相当于角色的户口本首页——ID、名字、
 *  两张图片路径，外加 memory_epoch（这个角色私有记忆的版本号）。
 *  版本号的作用：该角色的记忆被改动（比如用户纠正了称呼）时数字 +1，
 *  后台整理任务看到数字变了，就知道手里那份旧记忆清单作废、要重新取
 *  （05 §4）。它和 app_state 的共享版本各管各的范围，不能互相顶替 */
export const characters = sqliteTable('characters', {
  /** 程序生成的不重复字符串 ID。不用自增数字：恢复备份、合并数据时
   *  数字容易撞车，随机字符串撞上的概率约等于零（05 §1） */
  id: text('id').primaryKey(),
  /** 角色名字，聊天窗口标题显示用 */
  name: text('name').notNull(),
  /** 桌面形象（Q 版小人）图片路径；还没拿到正式图片时为空——
   *  「资源待定」是合法状态，不拿概念图凑数（05 §8） */
  desktopImagePath: text('desktop_image_path'),
  /** 聊天窗口头像图片路径，同样可为空 */
  portraitImagePath: text('portrait_image_path'),
  /** 该角色私有记忆的版本号，从 0 开始，记忆变动 +1 */
  memoryEpoch: integer('memory_epoch').notNull().default(0),
  /** 创建时间（UTC 毫秒数字，05 §1） */
  createdAt: integer('created_at').notNull(),
  /** 最后更新时间 */
  updatedAt: integer('updated_at').notNull(),
})

/** 「人设版本」表：角色设定不是只留一份，而是像文档的修订历史——
 *  每次编辑新增一行（版本号 1、2、3……），从不覆盖旧行。留历史的原因：
 *  旧聊天记录当时用的旧人设永远能查回「她当时是这个性格」，出质量
 *  问题时也能对照上一版找原因（模型运行记录会存当时用的版本 ID）。
 *  同一角色同一时刻只允许一行 is_active=1（当前生效），由数据库里
 *  名为 one_active_character_version 的部分唯一索引强制——程序写漏了
 *  检查，想同时激活两版，数据库也会当场报错兜底 */
export const characterVersions = sqliteTable('character_versions', {
  /** 这个人设版本的独立 ID */
  id: text('id').primaryKey(),
  /** 属于哪个角色（外键指向 characters.id）：删角色时这些版本
   *  随之一起删，不留没有主人的孤儿行 */
  characterId: text('character_id')
    .notNull()
    .references(() => characters.id, { onDelete: 'cascade' }),
  /** 人设第几版：同一角色内从 1 递增，同一角色同一版本号只许一行（UNIQUE 约束） */
  versionNo: integer('version_no').notNull(),
  /** 人设正文：性格、说话方式的完整描述。T03 写好的角色卡将来放这里 */
  personaText: text('persona_text').notNull(),
  /** 初始关系设定（如「恋人」），来自角色卡的关系部分 */
  initialRelationship: text('initial_relationship').notNull(),
  /** 对话示例，JSON 数组文本：组装提示词时给模型看「她习惯怎么说话」 */
  dialogueExamplesJson: text('dialogue_examples_json').notNull().default('[]'),
  /** 是否当前生效：1 是、0 否；同一角色最多一行 1（见表注释里的唯一索引） */
  isActive: integer('is_active').notNull().default(0),
  /** 这版人设的创建时间（UTC 毫秒数字） */
  createdAt: integer('created_at').notNull(),
})
