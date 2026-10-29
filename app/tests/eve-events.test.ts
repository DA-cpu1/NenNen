/**
 * 用固定事件序列检查回合消费：文字增量落库、终态判定、用量记账与额度取消。
 * 假 response 只提供事件迭代和取消两个能力（真实句柄也只用这两样），
 * 不启动框架、不连网络；数据库为内存库，不读正式资料。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { openCompanionDatabase, type CompanionDb } from '../src/data/db'
import { runMigrations } from '../src/data/migrations'
import { initializeFirstCharacter } from '../src/data/character-init'
import { saveUserMessage, createAssistantReply } from '../src/data/messages'
import { startAgentRun } from '../src/data/agent-runs'
import { agentRuns, characterVersions, messages } from '../src/data/tables'
import { consumeEveTurn, type TurnEvent, type TurnOutcome } from '../src/agent/eve-events'
import type { MessageResponse } from 'eve/client'

let companion: CompanionDb
let replyId: string
let runId: string

beforeEach(() => {
  companion = openCompanionDatabase(':memory:')
  runMigrations(companion.sqlite)
  const conversationId = initializeFirstCharacter(companion.db, {
    name: '测试角色', personaText: '固定性格', initialRelationship: '恋人', timezone: 'Asia/Hong_Kong',
  }).conversationId
  const user = saveUserMessage(companion.db, {
    conversationId, requestId: 'req-1', content: '固定问题',
  }).message
  replyId = createAssistantReply(companion.db, { userMessageId: user.id }).id
  const version = companion.db.select().from(characterVersions)
    .where(eq(characterVersions.isActive, 1)).get()!
  runId = startAgentRun(companion.db, {
    conversationId, characterVersionId: version.id, model: 'fixed-model', provider: 'fixed-provider',
  }).id
})

afterEach(() => companion.close())

/** 测试用事件：只填消费代码实际读取的字段，缺省字段不参与断言。 */
type FakeEvent = { type: string; data?: Record<string, unknown> }

function appended(delta: string): FakeEvent {
  return { type: 'message.appended', data: { messageDelta: delta, sequence: 1, stepIndex: 0, turnId: 't1' } }
}
function messageDone(text: string): FakeEvent {
  return { type: 'message.completed', data: { finishReason: 'stop', message: text, sequence: 2, stepIndex: 0, turnId: 't1' } }
}
function stepStarted(index: number): FakeEvent {
  return { type: 'step.started', data: { modelId: 'fixed-model', sequence: 0, stepIndex: index, turnId: 't1' } }
}
function stepCompleted(inputTokens?: number, outputTokens?: number): FakeEvent {
  return {
    type: 'step.completed',
    data: {
      finishReason: 'stop', sequence: 3, stepIndex: 0, turnId: 't1',
      usage: inputTokens === undefined ? undefined : { inputTokens, outputTokens: outputTokens ?? 0 },
    },
  }
}
function turnCompleted(): FakeEvent {
  return { type: 'turn.completed', data: { sequence: 9, turnId: 't1' } }
}
function turnFailed(code: string): FakeEvent {
  return { type: 'turn.failed', data: { code, message: '不进数据库的原始报错正文', sequence: 9, turnId: 't1' } }
}
function turnCancelled(): FakeEvent {
  return { type: 'turn.cancelled', data: { sequence: 9, turnId: 't1' } }
}
function sessionCompleted(inputTokens?: number, outputTokens?: number): FakeEvent {
  const usage = inputTokens === undefined ? undefined
    : { inputTokens, outputTokens: outputTokens ?? 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  return usage === undefined ? { type: 'session.completed' } : { type: 'session.completed', data: { usage } }
}

/** 造一个只支持迭代与取消的假受理句柄，并数一数取消被调了几次。 */
function fakeResponse(events: FakeEvent[], streamError?: Error) {
  const state = { cancelled: 0 }
  const response = {
    cancel: async () => { state.cancelled += 1 },
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event as never
      if (streamError) throw streamError
    },
  }
  return { response: response as unknown as MessageResponse, state }
}

/** 把生成器跑完，收集界面事件与最终汇总（return value 在最后一个 next 里）。 */
async function drive(generator: AsyncGenerator<TurnEvent, TurnOutcome>) {
  const events: TurnEvent[] = []
  for (;;) {
    const step = await generator.next()
    if (step.done) return { events, outcome: step.value }
    events.push(step.value)
  }
}

function replyRow() {
  return companion.db.select().from(messages).where(eq(messages.id, replyId)).get()!
}
function runRow() {
  return companion.db.select().from(agentRuns).where(eq(agentRuns.id, runId)).get()!
}

describe('eve 回合事件消费（T06⑪a）', () => {
  it('流式增量逐步入库，完成时按步骤用量精确记账', async () => {
    const { response } = fakeResponse([
      stepStarted(0), appended('你'), appended('好'), messageDone('你好'),
      stepCompleted(31, 9), turnCompleted(), sessionCompleted(),
    ])
    const { events, outcome } = await drive(consumeEveTurn(companion.db, {
      response, replyId, runId, estimatedInputTokens: 1_000,
    }))
    expect(events).toEqual([
      { type: 'text', delta: '你' }, { type: 'text', delta: '好' }, { type: 'done', replyId },
    ])
    expect(outcome).toEqual({ status: 'completed', finalText: '你好', usageEstimated: false })
    expect(replyRow()).toMatchObject({ role: 'assistant', content: '你好', status: 'completed' })
    expect(runRow()).toMatchObject({
      status: 'completed', inputTokens: 31, outputTokens: 9, usageEstimated: 0, errorCode: null,
    })
  })

  it('会话级用量优先于步骤累计', async () => {
    const { response } = fakeResponse([
      stepStarted(0), appended('好'), stepCompleted(5, 5),
      turnCompleted(), sessionCompleted(40, 10),
    ])
    await drive(consumeEveTurn(companion.db, { response, replyId, runId, estimatedInputTokens: 1_000 }))
    expect(runRow()).toMatchObject({ inputTokens: 40, outputTokens: 10, usageEstimated: 0 })
  })

  it('供应商没给用量时用保守估算记账且绝不为零', async () => {
    const { response } = fakeResponse([
      stepStarted(0), appended('文字'), messageDone('文字'), turnCompleted(), sessionCompleted(),
    ])
    const { outcome } = await drive(consumeEveTurn(companion.db, {
      response, replyId, runId, estimatedInputTokens: 1_000,
    }))
    expect(outcome.usageEstimated).toBe(true)
    const run = runRow()
    expect(run.usageEstimated).toBe(1)
    expect(run.inputTokens).toBe(1_000)
    expect((run.inputTokens ?? 0) + (run.outputTokens ?? 0)).toBeGreaterThan(0)
  })

  it('回合失败保留半截文字，只存固定错误码不存原始报错', async () => {
    const { response } = fakeResponse([
      stepStarted(0), appended('半截'), turnFailed('E_PROVIDER_DOWN'),
    ])
    const { events, outcome } = await drive(consumeEveTurn(companion.db, {
      response, replyId, runId, estimatedInputTokens: 100,
    }))
    expect(events.at(-1)).toEqual({ type: 'failed', code: 'E_PROVIDER_DOWN' })
    expect(outcome).toEqual({ status: 'failed', finalText: '半截', usageEstimated: true })
    expect(replyRow()).toMatchObject({ content: '半截', status: 'failed' })
    expect(runRow()).toMatchObject({ status: 'failed', errorCode: 'E_PROVIDER_DOWN' })
    expect(runRow().errorCode).not.toContain('原始报错')
  })

  it('框架错误码不合固定格式时替换为 E_TURN_FAILED', async () => {
    const { response } = fakeResponse([turnFailed('混合正文的 oops')])
    const { events } = await drive(consumeEveTurn(companion.db, {
      response, replyId, runId, estimatedInputTokens: 100,
    }))
    expect(events.at(-1)).toEqual({ type: 'failed', code: 'E_TURN_FAILED' })
    expect(runRow().errorCode).toBe('E_TURN_FAILED')
  })

  it('回合取消保留已到文字，运行记 cancelled 且不带错误码', async () => {
    const { response } = fakeResponse([appended('部分'), turnCancelled()])
    const { events, outcome } = await drive(consumeEveTurn(companion.db, {
      response, replyId, runId, estimatedInputTokens: 100,
    }))
    expect(events).toEqual([{ type: 'text', delta: '部分' }, { type: 'cancelled' }])
    expect(outcome.status).toBe('cancelled')
    expect(replyRow()).toMatchObject({ content: '部分', status: 'cancelled' })
    expect(runRow()).toMatchObject({ status: 'cancelled', errorCode: null })
  })

  it('模型生成超过 3 次时主动取消并记 E_TURN_LIMIT，后续取消事件不改写结论', async () => {
    const { response, state } = fakeResponse([
      stepStarted(0), stepStarted(1), stepStarted(2),
      appended('还在生成'), stepStarted(3), turnCancelled(),
    ])
    const { events, outcome } = await drive(consumeEveTurn(companion.db, {
      response, replyId, runId, estimatedInputTokens: 100,
    }))
    expect(state.cancelled).toBe(1)
    expect(events.at(-1)).toEqual({ type: 'failed', code: 'E_TURN_LIMIT' })
    expect(outcome.status).toBe('failed')
    expect(runRow()).toMatchObject({ status: 'failed', errorCode: 'E_TURN_LIMIT' })
  })

  it('事件流中途断开且非中止时记 E_EVE_STREAM_FAILED', async () => {
    const { response } = fakeResponse([appended('x')], new Error('网络断开正文'))
    const { events } = await drive(consumeEveTurn(companion.db, {
      response, replyId, runId, estimatedInputTokens: 100,
    }))
    expect(events.at(-1)).toEqual({ type: 'failed', code: 'E_EVE_STREAM_FAILED' })
    expect(replyRow()).toMatchObject({ content: 'x', status: 'failed' })
    expect(runRow().errorCode).toBe('E_EVE_STREAM_FAILED')
  })

  it('调用前已中止则直接取消并记 cancelled，不读任何事件', async () => {
    const { response, state } = fakeResponse([appended('不应到达')])
    const controller = new AbortController()
    controller.abort()
    const { events, outcome } = await drive(consumeEveTurn(companion.db, {
      response, replyId, runId, estimatedInputTokens: 100,
    }, controller.signal))
    expect(state.cancelled).toBe(1)
    expect(events).toEqual([{ type: 'cancelled' }])
    expect(outcome).toMatchObject({ status: 'cancelled', finalText: '' })
    expect(runRow().status).toBe('cancelled')
  })

  it('停止后迟到的文字和完成事件不显示、不落库，也不能改成成功', async () => {
    const controller = new AbortController()
    let cancelCalls = 0
    const response = {
      cancel: async () => { cancelCalls += 1 },
      async *[Symbol.asyncIterator]() {
        yield appended('半截') as never
        controller.abort()
        yield appended('迟到文字') as never
        yield turnCompleted() as never
      },
    } as unknown as MessageResponse
    const { events, outcome } = await drive(consumeEveTurn(companion.db, {
      response, replyId, runId, estimatedInputTokens: 100,
    }, controller.signal))
    expect(events).toEqual([{ type: 'text', delta: '半截' }, { type: 'cancelled' }])
    expect(outcome).toMatchObject({ status: 'cancelled', finalText: '半截' })
    expect(replyRow()).toMatchObject({ content: '半截', status: 'cancelled' })
    expect(cancelCalls).toBe(1)
  })

  it('框架取消事件后的迟到文字被拒绝，用量仍可收取', async () => {
    const { response } = fakeResponse([
      appended('半截'), turnCancelled(), appended('迟到'), messageDone('错误全文'),
      sessionCompleted(20, 3),
    ])
    const { events, outcome } = await drive(consumeEveTurn(companion.db, {
      response, replyId, runId, estimatedInputTokens: 100,
    }))
    expect(events).toEqual([{ type: 'text', delta: '半截' }, { type: 'cancelled' }])
    expect(outcome).toMatchObject({ status: 'cancelled', finalText: '半截' })
    expect(replyRow()).toMatchObject({ content: '半截', status: 'cancelled' })
    expect(runRow()).toMatchObject({ inputTokens: 20, outputTokens: 3, usageEstimated: 0 })
  })

  it('完成但一个字都没到时记 E_EMPTY_REPLY，不把空白标成成功', async () => {
    const { response } = fakeResponse([stepStarted(0), turnCompleted(), sessionCompleted()])
    const { events } = await drive(consumeEveTurn(companion.db, {
      response, replyId, runId, estimatedInputTokens: 100,
    }))
    expect(events.at(-1)).toEqual({ type: 'failed', code: 'E_EMPTY_REPLY' })
    expect(runRow()).toMatchObject({ status: 'failed', errorCode: 'E_EMPTY_REPLY' })
  })

  it('多步骤回复按段拼接全文，增量不重复计入', async () => {
    const { response } = fakeResponse([
      stepStarted(0), appended('第一'), messageDone('第一段'),
      stepStarted(1), appended('第二'), messageDone('第二段'),
      turnCompleted(), sessionCompleted(),
    ])
    const { outcome } = await drive(consumeEveTurn(companion.db, {
      response, replyId, runId, estimatedInputTokens: 100,
    }))
    expect(outcome.finalText).toBe('第一段第二段')
    expect(replyRow().content).toBe('第一段第二段')
  })

  it('流正常结束却没有任何终态事件时按 E_TURN_STREAM_ENDED 收场', async () => {
    const { response } = fakeResponse([appended('文字')])
    const { events } = await drive(consumeEveTurn(companion.db, {
      response, replyId, runId, estimatedInputTokens: 100,
    }))
    expect(events.at(-1)).toEqual({ type: 'failed', code: 'E_TURN_STREAM_ENDED' })
    expect(runRow().errorCode).toBe('E_TURN_STREAM_ENDED')
  })

  it('数据库不可写时保留事件流收尾：文字仍交给界面，终态留给退出恢复', async () => {
    companion.sqlite.pragma('query_only = ON')
    const { response, state } = fakeResponse([
      stepStarted(0), appended('可见但未保存'), turnFailed('E_PROVIDER_DOWN'),
    ])
    const { events } = await drive(consumeEveTurn(companion.db, {
      response, replyId, runId, estimatedInputTokens: 100,
    }))
    expect(state.cancelled).toBe(0)
    // 界面必须知道文字未保存，才能保留可见文本；原始回合失败原因仍由账本记载。
    expect(events).toEqual([
      { type: 'text', delta: '可见但未保存' },
      { type: 'failed', code: 'E_REPLY_SAVE_FAILED' },
    ])
    companion.sqlite.pragma('query_only = OFF')
    // 库恢复后行还是进行中状态：由编排层的退出恢复负责收拾，不在这里补写。
    expect(replyRow().status).toBe('pending')
  })

  it('回合本会成功但库不可写时，失败原因记存储码', async () => {
    companion.sqlite.pragma('query_only = ON')
    const { response } = fakeResponse([
      stepStarted(0), appended('文字'), turnCompleted(), sessionCompleted(),
    ])
    const { events } = await drive(consumeEveTurn(companion.db, {
      response, replyId, runId, estimatedInputTokens: 100,
    }))
    expect(events.at(-1)).toEqual({ type: 'failed', code: 'E_REPLY_SAVE_FAILED' })
  })

  it('流式保存成功但回复终态 UPDATE 失败时，禁止 done 并明确回复未保存', async () => {
    // 触发器只拦「完成」那次更新，保证这项检查不是重复测流式写入失败。
    companion.sqlite.exec(`
      CREATE TRIGGER fail_reply_completion BEFORE UPDATE OF status ON messages
      WHEN NEW.role = 'assistant' AND NEW.status = 'completed'
      BEGIN SELECT RAISE(ABORT, 'fixed-test-failure'); END;
    `)
    const { response } = fakeResponse([appended('完整回复'), turnCompleted(), sessionCompleted(20, 3)])
    const { events, outcome } = await drive(consumeEveTurn(companion.db, {
      response, replyId, runId, estimatedInputTokens: 100,
    }))
    expect(events).toEqual([
      { type: 'text', delta: '完整回复' }, { type: 'failed', code: 'E_REPLY_SAVE_FAILED' },
    ])
    expect(outcome).toMatchObject({ status: 'failed', finalText: '完整回复' })
    expect(replyRow()).toMatchObject({ status: 'streaming', content: '完整回复' })
    expect(runRow()).toMatchObject({ status: 'failed', errorCode: 'E_REPLY_SAVE_FAILED', inputTokens: 20, outputTokens: 3 })
  })

  it('回复已保存但账本 UPDATE 失败时，禁止 done 并明确用量未保存', async () => {
    companion.sqlite.exec(`
      CREATE TRIGGER fail_run_completion BEFORE UPDATE ON agent_runs
      BEGIN SELECT RAISE(ABORT, 'fixed-test-failure'); END;
    `)
    const { response } = fakeResponse([appended('完整回复'), turnCompleted(), sessionCompleted(20, 3)])
    const { events, outcome } = await drive(consumeEveTurn(companion.db, {
      response, replyId, runId, estimatedInputTokens: 100,
    }))
    expect(events).toEqual([
      { type: 'text', delta: '完整回复' }, { type: 'failed', code: 'E_RUN_SAVE_FAILED' },
    ])
    expect(outcome).toMatchObject({ status: 'failed', finalText: '完整回复' })
    expect(replyRow()).toMatchObject({ status: 'completed', content: '完整回复' })
    expect(runRow()).toMatchObject({ status: 'running', inputTokens: null, outputTokens: null })
  })

  it('模型失败和回复保存失败并发时，对外提示未保存、账本保留模型失败原因', async () => {
    companion.sqlite.exec(`
      CREATE TRIGGER fail_reply_failure BEFORE UPDATE OF status ON messages
      WHEN NEW.role = 'assistant' AND NEW.status = 'failed'
      BEGIN SELECT RAISE(ABORT, 'fixed-test-failure'); END;
    `)
    const { response } = fakeResponse([appended('半截'), turnFailed('E_PROVIDER_DOWN')])
    const { events } = await drive(consumeEveTurn(companion.db, {
      response, replyId, runId, estimatedInputTokens: 100,
    }))
    expect(events.at(-1)).toEqual({ type: 'failed', code: 'E_REPLY_SAVE_FAILED' })
    expect(runRow()).toMatchObject({ status: 'failed', errorCode: 'E_PROVIDER_DOWN' })
  })
})
