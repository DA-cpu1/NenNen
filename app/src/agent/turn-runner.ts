/**
 * 正式聊天与草稿试聊共用的回合编排：把已完成的积木按安全顺序串起来。
 * 顺序是「先能准备、再留回执行据、后花钱」：上下文准备失败时数据库里
 * 不会多出半截回复行；回复行和运行账本建好之后才允许把消息交给模型。
 * 总时限（默认 90 秒，04 §2）由程序计时：到点先请框架协作取消，
 * 再向事件流注入一条合成的失败事件，让消费层按统一路径收尾。
 */
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { and, eq, inArray } from 'drizzle-orm'
import type { MessageResponse, MessageStreamEvent } from 'eve/client'
import { messages, agentRuns } from '../data/tables'
import { createAssistantReply } from '../data/messages'
import { startAgentRun } from '../data/agent-runs'
import { prepareEveTurn, preparePreviewEveTurn, sendPreparedEveTurn, releasePreparedEveTurn, type PreparedEveTurn } from './eve-turn'
import { consumeEveTurn, finalizeTurnWrite, type TurnEvent, type TurnOutcome } from './eve-events'
import type { EveHandle } from './eve-process'
import type { ModelInputLimits } from './context-budget'
import type { BuildTurnContextInput } from './turn-context'
import type { PreviewPersonaDraft } from '../shared/chat-turn'
import { mayRequestImmediateMemory } from '../shared/memory-tool'

/** 04 §2：一轮的总用时上限；模型不能自己延长，到点由程序收场。 */
export const DEFAULT_TURN_TIMEOUT_MS = 90_000

/** 本轮开始发送后才可执行工具，结束、取消或超时后撤掉登记。 */
export interface ActiveToolSession {
  sessionId: string
  replyId: string
  contextEpoch: number
  deadlineAt: number
  rememberAllowed: boolean
}

/** 跑一次正式回合所需的资料；人设版本由准备阶段从库中锁定，调用方不能自选。 */
export interface RunFormalTurnInput extends BuildTurnContextInput {
  /** 已核对过的模型窗口与输出预留（context-budget 的口径）。 */
  limits: ModelInputLimits
  /** 实际使用的模型与供应商名，原样记入运行账本。 */
  model: string
  provider: string
  /** 从开始准备到回复结束的总时限；默认 90 秒。 */
  turnTimeoutMs?: number
  /** 服务用它登记工具的允许范围；返回清理函数，在回合收尾时撤下。 */
  registerToolSession?: (session: ActiveToolSession) => () => void
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
  const timeoutMs = input.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
  const deadlineAt = Date.now() + timeoutMs
  const phaseTimeout = new AbortController()
  // 建会话和等待受理也占总用时，不能等拿到事件流以后才开始计时。
  const phaseSignal = AbortSignal.any([signal, phaseTimeout.signal])
  let onInterrupted: () => void
  const interruption = new Promise<never>((_resolve, reject) => {
    onInterrupted = () => reject(new Error(signal.aborted ? 'E_CANCELLED' : 'E_TURN_TIMEOUT'))
    if (phaseSignal.aborted) onInterrupted()
    else phaseSignal.addEventListener('abort', onInterrupted, { once: true })
  })
  const phaseTimer = setTimeout(() => phaseTimeout.abort(), timeoutMs)
  let prepared: PreparedEveTurn | undefined
  let unregisterTools: (() => void) | undefined

  try {
    // 准备（读库+预算+建空会话+登记映射）失败时直接上抛：库里没有本轮痕迹。
    try {
      prepared = await Promise.race([prepare(phaseSignal), interruption])
    } catch (error) {
      if (error instanceof Error && error.message === 'E_CANCELLED') {
        yield { type: 'cancelled' }
        return { status: 'cancelled', finalText: '', usageEstimated: true }
      }
      throw error
    }

    // 回复行先建好：发送失败时它是「保留半截文字、标记失败」的载体。
    const reply = createAssistantReply(db, { userMessageId: input.userMessageId })
    // 运行账本在花钱前登记；人设版本由准备结果锁定（试聊为 null，账本允许）。
    const run = startAgentRun(db, {
      conversationId: input.conversationId,
      characterVersionId: prepared.context.persona.versionId,
      model: input.model, provider: input.provider,
    })

    /** 发送阶段失败/中止时的收尾：回复行与账本一起进终态，不留进行中悬案。 */
    function closeOnSendFailure(code: string, cancelled: boolean) {
      return finalizeTurnWrite(db, {
        replyId: reply.id, runId: run.id, status: cancelled ? 'cancelled' : 'failed', finalText: '',
        // 请求可能已被对方受理，用量不明：按准备阶段的输入估算兜底，绝不能记零。
        usage: { inputTokens: Math.max(1, prepared!.input.inputTokens), outputTokens: 1, estimated: true },
        errorCode: cancelled ? undefined : code,
      })
    }

    const rememberAllowed = prepared.context.conversationMode === 'normal' &&
      mayRequestImmediateMemory(prepared.context.currentMessage.content)
    let response: MessageResponse
    try {
      if ('registerToolSession' in input) unregisterTools = input.registerToolSession?.({
        sessionId: prepared.session.state.sessionId, replyId: reply.id,
        contextEpoch: prepared.context.contextEpoch, deadlineAt, rememberAllowed,
      })
      const sending = sendPreparedEveTurn(db, prepared, phaseSignal, unregisterTools !== undefined).then((accepted) => {
        // 超时后才收到受理句柄时也要回收，不能留下无人继续读取的模型回合。
        if (phaseSignal.aborted) void accepted.cancel().catch(() => { /* 本地已经收尾。 */ })
        return accepted
      })
      response = await Promise.race([sending, interruption])
    } catch (error) {
      const code = error instanceof Error ? error.message : ''
      const finalized = closeOnSendFailure(code || 'E_EVE_SEND_FAILED', code === 'E_CANCELLED')
      yield finalized.event
      return finalized.outcome
    }

    // 准备阶段已经用掉的时间不能重新获得；事件流只拿截止前剩余的毫秒数。
    clearTimeout(phaseTimer)
    phaseSignal.removeEventListener('abort', onInterrupted!)
    const wrapped = withTurnTimeout(response, Math.max(0, deadlineAt - Date.now()), signal)
    return yield* consumeEveTurn(db, {
      response: wrapped, replyId: reply.id, runId: run.id,
      estimatedInputTokens: prepared.input.inputTokens,
      waitForToolDecision: unregisterTools !== undefined && rememberAllowed,
    }, signal)
  } finally {
    unregisterTools?.()
    clearTimeout(phaseTimer)
    phaseSignal.removeEventListener('abort', onInterrupted!)
    if (prepared) await releasePreparedEveTurn(db, prepared)
  }
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
 * @param signal 用户停止/退出的取消信号；中止时本地立刻收尾，并请框架协作取消
 * @returns 可像原句柄一样迭代/取消的替身
 */
function withTurnTimeout(response: MessageResponse, timeoutMs: number, signal: AbortSignal): MessageResponse {
  /** 到点记号：用唯一的 symbol，和任何真实事件结果都不会撞。 */
  const expired = Symbol('turn-timeout')
  const cancelled = Symbol('turn-cancelled')
  let cancelRequested = false
  /** 只向框架请求一次取消；对方不回应时也不能卡住本地的停止按钮。 */
  function requestCancel(): void {
    if (cancelRequested) return
    cancelRequested = true
    void response.cancel().catch(() => { /* 取消失败仍按本地取消收尾。 */ })
  }
  let resolveCancelled: (value: typeof cancelled) => void
  const cancellationPromise = new Promise<typeof cancelled>((resolve) => { resolveCancelled = resolve })
  /** 用户停止时唤醒正在等下一段文字的读取，不依赖服务器再送一条事件。 */
  const onAbort = () => { requestCancel(); resolveCancelled(cancelled) }
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })
  return {
    cancel: async () => { requestCancel() },
    async *[Symbol.asyncIterator](): AsyncGenerator<MessageStreamEvent> {
      const iterator = response[Symbol.asyncIterator]()
      let timer: ReturnType<typeof setTimeout> | undefined
      // 到点只 resolve 记号、不 reject：超时不是流错误，要走事件路径收尾。
      const timerPromise = new Promise<typeof expired>((resolve) => {
        timer = setTimeout(() => resolve(expired), timeoutMs)
      })
      try {
        for (;;) {
          const raced = await Promise.race([iterator.next(), timerPromise, cancellationPromise])
          // 即使文字与停止恰好同一刻到达，也以已经中止的本地信号为准。
          if (raced === cancelled || signal.aborted) {
            iterator.return?.().catch(() => { /* 底层可能仍在等网络，本地不等待。 */ })
            yield {
              type: 'turn.cancelled',
              data: { sequence: -1, turnId: 'local-cancelled' },
              meta: { deliveryId: 'local-cancelled', sequence: -1, timestamp: '' },
            } as unknown as MessageStreamEvent
            break
          }
          if (raced === expired) {
            // 先请框架协作取消，再注入失败结论；随后不再等真实事件——
            // 供应商吊住时它们可能永远不来，超时结论必须立刻生效。
            requestCancel()
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
