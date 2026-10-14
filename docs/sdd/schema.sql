-- 桌面陪伴角色：SQLite 结构样稿 v0.1
-- 仅用于新建空库设计验证。生产使用带版本的 Drizzle 迁移。
-- UTC 毫秒由应用写入；JSON 内容由 Zod 检查。
PRAGMA foreign_keys = ON;

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

CREATE TABLE app_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  global_memory_epoch INTEGER NOT NULL DEFAULT 0 CHECK (global_memory_epoch >= 0)
);
INSERT INTO app_state (id) VALUES (1);

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

CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('character','global')),
  character_id TEXT REFERENCES characters(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('fact','preference','episode','temporary','interaction_request')),
  memory_key TEXT,
  content TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('user_explicit','conversation_event','user_edit')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','expired','deleted')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  supersedes_id TEXT REFERENCES memories(id) ON DELETE SET NULL,
  valid_from INTEGER NOT NULL,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((scope = 'character' AND character_id IS NOT NULL) OR (scope = 'global' AND character_id IS NULL)),
  CHECK (expires_at IS NULL OR expires_at >= valid_from),
  CHECK ((status = 'deleted' AND content = '') OR (status <> 'deleted' AND length(trim(content)) > 0))
);
CREATE UNIQUE INDEX one_active_character_memory_key
  ON memories(character_id, memory_key)
  WHERE scope = 'character' AND status = 'active' AND memory_key IS NOT NULL;
CREATE UNIQUE INDEX one_active_global_memory_key
  ON memories(memory_key)
  WHERE scope = 'global' AND status = 'active' AND memory_key IS NOT NULL;
CREATE INDEX memories_lookup ON memories(scope, character_id, status, kind, updated_at);

CREATE TABLE memory_sources (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  PRIMARY KEY (memory_id, message_id)
);
CREATE INDEX sources_by_message ON memory_sources(message_id);

CREATE TABLE context_exclusions (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('forgotten','source_removed','user_excluded')),
  created_at INTEGER NOT NULL,
  UNIQUE (message_id, reason)
);

CREATE TABLE memory_jobs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  start_seq INTEGER NOT NULL CHECK (start_seq > 0),
  end_seq INTEGER NOT NULL CHECK (end_seq >= start_seq),
  character_epoch INTEGER NOT NULL,
  global_epoch INTEGER NOT NULL,
  context_epoch INTEGER NOT NULL,
  extractor_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed','stale','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at INTEGER NOT NULL,
  lease_until INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (conversation_id, start_seq, end_seq, character_epoch, global_epoch, context_epoch, extractor_version)
);
CREATE INDEX jobs_ready ON memory_jobs(status, available_at);

CREATE TABLE conversation_summaries (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  start_seq INTEGER NOT NULL,
  end_seq INTEGER NOT NULL CHECK (end_seq >= start_seq),
  content TEXT NOT NULL,
  context_epoch INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','invalid')),
  created_at INTEGER NOT NULL
);

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

CREATE TABLE proactive_events (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  scheduled_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','evaluating','skipped','silent','dispatched','failed')),
  reason_code TEXT,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (character_id, scheduled_at)
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

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
