/**
 * 用实际 Agent 动态解析器和本机固定供应商检查生成次数：前三步可请求，第四步
 * 在 HTTP 发送前失败。假密钥只在测试内存，固定输入不含正式用户资料。
 */
import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import agent from '../agent/agent'
import { createModelStepLimitMiddleware, MAX_MODEL_GENERATIONS_PER_TURN } from '../agent/lib/model-step-limit'
import { MAX_MODEL_CALLS_PER_TURN } from '../src/agent/eve-events'

// 单元检查不在 eve 的运行上下文里：只替换状态槽，模型配置、SDK 和 HTTP 都用真的。
// 真实 defineState 的跨步行为另由 model-step-limit-native.ts 验证。
const { budget } = vi.hoisted(() => ({ budget: { value: { turnId: '', calls: 0 } } }))
vi.mock('eve/context', () => ({
  defineState: () => ({
    get: () => budget.value,
    update: (update: (current: typeof budget.value) => typeof budget.value) => { budget.value = update(budget.value) },
  }),
}))

vi.mock('../agent/lib/stdin-secrets', () => ({
  waitSecrets: async () => ({ modelApiKey: 'fixed-local-key', routeToken: 'unused-local-token' }),
}))

let server: Server
let providerCalls: number

beforeEach(async () => {
  providerCalls = 0
  budget.value = { turnId: '', calls: 0 }
  server = createServer(async (request, response) => {
    providerCalls += 1
    let body = ''
    for await (const chunk of request) body += chunk
    const input = JSON.parse(body) as { stream?: boolean }
    if (input.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: ' + JSON.stringify({
        id: 'fixed', object: 'chat.completion.chunk', created: 0, model: 'fixed',
        choices: [{ index: 0, delta: { content: '收到' }, finish_reason: null }],
      }) + '\n\n')
      response.write('data: ' + JSON.stringify({
        id: 'fixed', object: 'chat.completion.chunk', created: 0, model: 'fixed',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }) + '\n\n')
      response.end('data: [DONE]\n\n')
    } else {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        id: 'fixed', object: 'chat.completion', created: 0, model: 'fixed',
        choices: [{ index: 0, message: { role: 'assistant', content: '收到' }, finish_reason: 'stop' }],
      }))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('固定供应商未监听端口')
  vi.stubEnv('COMPANION_MODEL_BASE_URL', `http://127.0.0.1:${address.port}/v1`)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** 调用真实 Agent 的公开动态模型解析器，测试不会自行另拼一份模型配置。 */
async function modelAtStep(stepIndex: number, turnId = 'fixed-turn') {
  return (await agent.model.events['step.started']!({
    type: 'step.started', data: { stepIndex, turnId, sequence: 0, modelId: 'fixed' },
  }, {
    model: null, session: { id: 'fixed-session', auth: { current: null, initiator: null } }, channel: {}, messages: [],
  })).model
}

/** 唯一允许不带后台上下文信封的固定 T01 探针，足够验证实际 SDK 请求。 */
const prompt = [{ role: 'user' as const, content: [{ type: 'text' as const, text: '请只回复两个字：收到' }] }]

describe('供应商调用前的每轮生成上限', () => {
  it('前三步共发出3次真实HTTP请求，第4步普通与流式均为 E_TURN_LIMIT、零新增请求', async () => {
    expect(MAX_MODEL_GENERATIONS_PER_TURN).toBe(MAX_MODEL_CALLS_PER_TURN)
    for (const stepIndex of [0, 1]) {
      await (await modelAtStep(stepIndex)).doGenerate({ prompt })
    }
    const streamed = await (await modelAtStep(2)).doStream({ prompt })
    const reader = streamed.stream.getReader()
    while (!(await reader.read()).done) { /* 读完固定回复，关闭本次连接。 */ }
    expect(providerCalls).toBe(3)
    const fourth = await modelAtStep(3)
    await expect(fourth.doGenerate({ prompt })).rejects.toThrow(/^E_TURN_LIMIT$/)
    await expect(fourth.doStream({ prompt })).rejects.toThrow(/^E_TURN_LIMIT$/)
    expect(providerCalls).toBe(3)
  })

  it('步骤字段损坏时拒绝，不猜一个允许调用的编号', () => {
    for (const event of [null, {}, { type: 'turn.started', data: { stepIndex: 0 } },
      { type: 'step.started', data: { stepIndex: -1, turnId: 'fixed-turn' } },
      { type: 'step.started', data: { stepIndex: 0.5, turnId: 'fixed-turn' } }]) {
      expect(() => createModelStepLimitMiddleware(event)).toThrow(/^E_INVALID_MODEL_STEP$/)
    }
    expect(providerCalls).toBe(0)
  })

  it('同一步骤重试也计数，新回合才重置额度，不依赖 resolver 的步骤编号', async () => {
    const sameStep = await modelAtStep(0)
    for (let attempt = 0; attempt < 3; attempt += 1) await sameStep.doGenerate({ prompt })
    await expect(sameStep.doGenerate({ prompt })).rejects.toThrow(/^E_TURN_LIMIT$/)
    expect(providerCalls).toBe(3)
    await (await modelAtStep(0, 'next-turn')).doGenerate({ prompt })
    expect(providerCalls).toBe(4)
  })
})
