// 只验证规格完整性和内存数据库结构，不是产品功能测试。
// 运行：node docs/sdd/validate-spec.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const root = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(root);
const markdown = files.filter(name => name.endsWith('.md'));
let links = 0;
for (const name of markdown) {
  const text = readFileSync(resolve(root, name), 'utf8');
  const fences = text.match(/^```/gm) ?? [];
  assert.equal(fences.length % 2, 0, `${name} 的代码块未闭合`);
  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (/^(https?:|#)/.test(target)) continue;
    readFileSync(resolve(root, target.split('#')[0]));
    links++;
  }
}

const requirements = readFileSync(resolve(root, '01-需求说明.md'), 'utf8');
const trace = readFileSync(resolve(root, '07-验收与需求对应表.md'), 'utf8');
const tasks = readFileSync(resolve(root, '06-开发执行计划.md'), 'utf8');
for (let i = 1; i <= 18; i++) {
  const id = `R${String(i).padStart(2, '0')}`;
  assert(requirements.includes(`| ${id} |`), `缺需求 ${id}`);
  assert(trace.includes(`| ${id} `), `缺验收对应 ${id}`);
}
for (let i = 1; i <= 16; i++) {
  const id = `T${String(i).padStart(2, '0')}`;
  assert(tasks.includes(`| ${id} |`), `缺任务 ${id}`);
}

const db = new DatabaseSync(':memory:');
db.exec(readFileSync(resolve(root, 'schema.sql'), 'utf8'));
const tableCount = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get().n;
assert.equal(tableCount, 16);
let checks = 0;
function mustReject(sql, label) {
  db.exec('SAVEPOINT invalid_input');
  try { assert.throws(() => db.exec(sql), undefined, label); checks++; }
  finally { db.exec('ROLLBACK TO invalid_input; RELEASE invalid_input'); }
}
db.exec(`
  INSERT INTO characters(id,name,created_at,updated_at) VALUES('a','角色甲',0,0),('b','角色乙',0,0);
  INSERT INTO character_versions(id,character_id,version_no,persona_text,initial_relationship,is_active,created_at)
    VALUES('v1','a',1,'性格','熟悉伙伴',1,0);
  INSERT INTO conversations(id,character_id,created_at,last_message_at) VALUES('c','a',0,0);
  INSERT INTO messages(id,conversation_id,seq,role,content,status,client_request_id,created_at)
    VALUES('u','c',1,'user','以后叫我阿达','completed','request-1',0);
  INSERT INTO memories(id,scope,character_id,kind,memory_key,content,origin,valid_from,created_at,updated_at)
    VALUES('m1','character','a','preference','preferred_name','阿达','user_explicit',0,0,0);
  INSERT INTO memory_sources(memory_id,message_id) VALUES('m1','u');
`);
mustReject(`INSERT INTO character_versions(id,character_id,version_no,persona_text,initial_relationship,is_active,created_at)
 VALUES('v2','a',2,'性格','熟悉伙伴',1,0)`, '同角色不允许两个当前人设');
mustReject(`INSERT INTO memories(id,scope,character_id,kind,memory_key,content,origin,valid_from,created_at,updated_at)
 VALUES('m2','character','a','preference','preferred_name','小陈','user_explicit',0,0,0)`, '同角色有效属性唯一');
mustReject(`INSERT INTO memories(id,scope,character_id,kind,content,origin,valid_from,created_at,updated_at)
 VALUES('bad','global','a','fact','内容','user_edit',0,0,0)`, '共享范围与角色字段一致');
mustReject(`INSERT INTO memories(id,scope,character_id,kind,content,origin,valid_from,created_at,updated_at)
 VALUES('bad','character','unknown','fact','内容','user_edit',0,0,0)`, '角色外键有效');
mustReject(`UPDATE memories SET status='deleted' WHERE id='m1'`, '忘记标记必须清空正文');
mustReject(`INSERT INTO messages(id,conversation_id,seq,role,content,status,client_request_id,created_at)
 VALUES('u2','c',2,'user','重复','completed','request-1',0)`, '用户请求去重');
db.exec(`INSERT INTO memories(id,scope,character_id,kind,memory_key,content,origin,valid_from,created_at,updated_at)
 VALUES('mb','character','b','preference','preferred_name','小李','user_explicit',0,0,0)`);
checks++; // 不同角色可以有同名属性的不同值。
db.exec(`
  BEGIN;
  UPDATE memories SET status='superseded', revision=revision+1 WHERE id='m1';
  INSERT INTO memories(id,scope,character_id,kind,memory_key,content,origin,supersedes_id,valid_from,created_at,updated_at)
    VALUES('m2','character','a','preference','preferred_name','小陈','user_explicit','m1',1,1,1);
  COMMIT;
`);
assert.equal(db.prepare("SELECT content FROM memories WHERE character_id='a' AND status='active'").get().content, '小陈');
checks++;
db.exec(`INSERT INTO memories(id,scope,kind,memory_key,content,origin,valid_from,created_at,updated_at)
 VALUES('g','global','fact','name','姓名','user_edit',0,0,0)`);
mustReject(`INSERT INTO memories(id,scope,kind,memory_key,content,origin,valid_from,created_at,updated_at)
 VALUES('g2','global','fact','name','姓名2','user_edit',0,0,0)`, '共享有效属性唯一');
db.exec(`INSERT INTO memory_jobs(id,conversation_id,start_seq,end_seq,character_epoch,global_epoch,context_epoch,extractor_version,available_at,created_at,updated_at)
 VALUES('j','c',1,1,0,0,0,'1',0,0,0)`);
mustReject(`INSERT INTO memory_jobs(id,conversation_id,start_seq,end_seq,character_epoch,global_epoch,context_epoch,extractor_version,available_at,created_at,updated_at)
 VALUES('j2','c',1,1,0,0,0,'1',0,0,0)`, '同版本同批次唯一');
db.exec(`INSERT INTO proactive_events(id,character_id,scheduled_at,status,created_at,updated_at)
 VALUES('p','a',100,'pending',0,0)`);
mustReject(`INSERT INTO proactive_events(id,character_id,scheduled_at,status,created_at,updated_at)
 VALUES('p2','a',100,'pending',0,0)`, '主动机会去重');
assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
checks++;
db.close();
console.log(JSON.stringify({ status: '通过', markdownFiles: markdown.length, localLinks: links,
  requirements: 18, tasks: 16, schemaTables: tableCount, schemaChecks: checks,
  runtime: process.version, note: '仅结构及文档检查；未验证产品、Mermaid 渲染、eve 或安装包' }, null, 2));
