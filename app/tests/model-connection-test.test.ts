/** 用真正 AI SDK 与本机固定 HTTP 响应检查工具能力，不连接外网或调用付费模型。 */
import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { testModelConnection } from '../src/agent/model-connection-test'
import { DEFAULT_MODEL_CONNECTION } from '../src/shared/model-settings'

let server: Server
let baseUrl: string
let mode: 'tool' | 'text' | 'reject-tools' | 'unauthorized' | 'hold'
let calls: number
let model: string | undefined

beforeEach(async () => {
  mode = 'tool'; calls = 0; model = undefined
  server = createServer(async (request, response) => {
    calls += 1
    let text = ''
    for await (const chunk of request) text += chunk
    const input = JSON.parse(text)
    model = input.model
    if (mode === 'hold') return
    if (mode === 'unauthorized' || mode === 'reject-tools') {
      response.writeHead(mode === 'unauthorized' ? 401 : 400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: mode === 'unauthorized' ? 'fake-sensitive-detail' : 'tools are not supported' } }))
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ id: 'fixed-connection', object: 'chat.completion', created: 0, model: input.model,
      choices: [{ index: 0, message: mode === 'tool'
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'fixed-call', type: 'function', function: {
          name: 'connection_check', arguments: JSON.stringify({ confirmation: 'ok' }),
        } }] } : { role: 'assistant', content: 'fixed text' }, finish_reason: mode === 'tool' ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 17, completion_tokens: 4, total_tokens: 21 },
    }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
})
afterEach(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) })

/** 固定新模型名可以证明没有继续使用旧的写死模型。 */
function run(signal = new AbortController().signal) {
  return testModelConnection({ ...DEFAULT_MODEL_CONNECTION, baseUrl, model: 'fixed-custom-model' }, 'fake-api-key', signal)
}

describe('单次连接与工具能力测试', () => {
  it('只有合法工具调用才通过，并返回实际用量', async () => {
    expect(await run()).toEqual({ status: 'passed', usage: { inputTokens: 17, outputTokens: 4 } })
    expect(model).toBe('fixed-custom-model')
    expect(calls).toBe(1)
  })
  it.each(['text', 'reject-tools'] as const)('%s 不会被标为完整可用', async (value) => {
    mode = value
    expect(await run()).toMatchObject({ status: 'unsupported' })
    expect(calls).toBe(1)
  })
  it('认证失败只给固定码，不自动重试也不返回供应商原文', async () => {
    mode = 'unauthorized'
    await expect(run()).rejects.toThrow(/^E_MODEL_CONNECTION$/)
    expect(calls).toBe(1)
  })
  it('用户取消能结束等待，不等供应商主动断开', async () => {
    mode = 'hold'
    const controller = new AbortController()
    const result = run(controller.signal)
    const checked = expect(result).rejects.toThrow(/^E_MODEL_TEST_CANCELLED$/)
    controller.abort()
    await checked
  })
})
