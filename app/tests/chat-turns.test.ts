/**
 * 用内存库与模拟 eve 检查回合服务：登记簿挡并发、防重与「已回复不再花钱」、
 * 事件流必然走到终点、取消把回合收成 cancelled。不启动框架、不连网络。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { desc, eq } from 'drizzle-orm'
import { openCompanionDatabase, type CompanionDb } from '../src/data/db'
import { runMigrations } from '../src/data/migrations'
import { initializeFirstCharacter } from '../src/data/character-init'
import { agentRuns, characters, characterVersions, companionSettings, conversations, memories, messages, toolOperations } from '../src/data/tables'
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

/** 测试第二角色也建齐角色、人设、正式会话与设置，避免用半套资料掩盖隔离问题。 */
function addSecondCharacter(): string {
  const character = companion.db.select().from(characters).get()!
  const version = companion.db.select().from(characterVersions).get()!
  const conversation = companion.db.select().from(conversations).get()!
  const settings = companion.db.select().from(companionSettings).get()!
  companion.db.transaction((tx) => {
    tx.insert(characters).values({ ...character, id: 'second-character', name: '第二角色', createdAt: character.createdAt + 1 }).run()
    tx.insert(characterVersions).values({ ...version, id: 'second-version', characterId: 'second-character', personaText: '第二角色固定人设' }).run()
    tx.insert(conversations).values({ ...conversation, id: 'second-conversation', characterId: 'second-character' }).run()
    tx.insert(companionSettings).values({ ...settings, characterId: 'second-character' }).run()
  })
  return 'second-conversation'
}

describe('聊天回合服务（T06⑪c1）', () => {
  it('记忆工具绑定正式活动回合，只查所属角色与共享资料，并受四次额度约束', async () => {
    const secondId = addSecondCharacter()
    const { db } = companion
    const firstCharacter = db.select().from(conversations).where(eq(conversations.id, conversationId)).get()!.characterId
    const secondCharacter = db.select().from(conversations).where(eq(conversations.id, secondId)).get()!.characterId
    db.insert(memories).values(([
      { id: 'private', scope: 'character', characterId: firstCharacter, content: '喜欢水彩' },
      { id: 'shared', scope: 'global', characterId: null, content: '水彩在客厅' },
      { id: 'other', scope: 'character', characterId: secondCharacter, content: '水彩在卧室' },
    ] as const).map((row) => ({ ...row, kind: 'fact' as const, origin: 'user_edit', validFrom: 1, createdAt: 1, updatedAt: 1 }))).run()
    fake.send.mockResolvedValue(fakeResponse([appended('固定半截')], true).response)
    const turns = service()
    const request = { sessionId: 'eve-1', tool: 'search_memories', input: { query: '水彩' } } as const
    const { events } = turns.startTurn({ conversationId, requestId: 'tool-r1', content: '固定问题' })
    await events.next()
    expect(turns.executeMemoryTool(request)).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    await events.next()
    expect(turns.executeMemoryTool({ ...request, sessionId: 'wrong' })).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    const result = turns.executeMemoryTool(request)
    if (!result.ok || !('memories' in result)) throw new Error('未收到检索结果')
    expect(result.memories.map((row) => row.id).sort()).toEqual(['private', 'shared'])
    for (let index = 0; index < 3; index += 1) expect(turns.executeMemoryTool(request).ok).toBe(true)
    expect(turns.executeMemoryTool(request)).toMatchObject({ ok: false, code: 'BUDGET_EXCEEDED' })
    turns.cancelTurn(conversationId)
    expect(turns.executeMemoryTool(request)).toMatchObject({ ok: false, code: 'CANCELLED' })
    await collect(events)
    expect(turns.executeMemoryTool(request)).toMatchObject({ ok: false, code: 'NOT_FOUND' })
  })

  it('试聊即使有 eve 会话号也不能读取正式记忆', async () => {
    fake.send.mockResolvedValue(fakeResponse([appended('试聊固定半截')], true).response)
    const turns = service()
    const preview = turns.startPreviewTurn({ requestId: 'tool-preview', content: '查记忆',
      draft: { personaFullText: '草稿', initialRelationship: '恋人' } })
    await preview.events.next()
    await preview.events.next()
    expect(turns.executeMemoryTool({ sessionId: 'eve-1', tool: 'search_memories', input: { query: '水彩' } }))
      .toMatchObject({ ok: false, code: 'NOT_FOUND' })
    expect(turns.executeMemoryTool({ sessionId: 'eve-1', tool: 'remember_explicit', input: {
      sourceMessageId: preview.userMessageId, content: '用户希望被称为阿达', kind: 'preference',
    } })).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    expect(companion.db.select().from(memories).all()).toEqual([])
    turns.cancelTurn(preview.conversationId)
    await collect(preview.events)
  })

  it('只保存当前用户原话，回执失败时回滚，之后重试沿用已存结果', async () => {
    const { db, sqlite } = companion
    let begin!: () => void
    const sending = new Promise<void>((resolve) => { begin = resolve })
    fake.send.mockImplementation(async () => { begin(); return fakeResponse([], true).response })
    const turns = service()
    const formal = turns.startTurn({ conversationId, requestId: 'remember-r1', content: '以后叫我阿达。' })
    await formal.events.next()
    const reading = formal.events.next()
    await sending
    const input = { sourceMessageId: formal.userMessageId, kind: 'preference', memoryKey: 'preferred_name',
      content: '用户希望被称为阿达' } as const
    const request = { sessionId: 'eve-1', tool: 'remember_explicit', input } as const
    expect(turns.executeMemoryTool({ ...request, input: { ...input, sourceMessageId: 'not-this-turn' } }))
      .toMatchObject({ ok: false, code: 'SOURCE_NOT_ALLOWED' })

    // 在记忆写入之后让回执落库失败，用户不能收到假成功，数据库也不留半条操作。
    sqlite.exec("CREATE TRIGGER reject_receipt BEFORE UPDATE ON tool_operations BEGIN SELECT RAISE(ABORT, '拒绝回执'); END")
    expect(turns.executeMemoryTool(request)).toMatchObject({ ok: false, code: 'STORAGE_UNAVAILABLE' })
    expect(db.select().from(memories).all()).toEqual([])
    expect(db.select().from(toolOperations).all()).toEqual([])
    sqlite.exec('DROP TRIGGER reject_receipt')

    const result = turns.executeMemoryTool(request)
    expect(result).toMatchObject({ ok: true, status: 'saved', revision: 1 })
    expect(turns.executeMemoryTool(request)).toEqual({ ...result, status: 'already_saved' })
    expect(db.select().from(memories).all()).toHaveLength(1)
    const [receipt] = db.select().from(toolOperations).all()
    expect(receipt.status).toBe('committed')
    expect(receipt.resultJson).not.toContain('阿达')
    turns.cancelTurn(conversationId)
    expect((await reading).value).toEqual({ type: 'tool-status', status: 'memory-saved' })
    expect(await collect(formal.events)).toEqual([{ type: 'cancelled' }])
    expect(db.select().from(memories).all()).toHaveLength(1)
  })
  it('退出等待已开始回合取消落库，停止后拒绝正式和试聊新请求，重复stop复用', async () => {
    const { response } = fakeResponse([appended('退出前的半截')], true)
    fake.send.mockResolvedValue(response)
    const turns = service()
    const { events } = turns.startTurn({ conversationId, requestId: 'shutdown-r1', content: '固定问题' })
    await events.next()
    await events.next()
    const stopped = turns.stop()
    expect(turns.stop()).toBe(stopped)
    expect(() => turns.startTurn({ conversationId, requestId: 'shutdown-r2', content: '不能插队' }))
      .toThrow('E_BACKEND_STOPPING')
    expect(() => turns.startPreviewTurn({ requestId: 'shutdown-p1', content: '不能试聊',
      draft: { personaFullText: '固定草稿', initialRelationship: '恋人' } })).toThrow('E_BACKEND_STOPPING')
    // 退出流程自己接手尾部，不依赖界面再读一帧；终态以落库结果确认。
    await stopped
    expect(latestReply()).toMatchObject({ content: '退出前的半截', status: 'cancelled' })
    expect(companion.db.select().from(agentRuns).get()).toMatchObject({ status: 'cancelled' })
    expect(turns.activeCount()).toBe(0)
    expect(fake.send).toHaveBeenCalledTimes(1)
  })

  it('尚无界面消费的已受理回合也能退出，不触发模型或留下活动占用', async () => {
    const turns = service()
    turns.startTurn({ conversationId, requestId: 'shutdown-unread', content: '已保存但未开始' })
    await turns.stop()
    expect(turns.activeCount()).toBe(0)
    expect(fake.create).not.toHaveBeenCalled()
    expect(fake.send).not.toHaveBeenCalled()
    expect(companion.db.select().from(messages).all()).toHaveLength(1)
    expect(companion.db.select().from(agentRuns).all()).toHaveLength(0)
  })

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

  it('同角色新请求被挡下，不同完整角色可以同时回复并各自停止', async () => {
    const secondConversationId = addSecondCharacter()
    fake.send.mockResolvedValueOnce(fakeResponse([appended('甲的半截')], true).response)
      .mockResolvedValueOnce(fakeResponse([appended('乙的半截')], true).response)
    const turns = service()
    const first = turns.startTurn({ conversationId, requestId: 'r1', content: '第一句' })
    expect(() => turns.startTurn({ conversationId, requestId: 'r2', content: '插队' }))
      .toThrow('E_TURN_IN_PROGRESS')
    const second = turns.startTurn({ conversationId: secondConversationId, requestId: 'r2', content: '另一角色' })
    expect(second.userMessageId).not.toBe(first.userMessageId)
    await first.events.next()
    expect((await first.events.next()).value).toEqual({ type: 'text', delta: '甲的半截' })
    await second.events.next()
    expect((await second.events.next()).value).toEqual({ type: 'text', delta: '乙的半截' })
    expect(turns.activeCount()).toBe(2)
    turns.cancelTurn(conversationId)
    await collect(first.events)
    expect(turns.activeCount()).toBe(1)
    turns.cancelTurn(secondConversationId)
    await collect(second.events)
    expect(turns.activeCount()).toBe(0)
    expect(fake.send).toHaveBeenCalledTimes(2)
    expect(companion.db.select().from(messages).where(eq(messages.conversationId, conversationId)).all()).toHaveLength(2)
    expect(companion.db.select().from(messages).where(eq(messages.conversationId, secondConversationId)).all()).toHaveLength(2)
  })

  it.each(['normal', 'preview'] as const)('%s 活动时同角色另一入口被拒，取消后释放且拒绝不新增会话或消息', async (mode) => {
    fake.send.mockResolvedValue(fakeResponse([appended('回复'), turnCompleted(), sessionCompleted()]).response)
    const turns = service()
    const previewRequest = { requestId: 'p1', content: '试聊', draft: { personaFullText: '草稿', initialRelationship: '恋人' } }
    const formalRequest = { conversationId, requestId: 'r1', content: '正式聊天' }
    const first = mode === 'normal' ? turns.startTurn(formalRequest) : turns.startPreviewTurn(previewRequest)
    const messageCount = companion.db.select().from(messages).all().length
    const conversationCount = companion.db.select().from(conversations).all().length
    expect(() => mode === 'normal' ? turns.startPreviewTurn(previewRequest) : turns.startTurn(formalRequest))
      .toThrow('E_TURN_IN_PROGRESS')
    expect(companion.db.select().from(messages).all()).toHaveLength(messageCount)
    expect(companion.db.select().from(conversations).all()).toHaveLength(conversationCount)
    const activeConversationId = mode === 'normal' ? conversationId
      : companion.db.select().from(conversations).where(eq(conversations.mode, 'preview')).get()!.id
    turns.cancelTurn(activeConversationId)
    await collect(first.events)
    const after = mode === 'normal' ? turns.startPreviewTurn(previewRequest) : turns.startTurn(formalRequest)
    expect((await collect(after.events)).at(-1)).toEqual({ type: 'done', replyId: latestReply().id })
    expect(turns.activeCount()).toBe(0)
  })

  it('正式入口伪造preview会话在保存前被拒，缺失会话也不留数据或调用模型', () => {
    const normal = companion.db.select().from(conversations).get()!
    companion.db.insert(conversations).values({ ...normal, id: 'forged-preview', mode: 'preview' }).run()
    const turns = service()
    expect(() => turns.startTurn({ conversationId: 'forged-preview', requestId: 'r1', content: '伪造正式' }))
      .toThrow('E_PREVIEW_NOT_ALLOWED')
    expect(() => turns.startTurn({ conversationId: 'missing', requestId: 'r2', content: '无会话' }))
      .toThrow('E_CONVERSATION_NOT_FOUND')
    expect(companion.db.select().from(messages).all()).toHaveLength(0)
    expect(companion.db.select().from(agentRuns).all()).toHaveLength(0)
    expect(fake.create).not.toHaveBeenCalled()
    expect(fake.send).not.toHaveBeenCalled()
    expect(turns.activeCount()).toBe(0)
  })

  it('试聊依赖未就绪时撤回新preview会话，拒绝不留空壳', () => {
    const turns = createChatTurnService({ getDb: () => companion.db, getEve: () => undefined, limits: { modelWindowTokens: 32_000 } })
    expect(() => turns.startPreviewTurn({
      requestId: 'p1', content: '试聊', draft: { personaFullText: '草稿', initialRelationship: '恋人' },
    })).toThrow('E_EVE_UNAVAILABLE')
    expect(companion.db.select().from(conversations).where(eq(conversations.mode, 'preview')).all()).toHaveLength(0)
    expect(companion.db.select().from(messages).all()).toHaveLength(0)
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
      getDb: () => companion.db, getEve: () => handle,
      limits: { modelWindowTokens: 1_000, outputReserveTokens: 1_000 },
    })
    const { events } = turns.startTurn({ conversationId, requestId: 'r1', content: '问题' })
    const frames = await collect(events)
    expect(frames.at(-1)).toEqual({ type: 'failed', code: 'E_CONTEXT_BUDGET_EXCEEDED' })
    expect(companion.db.select().from(messages).all()).toHaveLength(1)
    expect(companion.db.select().from(agentRuns).all()).toHaveLength(0)
    expect(turns.activeCount()).toBe(0)
    // 正式回合失败后，试聊也能取得同一角色的占用，不被上一轮遗留登记挡住。
    const next = turns.startPreviewTurn({
      requestId: 'after-failure', content: '试聊', draft: { personaFullText: '草稿', initialRelationship: '恋人' },
    })
    expect((await collect(next.events)).at(-1)).toEqual({ type: 'failed', code: 'E_CONTEXT_BUDGET_EXCEEDED' })
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
