/**
 * 数据库里的表，在这里用 TypeScript 描述一遍（Drizzle 的用法：它照着这份
 * 描述生成类型安全的读写代码——字段名打错，编辑器直接红线，不用等运行时才炸）。
 * 结构和 docs/sdd/schema.sql 样稿保持一致。
 * 表跟着各自的功能任务再加，一次铺 15 张只会留下一堆没人用、没法验证的死代码。
 */
import { integer, sqliteTable, text, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core'

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

/** 「会话」表：一段连续聊天的「容器」。首版每个角色只有一条 mode='normal'
 *  的正式会话（服务层初始化时保证，见 T04 初始化函数），试聊走独立的
 *  preview 会话、绝不写正式记忆（05 §3）。runtime_session_id 存的是 eve
 *  框架那边的会话 ID，和本表自己的 id（应用会话 ID）是两回事：前者只是
 *  联系方式，换框架、清运行缓存后可以换成新的；用户看到的「同一段聊天」
 *  由后者决定，换联系方式时不变（04 §3） */
export const conversations = sqliteTable('conversations', {
  /** 应用自己的会话 ID，程序生成的不重复字符串 */
  id: text('id').primaryKey(),
  /** 这段聊天属于哪个角色（外键：删角色时会话一起删） */
  characterId: text('character_id')
    .notNull()
    .references(() => characters.id, { onDelete: 'cascade' }),
  /** 会话类型：normal 正式聊天 / preview 试聊。数据库 CHECK 只认这两个值 */
  mode: text('mode').notNull().default('normal'),
  /** eve 框架的会话 ID，可空可换：它只是「当前用哪个框架会话」的便签，
   *  丢了重建即可，不当作聊天记录的依据（05 §1） */
  runtimeSessionId: text('runtime_session_id'),
  /** 该会话「可用内容」的版本号：忘记、排除来源时 +1，依赖旧内容的
   *  后台整理任务看到数字变了就作废（05 §4） */
  contextEpoch: integer('context_epoch').notNull().default(0),
  /** 已整理到第几条消息：后台记忆整理的「进度书签」，T07 使用 */
  lastProcessedSeq: integer('last_processed_seq').notNull().default(0),
  /** 会话创建时间（UTC 毫秒数字） */
  createdAt: integer('created_at').notNull(),
  /** 最后一条消息的时间：按「最近聊过」排序会话时用 */
  lastMessageAt: integer('last_message_at').notNull(),
})

/** 「消息」表：会话里逐条的消息原文——用户的话、角色的回复、主动问候，
 *  都按顺序存在这张表里。防重的关键在 client_request_id：界面给每次用户
 *  输入配一个唯一编号，网络卡了用户连点重试时，同一个编号的第二条插不
 *  进来（数据库 UNIQUE 约束兜底），做到「重试不重复写」（05 §5） */
export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  /** 属于哪段会话（外键：删会话时消息一起删） */
  conversationId: text('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  /** 会话内的顺序号（第 1 条、第 2 条……），同一会话内不许重复 */
  seq: integer('seq').notNull(),
  /** 谁说的：user 用户 / assistant 角色回复 / proactive 主动问候 */
  role: text('role').notNull(),
  /** 消息正文 */
  content: text('content').notNull(),
  /** 完成状态：pending 等待中 / streaming 生成中 / completed 完成 /
   *  cancelled 已取消 / failed 失败（流式回复中断时就停在中间状态） */
  status: text('status').notNull(),
  /** 界面生成的唯一请求编号，重试沿用同一个号防重复；角色消息没有编号，
   *  留空。SQLite 的唯一约束不理会空值，多条角色消息同时为空不冲突 */
  clientRequestId: text('client_request_id'),
  /** 本条回复关联的上一条消息（如主动问候标注它回应的语境），可为空。
   *  自引用（引用同表的 id），写法上要延迟取值，见 AnySQLiteColumn */
  replyToId: text('reply_to_id').references((): AnySQLiteColumn => messages.id, {
    onDelete: 'set null',
  }),
  /** 是否已排除出模型上下文：忘记某事后相关原文不再发给模型，但历史
   *  记录里仍保留这行（只打标记，不删行），T08 使用（05 §6） */
  excludedFromContext: integer('excluded_from_context').notNull().default(0),
  createdAt: integer('created_at').notNull(),
})

/** 「主动陪伴设置」表：每个角色一行，管她什么时候可以主动开口——
 *  开关、间隔、免打扰时段、时区、每天次数上限（05 §2）。默认总开关
 *  关闭（enabled=0）：用户没主动打开就绝不打扰（02）。主动互动的完整
 *  流程是 T10 的活，这张表先由角色初始化函数建出默认行 */
export const companionSettings = sqliteTable('companion_settings', {
  /** 属于哪个角色。一个角色只有一行设置，直接拿角色 ID 当主键，
   *  不另发号——找设置时不用多记一个 ID */
  characterId: text('character_id')
    .primaryKey()
    .references(() => characters.id, { onDelete: 'cascade' }),
  /** 主动陪伴总开关：0 关 1 开，默认关 */
  enabled: integer('enabled').notNull().default(0),
  /** 两次检查之间的间隔（分钟），最短不许低于 15 */
  intervalMinutes: integer('interval_minutes').notNull().default(120),
  /** 免打扰时段开始：当天第几分钟（1380 = 23:00），跨午夜到结束点 */
  quietStartMinute: integer('quiet_start_minute').notNull().default(1380),
  /** 免打扰时段结束：当天第几分钟（480 = 8:00） */
  quietEndMinute: integer('quiet_end_minute').notNull().default(480),
  /** 免打扰开关，默认开——宁可少说话，不半夜吵人 */
  quietEnabled: integer('quiet_enabled').notNull().default(1),
  /** 用户时区名（如 Asia/Shanghai）：主动消息按用户当地作息算，不按 UTC */
  timezone: text('timezone').notNull(),
  /** 每天最多评估几次（评估=问一次模型「现在要不要说句话」） */
  dailyEvalLimit: integer('daily_eval_limit').notNull().default(6),
  /** 每天最多真发几次 */
  dailySendLimit: integer('daily_send_limit').notNull().default(4),
  /** 下次该检查主动开口的时间（UTC 毫秒），没启用时为空 */
  nextDueAt: integer('next_due_at'),
  /** 上次真的发出主动消息的时间（UTC 毫秒） */
  lastSentAt: integer('last_sent_at'),
  /** 最后更新时间（UTC 毫秒数字） */
  updatedAt: integer('updated_at').notNull(),
})

/** 「工具操作」表：模型调工具（记住/纠正/忘记）时的「回执登记簿」。
 *  每次操作登记一行；operation_key 是「同一件事」的编号——同一个请求
 *  重试、网络重放都带同一个 key，数据库 UNIQUE 拦下第二次，已成功的
 *  重复到达直接返回第一次的结果，做到「重试不重复写」（05 §5） */
export const toolOperations = sqliteTable('tool_operations', {
  id: text('id').primaryKey(),
  /** 在哪段会话里发生的（外键：删会话时登记一起删） */
  conversationId: text('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  /** 触发这次操作的消息（比如用户那句「记住我叫阿达」），可为空 */
  requestMessageId: text('request_message_id').references(() => messages.id, {
    onDelete: 'set null',
  }),
  /** 同一语义操作的唯一编号：程序拼接（会话+消息+工具+目标），不是随机数
   *  ——随机数每次都不同，起不到「认出是同一件事」的作用（05 §5） */
  operationKey: text('operation_key').notNull(),
  /** 工具名：remember_explicit / correct_memory / forget_memory 等（04 §4） */
  toolName: text('tool_name').notNull(),
  /** 操作对象（比如目标记忆的 ID），可为空 */
  targetId: text('target_id'),
  /** 执行状态：pending 执行中 / committed 已成功落库 / failed 失败。
   *  注意没有「已取消」——取消的操作停在 pending，重试时重新执行 */
  status: text('status').notNull(),
  /** 成功时的结果（JSON 文本）：重复到达同一编号时原样返回它 */
  resultJson: text('result_json'),
  /** 失败时的错误码（04 §4 的 INVALID_INPUT 等）；只存码，
   *  不复制正文——忘记操作的结果里不该残留被忘记的内容（05 §6） */
  errorCode: text('error_code'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})
