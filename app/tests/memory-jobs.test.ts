/** 用内存库检查任务防重、固定原话范围和三个独立版本的失效。 */
import { MockLanguageModelV4 } from 'ai/test'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recoverInterruptedTurns } from '../src/agent/turn-runner'
import { openCompanionDatabase, type CompanionDb } from '../src/data/db'
import { ensurePreviewConversation } from '../src/data/conversations'
import { initializeFirstCharacter } from '../src/data/character-init'
import { bumpCharacterMemoryEpoch, bumpContextEpoch, bumpGlobalMemoryEpoch } from '../src/data/epochs'
import { saveUserMessage } from '../src/data/messages'
import { saveCharacterMemory } from '../src/data/memories'
import { mutateMemory, previewMemoryDeletion } from '../src/data/memory-management'
import { runMigrations } from '../src/data/migrations'
import { agentRuns, conversations, memories, memoryJobs, memorySources, messages } from '../src/data/tables'
import { beginMemoryAttempt, finishMemoryAttempt, recoverExpiredMemoryJobs } from '../src/jobs/memory-budget'
import { claimMemoryJob, readMemoryJobWork, registerMemoryJob } from '../src/jobs/memory-jobs'
import { commitMemoryCandidates } from '../src/jobs/commit-candidates'
import { createMemoryWorker } from '../src/jobs/memory-worker'
import { runMemoryAttempt } from '../src/jobs/run-memory-attempt'

const now = 1_740_000_000_000
const testModel = { name: 'fixed', provider: 'local-test' }
let companion: CompanionDb
let conversationId: string
let characterId: string

beforeEach(() => {
  companion = openCompanionDatabase(':memory:')
  runMigrations(companion.sqlite)
  const initial = initializeFirstCharacter(companion.db, {
    name: '固定角色', personaText: '固定设定', initialRelationship: '朋友', timezone: 'Asia/Hong_Kong', now,
  })
  conversationId = initial.conversationId
  characterId = initial.characterId
})

describe('整理模型预算', () => {
  it('先预占本次估算输入和输出，再允许调用；聊天消耗不计入整理额度', () => {
    const { db } = companion
    db.insert(agentRuns).values({ id: 'ordinary-chat', characterId, triggerType: 'chat', model: testModel.name, provider: testModel.provider,
      status: 'completed', inputTokens: 50_000, outputTokens: 10_000, startedAt: now }).run()
    message('source')
    const job = registerMemoryJob(db, conversationId, now)!
    const result = beginMemoryAttempt(db, job.id, testModel, now)
    if (result.status !== 'ready') throw new Error('未取得预算')
    expect(db.select().from(agentRuns).where(eq(agentRuns.id, result.attempt.runId)).get()).toMatchObject({
      triggerType: 'memory', status: 'running', usageEstimated: 1,
      inputTokens: result.attempt.prepared.estimatedInputTokens, outputTokens: result.attempt.prepared.outputLimit,
    })
    expect(beginMemoryAttempt(db, job.id, testModel, now)).toEqual({ status: 'unavailable' })
  })

  it.each([{ requests: 20, tokens: 1 }, { requests: 1, tokens: 39_000 }])('任一额度不足就延到本地次日 $requests/$tokens', ({ requests, tokens }) => {
    const { db } = companion
    for (let index = 0; index < requests; index += 1) {
      db.insert(agentRuns).values({ id: `used-${index}`, characterId, triggerType: 'memory', model: testModel.name,
        provider: testModel.provider, status: 'completed', inputTokens: tokens, outputTokens: 0, startedAt: now }).run()
    }
    message('source')
    const job = registerMemoryJob(db, conversationId, now)!
    const tomorrow = new Date(now).setHours(24, 0, 0, 0)
    expect(beginMemoryAttempt(db, job.id, testModel, now)).toEqual({ status: 'delayed', retryAt: tomorrow })
    expect(db.select().from(memoryJobs).get()).toMatchObject({ status: 'pending', attempts: 0, availableAt: tomorrow })
    expect(db.select().from(agentRuns).all()).toHaveLength(requests)
    expect(beginMemoryAttempt(db, job.id, testModel, tomorrow).status).toBe('ready')
  })

  it('候选与实际用量一起提交，重复通知不重复写入', () => {
    const { db, sqlite } = companion
    const source = message('source')
    const job = registerMemoryJob(db, conversationId, now)!
    const started = beginMemoryAttempt(db, job.id, testModel, now)
    if (started.status !== 'ready') throw new Error('未领取任务')
    const result = { ok: true as const, candidates: [{ ...candidate(source.id), action: 'add' as const, kind: 'fact' as const }],
      usage: { inputTokens: 20, outputTokens: 5, estimated: false } }
    // 模拟账本写失败，之前写入的记忆、来源和书签也应撤回。
    sqlite.exec(`CREATE TEMP TRIGGER refuse_run_update BEFORE UPDATE ON agent_runs
      BEGIN SELECT RAISE(ABORT, 'test only'); END`)
    expect(() => finishMemoryAttempt(db, started.attempt, result, now + 1)).toThrow()
    expect(db.select().from(memories).all()).toHaveLength(0)
    expect(db.select().from(conversations).get()?.lastProcessedSeq).toBe(0)
    expect(db.select().from(memoryJobs).get()?.status).toBe('running')
    sqlite.exec('DROP TRIGGER refuse_run_update')
    finishMemoryAttempt(db, started.attempt, result, now + 2)
    finishMemoryAttempt(db, started.attempt, result, now + 3)
    expect(db.select().from(agentRuns).all()).toMatchObject([{
      status: 'completed', inputTokens: 20, outputTokens: 5, usageEstimated: 0, finishedAt: now + 2,
    }])
    expect(db.select().from(memorySources).all()).toMatchObject([{ messageId: source.id }])
  })

  it('三次退避均保留未知用量的估算，耗尽重试后同一批停止', () => {
    const { db } = companion
    saveUserMessage(db, { requestId: 'first', conversationId, content: '我在学 TypeScript', now })
    saveUserMessage(db, { requestId: 'second', conversationId, content: '每晚练习半小时', now })
    // 用两条短消息触发空闲整理，避免长批次先用完预算而遮住第三次退避。
    let time = now + 300_000
    const job = registerMemoryJob(db, conversationId, time)!
    for (const delay of [30_000, 120_000, 600_000, 0]) {
      const started = beginMemoryAttempt(db, job.id, testModel, time)
      if (started.status !== 'ready') throw new Error('未领取任务')
      const { attempt } = started
      finishMemoryAttempt(db, attempt, { ok: false, code: 'E_MEMORY_MODEL_FAILED', usage: {
        inputTokens: attempt.prepared.estimatedInputTokens, outputTokens: attempt.prepared.outputLimit, estimated: true,
      } }, time)
      expect(beginMemoryAttempt(db, job.id, testModel, time + delay - 1)).toEqual({ status: 'unavailable' })
      time += delay
    }
    expect(db.select().from(agentRuns).all()).toHaveLength(4)
    expect(db.select().from(agentRuns).all().every((run) => run.usageEstimated === 1 && run.outputTokens === 2_048)).toBe(true)
    expect(db.select().from(memoryJobs).get()).toMatchObject({ status: 'failed', attempts: 4, leaseUntil: null })
    expect(registerMemoryJob(db, conversationId, time + 1)).toBeNull()
  })
})
afterEach(() => companion.close())

describe('整理单次执行', () => {
  it.each(['排队', '调用前', '提交时'])('A13 在%s忘记来源，旧批次不能写回', async (phase) => {
    const { db } = companion
    const source = message('old-source')
    const target = saveCharacterMemory(db, { conversationId, kind: 'fact', memoryKey: 'project', content: '旧项目',
      origin: 'user_explicit', sourceMessageIds: [source.id], expiresAt: null, now })
    if (!('memory' in target)) throw new Error('缺少测试记忆')
    const job = registerMemoryJob(db, conversationId, now)!
    const started = phase === '排队' ? undefined : beginMemoryAttempt(db, job.id, testModel, now)
    const memory = { memoryId: target.memory.id, expectedRevision: target.memory.revision }
    const { sourceFingerprint } = previewMemoryDeletion(db, target.memory.characterId!, memory)
    mutateMemory(db, { conversationId, requestId: 'delete-source' }, {
      ...memory, action: 'forget', deleteSources: true, sourceFingerprint,
    }, now + 1)
    if (!started) {
      expect(beginMemoryAttempt(db, job.id, testModel, now + 1)).toEqual({ status: 'unavailable' })
      expect(db.select().from(agentRuns).all()).toEqual([])
    } else {
      if (started.status !== 'ready') throw new Error('未领取测试任务')
      if (phase === '调用前') {
        const model = new MockLanguageModelV4({ doGenerate: async () => { throw new Error('不应请求模型') } })
        await runMemoryAttempt(db, started.attempt, model, new AbortController().signal)
        expect(model.doGenerateCalls).toEqual([])
        expect(db.select().from(agentRuns).get()).toMatchObject({ inputTokens: 0, outputTokens: 0 })
      } else {
        finishMemoryAttempt(db, started.attempt, { ok: true, candidates: [],
          usage: { inputTokens: 19, outputTokens: 5, estimated: false } }, now + 1)
        expect(db.select().from(agentRuns).get()).toMatchObject({ inputTokens: 19, outputTokens: 5, errorCode: 'E_MEMORY_STALE' })
      }
    }
    expect(db.select().from(memoryJobs).get()).toMatchObject({ status: 'stale' })
    expect(db.select().from(conversations).get()?.lastProcessedSeq).toBe(0)
    expect(registerMemoryJob(db, conversationId, now + 2)).toBeNull()
    expect(db.select().from(memories).get()).toMatchObject({ status: 'deleted', content: '' })
  })

  it.each(['退出', '超时'])('%s后不等待忽略取消的模型，也不保存晚到候选', async (reason) => {
    vi.useFakeTimers({ now })
    try {
      const { db } = companion
      const source = message('source')
      const job = registerMemoryJob(db, conversationId, now)!
      const started = beginMemoryAttempt(db, job.id, testModel, now)
      if (started.status !== 'ready') throw new Error('未领取任务')
      let markReceived!: () => void
      let release!: () => void
      const received = new Promise<void>((resolve) => { markReceived = resolve })
      const held = new Promise<void>((resolve) => { release = resolve })
      const model = new MockLanguageModelV4({ doGenerate: async () => {
        markReceived()
        await held
        return { content: [{ type: 'text', text: JSON.stringify({ candidates: [candidate(source.id)] }) }],
          finishReason: { unified: 'stop', raw: undefined }, usage: {
            inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 5, text: undefined, reasoning: undefined },
          }, warnings: [] }
      } })
      const stop = new AbortController()
      const running = runMemoryAttempt(db, started.attempt, model, stop.signal)
      await received
      if (reason === '退出') stop.abort()
      else await vi.advanceTimersByTimeAsync(90_000)
      await running
      release()
      await vi.advanceTimersByTimeAsync(0)
      expect(model.doGenerateCalls).toHaveLength(1)
      expect(model.doGenerateCalls[0].abortSignal?.aborted).toBe(true)
      expect(db.select().from(memories).all()).toHaveLength(0)
      expect(db.select().from(memoryJobs).get()).toMatchObject({ status: 'pending', availableAt: Date.now() + 30_000 })
      expect(db.select().from(agentRuns).get()).toMatchObject({ usageEstimated: 1,
        errorCode: reason === '退出' ? 'E_CANCELLED' : 'E_MEMORY_TIMEOUT' })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('整理租约恢复', () => {
  it.each([false, true])('到期才恢复，失效来源不重试（来源失效 $0）', (stale) => {
    const { db } = companion
    // 用单字节长消息触发整理，让预占和重试都能在同一天的预算内验证。
    saveUserMessage(db, { requestId: 'source', conversationId, content: 'a'.repeat(6_001), now })
    const job = registerMemoryJob(db, conversationId, now)!
    const started = beginMemoryAttempt(db, job.id, testModel, now)
    if (started.status !== 'ready') throw new Error('未领取任务')
    if (stale) bumpContextEpoch(db, conversationId)
    const deadline = now + 90_000
    expect(recoverInterruptedTurns(db, now + 1).runs).toBe(0)
    expect(recoverExpiredMemoryJobs(db, deadline - 1)).toBe(deadline)
    expect(db.select().from(memoryJobs).get()?.status).toBe('running')
    expect(recoverExpiredMemoryJobs(db, deadline)).toBeUndefined()
    expect(db.select().from(memoryJobs).get()).toMatchObject({ status: stale ? 'stale' : 'pending', attempts: 1, leaseUntil: null })
    expect(db.select().from(agentRuns).get()).toMatchObject({ status: 'failed', errorCode: 'E_INTERRUPTED',
      usageEstimated: 1, outputTokens: started.attempt.prepared.outputLimit, finishedAt: deadline })
    recoverExpiredMemoryJobs(db, deadline + 10)
    expect(db.select().from(agentRuns).get()?.finishedAt).toBe(deadline)
    expect(db.select().from(conversations).get()?.lastProcessedSeq).toBe(0)
    expect(beginMemoryAttempt(db, job.id, testModel, deadline + 29_999).status).toBe('unavailable')
    expect(beginMemoryAttempt(db, job.id, testModel, deadline + 30_000).status).toBe(stale ? 'unavailable' : 'ready')
  })
})

describe('整理调度', () => {
  it('A13 只取消受影响的运行；模型忽略取消也不能复写已忘记资料', async () => {
    vi.useFakeTimers({ now })
    const { db } = companion
    const source = message('source')
    const saved = saveCharacterMemory(db, { conversationId, kind: 'fact', memoryKey: 'project', content: '旧项目',
      origin: 'user_explicit', sourceMessageIds: [source.id], expiresAt: null, now })
    if (!('memory' in saved)) throw new Error('缺少测试记忆')
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const model = new MockLanguageModelV4({ doGenerate: async () => {
      await held
      throw new Error('故意忽略取消，最后才结束')
    } })
    const worker = createMemoryWorker(db, () => model)
    try {
      worker.wake()
      await vi.advanceTimersByTimeAsync(1)
      const signal = model.doGenerateCalls[0].abortSignal!
      worker.invalidate(['other-character-conversation'])
      expect(signal.aborted).toBe(false)
      const change = mutateMemory(db, { conversationId, requestId: 'forget-running' }, {
        action: 'forget', memoryId: saved.memory.id, expectedRevision: saved.memory.revision, deleteSources: false,
      }, Date.now())
      worker.invalidate(change.conversationIds)
      expect(signal.aborted).toBe(true)
      await vi.advanceTimersByTimeAsync(1)
      release()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(model.doGenerateCalls).toHaveLength(1)
      expect(db.select().from(memoryJobs).get()).toMatchObject({ status: 'stale' })
      expect(db.select().from(agentRuns).get()).toMatchObject({ status: 'cancelled', usageEstimated: 1 })
      expect(db.select().from(conversations).get()?.lastProcessedSeq).toBe(0)
    } finally {
      release()
      await worker.stop()
      vi.useRealTimers()
    }
  })

  it('空闲到点只执行一次，收到新聊天通知后重新判断空闲时刻', async () => {
    vi.useFakeTimers({ now })
    const { db } = companion
    const model = new MockLanguageModelV4({ doGenerate: async () => ({
      content: [{ type: 'text', text: '{"candidates":[]}' }], finishReason: { unified: 'stop', raw: undefined },
      usage: { inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 5, text: undefined, reasoning: undefined } }, warnings: [],
    }) })
    const worker = createMemoryWorker(db, () => model)
    try {
      saveUserMessage(db, { requestId: 'first', conversationId, content: '我喜欢水彩', now })
      saveUserMessage(db, { requestId: 'second', conversationId, content: '下周想去上课', now })
      worker.wake()
      await vi.advanceTimersByTimeAsync(240_000)
      const last = saveUserMessage(db, { requestId: 'last', conversationId, content: '先买画纸', now: Date.now() }).message
      worker.wake()
      worker.wake()
      await vi.advanceTimersByTimeAsync(299_999)
      expect(model.doGenerateCalls).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(2)
      expect(model.doGenerateCalls).toHaveLength(1)
      expect(db.select().from(conversations).get()?.lastProcessedSeq).toBe(last.seq)
      await vi.advanceTimersByTimeAsync(900_000)
      expect(model.doGenerateCalls).toHaveLength(1)
    } finally {
      await worker.stop()
      vi.useRealTimers()
    }
  })
})

/** 写超过触发线的虚构消息，用于检查批次登记。 */
function message(requestId: string, conversation = conversationId) {
  return saveUserMessage(companion.db, { requestId, conversationId: conversation, content: '长'.repeat(6_001), now }).message
}

/** 造一项格式有效的固定候选，具体错误由各场景单独改变。 */
function candidate(sourceId: string) {
  return { action: 'add', kind: 'fact', memoryKey: 'project', content: '用户正在做桌面项目',
    sourceMessageIds: [sourceId], expiresAt: null, replacesMemoryId: null }
}

describe('整理任务登记与领取', () => {
  it('重复登记复用同一任务，追加原话不会进入已登记批次，执行中不能被重复领取', () => {
    const { db } = companion
    const first = message('first')
    const job = registerMemoryJob(db, conversationId, now)!
    expect(job).toMatchObject({ startSeq: first.seq, endSeq: first.seq, status: 'pending', attempts: 0 })
    message('future')
    expect(registerMemoryJob(db, conversationId, now)?.id).toBe(job.id)
    expect(claimMemoryJob(db, job.id, now)).toMatchObject({
      job: { status: 'running', attempts: 1, leaseUntil: now + 90_000 },
      batch: { sources: [{ id: first.id }] },
    })
    expect(claimMemoryJob(db, job.id, now)).toBeNull()
  })

  it.each(['character', 'global', 'context'] as const)('更改 %s 版本后旧任务拒绝领取，原进度保留', (version) => {
    const { db } = companion
    message('first')
    const job = registerMemoryJob(db, conversationId, now)!
    if (version === 'character') bumpCharacterMemoryEpoch(db, characterId)
    if (version === 'global') bumpGlobalMemoryEpoch(db)
    if (version === 'context') bumpContextEpoch(db, conversationId)
    expect(claimMemoryJob(db, job.id, now)).toBeNull()
    expect(db.select().from(memoryJobs).where(eq(memoryJobs.id, job.id)).get()?.status).toBe('stale')
    expect(db.select().from(conversations).get()?.lastProcessedSeq).toBe(0)
    expect(registerMemoryJob(db, conversationId, now)?.id).not.toBe(job.id)
  })

  it('试聊无法登记，伪造任务也不能领取或直接提交候选', () => {
    const { db } = companion
    message('formal')
    const valid = registerMemoryJob(db, conversationId, now)!
    const preview = ensurePreviewConversation(db, characterId)
    const source = message('preview', preview.id)
    expect(registerMemoryJob(db, preview.id, now)).toBeNull()
    const forged = { ...valid, id: 'forged', conversationId: preview.id }
    db.insert(memoryJobs).values(forged).run()
    expect(readMemoryJobWork(db, forged)).toBeNull()
    expect(claimMemoryJob(db, forged.id, now)).toBeNull()
    expect(db.select().from(memoryJobs).where(eq(memoryJobs.id, forged.id)).get()?.status).toBe('stale')

    // 绕过领取，直接在临时库造一条执行中记录，确认提交入口也会核对会话模式。
    const execution = { status: 'running', attempts: 1, leaseUntil: now + 90_000 }
    db.update(memoryJobs).set(execution).where(eq(memoryJobs.id, forged.id)).run()
    const position = { seq: source.seq, offset: 0 }
    const batch = { start: position, end: position,
      sources: [{ id: source.id, seq: source.seq, content: source.content, createdAt: source.createdAt }] }
    const work = { job: { ...forged, ...execution }, characterId, batch }
    expect(commitMemoryCandidates(db, work, [candidate(source.id)], new Map(), now + 1))
      .toEqual({ status: 'stale' })
    expect(db.select().from(memories).all()).toHaveLength(0)
    expect(db.select().from(conversations).where(eq(conversations.id, preview.id)).get()?.lastProcessedSeq).toBe(0)
  })

  it('已排除的唯一来源使批次失效，分段书签仍可立即整理余下原话', () => {
    const { db } = companion
    const source = message('source')
    const first = registerMemoryJob(db, conversationId, now)!
    db.update(messages).set({ excludedFromContext: 1 }).where(eq(messages.id, source.id)).run()
    expect(claimMemoryJob(db, first.id, now)).toBeNull()
    const remaining = message('remaining')
    db.update(conversations).set({ lastProcessedSeq: remaining.seq, lastProcessedOffset: 6_000 }).run()
    const next = registerMemoryJob(db, conversationId, now)!
    expect(claimMemoryJob(db, next.id, now)?.batch).toMatchObject({
      start: { seq: remaining.seq, offset: 6_000 }, end: { seq: remaining.seq, offset: 0 },
      sources: [{ id: remaining.id, content: '长' }],
    })
  })
})

describe('整理候选原子提交', () => {
  it('即时已保存的事实按原话进入整理候选，复用旧条并补来源后推进书签', () => {
    const { db } = companion
    const source = saveUserMessage(db, { conversationId, requestId: 'first', content: '这个我挺爱喝。', now }).message
    const old = saveCharacterMemory(db, { conversationId, kind: 'preference', memoryKey: null,
      content: '用户喜欢无糖可乐', origin: 'user_explicit', sourceMessageIds: [source.id], expiresAt: null, now })
    if (!('memory' in old)) throw new Error('缺少即时记忆')
    const repeated = saveUserMessage(db, { conversationId, requestId: 'second', content: '平时都选这个。', now }).message
    const started = beginMemoryAttempt(db, registerMemoryJob(db, conversationId, now + 300_000)!.id, testModel, now + 300_000)
    if (started.status !== 'ready') throw new Error('未领取任务')
    const { attempt } = started
    expect(JSON.parse(attempt.prepared.prompt).previous).toMatchObject([{ id: old.memory.id, firstSourceAt: now }])
    const reuse = { action: 'reuse', memoryId: old.memory.id, sourceMessageIds: [source.id, repeated.id] }
    expect(commitMemoryCandidates(db, attempt.work, [reuse], new Map(), now + 300_001))
      .toEqual({ status: 'invalid_candidates' })
    expect(db.select().from(conversations).get()?.lastProcessedSeq).toBe(0)
    expect(db.select().from(memorySources).all()).toHaveLength(1)

    finishMemoryAttempt(db, attempt, { ok: true, candidates: [{ ...reuse, action: 'reuse' }],
      usage: { inputTokens: 20, outputTokens: 5, estimated: false } }, now + 300_002)
    expect(db.select().from(memories).all()).toEqual([old.memory])
    expect(db.select().from(memorySources).all()).toHaveLength(2)
    expect(db.select().from(conversations).get()?.lastProcessedSeq).toBe(repeated.seq)
    expect(db.select().from(memoryJobs).get()?.status).toBe('completed')
  })

  it('保存、来源和书签一起提交，同一批重放只返回已完成', () => {
    const { db } = companion
    const source = message('source')
    const job = registerMemoryJob(db, conversationId, now)!
    const work = claimMemoryJob(db, job.id, now)!
    expect(commitMemoryCandidates(db, work, [candidate(source.id)], new Map(), now + 1))
      .toEqual({ status: 'completed', saved: 1 })
    expect(commitMemoryCandidates(db, work, [candidate(source.id)], new Map(), now + 2))
      .toEqual({ status: 'already_completed' })
    expect(db.select().from(memories).all()).toHaveLength(1)
    expect(db.select().from(memorySources).all()).toMatchObject([{ messageId: source.id }])
    expect(db.select().from(conversations).get()).toMatchObject({ lastProcessedSeq: source.seq, lastProcessedOffset: 0 })
  })

  it('一批第二项来源无效时撤回第一项、来源和进度；后来发的原话不属于本批', () => {
    const { db } = companion
    const source = message('source')
    const job = registerMemoryJob(db, conversationId, now)!
    const work = claimMemoryJob(db, job.id, now)!
    const future = message('future')
    expect(commitMemoryCandidates(db, work, [candidate(source.id), candidate(future.id)], new Map(), now + 1))
      .toEqual({ status: 'invalid_candidates' })
    expect(db.select().from(memories).all()).toEqual([])
    expect(db.select().from(memorySources).all()).toEqual([])
    expect(db.select().from(conversations).get()?.lastProcessedSeq).toBe(0)
  })

  it('任务运行中修改任一版本后拒绝旧结果并保留书签', () => {
    const { db } = companion
    const source = message('source')
    const job = registerMemoryJob(db, conversationId, now)!
    const work = claimMemoryJob(db, job.id, now)!
    bumpContextEpoch(db, conversationId)
    expect(commitMemoryCandidates(db, work, [candidate(source.id)], new Map(), now + 1)).toEqual({ status: 'stale' })
    expect(db.select().from(memoryJobs).get()?.status).toBe('stale')
    expect(db.select().from(conversations).get()?.lastProcessedSeq).toBe(0)
    expect(db.select().from(memories).all()).toEqual([])
  })

  it('到期旧属性在同批写新值时标为过期，候选本身过期时跳过', () => {
    const { db } = companion
    const oldSource = saveUserMessage(db, { conversationId, requestId: 'old', content: '旧项目', now: now - 100 }).message
    expect(saveCharacterMemory(db, { conversationId, kind: 'fact', memoryKey: 'project', content: '旧项目',
      origin: 'user_explicit', sourceMessageIds: [oldSource.id], expiresAt: now, now: now - 100 }).status).toBe('saved')
    const source = message('source')
    const work = claimMemoryJob(db, registerMemoryJob(db, conversationId, now)!.id, now)!
    expect(commitMemoryCandidates(db, work, [candidate(source.id),
      { ...candidate(oldSource.id), kind: 'temporary', memoryKey: 'old_state', expiresAt: now - 1 }], new Map(), now + 1))
      .toEqual({ status: 'completed', saved: 1 })
    expect(db.select().from(memories).orderBy(memories.createdAt).all()).toMatchObject([
      { content: '旧项目', status: 'expired', revision: 2 }, { content: '用户正在做桌面项目', status: 'active' },
    ])
  })

  it('替换必须是模型见过的同角色修订，旧原话不能覆盖后面明确保存的值', () => {
    const { db } = companion
    const source = message('earlier')
    const later = message('later')
    const recent = saveCharacterMemory(db, { conversationId, kind: 'fact', memoryKey: 'project', content: '后来新值',
      origin: 'user_explicit', sourceMessageIds: [later.id], expiresAt: null, now }).status
    expect(recent).toBe('saved')
    const old = db.select().from(memories).get()!
    const work = claimMemoryJob(db, registerMemoryJob(db, conversationId, now)!.id, now)!
    const replacement = { ...candidate(source.id), action: 'replace', replacesMemoryId: old.id }
    expect(commitMemoryCandidates(db, work, [replacement], new Map(), now + 1)).toEqual({ status: 'invalid_candidates' })
    expect(commitMemoryCandidates(db, work, [replacement], new Map([[old.id, old.revision]]), now + 1))
      .toEqual({ status: 'invalid_candidates' })
    expect(db.select().from(memories).get()?.content).toBe('后来新值')
  })
})
