/**
 * 用固定 eve 句柄检查先登记、后发送的准备顺序，以及框架缓存可丢失重建。
 * 只用内存测试库与模拟会话，不启动框架、不发模型请求，也不读取正式资料。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { openCompanionDatabase, type CompanionDb } from '../src/data/db'
import { runMigrations } from '../src/data/migrations'
import { initializeFirstCharacter } from '../src/data/character-init'
import { saveUserMessage, createAssistantReply, updateAssistantReply } from '../src/data/messages'
import { setRuntimeSessionId } from '../src/data/conversations'
import { bumpContextEpoch } from '../src/data/epochs'
import { characters, characterVersions, companionSettings, conversations, messages } from '../src/data/tables'
import { prepareEveTurn, sendPreparedEveTurn, releasePreparedEveTurn } from '../src/agent/eve-turn'
import { decodeEveTurnEnvelope } from '../src/shared/eve-turn-envelope'
import type { EveHandle } from '../src/agent/eve-process'

const fake = vi.hoisted(() => ({ create: vi.fn(), reset: vi.fn(), send: vi.fn() }))
vi.mock('eve/client', () => ({
  Client: class { sessions = { create: fake.create } },
}))
const handle: EveHandle = { port: 12345, token: 'test-only-token', dataDir: 'unused', stop: async () => {} }
let companion: CompanionDb
let conversationId: string
let userMessageId: string
const limits = { modelWindowTokens: 32_000 }

beforeEach(() => {
  vi.resetAllMocks()
  companion = openCompanionDatabase(':memory:')
  runMigrations(companion.sqlite)
  conversationId = initializeFirstCharacter(companion.db, {
    name: '测试角色', personaText: '固定性格', initialRelationship: '恋人', timezone: 'Asia/Hong_Kong',
  }).conversationId
  const previous = saveUserMessage(companion.db, { conversationId, requestId: 'old', content: '旧问题' }).message
  const reply = createAssistantReply(companion.db, { userMessageId: previous.id })
  updateAssistantReply(companion.db, { messageId: reply.id, content: '旧回复', status: 'completed' })
  userMessageId = saveUserMessage(companion.db, { conversationId, requestId: 'current', content: '当前问题' }).message.id
  fake.reset.mockResolvedValue({ status: 'reset' })
  fake.create.mockResolvedValue({ session: { state: { sessionId: 'eve-new' }, reset: fake.reset, send: fake.send } })
})

afterEach(() => companion.close())

/** 每次只从应用库取正式上下文，不提供读取旧框架记录的接口。 */
function prepare(signal = new AbortController().signal) {
  return prepareEveTurn(companion.db, handle, { conversationId, userMessageId, commonRules: '不编造经历。' }, limits, signal)
}

/** 读取应用库里的框架便签，不通过框架缓存推断聊天归属。 */
function runtimeId() {
  return companion.db.select().from(conversations).where(eq(conversations.id, conversationId)).get()?.runtimeSessionId
}

describe('干净 eve 会话准备（T06⑩a）', () => {
  it('回合结束只终止自己的框架会话，保留SQLite消息并清便签', async () => {
    const prepared = await prepare()
    const before = companion.db.select().from(messages).all()
    expect(await releasePreparedEveTurn(companion.db, prepared)).toBe(true)
    expect(fake.reset).toHaveBeenCalledTimes(1)
    expect(runtimeId()).toBeNull()
    expect(companion.db.select().from(messages).all()).toEqual(before)
  })

  it('旧回合回收不擦掉新编号；回收失败不伪造成功或删便签', async () => {
    const prepared = await prepare()
    setRuntimeSessionId(companion.db, conversationId, 'newer-turn')
    expect(await releasePreparedEveTurn(companion.db, prepared)).toBe(true)
    expect(runtimeId()).toBe('newer-turn')
    fake.reset.mockRejectedValue(new Error('fixed-secret-and-prompt'))
    expect(await releasePreparedEveTurn(companion.db, prepared)).toBe(false)
    expect(runtimeId()).toBe('newer-turn')
    expect(fake.send).not.toHaveBeenCalled()
  })
  it('无正文建会话后才登记；返回前不发送、不以受理当回复成功', async () => {
    const signal = new AbortController().signal
    const prepared = await prepare(signal)
    expect(fake.create).toHaveBeenCalledWith({ signal })
    expect(runtimeId()).toBe('eve-new')
    expect(prepared.context.currentMessage.id).toBe(userMessageId)
    expect(prepared.input.prompt.at(-1)).toEqual({ role: 'user', content: '当前问题' })
    expect(fake.send).not.toHaveBeenCalled()
    expect(companion.db.select().from(messages).all()).toHaveLength(3)
  })

  it('旧编号失效或被清空，仍从 SQLite 准备相同历史并换新框架编号', async () => {
    setRuntimeSessionId(companion.db, conversationId, 'lost-eve-cache')
    const first = await prepare()
    setRuntimeSessionId(companion.db, conversationId, null)
    fake.create.mockResolvedValueOnce({ session: { state: { sessionId: 'eve-second' }, reset: fake.reset } })
    const second = await prepare()
    expect(second.input).toEqual(first.input)
    expect(second.context.conversationId).toBe(first.context.conversationId)
    expect(second.input.prompt.map((item) => item.content)).toContain('旧回复')
    expect(runtimeId()).toBe('eve-second')
    expect(fake.create).toHaveBeenCalledTimes(2)
  })

  it('预算失败时不建立框架会话，原便签保留', async () => {
    setRuntimeSessionId(companion.db, conversationId, 'original')
    await expect(prepareEveTurn(companion.db, handle, {
      conversationId, userMessageId, commonRules: '规则',
    }, { modelWindowTokens: 1_000, outputReserveTokens: 1_000 }, new AbortController().signal))
      .rejects.toThrow('E_CONTEXT_BUDGET_EXCEEDED')
    expect(runtimeId()).toBe('original')
    expect(fake.create).not.toHaveBeenCalled()
  })

  it('两个完整角色各换自己的框架编号，历史不会交叉', async () => {
    const character = companion.db.select().from(characters).get()!
    const version = companion.db.select().from(characterVersions).get()!
    const conversation = companion.db.select().from(conversations).get()!
    const settings = companion.db.select().from(companionSettings).get()!
    companion.db.transaction((tx) => {
      tx.insert(characters).values({ ...character, id: 'second', name: '第二角色' }).run()
      tx.insert(characterVersions).values({ ...version, id: 'second-version', characterId: 'second' }).run()
      tx.insert(conversations).values({ ...conversation, id: 'second-conversation', characterId: 'second' }).run()
      tx.insert(companionSettings).values({ ...settings, characterId: 'second' }).run()
    })
    const other = saveUserMessage(companion.db, {
      conversationId: 'second-conversation', requestId: 'other-current', content: '第二角色的问题',
    }).message
    await prepare()
    fake.create.mockResolvedValueOnce({ session: { state: { sessionId: 'eve-other' }, reset: fake.reset } })
    const prepared = await prepareEveTurn(companion.db, handle, {
      conversationId: 'second-conversation', userMessageId: other.id, commonRules: '不编造经历。',
    }, limits, new AbortController().signal)
    expect(prepared.context.characterId).toBe('second')
    expect(prepared.input.historyMessageIds).toEqual([])
    expect(prepared.input.prompt.at(-1)?.content).toBe('第二角色的问题')
    expect(runtimeId()).toBe('eve-new')
    expect(companion.db.select().from(conversations).where(eq(conversations.id, 'second-conversation'))
      .get()?.runtimeSessionId).toBe('eve-other')
  })

  it('正式准备入口拒绝 preview，不创建或登记框架会话', async () => {
    const formal = companion.db.select().from(conversations).get()!
    companion.db.insert(conversations).values({ ...formal, id: 'preview', mode: 'preview' }).run()
    const preview = saveUserMessage(companion.db, {
      conversationId: 'preview', requestId: 'preview-message', content: '试聊消息',
    }).message
    await expect(prepareEveTurn(companion.db, handle, {
      conversationId: 'preview', userMessageId: preview.id, commonRules: '不编造经历。',
    }, limits, new AbortController().signal)).rejects.toThrow('E_PREVIEW_NOT_ALLOWED')
    expect(fake.create).not.toHaveBeenCalled()
    expect(runtimeId()).toBeNull()
  })

  it('创建失败只给固定错误，不改便签、不转发框架原始正文', async () => {
    fake.create.mockRejectedValue(new Error('test-secret-and-dialogue'))
    await expect(prepare()).rejects.toThrow(/^E_EVE_SESSION_FAILED$/)
    expect(runtimeId()).toBeNull()
    expect(fake.send).not.toHaveBeenCalled()
  })

  it('数据库不可写时回收空会话，不发送消息，旧映射不被覆盖', async () => {
    setRuntimeSessionId(companion.db, conversationId, 'old')
    companion.sqlite.pragma('query_only = ON')
    await expect(prepare()).rejects.toThrow(/^E_STORAGE_UNAVAILABLE$/)
    expect(runtimeId()).toBe('old')
    expect(fake.reset).toHaveBeenCalledTimes(1)
    expect(fake.send).not.toHaveBeenCalled()
  })

  it('请求前取消不建会话；创建期间取消则回收，不登记', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(prepare(controller.signal)).rejects.toThrow(/^E_CANCELLED$/)
    expect(fake.create).not.toHaveBeenCalled()
    const pending = new AbortController()
    fake.create.mockImplementationOnce(async () => {
      pending.abort()
      return { session: { state: { sessionId: 'cancelled' }, reset: fake.reset } }
    })
    await expect(prepare(pending.signal)).rejects.toThrow(/^E_CANCELLED$/)
    expect(runtimeId()).toBeNull()
    expect(fake.reset).toHaveBeenCalledTimes(1)
  })

  it('等待建会话期间内容版本变化，拒绝旧快照并回收', async () => {
    fake.create.mockImplementationOnce(async () => {
      bumpContextEpoch(companion.db, conversationId)
      return { session: { state: { sessionId: 'stale' }, reset: fake.reset } }
    })
    await expect(prepare()).rejects.toThrow(/^E_CONTEXT_CHANGED$/)
    expect(runtimeId()).toBeNull()
    expect(fake.reset).toHaveBeenCalledTimes(1)
  })

  it('登记成功后发送固定信封，只返回受理句柄，不提前保存成功回复', async () => {
    const prepared = await prepare()
    const accepted = { sessionId: 'eve-new' }
    fake.send.mockResolvedValue(accepted)
    const signal = new AbortController().signal
    expect(await sendPreparedEveTurn(companion.db, prepared, signal)).toBe(accepted)
    const [body, options] = fake.send.mock.calls[0]
    expect(decodeEveTurnEnvelope(body)).toMatchObject({
      prompt: prepared.input.prompt, optionalPromptGroups: prepared.input.optionalPromptGroups,
      modelWindowTokens: 32_000, outputReserveTokens: 0,
    })
    expect(options).toEqual({ signal, streamReconnectPolicy: { reconnect: false } })
    expect(companion.db.select().from(messages).all()).toHaveLength(3)
  })

  it('发送前取消、内容版本或框架映射变化时拒绝，供应商不会收到这份旧输入', async () => {
    const prepared = await prepare()
    const controller = new AbortController()
    controller.abort()
    await expect(sendPreparedEveTurn(companion.db, prepared, controller.signal)).rejects.toThrow(/^E_CANCELLED$/)
    setRuntimeSessionId(companion.db, conversationId, 'different-session')
    await expect(sendPreparedEveTurn(companion.db, prepared, new AbortController().signal))
      .rejects.toThrow(/^E_CONTEXT_CHANGED$/)
    setRuntimeSessionId(companion.db, conversationId, 'eve-new')
    bumpContextEpoch(companion.db, conversationId)
    await expect(sendPreparedEveTurn(companion.db, prepared, new AbortController().signal))
      .rejects.toThrow(/^E_CONTEXT_CHANGED$/)
    expect(fake.send).not.toHaveBeenCalled()
  })

  it('发送结果不明也不重发同一准备结果，框架错误只给固定码', async () => {
    const prepared = await prepare()
    fake.send.mockRejectedValue(new Error('test-secret-and-dialogue'))
    await expect(sendPreparedEveTurn(companion.db, prepared, new AbortController().signal))
      .rejects.toThrow(/^E_EVE_SEND_FAILED$/)
    await expect(sendPreparedEveTurn(companion.db, prepared, new AbortController().signal))
      .rejects.toThrow(/^E_EVE_TURN_ALREADY_SENT$/)
    expect(fake.send).toHaveBeenCalledTimes(1)
  })
})
