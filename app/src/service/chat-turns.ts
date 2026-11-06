/**
 * 聊天回合的后台服务：管「谁正在说话」这本登记簿，把界面请求接到回合编排。
 * 一个角色同一时刻只允许一个活动回合——正式聊天和试聊也不能同时回复，避免两个
 * 模型调用互相覆盖框架会话映射。事件流对外只出不进：界面的停止请求走
 * cancelTurn（打断 AbortController），不往流里塞命令。
 */
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { and, eq } from 'drizzle-orm'
import { conversations, messages } from '../data/tables'
import { saveUserMessage } from '../data/messages'
import { getFirstCharacter } from '../data/character-init'
import { ensurePreviewConversation } from '../data/conversations'
import { listCurrentMemories } from '../data/memories'
import { runFormalTurn, runPreviewTurn, type ActiveToolSession } from '../agent/turn-runner'
import type { ModelInputLimits } from '../agent/context-budget'
import type { EveHandle } from '../agent/eve-process'
import { finalizeTurnWrite, type PendingTurnWrite, type TurnEvent, type TurnOutcome } from '../agent/eve-events'
import { COMMON_FACT_RULES } from '../shared/character-sample'
import { searchMemories } from '../memory/search'
import type { MemoryToolRequest, MemoryToolResult } from '../shared/memory-tool'
import { rememberExplicit } from './remember-explicit'
import type { AppliedMemoryChange, ChatMemoryChange } from './memory-management'
import {
  resolvePreviewDraft, type ChatTurnRequest, type PreviewTurnRequest, type SseTurnEvent,
} from '../shared/chat-turn'

/**
 * 共同事实规则来自已确认的完整样稿，和角色草稿分开交付，
 * 防止只接入三句临时规则而丢掉引用、假设和工具结果的具体边界。
 */
export const COMMON_RULES_TEXT = COMMON_FACT_RULES

/** 旧固定探针的基线；正式入口通过 getModelConfiguration 读取当前配置。 */
const MODEL_NAME = 'glm-5.3-flash'
const PROVIDER_NAME = 'zhipu'

/** 创建服务所需的依赖；都用「取值函数」是让运行期换密钥/换库立即生效。 */
export interface ChatTurnServiceDeps {
  getDb: () => BetterSQLite3Database | undefined
  /** 当前在岗的 eve；没有密钥时是 undefined，回合请求会得到明确错误。 */
  getEve: () => EveHandle | undefined
  /** 模型窗口与输出预留；测试可注入小窗口制造预算失败。 */
  limits: ModelInputLimits
  /** 每次开始回合时取一份配置，记账名称与输入容量必须和实际模型一致。 */
  getModelConfiguration?: () => { model: string; provider: string; limits: ModelInputLimits } | undefined
  /** 正式聊天保存原话或结束回复后，请后台重查整理触发条件。 */
  wakeMemoryJobs?: () => void
  /** 旧缓存还在清理时，受影响会话暂停发送。其他会话仍可使用自己的资料。 */
  isContextBlocked?: (conversationId: string) => boolean
  /** 使用回合真实身份执行修改，完成后由事件流独立确认。 */
  changeMemory?: (conversationId: string, userMessageId: string, change: ChatMemoryChange) => AppliedMemoryChange
}

/** 回合服务的对外能力。 */
export interface ChatTurnService {
  /**
   * 保存用户消息并开始一轮回复；返回首帧要用的消息编号与事件流。
   * 同步阶段（校验、落库、登记）可能抛固定错误码，由 HTTP 层翻译状态码；
   * 异步阶段的全部失败都走事件流（failed 帧），不再改变 HTTP 状态。
   */
  startTurn: (request: ChatTurnRequest) => { userMessageId: string; events: AsyncGenerator<SseTurnEvent> }
  /**
   * 发起试聊回合：preview 会话由后台按角色解析/创建，人设用请求携带的
   * 草稿（不经 character_versions），登记与防重规则与正式回合一致。
   * 返回会话编号供 HTTP 层做断开取消。
   */
  startPreviewTurn: (request: PreviewTurnRequest) => {
    userMessageId: string
    conversationId: string
    events: AsyncGenerator<SseTurnEvent>
  }
  /** 请求停止指定会话的活动回合；没有活动回合时返回 false。 */
  cancelTurn: (conversationId: string) => boolean
  /** 当前活动回合数；检查与验收用。 */
  activeCount: () => number
  /** 中止受影响回复，并让待补写的旧结果也只能以未完成状态保存。 */
  invalidateContexts: (conversationIds: readonly string[]) => void
  /** 回收某个 eve 进程前，等待仍使用它的回合结束。 */
  waitForRuntime: (eve: EveHandle) => Promise<void>
  /** 只为仍有效的正式回合执行内部记忆工具；角色从会话查出。 */
  executeMemoryTool: (request: MemoryToolRequest) => MemoryToolResult
  /** 退出前停止受理，取消并等已有回合保存终态；重复调用共用同一次收尾。 */
  stop: () => Promise<void>
}

/**
 * 建一个回合服务。登记簿放闭包里而不是模块顶层：测试各建各的实例，
 * 互不串门；正式进程只有一个实例。
 * @param deps 数据库/句柄取值函数与模型容量
 * @returns 回合服务
 */
export function createChatTurnService(deps: ChatTurnServiceDeps): ChatTurnService {
  /** 完成信号让退出流程等到取消落库，不能只发出取消就关闭数据库。 */
  interface ActiveTurn {
    controller: AbortController
    eve?: EveHandle
    invalidated?: boolean
    runtimeDone: Promise<void>
    finishRuntime: () => void
    events?: AsyncGenerator<SseTurnEvent>
    completed: Promise<void>
    finish: () => void
    toolSession?: ActiveToolSession & { executions: number; seenMemories: Map<string, number> }
    /** 已落库的操作回执，与角色回复是否完成分开。 */
    memoryStatus?: 'memory-saved' | 'memory-already-saved'
    memoryChange?: AppliedMemoryChange
  }
  // 会话编号用来定位停止对象，角色编号用来挡下正式/试聊之间的并发。
  // 两份登记一起建立、一起清理；挡下请求时还没有保存新的用户消息。
  const active = new Map<string, ActiveTurn>()
  const activeCharacters = new Set<string>()
  // 只临时保留尚未写成的结果，不写日志；同一请求重试时先补写，不能再花一次模型钱。
  const pendingWrites = new Map<string, { conversationId: string; write: PendingTurnWrite }>()
  let closing = false
  let stopping: Promise<void> | undefined

  /** 退出时接手未读的流尾部；异步生成器会排队处理next，不会重复执行落库。 */
  async function drain(events: AsyncGenerator<SseTurnEvent>): Promise<void> {
    for await (const _event of events) { /* 退出时只保存结果，不再等待界面展示。 */ }
  }

  /**
   * 停止受理并排空活动回合，最后再尝试补写尚未保存的原结果。
   * @returns 所有本轮落库尝试结束后完成；不会再次调用模型
   */
  function stop(): Promise<void> {
    if (stopping) return stopping
    closing = true
    const turns = [...active.values()]
    for (const turn of turns) turn.controller.abort()
    for (const turn of turns) {
      if (turn.events) void drain(turn.events).catch(() => {})
    }
    stopping = Promise.all(turns.map((turn) => turn.completed)).then(() => {
      const db = deps.getDb()
      if (!db) return
      for (const [userMessageId, { write }] of pendingWrites) {
        if (!finalizeTurnWrite(db, write).outcome.pendingWrite) pendingWrites.delete(userMessageId)
      }
    })
    return stopping
  }

  /** 登记活动回合和完成信号，再把流交给HTTP层；避免退出发生在两者之间。 */
  function registerTurn(
    conversationId: string,
    characterId: string,
    userMessageId: string,
    eve: EveHandle | undefined,
    runStart: (turn: ActiveTurn) => AsyncGenerator<TurnEvent, TurnOutcome>,
    onSettled?: () => void,
  ): AsyncGenerator<SseTurnEvent> {
    let finish!: () => void
    let finishRuntime!: () => void
    const turn: ActiveTurn = {
      controller: new AbortController(), eve,
      runtimeDone: new Promise<void>((resolve) => { finishRuntime = resolve }), finishRuntime,
      completed: new Promise<void>((resolve) => { finish = resolve }), finish: () => {
        finish()
        onSettled?.()
      },
    }
    active.set(conversationId, turn)
    activeCharacters.add(characterId)
    turn.events = guardedEvents(conversationId, characterId, userMessageId, turn, runStart)
    return turn.events
  }

  /** 保存重试没有模型阶段，只把内存里的原结果再交给同一组落库检查。 */
  async function* replayWrite(db: BetterSQLite3Database, write: PendingTurnWrite): AsyncGenerator<TurnEvent, TurnOutcome> {
    const finalized = finalizeTurnWrite(db, write)
    yield finalized.event
    return finalized.outcome
  }

  /** 已成功回复的消息不再发起第二次模型调用；重试入口只对失败/取消开放。 */
  function assertNotAnswered(db: BetterSQLite3Database, userMessageId: string): void {
    const answered = db.select({ id: messages.id }).from(messages).where(and(
      eq(messages.replyToId, userMessageId), eq(messages.role, 'assistant'),
      eq(messages.status, 'completed'),
    )).get()
    if (answered) throw new Error('E_ALREADY_REPLIED')
  }

  /**
   * 受护事件流：编排层任何同步抛错都转成 failed 帧，流必然走到终点，
   * 结束就腾出登记簿。首帧 saved 顺带会话编号——试聊界面靠它调停止。
   */
  function guardedEvents(
    conversationId: string,
    characterId: string,
    userMessageId: string,
    turn: ActiveTurn,
    runStart: (turn: ActiveTurn) => AsyncGenerator<TurnEvent, TurnOutcome>,
  ): AsyncGenerator<SseTurnEvent> {
    return (async function* generate(): AsyncGenerator<SseTurnEvent> {
      try {
        yield { type: 'saved', userMessageId, conversationId }
        const runner = runStart(turn)
        let terminalEvent: TurnEvent | undefined
        let announcedMemoryStatus: ActiveTurn['memoryStatus']
        let shownText = ''
        for (;;) {
          const step = await runner.next()
          // 即使工具后的模型调用失败，也在终态前发出已落库的真实回执。
          if (turn.memoryStatus && turn.memoryStatus !== announcedMemoryStatus) {
            announcedMemoryStatus = turn.memoryStatus
            yield { type: 'tool-status', status: announcedMemoryStatus }
          }
          if (step.done) {
            turn.finishRuntime()
            const write = step.value.pendingWrite
            if (write) pendingWrites.set(userMessageId, { conversationId, write: turn.invalidated
              ? { ...write, status: 'cancelled', finalText: shownText } : write })
            else pendingWrites.delete(userMessageId)
            // 先接住待补写资料，再把保存失败交给界面；断线不会丢掉这次结果。
            if (turn.invalidated && terminalEvent?.type === 'done') {
              // 保存可能刚完成，界面还没收到终点。让重开历史也看到这条旧回复为未完成。
              const db = deps.getDb()
              db?.update(messages).set({ status: 'cancelled', content: shownText })
                .where(eq(messages.id, terminalEvent.replyId)).run()
            }
            if (turn.memoryChange) {
              try { await turn.memoryChange.cleaned }
              catch { yield { type: 'failed', code: 'MEMORY_CLEANUP_FAILED', reason: 'memory-changed' }; break }
              const receipt = turn.memoryChange.receipt
              yield { type: 'tool-status', status: receipt.action === 'correct' ? 'memory-corrected' : 'memory-forgotten',
                personaContainsContent: receipt.personaContainsContent }
            }
            if (turn.invalidated && !write) yield { type: 'cancelled', reason: 'memory-changed' }
            else if (turn.invalidated && terminalEvent?.type === 'failed') yield { ...terminalEvent, reason: 'memory-changed' }
            else if (terminalEvent) yield terminalEvent as SseTurnEvent
            break
          }
          // Agent 层的 TurnEvent 与线上帧形状一致，这里原样转发。
          if (step.value.type === 'text') {
            if (turn.invalidated) continue
            shownText += step.value.delta
            yield step.value as SseTurnEvent
          } else terminalEvent = step.value
        }
      } catch (error) {
        const code = error instanceof Error && /^E_[A-Z0-9_]+$/.test(error.message) ? error.message : 'E_TURN_FAILED'
        yield turn.invalidated ? { type: 'cancelled', reason: 'memory-changed' } : { type: 'failed', code }
      } finally {
        turn.finishRuntime()
        active.delete(conversationId)
        activeCharacters.delete(characterId)
        turn.finish()
      }
    })()
  }

  /** 发起回合的公共前置：依赖校验、登记占用、带防重落库。 */
  function beginTurn(
    conversationId: string,
    requestId: string,
    content: string,
    expectedMode: 'normal' | 'preview',
  ): { db: BetterSQLite3Database; eve: EveHandle | undefined; savedMessageId: string; characterId: string; pendingWrite?: PendingTurnWrite } {
    if (closing) throw new Error('E_BACKEND_STOPPING')
    const db = deps.getDb()
    if (!db) throw new Error('E_DB_NOT_OPEN')
    const conversation = db.select().from(conversations).where(eq(conversations.id, conversationId)).get()
    if (!conversation) throw new Error('E_CONVERSATION_NOT_FOUND')
    if (conversation.mode !== expectedMode) {
      throw new Error(expectedMode === 'normal' ? 'E_PREVIEW_NOT_ALLOWED' : 'E_PREVIEW_REQUIRED')
    }
    if (deps.isContextBlocked?.(conversation.id)) throw new Error('E_MEMORY_CLEANUP_PENDING')
    if (activeCharacters.has(conversation.characterId)) throw new Error('E_TURN_IN_PROGRESS')
    const existing = db.select().from(messages).where(and(
      eq(messages.conversationId, conversationId), eq(messages.clientRequestId, requestId),
    )).get()
    if (existing?.excludedFromContext === 1) throw new Error('E_USER_MESSAGE_NOT_ALLOWED')
    const pendingWrite = existing && pendingWrites.get(existing.id)?.write
    if (existing && pendingWrite) {
      if (existing.role !== 'user' || existing.content !== content) throw new Error('E_REQUEST_CONFLICT')
      // 补写不依赖 eve 仍在运行；即使模型后台已退出，也能把已收到的答案存好。
      return { db, eve: undefined, savedMessageId: existing.id, characterId: conversation.characterId, pendingWrite }
    }
    const eve = deps.getEve()
    if (!eve) throw new Error('E_EVE_UNAVAILABLE')
    // 落库带防重：同编号同正文返回原消息；同编号换正文报冲突。
    const saved = saveUserMessage(db, { conversationId, requestId, content })
    assertNotAnswered(db, saved.message.id)
    return { db, eve, savedMessageId: saved.message.id, characterId: conversation.characterId }
  }

  return {
    activeCount: () => active.size,
    stop,
    invalidateContexts: (conversationIds) => {
      for (const id of conversationIds) {
        const turn = active.get(id)
        if (turn) {
          turn.invalidated = true
          turn.controller.abort()
        }
      }
      for (const pending of pendingWrites.values()) {
        if (!conversationIds.includes(pending.conversationId)) continue
        // 模型结果未能保存时没有可靠的显示边界，只留用量；旧结果不得补写成完整回复。
        pending.write = { ...pending.write, status: 'cancelled', finalText: '' }
      }
    },
    waitForRuntime: async (eve) => {
      await Promise.all([...active.values()].filter((turn) => turn.eve === eve).map((turn) => turn.runtimeDone))
    },

    executeMemoryTool: (request) => {
      const notFound = { ok: false, code: 'NOT_FOUND', message: '找不到可用的正式聊天回合。', retryable: false } as const
      const entry = [...active.entries()].find(([, turn]) => turn.toolSession?.sessionId === request.sessionId)
      if (!entry) return notFound
      const [conversationId, turn] = entry
      const session = turn.toolSession!
      if (closing || turn.controller.signal.aborted || Date.now() >= session.deadlineAt) {
        return { ok: false, code: 'CANCELLED', message: '这轮聊天已停止。', retryable: false }
      }
      const db = deps.getDb()
      const unavailable = { ok: false, code: 'STORAGE_UNAVAILABLE', message: '暂时无法处理记忆。', retryable: true } as const
      if (!db) return unavailable
      try {
        const conversation = db.select().from(conversations).where(eq(conversations.id, conversationId)).get()
        const reply = db.select({ status: messages.status, replyToId: messages.replyToId }).from(messages)
          .where(and(eq(messages.id, session.replyId), eq(messages.conversationId, conversationId))).get()
        if (conversation?.mode !== 'normal' || conversation.runtimeSessionId !== request.sessionId ||
          conversation.contextEpoch !== session.contextEpoch || !reply?.replyToId ||
          (reply.status !== 'pending' && reply.status !== 'streaming')) {
          return notFound
        }
        if (session.executions >= 4) {
          return { ok: false, code: 'BUDGET_EXCEEDED', message: '这轮聊天已达到工具使用上限。', retryable: false }
        }
        // 同一后台里同步计数再查库，两条同时到达的请求也要各占一个位置。
        session.executions += 1
        if (request.tool === 'remember_explicit') {
          if (!session.rememberAllowed) {
            return { ok: false, code: 'SOURCE_NOT_ALLOWED', message: '这轮没有立即记忆请求。', retryable: false }
          }
          const result = rememberExplicit(db, { conversationId, userMessageId: reply.replyToId }, request.input, Date.now())
          if (result.ok && 'status' in result && turn.memoryStatus !== 'memory-saved') {
            turn.memoryStatus = result.status === 'saved' ? 'memory-saved' : 'memory-already-saved'
          }
          return result
        }
        if (request.tool === 'correct_memory' || request.tool === 'forget_memory') {
          const forget = request.tool === 'forget_memory'
          const source = request.tool === 'forget_memory' ? request.input.requestMessageId : request.input.sourceMessageId
          if (session.memoryChange !== (forget ? 'forget' : 'correct') || source !== reply.replyToId) {
            return { ok: false, code: 'SOURCE_NOT_ALLOWED', message: '只能根据本轮明确请求修改记忆。', retryable: false }
          }
          if (forget && session.bareForgetReference) {
            return { ok: false, code: 'AMBIGUOUS', message: '请先问清楚用户想忘记哪条记忆。', retryable: false }
          }
          if (session.seenMemories.get(request.input.memoryId) !== request.input.expectedRevision) {
            return { ok: false, code: 'STALE_REVISION', message: '请先查询本轮要修改的记忆及其修订号。', retryable: true }
          }
          if (!deps.changeMemory) return unavailable
          const { memoryId, expectedRevision } = request.input
          try {
            turn.memoryChange = deps.changeMemory(conversationId, source, request.tool === 'forget_memory'
              ? { action: 'forget', memoryId, expectedRevision }
              : { action: 'correct', memoryId, expectedRevision, content: request.input.content })
          } catch (error) {
            if (error instanceof Error && error.message === 'STALE_REVISION') {
              return { ok: false, code: 'STALE_REVISION', message: '这条记忆已经变化，请重新查询。', retryable: true }
            }
            if (error instanceof Error && error.message === 'NOT_FOUND') return notFound
            if (error instanceof Error && error.message === 'MEMORY_CLEANUP_PENDING') {
              return { ok: false, code: 'MEMORY_CLEANUP_PENDING', message: '上一项清理正在进行，请稍后再试。', retryable: true }
            }
            return unavailable
          }
          // 连同本轮一起停止。工具不预报成功，只有服务流在清理完毕后才发回执。
          void turn.memoryChange.cleaned.catch(() => {})
          turn.invalidated = true
          turn.controller.abort()
          return { ok: false, code: 'MEMORY_CLEANUP_PENDING', message: '应用正在重建本地上下文，将单独确认结果。', retryable: false }
        }
        const current = listCurrentMemories(db, conversation.characterId, Date.now())
        const matches = searchMemories(current, request.input.query, session.memoryChange ? undefined : request.input.limit)
        if (session.memoryChange) {
          session.seenMemories.clear()
          const privateMatches = matches.filter((memory) => memory.scope === 'character')
          // 写入工具只接最后一次查询的唯一候选。limit=1 不能用来掩盖有多个候选。
          if (privateMatches.length === 1) {
            const [memory] = privateMatches
            session.seenMemories.set(memory.id, memory.revision)
          }
        }
        return { ok: true, memories: matches }
      } catch { return unavailable }
    },

    cancelTurn: (conversationId) => {
      const turn = active.get(conversationId)
      if (!turn) return false
      turn.controller.abort()
      return true
    },

    startTurn: (request) => {
      const { db, eve, savedMessageId, characterId, pendingWrite } = beginTurn(request.conversationId, request.requestId, request.content, 'normal')
      const configured = deps.getModelConfiguration?.() ?? { model: MODEL_NAME, provider: PROVIDER_NAME, limits: deps.limits }
      const events = registerTurn(request.conversationId, characterId, savedMessageId, eve,
        (turn) => pendingWrite ? replayWrite(db, pendingWrite) : runFormalTurn(db, eve!, {
          conversationId: request.conversationId, userMessageId: savedMessageId,
          commonRules: COMMON_RULES_TEXT, limits: configured.limits,
          model: configured.model, provider: configured.provider,
          registerToolSession: (session) => {
            turn.toolSession = { ...session, executions: 0, seenMemories: new Map() }
            return () => { delete turn.toolSession }
          },
        }, turn.controller.signal), deps.wakeMemoryJobs)
      deps.wakeMemoryJobs?.()
      return { userMessageId: savedMessageId, events }
    },

    startPreviewTurn: (request) => {
      if (closing) throw new Error('E_BACKEND_STOPPING')
      // 草稿先归一：分区/全文二选一的规则与保存路径同源，坏草稿不出服务层。
      const draft = resolvePreviewDraft(request)
      if (!draft) throw new Error('E_INVALID_DRAFT_PERSONA')
      const peekDb = deps.getDb()
      if (!peekDb) throw new Error('E_DB_NOT_OPEN')
      const character = getFirstCharacter(peekDb)
      if (!character) throw new Error('E_CHARACTER_NOT_FOUND')
      if (activeCharacters.has(character.id)) throw new Error('E_TURN_IN_PROGRESS')
      // preview 会话由后台解析/创建：界面不能指定会话，也不能借试聊碰正式会话。
      // 新建会话与接收请求一起检查；后者失败时前者也撤回，不留一次失败试聊的空壳。
      const { conversation, started } = peekDb.transaction(() => {
        const conversation = ensurePreviewConversation(peekDb, character.id)
        return { conversation, started: beginTurn(conversation.id, request.requestId, request.content, 'preview') }
      })
      const { db, eve, savedMessageId, characterId, pendingWrite } = started
      const configured = deps.getModelConfiguration?.() ?? { model: MODEL_NAME, provider: PROVIDER_NAME, limits: deps.limits }
      return {
        userMessageId: savedMessageId,
        conversationId: conversation.id,
        events: registerTurn(conversation.id, characterId, savedMessageId, eve,
          (turn) => pendingWrite ? replayWrite(db, pendingWrite) : runPreviewTurn(db, eve!, {
            conversationId: conversation.id, userMessageId: savedMessageId,
            commonRules: COMMON_RULES_TEXT, draft, limits: configured.limits,
            model: configured.model, provider: configured.provider,
          }, turn.controller.signal)),
      }
    },
  }
}
