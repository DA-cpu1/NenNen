/**
 * 聊天回合的后台服务：管「谁正在说话」这本登记簿，把界面请求接到回合编排。
 * 一个会话同一时刻只允许一个活动回合——并发连点由这里挡下，而不是让两个
 * 模型调用互相覆盖框架会话映射。事件流对外只出不进：界面的停止请求走
 * cancelTurn（打断 AbortController），不往流里塞命令。
 */
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { and, eq } from 'drizzle-orm'
import { messages } from '../data/tables'
import { saveUserMessage } from '../data/messages'
import { getFirstCharacter } from '../data/character-init'
import { ensurePreviewConversation } from '../data/conversations'
import { runFormalTurn, runPreviewTurn } from '../agent/turn-runner'
import type { ModelInputLimits } from '../agent/context-budget'
import type { EveHandle } from '../agent/eve-process'
import type { TurnEvent, TurnOutcome } from '../agent/eve-events'
import {
  resolvePreviewDraft, type ChatTurnRequest, type PreviewTurnRequest, type SseTurnEvent,
} from '../shared/chat-turn'

/**
 * 共同事实规则的固定文本（02 §1「共同原则」）。正式的规则配置入口在 T11
 * 设置页；在那之前用这份内置文本，不空着——空规则会被上下文准备直接拒绝。
 */
export const COMMON_RULES_TEXT = '不编造没有发生过的共同经历。不用内疚感迫使用户继续聊天。对工具执行结果如实转述。'

/**
 * 模型窗口的暂定值：与 eve Agent 配置里的 modelContextWindowTokens 一致
 * （08 记录过它是未实测的暂定数）。注意它不会放宽 12,000 的输入硬上限；
 * 真实窗口容量在真机验收（⑪i）时核实后收进 08。
 */
export const PROVISIONAL_MODEL_WINDOW_TOKENS = 128_000

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
}

/**
 * 建一个回合服务。登记簿放闭包里而不是模块顶层：测试各建各的实例，
 * 互不串门；正式进程只有一个实例。
 * @param deps 数据库/句柄取值函数与模型容量
 * @returns 回合服务
 */
export function createChatTurnService(deps: ChatTurnServiceDeps): ChatTurnService {
  // conversationId → 该回合的取消控制器。登记即占用：新的同会话请求在
  // 保存消息之前就被挡下，不会出现两轮并发的模型调用。
  const active = new Map<string, AbortController>()

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
    userMessageId: string,
    controller: AbortController,
    runStart: (signal: AbortSignal) => AsyncGenerator<TurnEvent, TurnOutcome>,
  ): AsyncGenerator<SseTurnEvent> {
    return (async function* generate(): AsyncGenerator<SseTurnEvent> {
      try {
        yield { type: 'saved', userMessageId, conversationId }
        const runner = runStart(controller.signal)
        for (;;) {
          const step = await runner.next()
          if (step.done) break
          // Agent 层的 TurnEvent 与线上帧形状一致，这里原样转发。
          yield step.value as SseTurnEvent
        }
      } catch (error) {
        const code = error instanceof Error && /^E_[A-Z0-9_]+$/.test(error.message) ? error.message : 'E_TURN_FAILED'
        yield { type: 'failed', code }
      } finally {
        active.delete(conversationId)
      }
    })()
  }

  /** 发起回合的公共前置：依赖校验、登记占用、带防重落库。 */
  function beginTurn(
    conversationId: string,
    requestId: string,
    content: string,
  ): { db: BetterSQLite3Database; eve: EveHandle; savedMessageId: string } {
    const db = deps.getDb()
    if (!db) throw new Error('E_DB_NOT_OPEN')
    const eve = deps.getEve()
    if (!eve) throw new Error('E_EVE_UNAVAILABLE')
    if (active.has(conversationId)) throw new Error('E_TURN_IN_PROGRESS')
    // 落库带防重：同编号同正文返回原消息；同编号换正文报冲突。
    const saved = saveUserMessage(db, { conversationId, requestId, content })
    assertNotAnswered(db, saved.message.id)
    return { db, eve, savedMessageId: saved.message.id }
  }

  return {
    activeCount: () => active.size,

    cancelTurn: (conversationId) => {
      const controller = active.get(conversationId)
      if (!controller) return false
      controller.abort()
      return true
    },

    startTurn: (request) => {
      const { db, eve, savedMessageId } = beginTurn(request.conversationId, request.requestId, request.content)
      const controller = new AbortController()
      active.set(request.conversationId, controller)
      return {
        userMessageId: savedMessageId,
        events: guardedEvents(request.conversationId, savedMessageId, controller,
          (signal) => runFormalTurn(db, eve, {
            conversationId: request.conversationId, userMessageId: savedMessageId,
            commonRules: COMMON_RULES_TEXT, limits: deps.limits,
            model: MODEL_NAME, provider: PROVIDER_NAME,
          }, signal)),
      }
    },

    startPreviewTurn: (request) => {
      // 草稿先归一：分区/全文二选一的规则与保存路径同源，坏草稿不出服务层。
      const draft = resolvePreviewDraft(request)
      if (!draft) throw new Error('E_INVALID_DRAFT_PERSONA')
      const peekDb = deps.getDb()
      if (!peekDb) throw new Error('E_DB_NOT_OPEN')
      const character = getFirstCharacter(peekDb)
      if (!character) throw new Error('E_CHARACTER_NOT_FOUND')
      // preview 会话由后台解析/创建：界面不能指定会话，也不能借试聊碰正式会话。
      const conversation = ensurePreviewConversation(peekDb, character.id)
      const { db, eve, savedMessageId } = beginTurn(conversation.id, request.requestId, request.content)
      const controller = new AbortController()
      active.set(conversation.id, controller)
      return {
        userMessageId: savedMessageId,
        conversationId: conversation.id,
        events: guardedEvents(conversation.id, savedMessageId, controller,
          (signal) => runPreviewTurn(db, eve, {
            conversationId: conversation.id, userMessageId: savedMessageId,
            commonRules: COMMON_RULES_TEXT, draft, limits: deps.limits,
            model: MODEL_NAME, provider: PROVIDER_NAME,
          }, signal)),
      }
    },
  }
}
