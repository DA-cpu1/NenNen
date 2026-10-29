/**
 * 用模拟 eve 句柄与固定事件序列检查回合编排：先留据后花钱的顺序、
 * 发送失败/中止的收尾、90 秒总时限与启动时的退出恢复。
 * 不启动框架、不连网络；数据库为内存库，不读正式资料。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, desc, eq } from 'drizzle-orm'
import { openCompanionDatabase, type CompanionDb } from '../src/data/db'
import { runMigrations } from '../src/data/migrations'
import { initializeFirstCharacter } from '../src/data/character-init'
import { saveUserMessage, createAssistantReply, updateAssistantReply } from '../src/data/messages'
import { startAgentRun } from '../src/data/agent-runs'
import { agentRuns, characterVersions, conversations, messages } from '../src/data/tables'
import { runFormalTurn, runPreviewTurn, recoverInterruptedTurns } from '../src/agent/turn-runner'
import { decodeEveTurnEnvelope } from '../src/shared/eve-turn-envelope'
import type { TurnEvent, TurnOutcome } from '../src/agent/eve-events'
import type { EveHandle } from '../src/agent/eve-process'
import type { MessageResponse } from 'eve/client'

const fake = vi.hoisted(() => ({ create: vi.fn(), reset: vi.fn(), send: vi.fn() }))
vi.mock('eve/client', () => ({
  Client: class { sessions = { create: fake.create } },
}))
const handle: EveHandle = { port: 12345, token: 'test-only-token', dataDir: 'unused', stop: async () => {} }
const limits = { modelWindowTokens: 32_000 }

let companion: CompanionDb
let conversationId: string
let userMessageId: string

beforeEach(() => {
  vi.resetAllMocks()
  companion = openCompanionDatabase(':memory:')
  runMigrations(companion.sqlite)
  conversationId = initializeFirstCharacter(companion.db, {
    name: '测试角色', personaText: '固定性格', initialRelationship: '恋人', timezone: 'Asia/Hong_Kong',
  }).conversationId
  userMessageId = saveUserMessage(companion.db, {
    conversationId, requestId: 'req-1', content: '固定问题',
  }).message.id
  fake.reset.mockResolvedValue({ status: 'reset' })
  fake.create.mockResolvedValue({ session: { state: { sessionId: 'eve-run' }, reset: fake.reset, send: fake.send } })
})
afterEach(() => {
  vi.useRealTimers()
  companion.close()
})

/** 测试用事件：只填消费代码实际读取的字段。 */
type FakeEvent = { type: string; data?: Record<string, unknown> }
function appended(delta: string): FakeEvent {
  return { type: 'message.appended', data: { messageDelta: delta, sequence: 1, stepIndex: 0, turnId: 't1' } }
}
function stepCompleted(inputTokens: number, outputTokens: number): FakeEvent {
  return { type: 'step.completed', data: { finishReason: 'stop', sequence: 3, stepIndex: 0, turnId: 't1', usage: { inputTokens, outputTokens } } }
}
function turnCompleted(): FakeEvent {
  return { type: 'turn.completed', data: { sequence: 9, turnId: 't1' } }
}
function turnCancelled(): FakeEvent {
  return { type: 'turn.cancelled', data: { sequence: 9, turnId: 't1' } }
}
function sessionCompleted(): FakeEvent {
  return { type: 'session.completed' }
}

/**
 * 造一个可吊住的假受理句柄：正常时逐个给出事件；hold 时下一段永远不来。
 * @param hold 事件发完后把迭代挂起，模拟模型或网络吊死
 */
function fakeResponse(events: FakeEvent[], hold = false) {
  const state = { cancelled: 0 }
  const response = {
    cancel: async () => { state.cancelled += 1 },
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event as never
      if (hold) await new Promise(() => { /* 永不到来的下一段 */ })
    },
  }
  return { response: response as unknown as MessageResponse, state }
}

/** 把生成器跑完，收集界面事件与最终汇总。 */
async function drive(generator: AsyncGenerator<TurnEvent, TurnOutcome>) {
  const events: TurnEvent[] = []
  for (;;) {
    const step = await generator.next()
    if (step.done) return { events, outcome: step.value }
    events.push(step.value)
  }
}

function run(signal = new AbortController().signal) {
  return runFormalTurn(companion.db, handle, {
    conversationId, userMessageId, commonRules: '不编造经历。', limits,
    model: 'fixed-model', provider: 'fixed-provider',
  }, signal)
}

function replyRows() {
  return companion.db.select().from(messages).where(eq(messages.conversationId, conversationId)).all()
}
/** 不依赖查询返回的行序（数据库不保证无 ORDER BY 的顺序），按最新顺序号取本轮回复。 */
function latestReply() {
  return companion.db.select().from(messages).where(and(
    eq(messages.conversationId, conversationId), eq(messages.role, 'assistant'),
  )).orderBy(desc(messages.seq)).limit(1).get()!
}
function runRows() {
  return companion.db.select().from(agentRuns).all()
}

describe('回合编排（T06⑪b）', () => {
  it('正常回合全链路：先留据后发送，结束时回复与账本都是终态', async () => {
    const { response } = fakeResponse([
      appended('你'), appended('好'), stepCompleted(31, 9), turnCompleted(), sessionCompleted(),
    ])
    fake.send.mockResolvedValue(response)
    const { events, outcome } = await drive(run())
    const reply = latestReply()
    expect(events).toEqual([
      { type: 'text', delta: '你' }, { type: 'text', delta: '好' }, { type: 'done', replyId: reply.id },
    ])
    expect(outcome).toEqual({ status: 'completed', finalText: '你好', usageEstimated: false })
    // 库里两行：用户消息 + 完成的角色回复。
    expect(replyRows()).toHaveLength(2)
    expect(reply).toMatchObject({ role: 'assistant', content: '你好', status: 'completed' })
    // 账本精确记账，版本来自准备阶段锁定的当前人设。
    expect(runRows()).toHaveLength(1)
    expect(runRows()[0]).toMatchObject({
      status: 'completed', inputTokens: 31, outputTokens: 9, usageEstimated: 0, model: 'fixed-model',
    })
    // 发出去的是信封，且当前消息在末尾。
    const body = fake.send.mock.calls[0][0] as string
    const envelope = decodeEveTurnEnvelope(body)
    expect(envelope?.prompt.at(-1)).toEqual({ role: 'user', content: '固定问题' })
  })

  it('准备阶段失败原样上抛：不留回复行、不记账、不发送', async () => {
    await expect(drive(runFormalTurn(companion.db, handle, {
      conversationId, userMessageId, commonRules: '规则',
      limits: { modelWindowTokens: 1_000 }, model: 'fixed-model', provider: 'fixed-provider',
    }, new AbortController().signal))).rejects.toThrow('E_CONTEXT_BUDGET_EXCEEDED')
    expect(replyRows()).toHaveLength(1)
    expect(runRows()).toHaveLength(0)
    expect(fake.send).not.toHaveBeenCalled()
  })

  it('同一用户消息已有进行中回复时先拒绝，不白建空会话', async () => {
    createAssistantReply(companion.db, { userMessageId })
    await expect(drive(run())).rejects.toThrow('E_REPLY_IN_PROGRESS')
    expect(fake.create).not.toHaveBeenCalled()
    expect(fake.send).not.toHaveBeenCalled()
    expect(runRows()).toHaveLength(0)
  })

  it('发送失败时回复与账本一并收成失败，用量按估算记账', async () => {
    fake.send.mockRejectedValue(new Error('网络断开的正文不进库'))
    const { events, outcome } = await drive(run())
    expect(events).toEqual([{ type: 'failed', code: 'E_EVE_SEND_FAILED' }])
    expect(outcome.status).toBe('failed')
    expect(latestReply()).toMatchObject({ role: 'assistant', content: '', status: 'failed' })
    expect(runRows()[0]).toMatchObject({
      status: 'failed', errorCode: 'E_EVE_SEND_FAILED', usageEstimated: 1,
      inputTokens: expect.any(Number), outputTokens: 1,
    })
    expect(runRows()[0].inputTokens! + runRows()[0].outputTokens!).toBeGreaterThan(0)
  })

  it('事件流中途取消走消费层收尾，半截文字保留', async () => {
    const { response } = fakeResponse([appended('部分'), turnCancelled()])
    fake.send.mockResolvedValue(response)
    const { events, outcome } = await drive(run())
    expect(events).toEqual([{ type: 'text', delta: '部分' }, { type: 'cancelled' }])
    expect(outcome).toEqual({ status: 'cancelled', finalText: '部分', usageEstimated: true })
    expect(latestReply()).toMatchObject({ content: '部分', status: 'cancelled' })
    expect(runRows()[0]).toMatchObject({ status: 'cancelled' })
  })

  it('总时限到点注入合成失败：半截保留、主动取消、不留定时器', async () => {
    vi.useFakeTimers()
    const { response, state } = fakeResponse([appended('半截')], true)
    fake.send.mockResolvedValue(response)
    const generator = run()
    // 第一段文字先到；随后模型吊住，下一段永远不来。
    expect((await generator.next()).value).toEqual({ type: 'text', delta: '半截' })
    await vi.advanceTimersByTimeAsync(90_000)
    let events: TurnEvent[] = []
    let outcome: TurnOutcome | undefined
    for (;;) {
      const step = await generator.next()
      if (step.done) { outcome = step.value; break }
      events.push(step.value)
    }
    expect(events).toEqual([{ type: 'failed', code: 'E_TURN_TIMEOUT' }])
    expect(outcome).toMatchObject({ status: 'failed', finalText: '半截' })
    expect(state.cancelled).toBe(1)
    expect(latestReply()).toMatchObject({ content: '半截', status: 'failed' })
    expect(runRows()[0]).toMatchObject({ status: 'failed', errorCode: 'E_TURN_TIMEOUT' })
    // 回合结束后计时器已清干净，不留到点空响的悬空定时器。
    expect(vi.getTimerCount()).toBe(0)
  })

  it('停止立即打断等待：框架取消不回应也收成 cancelled，不等 90 秒', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    let cancelCalls = 0
    const response = {
      cancel: () => {
        cancelCalls += 1
        return new Promise<void>(() => { /* 模拟供应商连取消也永不回应。 */ })
      },
      async *[Symbol.asyncIterator]() {
        yield appended('半截') as never
        await new Promise(() => { /* 模拟下一段文字永不回来。 */ })
      },
    } as unknown as MessageResponse
    fake.send.mockResolvedValue(response)
    const generator = run(controller.signal)
    expect((await generator.next()).value).toEqual({ type: 'text', delta: '半截' })
    const waiting = generator.next()
    controller.abort()
    // 没有推进模拟时钟：必须由取消信号唤醒，而不是等到总时限。
    expect((await waiting).value).toEqual({ type: 'cancelled' })
    expect((await generator.next()).value).toMatchObject({ status: 'cancelled', finalText: '半截' })
    expect(cancelCalls).toBe(1)
    expect(latestReply()).toMatchObject({ content: '半截', status: 'cancelled' })
    expect(runRows()[0]).toMatchObject({ status: 'cancelled' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('建空会话永不回应也受 90 秒总时限约束，不留回复和账本', async () => {
    vi.useFakeTimers()
    fake.create.mockImplementation(() => new Promise(() => { /* 建会话接口吊住。 */ }))
    const running = drive(run())
    // 先挂拒绝断言，避免推进模拟时钟后把预期的超时当成未处理异常。
    const rejected = expect(running).rejects.toThrow('E_TURN_TIMEOUT')
    await vi.advanceTimersByTimeAsync(90_000)
    await rejected
    expect(replyRows()).toHaveLength(1)
    expect(runRows()).toHaveLength(0)
    expect(fake.send).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('建空会话期间用户停止立即取消，不等接口回应，也不留下回复账本', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    fake.create.mockImplementation(() => new Promise(() => { /* 不回应中止信号的接口。 */ }))
    const running = drive(run(controller.signal))
    controller.abort()
    const { events, outcome } = await running
    expect(events).toEqual([{ type: 'cancelled' }])
    expect(outcome.status).toBe('cancelled')
    expect(replyRows()).toHaveLength(1)
    expect(runRows()).toHaveLength(0)
    expect(fake.send).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('发送受理永不回应也在 90 秒收尾，回复和账本均失败', async () => {
    vi.useFakeTimers()
    fake.send.mockImplementation(() => new Promise(() => { /* 发送已出门，受理结果不明。 */ }))
    const running = drive(run())
    await vi.advanceTimersByTimeAsync(90_000)
    const { events, outcome } = await running
    expect(events).toEqual([{ type: 'failed', code: 'E_TURN_TIMEOUT' }])
    expect(outcome).toMatchObject({ status: 'failed', finalText: '' })
    expect(latestReply()).toMatchObject({ status: 'failed' })
    expect(runRows()[0]).toMatchObject({ status: 'failed', errorCode: 'E_TURN_TIMEOUT', usageEstimated: 1 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('准备花掉 30 秒后，事件流只剩 60 秒，不重新获得完整时限', async () => {
    vi.useFakeTimers()
    fake.create.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30_000))
      return { session: { state: { sessionId: 'eve-run' }, reset: fake.reset, send: fake.send } }
    })
    const { response } = fakeResponse([appended('半截')], true)
    fake.send.mockResolvedValue(response)
    const running = drive(run())
    await vi.advanceTimersByTimeAsync(89_999)
    expect(latestReply()).toMatchObject({ content: '半截', status: 'streaming' })
    await vi.advanceTimersByTimeAsync(1)
    const { events } = await running
    expect(events.at(-1)).toEqual({ type: 'failed', code: 'E_TURN_TIMEOUT' })
    expect(latestReply()).toMatchObject({ content: '半截', status: 'failed' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('发送超时后才回来的受理句柄会被取消，不再读取迟到回复', async () => {
    vi.useFakeTimers()
    let resolveSend!: (response: MessageResponse) => void
    fake.send.mockImplementation(() => new Promise<MessageResponse>((resolve) => { resolveSend = resolve }))
    const running = drive(run())
    await vi.advanceTimersByTimeAsync(90_000)
    expect((await running).events).toEqual([{ type: 'failed', code: 'E_TURN_TIMEOUT' }])
    const { response, state } = fakeResponse([appended('迟到回复'), turnCompleted()])
    resolveSend(response)
    await vi.advanceTimersByTimeAsync(0)
    expect(state.cancelled).toBe(1)
    expect(latestReply()).toMatchObject({ content: '', status: 'failed' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('试聊回合：草稿进信封、账本记空版本且 trigger 为 preview', async () => {
    // 同角色开一条 preview 会话并保存用户消息。
    const formal = companion.db.select().from(conversations).where(eq(conversations.id, conversationId)).get()!
    companion.db.insert(conversations).values({ ...formal, id: 'preview-1', mode: 'preview' }).run()
    const previewUser = saveUserMessage(companion.db, {
      conversationId: 'preview-1', requestId: 'preview-r1', content: '试聊问题',
    }).message.id
    const { response } = fakeResponse([appended('哼。'), turnCompleted(), sessionCompleted()])
    fake.send.mockResolvedValue(response)
    const { events, outcome } = await drive(runPreviewTurn(companion.db, handle, {
      conversationId: 'preview-1', userMessageId: previewUser, commonRules: '不编造经历。',
      draft: {
        personaText: '草稿人设：说话带「哼」。', initialRelationship: '暧昧',
        userNickname: null, dialogueExamples: [],
      },
      limits, model: 'fixed-model', provider: 'fixed-provider',
    }, new AbortController().signal))
    const previewReply = companion.db.select().from(messages).where(and(
      eq(messages.conversationId, 'preview-1'), eq(messages.role, 'assistant'),
    )).orderBy(desc(messages.seq)).limit(1).get()!
    expect(events.at(-1)).toEqual({ type: 'done', replyId: previewReply.id })
    expect(outcome).toEqual({ status: 'completed', finalText: '哼。', usageEstimated: true })
    const body = fake.send.mock.calls[0][0] as string
    expect(decodeEveTurnEnvelope(body)?.prompt[1].content).toContain('草稿人设')
    expect(runRows()[0]).toMatchObject({
      triggerType: 'preview', characterVersionId: null, status: 'completed',
    })
  })

  it('启动恢复把进行中的回复与账本收成失败，已完成的不动', async () => {
    const interrupted = createAssistantReply(companion.db, { userMessageId })
    const activeVersion = companion.db.select({ id: characterVersions.id }).from(characterVersions)
      .where(eq(characterVersions.isActive, 1)).get()!
    const interruptedRun = startAgentRun(companion.db, {
      conversationId, characterVersionId: activeVersion.id, model: 'm', provider: 'p',
    })
    // 另一组早已完成的记录：恢复不应碰它们。
    const doneUser = saveUserMessage(companion.db, {
      conversationId, requestId: 'req-2', content: '旧问题',
    }).message
    const doneReply = createAssistantReply(companion.db, { userMessageId: doneUser.id })
    updateAssistantReply(companion.db, { messageId: doneReply.id, content: '旧回复', status: 'completed' })

    const result = recoverInterruptedTurns(companion.db, 123)
    expect(result).toEqual({ replies: 1, runs: 1 })
    const interruptedRow = companion.db.select().from(messages).where(eq(messages.id, interrupted.id)).get()!
    expect(interruptedRow.status).toBe('failed')
    const runRow = companion.db.select().from(agentRuns).where(eq(agentRuns.id, interruptedRun.id)).get()!
    expect(runRow).toMatchObject({ status: 'failed', errorCode: 'E_INTERRUPTED', usageEstimated: 1, finishedAt: 123 })
    expect(runRow.inputTokens).toBeNull()
    const doneRow = companion.db.select().from(messages).where(eq(messages.id, doneReply.id)).get()!
    expect(doneRow).toMatchObject({ content: '旧回复', status: 'completed' })
  })
})
