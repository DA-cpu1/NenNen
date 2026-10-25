/** 检查模型尝试的记账边界：归属从会话取、真实重试分开记、未知消耗带估算标记。 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openCompanionDatabase, type CompanionDb } from '../src/data/db'
import { runMigrations } from '../src/data/migrations'
import { initializeFirstCharacter } from '../src/data/character-init'
import { finishAgentRun, startAgentRun } from '../src/data/agent-runs'
import { agentRuns, characters, characterVersions, companionSettings, conversations } from '../src/data/tables'

let companion: CompanionDb
let conversationId: string
let characterVersionId: string
const now = 1740000005000

beforeEach(() => {
  companion = openCompanionDatabase(':memory:')
  runMigrations(companion.sqlite)
  conversationId = initializeFirstCharacter(companion.db, {
    name: '检查角色', personaText: '检查人设', initialRelationship: '恋人',
    timezone: 'Asia/Hong_Kong', now,
  }).conversationId
  characterVersionId = companion.db.select().from(characterVersions).get()!.id
})

afterEach(() => companion.close())

/** 用固定版本和模型登记一次假调用；不真正联网。 */
function start() {
  return startAgentRun(companion.db, {
    conversationId, characterVersionId, model: 'test-model', provider: 'test-provider', now,
  })
}

describe('模型运行记账（T06④）', () => {
  it('登记实际版本和模型，再保存精确用量与结束时间', () => {
    const run = start()
    expect(run).toMatchObject({ conversationId, characterVersionId, triggerType: 'chat', status: 'running' })
    expect(finishAgentRun(companion.db, {
      runId: run.id, status: 'completed', usage: { inputTokens: 120, outputTokens: 30, estimated: false }, now: now + 1,
    })).toMatchObject({ status: 'completed', inputTokens: 120, outputTokens: 30, usageEstimated: 0, finishedAt: now + 1 })
  })

  it.each(['failed', 'cancelled'] as const)('%s 仍保存保守估算，不把已发生用量漏掉', (status) => {
    expect(finishAgentRun(companion.db, {
      runId: start().id, status, usage: { inputTokens: 100, outputTokens: 1000, estimated: true },
      errorCode: 'E_MODEL_STOPPED', now,
    })).toMatchObject({ status, usageEstimated: 1, errorCode: 'E_MODEL_STOPPED' })
  })

  it('同一结束通知重放保留原时间，冲突结果拒绝；新的尝试独立记账', () => {
    const input = {
      runId: start().id, status: 'completed' as const,
      usage: { inputTokens: 120, outputTokens: 30, estimated: false }, now,
    }
    const first = finishAgentRun(companion.db, input)
    expect(finishAgentRun(companion.db, { ...input, now: now + 10 })).toEqual(first)
    expect(() => finishAgentRun(companion.db, { ...input, status: 'failed' })).toThrow('E_RUN_ALREADY_FINISHED')
    expect(start().id).not.toBe(first.id)
    expect(companion.db.select().from(agentRuns).all()).toHaveLength(2)
  })

  it('试聊触发类型由数据库推导，未保存的草稿可不关联正式人设版本', () => {
    const formal = companion.db.select().from(conversations).get()!
    companion.db.insert(conversations).values({ ...formal, id: 'preview-check', mode: 'preview' }).run()
    expect(startAgentRun(companion.db, {
      conversationId: 'preview-check', characterVersionId: null, model: 'test', provider: 'test', now,
    })).toMatchObject({ triggerType: 'preview', characterId: formal.characterId, characterVersionId: null })
  })

  it('拒绝缺失会话、其他角色版本及空模型，不产生运行记录', () => {
    const input = { conversationId, characterVersionId, model: 'test', provider: 'test', now }
    expect(() => startAgentRun(companion.db, { ...input, conversationId: 'missing' }))
      .toThrow('E_CONVERSATION_NOT_FOUND')
    expect(() => startAgentRun(companion.db, { ...input, characterVersionId: null }))
      .toThrow('E_VERSION_NOT_ALLOWED')
    const version = companion.db.select().from(characterVersions).get()!
    // 用另一个完整角色来验证归属，不只测「版本号不存在」。
    const original = companion.db.select().from(conversations).get()!
    const character = companion.db.select().from(characters).get()!
    const settings = companion.db.select().from(companionSettings).get()!
    companion.db.transaction((tx) => {
      tx.insert(characters).values({ ...character, id: 'other', name: '乙' }).run()
      tx.insert(characterVersions).values({ ...version, id: 'other-version', characterId: 'other' }).run()
      tx.insert(conversations).values({ ...original, id: 'other-conversation', characterId: 'other' }).run()
      tx.insert(companionSettings).values({ ...settings, characterId: 'other' }).run()
    })
    expect(() => startAgentRun(companion.db, { ...input, conversationId: 'other-conversation' }))
      .toThrow('E_VERSION_NOT_ALLOWED')
    expect(() => startAgentRun(companion.db, { ...input, model: ' ' })).toThrow('E_INVALID_RUN')
    expect(companion.db.select().from(agentRuns).all()).toHaveLength(0)
  })

  it('拒绝非法用量和含正文的错误信息，原运行继续保持未结束', () => {
    const runId = start().id
    for (const usage of [
      { inputTokens: -1, outputTokens: 0, estimated: false },
      { inputTokens: 0.5, outputTokens: 1, estimated: false },
      { inputTokens: 0, outputTokens: 0, estimated: true },
    ]) {
      expect(() => finishAgentRun(companion.db, { runId, status: 'failed', usage, now }))
        .toThrow('E_INVALID_USAGE')
    }
    expect(() => finishAgentRun(companion.db, {
      runId, status: 'failed', usage: { inputTokens: 1, outputTokens: 1, estimated: true },
      errorCode: '请求失败，用户说了私人内容', now,
    })).toThrow('E_INVALID_ERROR_CODE')
    expect(companion.db.select().from(agentRuns).get()?.status).toBe('running')
  })
})
