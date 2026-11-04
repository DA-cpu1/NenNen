/** 用内存库检查任务防重、固定原话范围和三个独立版本的失效。 */
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openCompanionDatabase, type CompanionDb } from '../src/data/db'
import { ensurePreviewConversation } from '../src/data/conversations'
import { initializeFirstCharacter } from '../src/data/character-init'
import { bumpCharacterMemoryEpoch, bumpContextEpoch, bumpGlobalMemoryEpoch } from '../src/data/epochs'
import { saveUserMessage } from '../src/data/messages'
import { saveCharacterMemory } from '../src/data/memories'
import { runMigrations } from '../src/data/migrations'
import { agentRuns, conversations, memories, memoryJobs, memorySources, messages } from '../src/data/tables'
import { beginMemoryAttempt } from '../src/jobs/memory-budget'
import { claimMemoryJob, readMemoryJobWork, registerMemoryJob } from '../src/jobs/memory-jobs'
import { commitMemoryCandidates } from '../src/jobs/commit-candidates'

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
})
afterEach(() => companion.close())

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

  it('试聊无法登记，即使手工伪造待执行行也不能领取', () => {
    const { db } = companion
    message('formal')
    const valid = registerMemoryJob(db, conversationId, now)!
    const preview = ensurePreviewConversation(db, characterId)
    message('preview', preview.id)
    expect(registerMemoryJob(db, preview.id, now)).toBeNull()
    const forged = { ...valid, id: 'forged', conversationId: preview.id }
    db.insert(memoryJobs).values(forged).run()
    expect(readMemoryJobWork(db, forged)).toBeNull()
    expect(claimMemoryJob(db, forged.id, now)).toBeNull()
    expect(db.select().from(memoryJobs).where(eq(memoryJobs.id, forged.id)).get()?.status).toBe('stale')
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
