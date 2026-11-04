/** 用内存库检查任务防重、固定原话范围和三个独立版本的失效。 */
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openCompanionDatabase, type CompanionDb } from '../src/data/db'
import { ensurePreviewConversation } from '../src/data/conversations'
import { initializeFirstCharacter } from '../src/data/character-init'
import { bumpCharacterMemoryEpoch, bumpContextEpoch, bumpGlobalMemoryEpoch } from '../src/data/epochs'
import { saveUserMessage } from '../src/data/messages'
import { runMigrations } from '../src/data/migrations'
import { conversations, memoryJobs, messages } from '../src/data/tables'
import { claimMemoryJob, readMemoryJobWork, registerMemoryJob } from '../src/jobs/memory-jobs'

const now = 1_740_000_000_000
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
afterEach(() => companion.close())

/** 写超过触发线的虚构消息，用于检查批次登记。 */
function message(requestId: string, conversation = conversationId) {
  return saveUserMessage(companion.db, { requestId, conversationId: conversation, content: '长'.repeat(6_001), now }).message
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
