/** 把记忆修改、来源排除、旧任务失效和操作回执一起保存。 */
import { createHash, randomUUID } from 'node:crypto'
import { and, asc, desc, eq, gte, inArray, ne, or } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { bumpCharacterMemoryEpoch, bumpContextEpoch, bumpGlobalMemoryEpoch } from './epochs'
import type { Memory } from './memories'
import { characterVersions, contextExclusions, conversations, memories, memoryJobs, memorySources, messages } from './tables'
import { beginToolOperation, buildOperationKey, completeToolOperation } from './tool-ops'
import {
  memoryChangeReceiptSchema, memoryContentSchema, type ManagedMemory, type MemoryChangeReceipt,
  type MemoryDeletionPreview, type MemoryScope, type MemoryTarget,
} from '../shared/memory-management'

/** 新建由用户明确指定范围；删除原文必须确认。聊天操作只使用本轮已保存的用户原话。 */
export type MemoryMutation = { action: 'create'; scope: MemoryScope; content: string } | (MemoryTarget & (
  | { action: 'correct'; content: string }
  | { action: 'forget'; deleteSources: boolean; sourceFingerprint?: string }
))

/** 管理页与聊天工具都要说明是谁触发的操作，方便复用同一份回执。 */
export type MemoryMutationContext = { conversationId: string } & (
  | { requestId: string; requestMessageId?: never }
  | { requestMessageId: string; requestId?: never }
)

/** 事务完成后才允许服务发取消信号。回执可重用，重复请求不会再次改库。 */
export interface MemoryMutationResult {
  receipt: MemoryChangeReceipt
  conversationIds: string[]
}

/** 当前角色可管理自己的资料和共享资料，其他角色的私有资料不可见。 */
function visibleTo(characterId: string) {
  return or(eq(memories.scope, 'global'), eq(memories.characterId, characterId))
}

/**
 * 列出尚未忘记的当前与历史资料，并附原话供用户查看。
 * @param db 后台数据库连接
 * @param characterId 后台选定的角色
 * @param now 用于判断是否已过期的时间
 * @returns 管理页资料，按生效时间由近到远
 */
export function listManagedMemories(db: BetterSQLite3Database, characterId: string, now: number): ManagedMemory[] {
  const rows = db.select().from(memories).where(and(visibleTo(characterId), ne(memories.status, 'deleted')))
    .orderBy(desc(memories.validFrom), desc(memories.id)).all()
  const sources = db.select({ memoryId: memorySources.memoryId, id: messages.id, content: messages.content,
    createdAt: messages.createdAt, excluded: messages.excludedFromContext, seq: messages.seq,
    conversationId: messages.conversationId, sourceCharacter: conversations.characterId, mode: conversations.mode })
    .from(memorySources).innerJoin(memories, eq(memorySources.memoryId, memories.id))
    .innerJoin(messages, eq(memorySources.messageId, messages.id))
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(and(visibleTo(characterId), ne(memories.status, 'deleted'))).orderBy(asc(messages.createdAt)).all()
  const byMemory = new Map<string, ManagedMemory['sources']>()
  for (const { memoryId, excluded, seq, conversationId, sourceCharacter, mode, ...source } of sources) {
    const entry = byMemory.get(memoryId) ?? []
    // 可定位的范围只限当前角色的正式聊天。共享资料不会因此开放其他角色的会话。
    const location = sourceCharacter === characterId && mode === 'normal' ? { id: source.id, conversationId, seq } : undefined
    entry.push({ ...source, excluded: excluded === 1, location })
    byMemory.set(memoryId, entry)
  }
  return rows.map((row) => ({
    id: row.id, revision: row.revision, scope: row.scope, kind: row.kind, content: row.content,
    status: row.status === 'superseded' ? 'superseded'
      : row.status === 'expired' || (row.expiresAt !== null && row.expiresAt <= now) ? 'expired' : 'active',
    validFrom: row.validFrom, expiresAt: row.expiresAt, updatedAt: row.updatedAt,
    origin: row.origin, supersedesId: row.supersedesId, sources: byMemory.get(row.id) ?? [],
  }))
}

/** 纠正写一条新记录，旧值仍可按时间查看。 */
function correctMemory(db: BetterSQLite3Database, old: Memory, content: string, sourceId: string | undefined, now: number): Memory {
  db.update(memories).set({ status: 'superseded', revision: old.revision + 1, updatedAt: now })
    .where(eq(memories.id, old.id)).run()
  const corrected = db.insert(memories).values({
    id: `mem-${randomUUID()}`, characterId: old.characterId, scope: old.scope, kind: old.kind,
    memoryKey: old.memoryKey, content, origin: sourceId ? 'user_explicit' : 'user_edit',
    supersedesId: old.id, validFrom: now, expiresAt: old.expiresAt, createdAt: now, updatedAt: now,
  }).returning().get()
  if (sourceId) db.insert(memorySources).values({ memoryId: corrected.id, messageId: sourceId }).run()
  return corrected
}

/** 找同一属性的所有旧值。无属性键的经历则沿着「替代了哪一条」的连线找。 */
function memoryChain(all: Memory[], target: Memory): Memory[] {
  const ids = new Set([target.id])
  const linked = all.filter((row) => row.scope === target.scope && row.characterId === target.characterId)
  if (target.memoryKey !== null) return linked.filter((row) => row.memoryKey === target.memoryKey)
  // 反复沿链两端找，用户点中间那条时，新旧两头也要忘记。
  let before = 0
  while (before !== ids.size) {
    before = ids.size
    for (const row of linked) {
      if (row.supersedesId === null) continue
      if (ids.has(row.id)) ids.add(row.supersedesId)
      if (ids.has(row.supersedesId)) ids.add(row.id)
    }
  }
  return linked.filter((row) => ids.has(row.id))
}

/** 两条历史记忆可能引用同一句话，预览和删除都只处理一次。 */
function readChainSources(db: BetterSQLite3Database, chain: Memory[]) {
  const ids = chain.map(({ id }) => id)
  const sources = new Map<string, typeof messages.$inferSelect>()
  for (let start = 0; start < ids.length; start += 500) {
    const rows = db.select({ message: messages }).from(memorySources)
      .innerJoin(messages, eq(memorySources.messageId, messages.id))
      .where(inArray(memorySources.memoryId, ids.slice(start, start + 500))).all()
    for (const { message } of rows) sources.set(message.id, message)
  }
  return [...sources.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}

/** 内容指纹像一张名单的校验码，编号或原文有变化就要重新确认。 */
function deletionPreview(rows: ReturnType<typeof readChainSources>): MemoryDeletionPreview {
  const sources = rows.map(({ id, role, content, createdAt }) => ({ id, role, content, createdAt }))
  const sourceFingerprint = createHash('sha256').update(JSON.stringify(sources)).digest('hex')
  return { sources, sourceFingerprint }
}

/**
 * 预览目标及同属性旧值实际关联的原话。其他被排除的回复仍保留在聊天里。
 * @param db 后台数据库连接
 * @param characterId 由后台选定的角色
 * @param change 页面选定的记忆与修订号
 * @returns 待删除原话与用于再次核对的指纹
 */
export function previewMemoryDeletion(db: BetterSQLite3Database, characterId: string, change: MemoryTarget): MemoryDeletionPreview {
  return db.transaction((tx) => {
    const all = tx.select().from(memories).where(visibleTo(characterId)).all()
    const target = all.find((row) => row.id === change.memoryId)
    if (!target) throw new Error('NOT_FOUND')
    if (target.status === 'deleted' || target.revision !== change.expectedRevision) throw new Error('STALE_REVISION')
    return deletionPreview(readChainSources(tx, memoryChain(all, target)))
  })
}

/** 保留原文时，消息的快速过滤标记和排除理由一起写。 */
function excludeMessages(db: BetterSQLite3Database, ids: Set<string>, reason: 'forgotten' | 'source_removed', now: number): void {
  for (const messageId of ids) {
    db.update(messages).set({ excludedFromContext: 1 }).where(eq(messages.id, messageId)).run()
    db.insert(contextExclusions).values({ id: randomUUID(), messageId, reason, createdAt: now }).onConflictDoNothing().run()
  }
}

/** 按资料范围提升版本号，让受影响的正式聊天和未运行的整理任务丢掉旧上下文。 */
function invalidateMemoryContexts(
  db: BetterSQLite3Database, privateIds: Set<string>, sourceConversations: Set<string>, globalChanged: boolean, now: number,
): string[] {
  for (const id of privateIds) bumpCharacterMemoryEpoch(db, id)
  if (globalChanged) bumpGlobalMemoryEpoch(db)
  // 所有正式角色都可能读取明确共享的资料；试聊根本不使用它们。
  const affected = db.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.mode, 'normal'),
    globalChanged ? undefined : or(inArray(conversations.characterId, [...privateIds]), inArray(conversations.id, [...sourceConversations])))).all()
  const conversationIds = affected.map(({ id }) => id)
  for (const id of conversationIds) bumpContextEpoch(db, id)
  db.update(conversations).set({ runtimeSessionId: null }).where(inArray(conversations.id, conversationIds)).run()
  db.update(memoryJobs).set({ status: 'stale', leaseUntil: null, updatedAt: now }).where(and(
    eq(memoryJobs.status, 'pending'), inArray(memoryJobs.conversationId, conversationIds),
  )).run()
  return conversationIds
}

/**
 * 完成一次资料新建、纠正或忘记。旧任务先失效，运行中的任务仍可写用量账本。
 * @param db 后台唯一写连接
 * @param context 实际正式会话和页面请求编号，或本轮用户原话编号
 * @param change 已校验的操作、目标与修订号
 * @param now 本次操作的毫秒时间戳
 * @returns 持久回执和需失效的会话；重复请求直接取原回执
 * @throws NOT_FOUND 目标不可见；STALE_REVISION 记录已变化；SOURCE_NOT_ALLOWED 来源不是本轮正式原话；INVALID_INPUT 参数无效
 */
export function mutateMemory(
  db: BetterSQLite3Database, context: MemoryMutationContext, change: MemoryMutation, now: number,
): MemoryMutationResult {
  return db.transaction((tx) => {
    const conversation = tx.select().from(conversations).where(eq(conversations.id, context.conversationId)).get()
    if (!conversation || conversation.mode !== 'normal') throw new Error('SOURCE_NOT_ALLOWED')
    const sourceId = context.requestMessageId
    if (change.action === 'create' && sourceId !== undefined) throw new Error('SOURCE_NOT_ALLOWED')
    const toolNames = { create: 'create_managed_memory', correct: 'correct_memory', forget: 'forget_memory' }
    const operation = { conversationId: conversation.id, requestMessageId: sourceId ?? null,
      toolName: toolNames[change.action], targetId: change.action === 'create' ? null : change.memoryId }
    const begun = beginToolOperation(tx, { ...operation, now,
      operationKey: buildOperationKey({ ...operation, targetId: context.requestId ?? operation.targetId }) })
    if (begun.kind === 'already-committed') {
      const receipt = memoryChangeReceiptSchema.parse(JSON.parse(begun.resultJson ?? 'null'))
      return { receipt, conversationIds: [] }
    }
    if (begun.kind !== 'new') throw new Error('STORAGE_UNAVAILABLE')
    if (change.action === 'create') {
      const content = memoryContentSchema.safeParse(change.content)
      if (!content.success) throw new Error('INVALID_INPUT')
      const characterId = change.scope === 'character' ? conversation.characterId : null
      // 手填资料单独保存，不引用原聊天，也不会把同一句话里的其他资料一起共享。
      const saved = tx.insert(memories).values({ id: `mem-${randomUUID()}`, scope: change.scope, characterId,
        kind: 'fact', content: content.data, origin: 'user_edit', validFrom: now, createdAt: now, updatedAt: now,
      }).returning().get()
      const receipt: MemoryChangeReceipt = { action: 'create', memoryId: saved.id, revision: saved.revision,
        removedSources: 0, affectedMemories: 0, personaContainsContent: false }
      const conversationIds = invalidateMemoryContexts(tx, new Set(characterId ? [characterId] : []), new Set(), change.scope === 'global', now)
      completeToolOperation(tx, begun.operationId, JSON.stringify(receipt), now)
      return { receipt, conversationIds }
    }
    const target = tx.select().from(memories).where(and(eq(memories.id, change.memoryId), visibleTo(conversation.characterId))).get()
    if (!target || (sourceId && target.scope === 'global')) throw new Error('NOT_FOUND')
    if (target.status === 'deleted' || target.revision !== change.expectedRevision) throw new Error('STALE_REVISION')
    let requestCreatedAt: number | undefined
    if (sourceId) {
      const source = tx.select({ createdAt: messages.createdAt }).from(messages).where(and(eq(messages.id, sourceId),
        eq(messages.conversationId, conversation.id), eq(messages.role, 'user'), eq(messages.status, 'completed'),
        eq(messages.excludedFromContext, 0))).get()
      if (!source || (change.action === 'forget' && change.deleteSources)) throw new Error('SOURCE_NOT_ALLOWED')
      requestCreatedAt = source.createdAt
    }

    const privateIds = new Set<string>()
    const sourceConversations = new Set<string>()
    let globalChanged = false
    let receipt: MemoryChangeReceipt
    if (change.action === 'correct') {
      if (target.status !== 'active' || (target.expiresAt !== null && target.expiresAt <= now)) throw new Error('STALE_REVISION')
      const parsed = memoryContentSchema.safeParse(change.content)
      if (!parsed.success) throw new Error('INVALID_INPUT')
      const corrected = target.content === parsed.data ? target : correctMemory(tx, target, parsed.data, sourceId, now)
      if (corrected.id !== target.id) {
        if (target.characterId) privateIds.add(target.characterId)
        else globalChanged = true
      }
      receipt = { action: 'correct', memoryId: corrected.id, revision: corrected.revision,
        removedSources: 0, affectedMemories: 0, personaContainsContent: false }
    } else {
      const all = tx.select().from(memories).all()
      const chain = memoryChain(all, target)
      const originals = readChainSources(tx, chain)
      if (change.deleteSources && deletionPreview(originals).sourceFingerprint !== change.sourceFingerprint) {
        throw new Error('SOURCE_PREVIEW_CHANGED')
      }
      const excludedIds = new Set(originals.map(({ id }) => id))
      // 用户说「忘掉我的某个偏好」也可能复述内容，不能把这条指令作为新记忆来源。
      if (sourceId) excludedIds.add(sourceId)
      if (sourceId) sourceConversations.add(conversation.id)
      for (const row of originals) sourceConversations.add(row.conversationId)
      const invalidIds = new Set(chain.map((row) => row.id))
      const invalid: Memory[] = []
      let earliest = originals.reduce((at, row) => Math.min(at, row.createdAt), target.validFrom)
      if (requestCreatedAt !== undefined) earliest = Math.min(earliest, requestCreatedAt)
      const reason = change.deleteSources ? 'source_removed' : 'forgotten'
      let newlyExcluded = [...excludedIds]
      for (;;) {
        excludeMessages(tx, new Set(newlyExcluded), reason, now)
        // 依赖已排除原话的记忆也失效，避免一条原话支撑的两条记忆把旧内容带回来。
        // 每次最多查 500 个编号，长历史也不会超过 SQLite 单次查询的参数上限。
        for (let start = 0; start < newlyExcluded.length; start += 500) {
          const linked = tx.select({ id: memorySources.memoryId }).from(memorySources)
            .where(inArray(memorySources.messageId, newlyExcluded.slice(start, start + 500))).all()
          for (const { id } of linked) invalidIds.add(id)
        }
        const newlyInvalid = all.filter((row) => invalidIds.has(row.id) && row.status !== 'deleted')
        for (const row of newlyInvalid) {
          if (row.characterId) privateIds.add(row.characterId)
          else globalChanged = true
          earliest = Math.min(earliest, row.validFrom)
          tx.update(memories).set({ status: 'deleted', content: '', revision: row.revision + 1, updatedAt: now })
            .where(eq(memories.id, row.id)).run()
          tx.delete(memorySources).where(eq(memorySources.memoryId, row.id)).run()
          invalid.push(row)
          row.status = 'deleted'
        }
        // 回复没有逐句来源。从最早相关资料出现起，它们可能复述旧信息，仍能看但停用作背景。
        const replies = tx.select({ id: messages.id }).from(messages)
          .innerJoin(conversations, eq(conversations.id, messages.conversationId)).where(and(
            eq(conversations.mode, 'normal'), ne(messages.role, 'user'), eq(messages.excludedFromContext, 0),
            gte(messages.createdAt, earliest), globalChanged ? undefined : or(
              inArray(conversations.characterId, [...privateIds]), inArray(conversations.id, [...sourceConversations])),
          )).all()
        if (replies.length === 0) break
        newlyExcluded = replies.map(({ id }) => id)
      }
      let removedSources = 0
      if (change.deleteSources) {
        for (const row of originals) {
          tx.delete(messages).where(eq(messages.id, row.id)).run()
          // 书签若卡在已删原话的中间，保留原顺序号，下一条消息从后面继续。
          tx.update(conversations).set({ lastProcessedOffset: 0 }).where(and(
            eq(conversations.id, row.conversationId), eq(conversations.lastProcessedSeq, row.seq),
          )).run()
          removedSources += 1
        }
      }
      const persona = tx.select().from(characterVersions).where(and(eq(characterVersions.isActive, 1),
        globalChanged ? undefined : inArray(characterVersions.characterId, [...privateIds]))).all()
      const personaContainsContent = persona.some((row) => invalid.some(({ content }) => content &&
        [row.personaText, row.initialRelationship, row.userNickname, row.dialogueExamplesJson].some((part) => part?.includes(content))))
      receipt = { action: 'forget', memoryId: target.id, revision: target.revision + 1, removedSources,
        affectedMemories: invalid.length, personaContainsContent }
    }

    const conversationIds = invalidateMemoryContexts(tx, privateIds, sourceConversations, globalChanged, now)
    completeToolOperation(tx, begun.operationId, JSON.stringify(receipt), now)
    return { receipt, conversationIds }
  })
}
