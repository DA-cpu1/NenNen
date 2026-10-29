/**
 * 独立真实 eve 验收：本机供应商反复要求一个不存在的工具，诱发后续生成步骤。
 * 确认公开步骤从 0 开始，供应商最多收到 3 次请求，第 4 步在本地被拒绝。
 * 本脚本不进普通单元测试；先 build:agent，再用已有 esbuild 打包执行。
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { Client, type ClientSession } from 'eve/client'
import { startEve, type EveHandle } from '../src/agent/eve-process'
import { openCompanionDatabase, type CompanionDb } from '../src/data/db'
import { runMigrations } from '../src/data/migrations'
import { initializeFirstCharacter } from '../src/data/character-init'
import { saveUserMessage } from '../src/data/messages'
import { agentRuns } from '../src/data/tables'
import { runFormalTurn } from '../src/agent/turn-runner'
import type { TurnEvent } from '../src/agent/eve-events'

/**
 * 跑真实框架与固定供应商循环；输出只含次数、步骤编号和错误码。
 * @returns 全部断言及框架/监听端口清理结束后完成
 */
async function main(): Promise<void> {
  const key = randomBytes(24).toString('base64url')
  let calls = 0
  const provider = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${key}`)
    for await (const _chunk of request) { /* 不保存固定请求正文。 */ }
    calls += 1
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const payload of [
      { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{
        index: 0, id: `fixed-call-${calls}`, type: 'function',
        function: { name: 'fixed_nonexistent_tool', arguments: '{}' },
      }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } },
    ]) response.write('data: ' + JSON.stringify({
      id: `fixed-${calls}`, object: 'chat.completion.chunk', created: 0, model: 'glm-5.3-flash', ...payload,
    }) + '\n\n')
    response.end('data: [DONE]\n\n')
  })
  let eve: EveHandle | undefined
  let session: ClientSession | undefined
  let companion: CompanionDb | undefined
  try {
    await new Promise<void>((accept) => provider.listen(0, '127.0.0.1', accept))
    const address = provider.address()
    assert(address && typeof address !== 'string')
    eve = await startEve({
      appDir: resolve(process.cwd()), modelApiKey: key,
      modelBaseUrl: `http://127.0.0.1:${address.port}/v1`,
    })
    const client = new Client({ host: `http://127.0.0.1:${eve.port}`, auth: { bearer: eve.token }, redirect: 'error' })
    const created = await client.sessions.create({ message: '请只回复两个字：收到', signal: AbortSignal.timeout(45_000) })
    session = created.session
    const result = await created.response.result()
    const indices = result.events.filter((event) => event.type === 'step.started').map((event) => event.data.stepIndex)
    const failures = result.events.filter((event) => event.type === 'turn.failed' || event.type === 'step.failed')
      .map((event) => ({ type: event.type, code: event.data.code, limitRejected: event.data.message === 'E_TURN_LIMIT' }))
    // 只打印固定编号与码；不打印框架错误 message，它可能夹带上下文。
    process.stdout.write(JSON.stringify({ providerCalls: calls, stepIndices: indices, failures }) + '\n')
    assert.equal(calls, 3)
    assert.deepEqual(indices, [0, 1, 2, 3])
    assert(failures.some((event) => event.limitRejected))
    await session.reset({ signal: AbortSignal.timeout(5_000) })
    session = undefined

    // 再走应用真实编排，确认供应商次数、对外限额码和用量记账同时成立。
    calls = 0
    companion = openCompanionDatabase(':memory:')
    runMigrations(companion.sqlite)
    const initial = initializeFirstCharacter(companion.db, {
      name: '固定测试角色', personaText: '固定性格', initialRelationship: '恋人', timezone: 'Asia/Hong_Kong',
    })
    const user = saveUserMessage(companion.db, {
      conversationId: initial.conversationId, requestId: 'fixed-budget-request', content: '固定问题',
    }).message
    const events: TurnEvent[] = []
    for await (const event of runFormalTurn(companion.db, eve, {
      conversationId: initial.conversationId, userMessageId: user.id, commonRules: '不编造经历。',
      limits: { modelWindowTokens: 13_000 }, model: 'fixed', provider: 'fixed',
    }, AbortSignal.timeout(30_000))) events.push(event)
    assert.equal(calls, 3)
    assert.deepEqual(events.at(-1), { type: 'failed', code: 'E_TURN_LIMIT' })
    const run = companion.db.select().from(agentRuns).get()!
    assert.equal(run.status, 'failed')
    assert.equal(run.errorCode, 'E_TURN_LIMIT')
    assert.equal(run.inputTokens, 24)
    assert.equal(run.outputTokens, 6)
    assert.equal(run.usageEstimated, 0)
    process.stdout.write(JSON.stringify({ applicationProviderCalls: calls, code: run.errorCode,
      inputTokens: run.inputTokens, outputTokens: run.outputTokens, usageEstimated: false }) + '\n')
  } finally {
    try { await session?.reset({ signal: AbortSignal.timeout(5_000) }) } finally { await eve?.stop() }
    companion?.close()
    provider.closeAllConnections()
    await new Promise<void>((accept) => provider.close(() => accept()))
  }
}

await main()
