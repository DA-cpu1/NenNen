/**
 * 解决"用户升级软件那天"的问题：
 * 老用户库文件还是旧结构，新版程序要新结构，又绝不能删库重来
 * （删了 = 聊天记录全丢）。做法：每次结构变更写成一张带编号的"装修单"；
 * 数据库里放一本"装修记录本"（schema_migrations 表）；
 * 程序启动时翻记录本，把没做过的单子补做掉。
 *
 * 为什么不能每张表都写 CREATE TABLE IF NOT EXISTS 凑合？它对已存在的旧表
 * 什么都不做——新加的列、改的约束统统不生效，等于没升级（05 §1）。
 */
import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'

/** 一张"装修单"。规矩：version 编号只增不减；已发布的单子绝不修改，
 * 要改就追加新单子（原因见下面的指纹校验：改旧单会让老用户的库对不上账）。
 * sql 是施工内容，会被整体包进一个"事务"里执行——事务的意思是：
 * 里面所有操作要么全做成、要么全部当作没发生 */
export interface Migration {
  version: number
  /** 人看的施工说明，便于排查问题 */
  summary: string
  /** 可执行的多条 SQL */
  sql: string
}

/** 装修单清单：只允许往末尾追加，不允许插入或修改 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    summary: '初始结构：app_state 单行共享版本表',
    sql: `
CREATE TABLE app_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  global_memory_epoch INTEGER NOT NULL DEFAULT 0 CHECK (global_memory_epoch >= 0)
);
INSERT INTO app_state (id) VALUES (1);
`,
  },
  {
    version: 2,
    summary: '应用设置表 app_settings：键值对存窗口位置等非机密设置（05 §2）',
    sql: `
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`,
  },
  {
    version: 3,
    summary:
      '角色域两表：characters 角色入口 + character_versions 人设历史（T04，05 §2）',
    sql: `
CREATE TABLE characters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  desktop_image_path TEXT,
  portrait_image_path TEXT,
  memory_epoch INTEGER NOT NULL DEFAULT 0 CHECK (memory_epoch >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE character_versions (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL CHECK (version_no > 0),
  persona_text TEXT NOT NULL,
  initial_relationship TEXT NOT NULL,
  dialogue_examples_json TEXT NOT NULL DEFAULT '[]',
  is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0,1)),
  created_at INTEGER NOT NULL,
  UNIQUE (character_id, version_no)
);
CREATE UNIQUE INDEX one_active_character_version
  ON character_versions(character_id) WHERE is_active = 1;
`,
  },
  {
    version: 4,
    summary:
      '会话域两表：conversations 聊天容器 + messages 消息原文，含请求编号防重约束（T04，05 §2/§5）',
    sql: `
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'normal' CHECK (mode IN ('normal','preview')),
  runtime_session_id TEXT,
  context_epoch INTEGER NOT NULL DEFAULT 0,
  last_processed_seq INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_message_at INTEGER NOT NULL
);
CREATE INDEX conversations_by_character ON conversations(character_id, last_message_at);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq > 0),
  role TEXT NOT NULL CHECK (role IN ('user','assistant','proactive')),
  content TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','streaming','completed','cancelled','failed')),
  client_request_id TEXT,
  reply_to_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  excluded_from_context INTEGER NOT NULL DEFAULT 0 CHECK (excluded_from_context IN (0,1)),
  created_at INTEGER NOT NULL,
  UNIQUE (conversation_id, seq),
  UNIQUE (conversation_id, client_request_id)
);
`,
  },
  {
    version: 5,
    summary:
      '工具与设置两表：companion_settings 主动陪伴规则 + tool_operations 操作防重登记（T04，05 §2/§5）',
    sql: `
CREATE TABLE companion_settings (
  character_id TEXT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  interval_minutes INTEGER NOT NULL DEFAULT 120 CHECK (interval_minutes >= 15),
  quiet_start_minute INTEGER NOT NULL DEFAULT 1380 CHECK (quiet_start_minute BETWEEN 0 AND 1439),
  quiet_end_minute INTEGER NOT NULL DEFAULT 480 CHECK (quiet_end_minute BETWEEN 0 AND 1439),
  quiet_enabled INTEGER NOT NULL DEFAULT 1 CHECK (quiet_enabled IN (0,1)),
  timezone TEXT NOT NULL,
  daily_eval_limit INTEGER NOT NULL DEFAULT 6 CHECK (daily_eval_limit >= 0),
  daily_send_limit INTEGER NOT NULL DEFAULT 4 CHECK (daily_send_limit >= 0),
  next_due_at INTEGER,
  last_sent_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE tool_operations (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  request_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  operation_key TEXT NOT NULL UNIQUE,
  tool_name TEXT NOT NULL,
  target_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','committed','failed')),
  result_json TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`,
  },
  {
    version: 6,
    summary:
      '人设版本表加两列：user_nickname 称呼设定（01 R05 编辑项）+ save_request_id 保存防重编号（T05，05 §5）',
    sql: `
ALTER TABLE character_versions ADD COLUMN user_nickname TEXT;
ALTER TABLE character_versions ADD COLUMN save_request_id TEXT;
CREATE UNIQUE INDEX one_save_request_per_character
  ON character_versions(character_id, save_request_id);
`,
  },
  {
    version: 7,
    summary:
      '模型运行记录表 agent_runs：每次模型调用的用量/耗时/错误与所用版本（T06，05 §2）',
    sql: `
CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  character_version_id TEXT REFERENCES character_versions(id) ON DELETE SET NULL,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('chat','memory','proactive','preview')),
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','completed','failed','cancelled')),
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  usage_estimated INTEGER NOT NULL DEFAULT 0 CHECK (usage_estimated IN (0,1)),
  error_code TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX runs_for_budget ON agent_runs(trigger_type, started_at);
`,
  },
]

/** 给一份 SQL 算"指纹"（sha256）：同样的内容永远得到同一串字符，
 * 改一个标点指纹就整个变。用来发现"单子被事后改过" */
function checksumOf(sql: string): string {
  return createHash('sha256').update(sql).digest('hex')
}

/**
 * 翻记录本、补做没做过的装修单。
 * @param sqlite 已打开的数据库连接
 * @param migrations 装修单清单；测试可以传自定义清单进来，正常调用用默认的
 * @throws 两道关卡任何一道过不去都抛错（见循环内注释），调用方必须停止写入
 */
export function runMigrations(
  sqlite: Database.Database,
  migrations: Migration[] = MIGRATIONS,
): void {
  // 先把"装修记录本"立起来。全文件只有这里允许 IF NOT EXISTS：
  // 记录本自己没法用单子来建（先有本子才能记单子，鸡生蛋），
  // 而且它只记"做过哪几号单"，不装任何用户数据，所以裸建无害
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
`)

  const applied = sqlite
    .prepare('SELECT version, checksum FROM schema_migrations ORDER BY version')
    .all() as Array<{ version: number; checksum: string }>

  // 逐条核对记录本，两道关卡
  for (const row of applied) {
    const known = migrations.find((m) => m.version === row.version)
    if (!known) {
      // 关卡 A：记录本上有张我不认识的单子 → 这个库比当前程序还新。
      // 场景：用户装了新版又回滚旧版。旧程序不知道新单子改了什么，
      // 硬跑会把新库写坏——所以宁可拒绝启动写入（05 §7）
      throw new Error(`数据库包含未知迁移版本 ${row.version}，程序版本过旧，拒绝写入`)
    }
    if (checksumOf(known.sql) !== row.checksum) {
      // 关卡 B：编号认识，但内容指纹对不上 → 有人改过已发布的旧单子。
      // 后果：不同用户的库都"做过 1 号单"，实际内容却不一样，排查时对不上账
      throw new Error(`迁移 ${row.version} 的脚本与已应用版本不一致，拒绝写入`)
    }
  }

  // 挑出没做过的单子逐个补做。关键：施工（建表）和记账（登记版本号）
  // 绑在同一个事务里。不绑会出现两种撕裂——
  // 表建了没记账：下次启动重做这张单，撞上已存在的表，程序起不来；
  // 记了账没建表：程序以为自己是最新，用到那张表时才炸，炸得最难查
  const pending = migrations.filter((m) => !applied.some((a) => a.version === m.version))
  const insertRecord = sqlite.prepare(
    'INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)',
  )
  for (const migration of pending) {
    // transaction(fn) 只是把 fn 打包成"原子函数"，此刻还没执行；
    // 调用它（下一行）才真正在事务里跑
    const apply = sqlite.transaction(() => {
      sqlite.exec(migration.sql)
      // 记"何时做过"：统一存数字（毫秒），显示时才转成人看得懂的时间（05 §1）
      insertRecord.run(migration.version, checksumOf(migration.sql), Date.now())
    })
    apply()
  }
}
