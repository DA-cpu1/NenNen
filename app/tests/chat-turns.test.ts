/**
 * 用内存库与模拟 eve 检查回合服务：登记簿挡并发、防重与「已回复不再花钱」、
 * 事件流必然走到终点、取消把回合收成 cancelled。不启动框架、不连网络。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { desc, eq } from 'drizzle-orm'
import { openCompanionDatabase, type CompanionDb } from '../src/data/db'
import { runMigrations } from '../src/data/migrations'
import { initializeFirstCharacter } from '../src/data/character-init'
import { agentRuns, conversations, messages } from '../src/data/tables'
import { createChatTurnService } from '../src/service/chat-turns'
import type { EveHandle } from '../src/agent/eve-process'
import type { SseTurnEvent } from '../src/shared/chat-turn'
import type { MessageResponse } from 'eve/client'

const fake = vi.hoisted(() => ({ create: vi.fn(), reset: vi.fn(), send: vi.fn() }))
vi.mock('eve/client', () => ({
  Client: class { sessions = { create: fake.create } },
}))
const handle: EveHandle = { port: 12345, token: 'test-only-token', dataDir: 'unused', stop: async () => {} }

let companion: CompanionDb
let conversationId: string

beforeEach(() => {
  vi.resetAllMocks()
  companion = openCompanionDatabase(':memory:')
  runMigrations(companion.sqlite)
  conversationId = initializeFirstCharacter(companion.db, {
    name: '测试角色', personaText: '固定性格', initialRelationship: '恋人', timezone: 'Asia/Hong_Kong',
  }).conversationId
  fake.reset.mockResolvedValue({ status: 'reset' })
  fake.create.mockResolvedValue({ session: { state: { sessionId: 'eve-1' }, reset: fake.reset, send: fake.send } })
})
afterEach(() => companion.close())

type FakeEvent = { type: string; data?: Record<string, unknown> }
const appended = (delta: string): FakeEvent => ({ type: 'message.appended', data: { messageDelta: delta } })
const turnCompleted = (): FakeEvent => ({ type: 'turn.completed', data: {} })
const sessionCompleted = (): FakeEvent => ({ type: 'session.completed' })

/**
 * 假受理句柄：正常时逐个给出事件；holdUntilCancelled 时下一段挂起，
 * 直到 cancel() 被调用才补一条 turn.cancelled 并结束——模拟真实框架
 * 「协作取消后服务器把回合收成取消、流到边界」的行为。
 */
function fakeResponse(events: FakeEvent[], holdUntilCancelled = false) {
  const state = { cancelled: 0 }
  let release: () => void = () => { /* 尚未挂起时收到取消也无妨 */ }
  const held = new Promise<void>((resolve) => { release = resolve })
  const response = {
    cancel: async () => {
      state.cancelled += 1
      if (holdUntilCancelled) release()
    },
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event as never
      if (holdUntilCancelled) {
        await held
        yield { type: 'turn.cancelled', data: {} } as never
      }
    },
  }
  return { response: response as unknown as MessageResponse, state }
}

async function collect(events: AsyncGenerator<SseTurnEvent>): Promise<SseTurnEvent[]> {
  const frames: SseTurnEvent[] = []
  for (;;) {
    const step = await events.next()
    if (step.done) return frames
    frames.push(step.value)
  }
}

function service() {
  return createChatTurnService({
    getDb: () => companion.db, getEve: () => handle, limits: { modelWindowTokens: 32_000 },
  })
}
function latestReply() {
  return companion.db.select().from(messages).where(eq(messages.role, 'assistant'))
    .orderBy(desc(messages.seq)).limit(1).get()!
}

describe('聊天回合服务（T06⑪c1）', () => {
  it('正常回合：首帧 saved，转发文字与完成帧，结束腾出登记簿', async () => {
    const { response } = fakeResponse([appended('你好'), turnCompleted(), sessionCompleted()])
    fake.send.mockResolvedValue(response)
    const turns = service()
    const { userMessageId, events } = turns.startTurn({
      conversationId, requestId: 'r1', content: '固定问题',
    })
    const frames = await collect(events)
    expect(frames[0]).toEqual({ type: 'saved', userMessageId, conversationId })
    expect(frames).toEqual([
      { type: 'saved', userMessageId, conversationId }, { type: 'text', delta: '你好' },
      { type: 'done', replyId: latestReply().id },
    ])
    expect(latestReply()).toMatchObject({ content: '你好', status: 'completed' })
    expect(turns.activeCount()).toBe(0)
  })

  it('活动回合期间同会话新请求被登记簿挡下，其他会话不受影响', async () => {
    const { response } = fakeResponse([appended('慢'), turnCompleted(), sessionCompleted()], true)
    fake.send.mockResolvedValue(response)
    // 同角色再开一条正式会话，验证登记按会话隔离（首版每角色一条，这里只测隔离语义）。
    const formal = companion.db.select().from(conversations).get()!
    companion.db.insert(conversations).values({ ...formal, id: 'conv-2' }).run()
    const turns = service()
    const first = turns.startTurn({ conversationId, requestId: 'r1', content: '第一句' })
    expect(() => turns.startTurn({ conversationId, requestId: 'r2', content: '插队' }))
      .toThrow('E_TURN_IN_PROGRESS')
    const second = turns.startTurn({ conversationId: 'conv-2', requestId: 'r2', content: '另一会话' })
    expect(second.userMessageId).not.toBe(first.userMessageId)
    // 各自收尾：第一路取消收流；第二路只取消不消费（事件流是惰性的，不读就不跑）。
    turns.cancelTurn(conversationId)
    await collect(first.events)
    turns.cancelTurn('conv-2')
  })

  it('没有 eve 或没有库时给出明确错误码，不碰数据', () => {
    const noEve = createChatTurnService({
      getDb: () => companion.db, getEve: () => undefined, limits: { modelWindowTokens: 32_000 },
    })
    expect(() => noEve.startTurn({ conversationId, requestId: 'r1', content: '内容' }))
      .toThrow('E_EVE_UNAVAILABLE')
    const noDb = createChatTurnService({
      getDb: () => undefined, getEve: () => handle, limits: { modelWindowTokens: 32_000 },
    })
    expect(() => noDb.startTurn({ conversationId, requestId: 'r1', content: '内容' }))
      .toThrow('E_DB_NOT_OPEN')
  })

  it('同一编号重发在成功后不再花第二次模型钱', async () => {
    const { response } = fakeResponse([appended('回答'), turnCompleted(), sessionCompleted()])
    fake.send.mockResolvedValue(response)
    const turns = service()
    await collect(turns.startTurn({ conversationId, requestId: 'r1', content: '问题' }).events)
    expect(() => turns.startTurn({ conversationId, requestId: 'r1', content: '问题' }))
      .toThrow('E_ALREADY_REPLIED')
    expect(fake.send).toHaveBeenCalledTimes(1)
    // 同编号不同正文：防重冲突照常生效。
    expect(() => turns.startTurn({ conversationId, requestId: 'r1', content: '换内容' }))
      .toThrow('E_REQUEST_CONFLICT')
  })

  it.each(['reply', 'run'] as const)('%s 保存失败后重试只补写原结果，恢复前后都不再调用模型', async (target) => {
    companion.sqlite.exec(target === 'reply' ? `
      CREATE TRIGGER fail_final_write BEFORE UPDATE OF status ON messages
      WHEN NEW.role = 'assistant' AND NEW.status = 'completed'
      BEGIN SELECT RAISE(ABORT, 'fixed-test-failure'); END;
    ` : `
      CREATE TRIGGER fail_final_write BEFORE UPDATE ON agent_runs
      BEGIN SELECT RAISE(ABORT, 'fixed-test-failure'); END;
    `)
    fake.send.mockResolvedValue(fakeResponse([appended('完整回复'), turnCompleted(), sessionCompleted()]).response)
    let eveAvailable = true
    const turns = createChatTurnService({
      getDb: () => companion.db, getEve: () => eveAvailable ? handle : undefined,
      limits: { modelWindowTokens: 32_000 },
    })
    const request = { conversationId, requestId: 'save-r1', content: '固定问题' }
    const first = await collect(turns.startTurn(request).events)
    const expectedCode = target === 'reply' ? 'E_REPLY_SAVE_FAILED' : 'E_RUN_SAVE_FAILED'
    expect(first.at(-1)).toEqual({ type: 'failed', code: expectedCode })
    expect(latestReply()).toMatchObject({ status: 'streaming', content: '完整回复' })
    expect(companion.db.select().from(agentRuns).get()).toMatchObject({ status: 'running' })
    // 后台模型已退出也能补写；库仍未恢复时保留待写资料，不另建一次尝试。
    eveAvailable = false
    expect((await collect(turns.startTurn(request).events)).at(-1)).toEqual({ type: 'failed', code: expectedCode })
    expect(() => turns.startTurn({ ...request, content: '改写原话' })).toThrow('E_REQUEST_CONFLICT')
    companion.sqlite.exec('DROP TRIGGER fail_final_write')
    const restored = await collect(turns.startTurn(request).events)
    expect(restored.at(-1)).toEqual({ type: 'done', replyId: latestReply().id })
    expect(restored.some((frame) => frame.type === 'text')).toBe(false)
    expect(latestReply()).toMatchObject({ status: 'completed', content: '完整回复' })
    expect(companion.db.select().from(agentRuns).get()).toMatchObject({ status: 'completed' })
    eveAvailable = true
    expect(() => turns.startTurn(request)).toThrow('E_ALREADY_REPLIED')
    expect(fake.create).toHaveBeenCalledTimes(1)
    expect(fake.send).toHaveBeenCalledTimes(1)
    expect(companion.db.select().from(messages).all()).toHaveLength(2)
    expect(companion.db.select().from(agentRuns).all()).toHaveLength(1)
    expect(turns.activeCount()).toBe(0)
  })

  it('模型原本失败时，补写恢复后仍返回原失败原因，不改成成功或再次调用模型', async () => {
    companion.sqlite.exec(`
      CREATE TRIGGER fail_failed_reply BEFORE UPDATE OF status ON messages
      WHEN NEW.role = 'assistant' AND NEW.status = 'failed'
      BEGIN SELECT RAISE(ABORT, 'fixed-test-failure'); END;
    `)
    fake.send.mockResolvedValue(fakeResponse([
      appended('半截'), { type: 'turn.failed', data: { code: 'E_PROVIDER_DOWN' } },
    ]).response)
    const turns = service()
    const request = { conversationId, requestId: 'save-failed-r1', content: '固定问题' }
    expect((await collect(turns.startTurn(request).events)).at(-1)).toEqual({ type: 'failed', code: 'E_REPLY_SAVE_FAILED' })
    companion.sqlite.exec('DROP TRIGGER fail_failed_reply')
    expect((await collect(turns.startTurn(request).events)).at(-1)).toEqual({ type: 'failed', code: 'E_PROVIDER_DOWN' })
    expect(latestReply()).toMatchObject({ status: 'failed', content: '半截' })
    expect(companion.db.select().from(agentRuns).get()).toMatchObject({ status: 'failed', errorCode: 'E_PROVIDER_DOWN' })
    expect(fake.send).toHaveBeenCalledTimes(1)
    expect(companion.db.select().from(messages).all()).toHaveLength(2)
  })

  it('发送受理失败且收尾未保存时，恢复后只补写原失败，不重发模型请求', async () => {
    companion.sqlite.exec(`
      CREATE TRIGGER fail_send_failure BEFORE UPDATE OF status ON messages
      WHEN NEW.role = 'assistant' AND NEW.status = 'failed'
      BEGIN SELECT RAISE(ABORT, 'fixed-test-failure'); END;
    `)
    fake.send.mockRejectedValue(new Error('fixed-send-failure'))
    const turns = service()
    const request = { conversationId, requestId: 'send-failed-r1', content: '固定问题' }
    expect((await collect(turns.startTurn(request).events)).at(-1)).toEqual({ type: 'failed', code: 'E_REPLY_SAVE_FAILED' })
    companion.sqlite.exec('DROP TRIGGER fail_send_failure')
    expect((await collect(turns.startTurn(request).events)).at(-1)).toEqual({ type: 'failed', code: 'E_EVE_SEND_FAILED' })
    expect(companion.db.select().from(agentRuns).get()).toMatchObject({ status: 'failed', errorCode: 'E_EVE_SEND_FAILED' })
    expect(fake.send).toHaveBeenCalledTimes(1)
    expect(companion.db.select().from(messages).all()).toHaveLength(2)
  })

  it('试聊保存失败重试也只补写原preview结果，不读取新草稿再生成', async () => {
    companion.sqlite.exec(`
      CREATE TRIGGER fail_preview_completion BEFORE UPDATE OF status ON messages
      WHEN NEW.role = 'assistant' AND NEW.status = 'completed'
      BEGIN SELECT RAISE(ABORT, 'fixed-test-failure'); END;
    `)
    fake.send.mockResolvedValue(fakeResponse([appended('草稿回复'), turnCompleted(), sessionCompleted()]).response)
    const turns = service()
    const request = {
      requestId: 'preview-save-r1', content: '试聊问题',
      draft: { personaFullText: '原草稿', initialRelationship: '恋人' },
    }
    const first = turns.startPreviewTurn(request)
    expect((await collect(first.events)).at(-1)).toEqual({ type: 'failed', code: 'E_REPLY_SAVE_FAILED' })
    companion.sqlite.exec('DROP TRIGGER fail_preview_completion')
    expect((await collect(turns.startPreviewTurn({
      ...request, draft: { ...request.draft, personaFullText: '后来修改的草稿' },
    }).events)).at(-1)).toEqual({ type: 'done', replyId: latestReply().id })
    expect(latestReply()).toMatchObject({ conversationId: first.conversationId, content: '草稿回复' })
    expect(fake.send).toHaveBeenCalledTimes(1)
    expect(companion.db.select().from(messages).all()).toHaveLength(2)
  })

  it('准备阶段失败转成 failed 帧：流走到终点、不留回复行、登记簿清空', async () => {
    const turns = createChatTurnService({
      getDb: () => companion.db, getEve: () => handle, limits: { modelWindowTokens: 1_000 },
    })
    const { events } = turns.startTurn({ conversationId, requestId: 'r1', content: '问题' })
    const frames = await collect(events)
    expect(frames.at(-1)).toEqual({ type: 'failed', code: 'E_CONTEXT_BUDGET_EXCEEDED' })
    expect(companion.db.select().from(messages).all()).toHaveLength(1)
    expect(companion.db.select().from(agentRuns).all()).toHaveLength(0)
    expect(turns.activeCount()).toBe(0)
  })

  it('取消活动回合：事件以 cancelled 收尾、半截文字保留、账本记 cancelled', async () => {
    const { response, state } = fakeResponse([appended('半截')], true)
    fake.send.mockResolvedValue(response)
    const turns = service()
    const { events } = turns.startTurn({ conversationId, requestId: 'r1', content: '问题' })
    await events.next() // saved
    await events.next() // text 半截
    expect(turns.cancelTurn(conversationId)).toBe(true)
    const frames = await collect(events)
    expect(frames.at(-1)).toEqual({ type: 'cancelled' })
    // 中止先走框架协作取消，再由消费层把回合收成取消。
    expect(state.cancelled).toBe(1)
    expect(latestReply()).toMatchObject({ content: '半截', status: 'cancelled' })
    expect(turns.cancelTurn(conversationId)).toBe(false)
    expect(turns.activeCount()).toBe(0)
  })

  it('试聊：自动建 preview 会话并复用，草稿经归一、saved 带会话编号', async () => {
    fake.send.mockResolvedValueOnce(fakeResponse([appended('哼。'), turnCompleted(), sessionCompleted()]).response)
      .mockResolvedValueOnce(fakeResponse([appended('嗯。'), turnCompleted(), sessionCompleted()]).response)
    const turns = service()
    const draftBody = {
      personaFullText: '草稿人设：说话带「哼」。', initialRelationship: '暧昧',
      userNickname: null, dialogueExamples: [],
    }
    const first = turns.startPreviewTurn({ requestId: 'p1', content: '试聊一', draft: draftBody })
    const frames1 = await collect(first.events)
    const previewConversationId = (frames1[0] as { conversationId: string }).conversationId
    expect(frames1).toEqual([
      { type: 'saved', userMessageId: first.userMessageId, conversationId: previewConversationId },
      { type: 'text', delta: '哼。' },
      { type: 'done', replyId: latestReply().id },
    ])
    // 第二次试聊复用同一条 preview 会话，不新建。
    const second = turns.startPreviewTurn({ requestId: 'p2', content: '试聊二', draft: draftBody })
    await collect(second.events)
    const previews = companion.db.select().from(conversations)
      .where(eq(conversations.mode, 'preview')).all()
    expect(previews).toHaveLength(1)
    expect(previews[0].id).toBe(previewConversationId)
    // 试聊消息落在 preview 会话，不碰正式会话。
    const previewMessages = companion.db.select().from(messages)
      .where(eq(messages.conversationId, previewConversationId)).all()
    expect(previewMessages).toHaveLength(4)
  })

  it('试聊草稿不合法（分区与全文都带）在服务层被拒，不建会话不落库', () => {
    const turns = service()
    expect(() => turns.startPreviewTurn({
      requestId: 'p1', content: '内容',
      draft: {
        personaSections: { core: '核心', speech: '', background: '' },
        personaFullText: '全文', initialRelationship: '恋人',
      },
    })).toThrow('E_INVALID_DRAFT_PERSONA')
    expect(companion.db.select().from(conversations).where(eq(conversations.mode, 'preview')).all())
      .toHaveLength(0)
    expect(turns.activeCount()).toBe(0)
  })
})
