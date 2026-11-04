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
import {
  resolvePreviewDraft, type ChatTurnRequest, type PreviewTurnRequest, type SseTurnEvent,
} from '../shared/chat-turn'

/**
 * 共同事实规则来自已确认的完整样稿，和角色草稿分开交付，
 * 防止只接入三句临时规则而丢掉引用、假设和工具结果的具体边界。
 */
export const COMMON_RULES_TEXT = COMMON_FACT_RULES

/** 依 08 的 T01 基线记账用名称；换模型入口在 T11。 */
const MODEL_NAME = 'glm-5.3-flash'
const PROVIDER_NAME = 'zhipu'

/** 创建服务所需的依赖；都用「取值函数」是让运行期换密钥/换库立即生效。 */
export interface ChatTurnServiceDeps {
  getDb: () => BetterSQLite3Database | undefined
  /** 当前在岗的 eve；没有密钥时是 undefined，回合请求会得到明确错误。 */
  getEve: () => EveHandle | undefined
  /** 模型窗口与输出预留；测试可注入小窗口制造预算失败。 */
  limits: ModelInputLimits
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
    events?: AsyncGenerator<SseTurnEvent>
    completed: Promise<void>
    finish: () => void
    toolSession?: ActiveToolSession & { executions: number }
  }
  // 会话编号用来定位停止对象，角色编号用来挡下正式/试聊之间的并发。
  // 两份登记一起建立、一起清理；挡下请求时还没有保存新的用户消息。
  const active = new Map<string, ActiveTurn>()
  const activeCharacters = new Set<string>()
  // 只临时保留尚未写成的结果，不写日志；同一请求重试时先补写，不能再花一次模型钱。
  const pendingWrites = new Map<string, PendingTurnWrite>()
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
      for (const [userMessageId, write] of pendingWrites) {
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
    runStart: (turn: ActiveTurn) => AsyncGenerator<TurnEvent, TurnOutcome>,
  ): AsyncGenerator<SseTurnEvent> {
    let finish!: () => void
    const turn: ActiveTurn = {
      controller: new AbortController(),
      completed: new Promise<void>((resolve) => { finish = resolve }), finish: () => finish(),
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
        for (;;) {
          const step = await runner.next()
          if (step.done) {
            if (step.value.pendingWrite) pendingWrites.set(userMessageId, step.value.pendingWrite)
            else pendingWrites.delete(userMessageId)
            // 先接住待补写资料，再把保存失败交给界面；断线不会丢掉这次结果。
            if (terminalEvent) yield terminalEvent as SseTurnEvent
            break
          }
          // Agent 层的 TurnEvent 与线上帧形状一致，这里原样转发。
          if (step.value.type === 'text') yield step.value as SseTurnEvent
          else terminalEvent = step.value
        }
      } catch (error) {
        const code = error instanceof Error && /^E_[A-Z0-9_]+$/.test(error.message) ? error.message : 'E_TURN_FAILED'
        yield { type: 'failed', code }
      } finally {
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
    if (activeCharacters.has(conversation.characterId)) throw new Error('E_TURN_IN_PROGRESS')
    const existing = db.select().from(messages).where(and(
      eq(messages.conversationId, conversationId), eq(messages.clientRequestId, requestId),
    )).get()
    const pendingWrite = existing && pendingWrites.get(existing.id)
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
          return rememberExplicit(db, { conversationId, userMessageId: reply.replyToId }, request.input, Date.now())
        }
        const current = listCurrentMemories(db, conversation.characterId, Date.now())
        return { ok: true, memories: searchMemories(current, request.input.query, request.input.limit) }
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
      return {
        userMessageId: savedMessageId,
        events: registerTurn(request.conversationId, characterId, savedMessageId,
          (turn) => pendingWrite ? replayWrite(db, pendingWrite) : runFormalTurn(db, eve!, {
            conversationId: request.conversationId, userMessageId: savedMessageId,
            commonRules: COMMON_RULES_TEXT, limits: deps.limits,
            model: MODEL_NAME, provider: PROVIDER_NAME,
            registerToolSession: (session) => {
              turn.toolSession = { ...session, executions: 0 }
              return () => { delete turn.toolSession }
            },
          }, turn.controller.signal)),
      }
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
      return {
        userMessageId: savedMessageId,
        conversationId: conversation.id,
        events: registerTurn(conversation.id, characterId, savedMessageId,
          (turn) => pendingWrite ? replayWrite(db, pendingWrite) : runPreviewTurn(db, eve!, {
            conversationId: conversation.id, userMessageId: savedMessageId,
            commonRules: COMMON_RULES_TEXT, draft, limits: deps.limits,
            model: MODEL_NAME, provider: PROVIDER_NAME,
          }, turn.controller.signal)),
      }
    },
  }
}
