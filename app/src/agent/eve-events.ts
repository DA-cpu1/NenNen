/**
 * 消费一次 eve 回合的事件流：把框架事件翻译成数据库里的回复状态与用量记账。
 * 上一步（eve-turn）只拿到「受理句柄」，模型还没说话；逐段到达的文字、成败
 * 和用量都在这里落地。正式工具回合先等步骤确认才展示并保存文字，试聊可逐段展示。
 * 这里只做翻译和落库，不重发请求、不补写用户消息；保存失败可用原结果单独补写。
 */
import { Buffer } from 'node:buffer'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { MessageResponse } from 'eve/client'
import { finishAgentRun, type FinishAgentRunInput } from '../data/agent-runs'
import { updateAssistantReply } from '../data/messages'

/** 04 §2：每轮最多 3 次模型生成；额度在程序手里，不能由模型自行放宽。 */
export const MAX_MODEL_CALLS_PER_TURN = 3

/** 04 §3 事件草图的当前子集；工具状态（tool-status）等 T07 有工具时再补。 */
export type TurnEvent =
  | { type: 'text'; delta: string }
  | { type: 'done'; replyId: string }
  | { type: 'cancelled' }
  | { type: 'failed'; code: string }

/** 回合结束后的汇总；编排层（下一步）据此决定提示与重试入口。 */
export interface TurnOutcome {
  status: 'completed' | 'failed' | 'cancelled'
  /** 回复最终全文；失败/取消时保留已确认可展示的文字，不保存待确认旁白。 */
  finalText: string
  /** 用量是否为保守估算；true 表示供应商没有报告精确数字。 */
  usageEstimated: boolean
  /** 保存失败时留在服务内存里；重试只补写这份结果，不重新请求模型。 */
  pendingWrite?: PendingTurnWrite
}

/** 一次模型结果的待落库资料；都是普通值，不保存框架句柄或数据库连接。 */
export interface PendingTurnWrite {
  replyId: string
  runId: string
  status: TurnOutcome['status']
  finalText: string
  usage: FinishAgentRunInput['usage']
  errorCode?: string
}

/**
 * 把同一次结果的回复终态和用量账本一起写成；任一写失败，两项一起撤回。
 * 这份资料可以原样重放，数据层会复用相同终态，避免重试多记一次用量。
 * @param db 后台数据库连接
 * @param write 原模型结果、回复编号、运行编号与用量
 * @returns 终态事件及汇总；失败时带原始待写资料，调用方可稍后只重试保存
 */
export function finalizeTurnWrite(
  db: BetterSQLite3Database,
  write: PendingTurnWrite,
): { event: TurnEvent; outcome: TurnOutcome } {
  let saveErrorCode = 'E_REPLY_SAVE_FAILED'
  try {
    db.transaction((tx) => {
      updateAssistantReply(tx, { messageId: write.replyId, content: write.finalText, status: write.status })
      saveErrorCode = 'E_RUN_SAVE_FAILED'
      finishAgentRun(tx, {
        runId: write.runId, status: write.status, usage: write.usage,
        errorCode: write.status === 'failed' ? write.errorCode ?? 'E_TURN_FAILED' : undefined,
      })
    })
  } catch {
    return {
      event: { type: 'failed', code: saveErrorCode },
      outcome: { status: 'failed', finalText: write.finalText, usageEstimated: write.usage.estimated, pendingWrite: write },
    }
  }
  const event: TurnEvent = write.status === 'completed'
    ? { type: 'done', replyId: write.replyId }
    : write.status === 'cancelled' ? { type: 'cancelled' } : { type: 'failed', code: write.errorCode ?? 'E_TURN_FAILED' }
  return { event, outcome: { status: write.status, finalText: write.finalText, usageEstimated: write.usage.estimated } }
}

/** 消费一次已受理回合所需的资料。 */
export interface ConsumeEveTurnInput {
  /** sendPreparedEveTurn 返回的受理句柄；事件只能被读一遍。 */
  response: MessageResponse
  /** 本轮角色回复的消息编号（createAssistantReply 建的那行）。 */
  replyId: string
  /** 本轮模型运行的记账编号（startAgentRun 登记的那行）。 */
  runId: string
  /** 准备阶段按字节口径估算的输入 token；供应商不给用量时兜底记账。 */
  estimatedInputTokens: number
  /** 正式工具回合等步骤明确结束后才展示文字，以免尚未写成就抢先说成功。 */
  waitForToolDecision?: boolean
}

/** 只接受「大写字母开头的固定错误码」；eve 或供应商的原始报错正文不能入库。 */
function sanitizeErrorCode(code: string | undefined, fallback: string): string {
  return code !== undefined && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : fallback
}

/**
 * 消费一次已受理的 eve 回合：流式保存回复文字，结束时写终态和用量。
 * 终态判定「先到先得」——比如超限后我们主动取消，随后到达的 turn.cancelled
 * 不能把已定的失败改写成取消。数据库终态写入失败时给明确的保存失败码，
 * 让界面保留尚不能确认保存的文字；退出恢复会收拾库里遗留的进行中状态。
 * @param db 后台数据库连接
 * @param input 受理句柄、回复编号、运行编号与估算输入
 * @param signal 取消信号；中止视为用户停止，回合记为已取消
 * @returns 逐段产出界面事件，最终以 TurnOutcome 结束（用 return value）
 */
export async function* consumeEveTurn(
  db: BetterSQLite3Database,
  input: ConsumeEveTurnInput,
  signal?: AbortSignal,
): AsyncGenerator<TurnEvent, TurnOutcome> {
  // 已完成步骤的整段文字与当前步骤正在流式输出的部分分开记：
  // message.completed 给的是该步骤的权威全文，若不分开会把增量重复拼一遍。
  let settledText = ''
  let streamingText = ''
  let modelCalls = 0
  // 会话级用量是权威口径（含子代理消耗）；步骤级只在没有会话级时兜底求和。
  let sessionUsage: { inputTokens: number; outputTokens: number } | undefined
  let stepUsage = { inputTokens: 0, outputTokens: 0 }
  let terminal: TurnOutcome['status'] | undefined
  let errorCode: string | undefined
  let streamingWriteFailed = false

  const currentText = () => settledText + streamingText

  /** 进行中的落库只更新全文与状态；失败后等最后一次整段保存，不让文字断在半路。 */
  function persistStreaming(): void {
    if (streamingWriteFailed) return
    try {
      updateAssistantReply(db, { messageId: input.replyId, content: currentText(), status: 'streaming' })
    } catch { streamingWriteFailed = true }
  }

  /** 请求框架协作取消；取消本身失败不改变已定的终态。 */
  function cancelTurn(): void {
    void input.response.cancel().catch(() => { /* 对方不回应时，本地仍须立刻结束。 */ })
  }

  if (signal?.aborted) {
    terminal = 'cancelled'
    cancelTurn()
  }

  if (terminal === undefined) {
    try {
      for await (const event of input.response) {
        // 停止后到达的文字不能再显示或入库；取消请求是否成功不影响这道关卡。
        if (signal?.aborted) {
          if (terminal === undefined) terminal = 'cancelled'
          cancelTurn()
          break
        }
        // 终态后仍可收用量，但迟到文字不得改变已经结束的回复。
        if (terminal !== undefined && (event.type === 'message.appended' || event.type === 'message.completed')) continue
        // data 是 eve 给每类事件规定的载荷位置；switch 按事件名逐类翻译。
        switch (event.type) {
          case 'message.appended':
            streamingText += event.data.messageDelta
            if (!input.waitForToolDecision) {
              persistStreaming()
              yield { type: 'text', delta: event.data.messageDelta }
            }
            break
          case 'message.completed': {
            streamingText = ''
            // eve 的结束原因区分「接下来调工具」与最终角色回复。前者没有可靠保存结果。
            if (input.waitForToolDecision && event.data.finishReason === 'tool-calls') break
            settledText += event.data.message
            persistStreaming()
            if (input.waitForToolDecision && event.data.message) yield { type: 'text', delta: event.data.message }
            break
          }
          case 'step.started':
            modelCalls += 1
            if (modelCalls > MAX_MODEL_CALLS_PER_TURN) {
              // 超出额度：主动取消并记失败，后续到达的取消事件不得改写结论。
              if (terminal === undefined) { terminal = 'failed'; errorCode = 'E_TURN_LIMIT' }
              cancelTurn()
            }
            break
          case 'step.completed': {
            const usage = event.data.usage
            if (usage?.inputTokens !== undefined) stepUsage.inputTokens += usage.inputTokens
            if (usage?.outputTokens !== undefined) stepUsage.outputTokens += usage.outputTokens
            break
          }
          case 'turn.failed':
            if (terminal === undefined) { terminal = 'failed'; errorCode = sanitizeErrorCode(event.data.code, 'E_TURN_FAILED') }
            break
          case 'turn.cancelled':
            if (terminal === undefined) terminal = 'cancelled'
            break
          case 'turn.completed':
            if (terminal === undefined) terminal = 'completed'
            break
          case 'session.failed':
            if (terminal === undefined) { terminal = 'failed'; errorCode = sanitizeErrorCode(event.data.code, 'E_SESSION_FAILED') }
            if (event.data.usage) {
              sessionUsage = { inputTokens: event.data.usage.inputTokens, outputTokens: event.data.usage.outputTokens }
            }
            break
          case 'session.waiting':
          case 'turn.waiting':
            // 会话停在等待边界：这是回合间的正常状态，usage 若随事件到达则采用。
            if (event.data.usage) {
              sessionUsage = { inputTokens: event.data.usage.inputTokens, outputTokens: event.data.usage.outputTokens }
            }
            break
          case 'session.completed':
            // 会话完成是回合的正常收尾；这类事件的 data 本身允许缺失。
            if (event.data?.usage) {
              sessionUsage = { inputTokens: event.data.usage.inputTokens, outputTokens: event.data.usage.outputTokens }
            }
            break
          default:
            // 其余事件（推理增量、工具输入等）首版不展示，也不写入数据库。
            break
        }
      }
    } catch {
      // 事件流中途断开：中止信号视为取消，其余一律记固定失败码，不转发原始报错。
      if (terminal === undefined) {
        terminal = signal?.aborted ? 'cancelled' : 'failed'
        if (terminal === 'failed') errorCode = 'E_EVE_STREAM_FAILED'
      }
    }
  }

  // 工具回合若中途断流，尚未确认用途的文字可能是抢先报成功的旁白，不能显示或落库。
  if (input.waitForToolDecision) streamingText = ''

  // 完成但没有可读文字：按约定不能把空白标成成功（③ 的规则），改记失败。
  if (terminal === 'completed' && currentText().trim() === '') {
    terminal = 'failed'
    errorCode = 'E_EMPTY_REPLY'
  }
  // 流读到头却没见到任何终态事件（框架异常时的兜底）：按失败收场并给独立码。
  if (terminal === undefined) {
    terminal = 'failed'
    errorCode = 'E_TURN_STREAM_ENDED'
  }
  const finalText = currentText()

  // 用量三选一：会话级精确 → 步骤级求和 → 保守估算（估算绝不能合计为零）。
  let usage = sessionUsage ?? (stepUsage.inputTokens + stepUsage.outputTokens > 0 ? stepUsage : undefined)
  let usageEstimated: boolean
  if (usage) usageEstimated = false
  else {
    usageEstimated = true
    // 估算口径与准备阶段一致：文字按 UTF-8 字节加协议预留；输出无文字时至少记 1。
    const outputEstimate = finalText ? Buffer.byteLength(finalText, 'utf8') + 256 : 1
    usage = { inputTokens: Math.max(1, input.estimatedInputTokens), outputTokens: outputEstimate }
  }
  // 即使中途有一段没存进去，这里仍用完整文字补写；只有真正写成才报告完成。
  const finalized = finalizeTurnWrite(db, {
    replyId: input.replyId, runId: input.runId, status: terminal, finalText,
    usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, estimated: usageEstimated },
    errorCode,
  })
  yield finalized.event
  return finalized.outcome
}
