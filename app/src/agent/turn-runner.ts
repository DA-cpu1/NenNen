/**
 * 一次正式聊天回合的编排：把已完成的积木按安全顺序串起来。
 * 顺序是「先能准备、再留回执行据、后花钱」：上下文准备失败时数据库里
 * 不会多出半截回复行；回复行和运行账本建好之后才允许把消息交给模型。
 * 总时限（默认 90 秒，04 §2）由程序计时：到点先请框架协作取消，
 * 再向事件流注入一条合成的失败事件，让消费层按统一路径收尾。
 */
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { and, eq, inArray } from 'drizzle-orm'
import type { MessageResponse, MessageStreamEvent } from 'eve/client'
import { messages, agentRuns } from '../data/tables'
import { createAssistantReply, updateAssistantReply } from '../data/messages'
import { startAgentRun, finishAgentRun } from '../data/agent-runs'
import { prepareEveTurn, preparePreviewEveTurn, sendPreparedEveTurn, type PreparedEveTurn } from './eve-turn'
import { consumeEveTurn, type TurnEvent, type TurnOutcome } from './eve-events'
import type { EveHandle } from './eve-process'
import type { ModelInputLimits } from './context-budget'
import type { BuildTurnContextInput } from './turn-context'
import type { PreviewPersonaDraft } from '../shared/chat-turn'

/** 04 §2：一轮的总用时上限；模型不能自己延长，到点由程序收场。 */
export const DEFAULT_TURN_TIMEOUT_MS = 90_000

/** 跑一次正式回合所需的资料；人设版本由准备阶段从库中锁定，调用方不能自选。 */
export interface RunFormalTurnInput extends BuildTurnContextInput {
  /** 已核对过的模型窗口与输出预留（context-budget 的口径）。 */
  limits: ModelInputLimits
  /** 实际使用的模型与供应商名，原样记入运行账本。 */
  model: string
  provider: string
  /** 回合总时限；默认 90 秒。 */
  turnTimeoutMs?: number
}

/** 跑一次试聊回合所需的资料；草稿人设随请求携带，不经 character_versions。 */
export interface RunPreviewTurnInput {
  conversationId: string
  userMessageId: string
  commonRules: string
  draft: PreviewPersonaDraft
  limits: ModelInputLimits
  model: string
  provider: string
  turnTimeoutMs?: number
}

/** 已有进行中回复的预检：挡在准备之前，不白建空会话。 */
function assertNoActiveReply(db: BetterSQLite3Database, userMessageId: string): void {
  const activeReply = db.select({ id: messages.id }).from(messages).where(and(
    eq(messages.replyToId, userMessageId), eq(messages.role, 'assistant'),
    inArray(messages.status, ['pending', 'streaming']),
  )).get()
  if (activeReply) throw new Error('E_REPLY_IN_PROGRESS')
}

/**
 * 回合编排内核：正式与试聊共用（准备 → 留据 → 发送 → 消费），差别只在准备函数。
 */
async function* runTurn(
  db: BetterSQLite3Database,
  handle: EveHandle,
  input: RunFormalTurnInput | RunPreviewTurnInput,
  prepare: (signal: AbortSignal) => Promise<PreparedEveTurn>,
  signal: AbortSignal,
): AsyncGenerator<TurnEvent, TurnOutcome> {
  // 准备（读库+预算+建空会话+登记映射）失败时直接上抛：库里没有本轮痕迹。
  const prepared = await prepare(signal)

  // 回复行先建好：发送失败时它是「保留半截文字、标记失败」的载体。
  const reply = createAssistantReply(db, { userMessageId: input.userMessageId })
  // 运行账本在花钱前登记；人设版本由准备结果锁定（试聊为 null，账本允许）。
  const run = startAgentRun(db, {
    conversationId: input.conversationId,
    characterVersionId: prepared.context.persona.versionId,
    model: input.model, provider: input.provider,
  })

  /** 发送阶段失败/中止时的收尾：回复行与账本一起进终态，不留进行中悬案。 */
  function closeOnSendFailure(code: string, cancelled: boolean, now?: number): void {
    try {
      updateAssistantReply(db, { messageId: reply.id, content: '', status: cancelled ? 'cancelled' : 'failed', now })
    } catch { /* 库也坏时留给启动恢复；错误码仍交给界面。 */ }
    try {
      finishAgentRun(db, {
        runId: run.id, status: cancelled ? 'cancelled' : 'failed',
        // 请求可能已被对方受理，用量不明：按准备阶段的输入估算兜底，绝不能记零。
        usage: { inputTokens: Math.max(1, prepared.input.inputTokens), outputTokens: 1, estimated: true },
        errorCode: cancelled ? undefined : code, now,
      })
    } catch { /* 同上。 */ }
  }

  let response: MessageResponse
  try {
    response = await sendPreparedEveTurn(db, prepared, signal)
  } catch (error) {
    const code = error instanceof Error ? error.message : ''
    if (code === 'E_CANCELLED') {
      closeOnSendFailure(code, true)
      yield { type: 'cancelled' }
      return { status: 'cancelled', finalText: '', usageEstimated: true }
    }
    closeOnSendFailure(code || 'E_EVE_SEND_FAILED', false)
    yield { type: 'failed', code: code || 'E_EVE_SEND_FAILED' }
    return { status: 'failed', finalText: '', usageEstimated: true }
  }

  // 消费事件流；总时限包在句柄外面（见 withTurnTimeout）。
  const wrapped = withTurnTimeout(response, input.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS, signal)
  return yield* consumeEveTurn(db, {
    response: wrapped, replyId: reply.id, runId: run.id,
    estimatedInputTokens: prepared.input.inputTokens,
  }, signal)
}

/**
 * 跑完一次正式聊天回合，逐段交出界面事件，结束时返回回合汇总。
 * 失败路径同样落库：发送失败或中止时，本函数自己把回复行和运行账本
 * 收成终态，调用方只负责把错误码翻译给界面。
 * @param db 后台数据库连接
 * @param handle 已启动的本机 eve 服务凭证
 * @param input 会话、用户消息、共同规则、模型容量与模型名
 * @param signal 用户停止/应用退出的取消信号
 * @returns 界面事件流；return value 为回合汇总（与 consumeEveTurn 相同）
 * @throws 准备阶段的错误原样上抛（此时还没有回复行/运行行需要收拾）；
 * E_REPLY_IN_PROGRESS 同一条用户消息已有进行中的回复
 */
export async function* runFormalTurn(
  db: BetterSQLite3Database,
  handle: EveHandle,
  input: RunFormalTurnInput,
  signal: AbortSignal,
): AsyncGenerator<TurnEvent, TurnOutcome> {
  assertNoActiveReply(db, input.userMessageId)
  return yield* runTurn(db, handle, input,
    (abort) => prepareEveTurn(db, handle, input, input.limits, abort), signal)
}

/**
 * 跑完一次试聊回合：人设来自请求携带的草稿，账本记空版本（trigger preview）。
 * 行为与正式回合一致（时限、留据顺序、失败收尾），只是准备走草稿上下文。
 * @param db 后台数据库连接
 * @param handle 已启动的本机 eve 服务凭证
 * @param input preview 会话、用户消息、共同规则、草稿人设、模型容量与模型名
 * @param signal 用户停止/应用退出的取消信号
 * @returns 界面事件流；return value 为回合汇总
 * @throws 同 runFormalTurn；另 E_PREVIEW_REQUIRED 传来的不是 preview 会话
 */
export async function* runPreviewTurn(
  db: BetterSQLite3Database,
  handle: EveHandle,
  input: RunPreviewTurnInput,
  signal: AbortSignal,
): AsyncGenerator<TurnEvent, TurnOutcome> {
  assertNoActiveReply(db, input.userMessageId)
  return yield* runTurn(db, handle, input,
    (abort) => preparePreviewEveTurn(db, handle, {
      conversationId: input.conversationId, userMessageId: input.userMessageId,
      commonRules: input.commonRules, draft: input.draft,
    }, input.limits, abort), signal)
}

/**
 * 给受理句柄包一层总时限，返回一个「同样只会迭代+取消」的替身。
 * 到点先请框架协作取消，再注入一条合成的 turn.failed（码 E_TURN_TIMEOUT）；
 * 消费层「先到先得」的终态规则会保住超时结论，随后真实到达的取消事件不改写它。
 * @param response 原始受理句柄（事件只能被读一遍，替身转手这份唯一性）
 * @param timeoutMs 总时限毫秒数
 * @param signal 用户停止/退出的取消信号；中止时先请框架协作取消
 * @returns 可像原句柄一样迭代/取消的替身
 */
function withTurnTimeout(response: MessageResponse, timeoutMs: number, signal: AbortSignal): MessageResponse {
  /** 到点记号：用唯一的 symbol，和任何真实事件结果都不会撞。 */
  const expired = Symbol('turn-timeout')
  /** 用户停止/退出时先请框架协作取消：优雅收场，也避免服务器留孤儿回合。 */
  const onAbort = () => { void response.cancel().catch(() => { /* 取消失败仍按本地取消收尾。 */ }) }
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })
  return {
    cancel: () => response.cancel(),
    async *[Symbol.asyncIterator](): AsyncGenerator<MessageStreamEvent> {
      const iterator = response[Symbol.asyncIterator]()
      let timer: ReturnType<typeof setTimeout> | undefined
      // 到点只 resolve 记号、不 reject：超时不是流错误，要走事件路径收尾。
      const timerPromise = new Promise<typeof expired>((resolve) => {
        timer = setTimeout(() => resolve(expired), timeoutMs)
      })
      try {
        for (;;) {
          const raced = await Promise.race([iterator.next(), timerPromise])
          if (raced === expired) {
            // 先请框架协作取消，再注入失败结论；随后不再等真实事件——
            // 供应商吊住时它们可能永远不来，超时结论必须立刻生效。
            void response.cancel().catch(() => { /* 取消失败不改变本地超时判定。 */ })
            yield {
              type: 'turn.failed',
              data: { code: 'E_TURN_TIMEOUT', message: '', sequence: -1, turnId: 'local-timeout' },
              meta: { deliveryId: 'local-timeout', sequence: -1, timestamp: '' },
            } as unknown as MessageStreamEvent
            // 关闭底层迭代器但不等待：它可能正吊在永远不来的下一段上。
            iterator.return?.().catch(() => { /* 关不掉就算了，超时结论已经生效。 */ })
            break
          }
          if (raced.done) break
          yield raced.value
        }
      } finally {
        // 流结束就停表、摘掉中止监听：不留到点空响的定时器与悬挂的监听器。
        if (timer !== undefined) clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
      }
    },
  } as unknown as MessageResponse
}

/**
 * 启动时的退出恢复：把上个进程遗留的进行中回复与运行账本收成失败终态。
 * 不恢复任何「成功」：崩溃前没写完成就是没完成，用户按原请求编号重试即可
 * （04 §9）。只应在服务启动、尚无回合开始前调用一次。
 * @param db 后台数据库连接
 * @param now 检查时间；测试可传固定值
 * @returns 各自收拾掉的回复行数与运行行数
 */
export function recoverInterruptedTurns(db: BetterSQLite3Database, now?: number): { replies: number; runs: number } {
  const time = now ?? Date.now()
  return db.transaction((tx) => {
    // 只有角色回复会停在 pending/streaming；用户消息生来就是 completed。
    const replies = tx.update(messages).set({ status: 'failed' })
      .where(inArray(messages.status, ['pending', 'streaming'])).returning().all()
    // 遗留运行的用量无从得知：token 数留空、估算标志置 1，不冒充精确也不记零。
    const runs = tx.update(agentRuns)
      .set({ status: 'failed', errorCode: 'E_INTERRUPTED', usageEstimated: 1, finishedAt: time })
      .where(eq(agentRuns.status, 'running')).returning().all()
    return { replies: replies.length, runs: runs.length }
  })
}
