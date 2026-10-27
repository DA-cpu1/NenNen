/**
 * 从 SQLite 准备一轮输入，并创建尚未发送消息的干净 eve 会话。
 * 先保存框架编号、后允许发送，防止数据库不可写时已经花费模型用量。
 * 每轮换框架会话，用户看到的应用会话和历史不变，也不读取 eve 的旧聊天。
 */
import { Client, type ClientSession } from 'eve/client'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { conversations } from '../data/tables'
import { buildTurnContext, type BuildTurnContextInput, type TurnContext } from './turn-context'
import { prepareBudgetedContext, type BudgetedTurnContext, type ModelInputLimits } from './context-budget'
import type { EveHandle } from './eve-process'

/** 尚未启动模型的回合资料；后续发送入口继续使用这里固定的人设和预算输入。 */
export interface PreparedEveTurn {
  context: TurnContext
  input: BudgetedTurnContext
  session: ClientSession
}

/**
 * 准备正式回合并登记新框架会话，任何失败都不能向模型发送用户消息。
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
  const context = buildTurnContext(db, input)
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
      if (!current || current.mode !== 'normal' || current.contextEpoch !== context.contextEpoch) {
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
