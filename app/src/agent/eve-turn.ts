/**
 * 从 SQLite 准备一轮输入，登记干净 eve 会话，再经独立发送入口交付上下文。
 * 先保存框架编号、后允许发送，防止数据库不可写时已经花费模型用量。
 * 每轮换框架会话，用户看到的应用会话和历史不变，也不读取 eve 的旧聊天。
 */
import { Client, type ClientSession, type MessageResponse } from 'eve/client'
import { and, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { conversations } from '../data/tables'
import { buildTurnContext, type BuildTurnContextInput, type TurnContext } from './turn-context'
import {
  buildPreviewTurnContext, type BuildPreviewTurnContextInput,
} from './preview-context'
import { prepareBudgetedContext, type BudgetedTurnContext, type ModelInputLimits } from './context-budget'
import type { EveHandle } from './eve-process'
import { encodeEveTurnEnvelope } from '../shared/eve-turn-envelope'
import { requestedMemoryChange } from '../shared/memory-tool'

/** 尚未启动模型的回合资料；后续发送入口继续使用这里固定的人设和预算输入。 */
export interface PreparedEveTurn {
  context: TurnContext
  input: BudgetedTurnContext
  session: ClientSession
}

// WeakSet 只在对象仍被使用时记住它；防止同一准备结果被连点发送两次，又不长期积攒记录。
const sentTurns = new WeakSet<PreparedEveTurn>()

/**
 * 准备内核：正式与试聊共用（预算 → 建空会话 → 复查登记）。
 * 差别只在上下文从哪来——正式读 character_versions，试聊用请求携带的草稿。
 * 任何失败都不能向模型发送用户消息。
 */
async function prepareTurnSession(
  db: BetterSQLite3Database,
  handle: EveHandle,
  context: TurnContext,
  limits: ModelInputLimits,
  signal: AbortSignal,
): Promise<PreparedEveTurn> {
  const budgeted = prepareBudgetedContext(context, limits)
  const client = new Client({
    host: `http://127.0.0.1:${handle.port}`, auth: { bearer: handle.token }, redirect: 'error',
  })
  let session: ClientSession
  try {
    // 官方无 message 的 create 只建立等待会话，不触发模型；不能在这里附带正文。
    session = (await client.sessions.create({ signal })).session
  } catch {
    throw new Error(signal.aborted ? 'E_CANCELLED' : 'E_EVE_SESSION_FAILED')
  }
  let failure = 'E_STORAGE_UNAVAILABLE'
  try {
    if (signal.aborted) { failure = 'E_CANCELLED'; throw new Error(failure) }
    // 不跨网络等待持有事务；回来后短暂检查版本并登记，防止把过期快照交给下一步。
    db.transaction((tx) => {
      const current = tx.select().from(conversations).where(eq(conversations.id, context.conversationId)).get()
      if (!current || current.mode !== context.conversationMode || current.contextEpoch !== context.contextEpoch) {
        failure = 'E_CONTEXT_CHANGED'
        throw new Error(failure)
      }
      tx.update(conversations).set({ runtimeSessionId: session.state.sessionId })
        .where(eq(conversations.id, context.conversationId)).run()
    })
  } catch {
    // 空会话没有模型工作，回收失败也不能改报成功；不透传可能带正文的框架错误。
    try { await session.reset({ signal: AbortSignal.timeout(5_000) }) } catch { /* 下次仍会新建，不依赖这个残留会话。 */ }
    throw new Error(failure)
  }
  return { context, input: budgeted, session }
}

/**
 * 准备正式回合并登记新框架会话；先建上下文（读当前人设版本）再走共用内核。
 * @param db 后台数据库连接
 * @param handle 已启动的本机 eve 服务凭证，仅在后台使用
 * @param input 应用会话、已保存用户消息与内部共同规则
 * @param limits 已核对的模型窗口与输出预留
 * @param signal 调用方取消信号
 * @returns 固定快照、预算内文字输入与尚未发送消息的会话句柄
 * @throws 上下文/预算错误原样保留；E_EVE_SESSION_FAILED 创建失败；
 * E_CONTEXT_CHANGED 等待期间资料已失效；E_STORAGE_UNAVAILABLE 映射落库失败；E_CANCELLED 已取消
 */
export async function prepareEveTurn(
  db: BetterSQLite3Database, handle: EveHandle, input: BuildTurnContextInput,
  limits: ModelInputLimits, signal: AbortSignal,
): Promise<PreparedEveTurn> {
  if (signal.aborted) throw new Error('E_CANCELLED')
  return prepareTurnSession(db, handle, buildTurnContext(db, input), limits, signal)
}

/**
 * 准备试聊回合并登记新框架会话；人设用请求携带的草稿（preview 会话专用）。
 * @param db 后台数据库连接
 * @param handle 已启动的本机 eve 服务凭证
 * @param input preview 会话、已保存用户消息、共同规则与草稿人设
 * @param limits 已核对的模型窗口与输出预留
 * @param signal 调用方取消信号
 * @returns 固定快照、预算内文字输入与尚未发送消息的会话句柄
 * @throws 同 prepareEveTurn；另 E_PREVIEW_REQUIRED 传来的不是 preview 会话
 */
export async function preparePreviewEveTurn(
  db: BetterSQLite3Database, handle: EveHandle, input: BuildPreviewTurnContextInput,
  limits: ModelInputLimits, signal: AbortSignal,
): Promise<PreparedEveTurn> {
  if (signal.aborted) throw new Error('E_CANCELLED')
  return prepareTurnSession(db, handle, buildPreviewTurnContext(db, input), limits, signal)
}

/**
 * 将已登记的准备结果交给 eve；受理仅返回事件流句柄，不能在这里宣称回复完成。
 * @param db 后台数据库连接，用于发送前复查会话映射与内容版本
 * @param prepared 本轮固定的人设、预算输入和已登记框架会话
 * @param signal 取消信号；发送结果不明时不自动重复请求
 * @param allowMemoryTools 是否已有本轮的正式工具访问登记
 * @returns 官方 MessageResponse，由后续事件适配层消费
 * @throws E_CANCELLED 已取消；E_CONTEXT_CHANGED 映射/内容失效；
 * E_STORAGE_UNAVAILABLE 无法读取；E_EVE_TURN_ALREADY_SENT 此准备结果已发送；E_EVE_SEND_FAILED 请求失败
 */
export async function sendPreparedEveTurn(
  db: BetterSQLite3Database, prepared: PreparedEveTurn, signal: AbortSignal, allowMemoryTools = false,
): Promise<MessageResponse> {
  if (signal.aborted) throw new Error('E_CANCELLED')
  if (sentTurns.has(prepared)) throw new Error('E_EVE_TURN_ALREADY_SENT')
  let current: typeof conversations.$inferSelect | undefined
  try { current = db.select().from(conversations).where(eq(conversations.id, prepared.context.conversationId)).get() }
  catch { throw new Error('E_STORAGE_UNAVAILABLE') }
  if (!current || current.mode !== prepared.context.conversationMode ||
      current.contextEpoch !== prepared.context.contextEpoch ||
      current.runtimeSessionId !== prepared.session.state.sessionId) throw new Error('E_CONTEXT_CHANGED')
  const toolsAllowed = prepared.context.conversationMode === 'normal' && allowMemoryTools
  const currentMessage = prepared.context.currentMessage
  const change = toolsAllowed ? requestedMemoryChange(currentMessage.content) : undefined
  const message = encodeEveTurnEnvelope({
    prompt: prepared.input.prompt, optionalPromptGroups: prepared.input.optionalPromptGroups,
    // 把回复空位一起交付，实际请求加上工具说明后也必须给回复留下相同空间。
    modelWindowTokens: prepared.input.inputLimit + prepared.input.outputReserveTokens,
    outputReserveTokens: prepared.input.outputReserveTokens,
    maxOutputTokens: prepared.input.maxOutputTokens,
    allowMemoryTools: toolsAllowed ? true : undefined,
    // 普通正式回合都提供当前原话编号，让模型按内容选择；纠正/忘记仍走原修改工具。
    rememberSourceMessageId: toolsAllowed && !change ? currentMessage.id : undefined,
    memoryChange: change ? { action: change, messageId: currentMessage.id } : undefined,
  })
  sentTurns.add(prepared)
  try {
    return await prepared.session.send(message, { signal, streamReconnectPolicy: { reconnect: false } })
  } catch {
    // 请求失败时可能已被对方受理；不沿用这个准备结果重发，以免发生第二次模型调用。
    throw new Error(signal.aborted ? 'E_CANCELLED' : 'E_EVE_SEND_FAILED')
  }
}

/**
 * 一轮已经结束，不让空闲框架会话继续挂着；SQLite里的原话与结果都保留。
 * @param db 后台数据库连接
 * @param prepared 这轮独有的框架句柄
 * @returns 是否成功终止会话并清理对应便签；失败不改写本轮业务结果
 */
export async function releasePreparedEveTurn(db: BetterSQLite3Database, prepared: PreparedEveTurn): Promise<boolean> {
  try {
    await prepared.session.reset({ signal: AbortSignal.timeout(5_000) })
    // 新一轮可能已经换了编号：只清理自己的旧便签，不能擦掉别人的新编号。
    db.update(conversations).set({ runtimeSessionId: null }).where(and(
      eq(conversations.id, prepared.context.conversationId),
      eq(conversations.runtimeSessionId, prepared.session.state.sessionId),
    )).run()
    return true
  } catch { return false }
}
