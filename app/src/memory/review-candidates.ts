/** 找出保存前值得比较的旧记忆，事实是否相同由模型结合原话决定。 */
import { asc, eq, inArray } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { Memory } from '../data/memories'
import { memorySources, messages } from '../data/tables'
import { searchMemories } from './search'

/** 模型需要知道类别、属性和时间，避免把同一话题的不同事实合在一起。 */
export type MemoryReviewCandidate = Pick<Memory, 'id' | 'revision' | 'content' | 'kind' |
  'memoryKey' | 'validFrom' | 'expiresAt'> & { firstSourceAt: number | null }

/**
 * 先选同来源，再选同属性，最后用关键词补足，最多五条。
 * @param db 后台 SQLite 连接
 * @param current 已按当前角色和时效筛过的旧记录
 * @param proposal 这次查找用的原话编号、属性和正文
 * @returns 去掉重复编号后的候选，保留模型比较时间所需的资料
 */
export function findMemoryReviewCandidates(
  db: BetterSQLite3Database, current: readonly Memory[],
  proposal: { sourceMessageIds: readonly string[]; memoryKey: string | null; content: string },
): MemoryReviewCandidate[] {
  const limit = 5
  const rows = current.filter((row) => row.scope === 'character')
  const linkedIds = new Set(db.select({ id: memorySources.memoryId }).from(memorySources)
    .where(inArray(memorySources.messageId, proposal.sourceMessageIds)).all().map(({ id }) => id))
  const selected = new Map<string, Memory>()
  for (const row of rows) {
    if (linkedIds.has(row.id)) selected.set(row.id, row)
  }
  for (const row of rows) {
    if (proposal.memoryKey !== null && row.memoryKey === proposal.memoryKey) selected.set(row.id, row)
  }
  // 已选中的条目不占关键词搜索的名额。
  const remaining = rows.filter((row) => !selected.has(row.id))
  for (const { id } of searchMemories(remaining, proposal.content, limit - selected.size)) {
    const row = remaining.find((memory) => memory.id === id)
    if (row) selected.set(id, row)
  }
  return [...selected.values()].slice(0, limit).map(({ id, revision, content, kind, memoryKey, validFrom, expiresAt }) => {
    const source = db.select({ createdAt: messages.createdAt }).from(memorySources)
      .innerJoin(messages, eq(messages.id, memorySources.messageId))
      .where(eq(memorySources.memoryId, id)).orderBy(asc(messages.createdAt)).get()
    return { id, revision, content, kind, memoryKey, validFrom, expiresAt, firstSourceAt: source?.createdAt ?? null }
  })
}
