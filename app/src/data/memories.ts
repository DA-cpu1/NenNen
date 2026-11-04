/** 从 SQLite 读取当前可用记忆，并把私有记忆、原话来源和版本一起写入。 */
import { randomUUID } from 'node:crypto'
import { and, desc, eq, gt, inArray, isNull, lte, or } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { bumpCharacterMemoryEpoch } from './epochs'
import { conversations, memories, memorySources, messages } from './tables'

/** 从数据库读出的记忆，含检索和检查旧版本所需的属性。 */
export type Memory = typeof memories.$inferSelect

/** 记忆的类别，供工具和整理任务共用。 */
export const memoryKinds = ['fact', 'preference', 'episode', 'temporary', 'interaction_request'] as const

/** 私有记忆的写入参数。调用方从会话和原话确定归属与来源。 */
export interface SaveCharacterMemoryInput {
  conversationId: string
  kind: typeof memoryKinds[number]
  memoryKey: string | null
  content: string
  origin: 'user_explicit' | 'conversation_event'
  sourceMessageIds: readonly string[]
  expiresAt: number | null
  replacement?: { id: string; revision: number }
  now: number
}

/** 写入结果。碰到冲突或无效来源时，调用方可以直接报告失败。 */
export type SaveMemoryResult =
  | { status: 'saved' | 'already_saved'; memory: Memory }
  | { status: 'INVALID_INPUT' | 'SOURCE_NOT_ALLOWED' | 'STALE_REVISION' }

/**
 * 读取一个角色能使用的当前记忆。共享记录可见，其他角色的私有记录不可见。
 * @param db 后台数据库连接
 * @param characterId 由服务确认的当前角色编号
 * @param now 检查到期时间所用的毫秒时间戳
 * @returns 新到旧排列的有效记忆；同一时刻用编号稳定排序
 */
export function listCurrentMemories(db: BetterSQLite3Database, characterId: string, now: number): Memory[] {
  return db.select().from(memories).where(and(
    or(eq(memories.scope, 'global'), and(eq(memories.scope, 'character'), eq(memories.characterId, characterId))),
    eq(memories.status, 'active'), lte(memories.validFrom, now),
    or(isNull(memories.expiresAt), gt(memories.expiresAt, now)),
  )).orderBy(desc(memories.validFrom), desc(memories.id)).all()
}

/**
 * 写入一条私有记忆。事务让新值、旧状态、原话来源和版本号一起成功或一起撤回。
 * @param db 后台数据库连接，也可由外层整理事务传入
 * @param input 已挑选的内容、正式会话、来源和可选的待替换记录版本
 * @returns 写入后的记忆、重复请求已有的记忆，或具体拒绝原因
 */
export function saveCharacterMemory(db: BetterSQLite3Database, input: SaveCharacterMemoryInput): SaveMemoryResult {
  const { now, kind, origin, expiresAt, replacement } = input
  const content = input.content.trim()
  const memoryKey = input.memoryKey?.trim() ?? null
  if (!content || memoryKey === '' || (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt <= now))) {
    return { status: 'INVALID_INPUT' }
  }

  return db.transaction((tx) => {
    const conversation = tx.select().from(conversations).where(eq(conversations.id, input.conversationId)).get()
    const sourceIds = [...new Set(input.sourceMessageIds)]
    if (conversation?.mode !== 'normal' || sourceIds.length === 0) return { status: 'SOURCE_NOT_ALLOWED' }

    // 例如试聊也能生成消息编号。只检查编号存在，会把试聊原话误存成正式记忆。
    const sources = tx.select({ role: messages.role }).from(messages).where(and(
      inArray(messages.id, sourceIds), eq(messages.conversationId, conversation.id),
      eq(messages.status, 'completed'), eq(messages.excludedFromContext, 0),
    )).all()
    if (sources.length !== sourceIds.length || !sources.some((source) => source.role === 'user') ||
        sources.some((source) => source.role !== 'user' && !(kind === 'episode' && source.role === 'assistant'))) {
      return { status: 'SOURCE_NOT_ALLOWED' }
    }

    const active = tx.select().from(memories).where(and(
      eq(memories.scope, 'character'), eq(memories.characterId, conversation.characterId), eq(memories.status, 'active'),
      memoryKey === null ? isNull(memories.memoryKey) : eq(memories.memoryKey, memoryKey),
      replacement ? eq(memories.id, replacement.id) : undefined,
      memoryKey === null && !replacement
        ? and(eq(memories.kind, kind), eq(memories.content, content), or(isNull(memories.expiresAt), gt(memories.expiresAt, now)))
        : undefined,
    )).get()
    const expired = active?.expiresAt != null && active.expiresAt <= now
    if (replacement && (!active || expired || active.id !== replacement.id || active.revision !== replacement.revision)) {
      return { status: 'STALE_REVISION' }
    }
    if (active && !expired && active.content === content && active.kind === kind &&
        (!replacement || active.expiresAt === expiresAt)) {
      return { status: 'already_saved', memory: active }
    }
    if (active && !expired && !replacement) return { status: 'STALE_REVISION' }

    // 到期的旧值仍占着「当前称呼」这类唯一位置。先释放位置，再写入；中途失败会一起撤回。
    if (active) {
      tx.update(memories).set({ status: expired ? 'expired' : 'superseded', revision: active.revision + 1, updatedAt: now })
        .where(eq(memories.id, active.id)).run()
    }
    const memory = tx.insert(memories).values({
      id: `mem-${randomUUID()}`, scope: 'character', characterId: conversation.characterId,
      kind, memoryKey, content, origin, validFrom: now, expiresAt,
      supersedesId: replacement?.id ?? null, createdAt: now, updatedAt: now,
    }).returning().get()
    tx.insert(memorySources).values(sourceIds.map((messageId) => ({ memoryId: memory.id, messageId }))).run()
    bumpCharacterMemoryEpoch(tx, conversation.characterId)
    return { status: 'saved', memory }
  })
}
