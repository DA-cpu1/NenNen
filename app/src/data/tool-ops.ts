/**
 * 工具操作的「回执登记与防重」（05 §5）：模型调工具（记住/纠正/忘记）
 * 前先到这里登记；网络重试、重放带着同一个操作编号再来时，不再执行，
 * 直接拿回第一次的结果。配套规矩：
 * - 操作编号（operation_key）由程序拼接，不是随机数——随机数每次都
 *   不同，永远认不出「这是同一件事」；
 * - 「用户用不同措辞说了两遍同一件事」这种语义重复不归这里管，由记忆
 *   层的属性键唯一索引归并（T07/T08 实现），两层各防一种重复。
 */
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { toolOperations } from './tables'

/**
 * 拼出「同一件事」的操作编号。
 * 组成：在哪段会话 + 因哪条消息 + 调哪个工具 + 对哪个对象——同一句话
 * 重试，四项全同，拼出的编号也全同；任何一项不同就是另一件事。
 * @param input 会话/消息/工具名/目标（目标与消息可为空，空用 '-' 占位
 *  保持长度一致；UUID 里不含 '|'，分隔符不会撞进编号内部）
 */
export function buildOperationKey(input: {
  conversationId: string
  requestMessageId: string | null
  toolName: string
  targetId?: string | null
}): string {
  return [
    input.conversationId,
    input.requestMessageId ?? '-',
    input.toolName,
    input.targetId ?? '-',
  ].join('|')
}

/** beginToolOperation 的三种结局，调用方按 kind 分流 */
export type BeginOutcome =
  /** 全新登记（或上次失败后的重跑）：调用方去执行操作 */
  | { kind: 'new'; operationId: string }
  /** 同一操作正在执行中（另一个流程已登记未落定）：别再开一份 */
  | { kind: 'in-progress'; operationId: string }
  /** 同一操作已经成功过：直接拿第一次的结果，什么都不用再做 */
  | { kind: 'already-committed'; operationId: string; resultJson: string | null }

/**
 * 登记一次工具操作（或认出重复，拒绝重开）。
 * 「先查后插」看起来有缝（两个调用同时查到「没有」各插一行），但这里
 * 不会有：Node 单线程 + better-sqlite3 同步执行，查和插之间没有让出点；
 * 而且全项目只有一个后台服务写库（05 §1），不存在第二个写者。数据库
 * 的 UNIQUE 约束仍在兜底——真有漏网，第二次插入会当场报错。
 * @param db 数据库连接
 * @param input 操作要素；operationKey 用 buildOperationKey 生成
 * @returns 三种结局之一（见 BeginOutcome）
 */
export function beginToolOperation(
  db: BetterSQLite3Database,
  input: {
    operationKey: string
    conversationId: string
    toolName: string
    requestMessageId?: string | null
    targetId?: string | null
    /** 时间戳仅供自动检查注入固定值（07 §3） */
    now?: number
  },
): BeginOutcome {
  const now = input.now ?? Date.now()
  const existing = db
    .select()
    .from(toolOperations)
    .where(eq(toolOperations.operationKey, input.operationKey))
    .get()

  if (existing) {
    if (existing.status === 'committed') {
      // 已经成功过：返回第一次的结果。调用方对用户只能报第一次的真实
      // 结果，绝不能把同一件事再执行一遍写成两条（05 §5）
      return {
        kind: 'already-committed',
        operationId: existing.id,
        resultJson: existing.resultJson,
      }
    }
    if (existing.status === 'pending') {
      // 有人正在办同一件事：交给调用方决定等待还是放弃，这里不开第二份
      return { kind: 'in-progress', operationId: existing.id }
    }
    // 上次 failed：什么都没写进去过，允许重跑。复用原行（编号唯一，
    // 新建必撞约束），把状态和残留字段归零后当作新登记交给调用方
    db.update(toolOperations)
      .set({ status: 'pending', resultJson: null, errorCode: null, updatedAt: now })
      .where(eq(toolOperations.id, existing.id))
      .run()
    return { kind: 'new', operationId: existing.id }
  }

  const operationId = `op-${randomUUID()}`
  db.insert(toolOperations)
    .values({
      id: operationId,
      conversationId: input.conversationId,
      requestMessageId: input.requestMessageId ?? null,
      operationKey: input.operationKey,
      toolName: input.toolName,
      targetId: input.targetId ?? null,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    })
    .run()
  return { kind: 'new', operationId }
}

/**
 * 落定一次操作：执行成功，记下结果。
 * @throws 操作不存在、或已落定过（committed/failed）时抛错——
 *  一件事只许落定一次，二次落定多半是流程 bug，宁可炸出来
 */
export function completeToolOperation(
  db: BetterSQLite3Database,
  operationId: string,
  resultJson: string,
  now?: number,
): void {
  // where 里带 status='pending'：只许从「执行中」走向「已成功」；
  // 想给已落定的操作再 complete，改不到任何行（changes=0），当场暴露
  const result = db
    .update(toolOperations)
    .set({
      status: 'committed',
      resultJson,
      errorCode: null,
      updatedAt: now ?? Date.now(),
    })
    .where(
      and(eq(toolOperations.id, operationId), eq(toolOperations.status, 'pending')),
    )
    .run()
  if (result.changes === 0) {
    throw new Error(`工具操作不存在或已落定：${operationId}`)
  }
}

/**
 * 落定一次操作：执行失败，只记错误码。
 * 不记错误正文——第三方错误消息可能带着提示词或被忘记的内容（05 §6）。
 * @throws 同 completeToolOperation：只能从 pending 落定一次
 */
export function failToolOperation(
  db: BetterSQLite3Database,
  operationId: string,
  errorCode: string,
  now?: number,
): void {
  const result = db
    .update(toolOperations)
    .set({ status: 'failed', errorCode, resultJson: null, updatedAt: now ?? Date.now() })
    .where(
      and(eq(toolOperations.id, operationId), eq(toolOperations.status, 'pending')),
    )
    .run()
  if (result.changes === 0) {
    throw new Error(`工具操作不存在或已落定：${operationId}`)
  }
}
