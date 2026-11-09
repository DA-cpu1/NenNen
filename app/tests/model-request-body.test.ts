/**
 * 用本机固定 HTTP 服务检查真正发给供应商的请求体。
 * 只验证公开参数（温度、Top P、思考开关与档位），不连接外网、不使用真实密钥。
 */
import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateText } from 'ai'
import { createCompanionLanguageModel } from '../src/agent/model'
import { DEEPSEEK_MODEL_CONNECTION, DEFAULT_MODEL_CONNECTION, type ModelConnection } from '../src/shared/model-settings'

let server: Server
let baseUrl: string
let bodies: Array<Record<string, unknown>>

beforeEach(async () => {
  bodies = []
  server = createServer(async (request, response) => {
    let text = ''
    for await (const chunk of request) text += chunk
    bodies.push(JSON.parse(text))
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ id: 'fixed-request', object: 'chat.completion', created: 0, model: 'fixed',
      choices: [{ index: 0, message: { role: 'assistant', content: '固定回复' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
})
afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** 发一次普通文字请求，返回供应商实际收到的 JSON。 */
async function request(connection: ModelConnection) {
  await generateText({ model: createCompanionLanguageModel('fake-api-key', connection), prompt: '固定测试输入' })
  return bodies.at(-1)!
}

describe('模型请求体里的回复参数', () => {
  it('DeepSeek 未开启思考时显式关闭，且不发送温度和档位', async () => {
    const body = await request({ ...DEEPSEEK_MODEL_CONNECTION, baseUrl })
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.reasoning_effort).toBeUndefined()
    expect(body.temperature).toBeUndefined()
  })

  it('DeepSeek 开启思考时发送档位，并按官方规则省略温度', async () => {
    const body = await request({ ...DEEPSEEK_MODEL_CONNECTION, baseUrl, temperature: 1.2, topP: 0.98,
      reasoning: { enabled: true, effort: 'max' } })
    expect(body.thinking).toEqual({ type: 'enabled' })
    expect(body.reasoning_effort).toBe('max')
    expect(body.temperature).toBeUndefined()
    expect(body.top_p).toBe(0.98)
  })

  it('智谱 GLM-5.3 即使存了关闭也会按强制思考发送', async () => {
    const body = await request({ ...DEFAULT_MODEL_CONNECTION, baseUrl, temperature: 0.7, topP: 0.9,
      reasoning: { enabled: false, effort: 'low' } })
    expect(body.thinking).toEqual({ type: 'enabled' })
    expect(body.reasoning_effort).toBe('low')
    expect(body.temperature).toBe(0.7)
    expect(body.top_p).toBe(0.9)
  })

  it('智谱旧配置不带思考字段时不擅自添加，交给服务商默认值', async () => {
    const body = await request({ ...DEFAULT_MODEL_CONNECTION, baseUrl })
    expect(body.thinking).toBeUndefined()
    expect(body.reasoning_effort).toBeUndefined()
  })

  it('自定义服务不发送 thinking，只发送推理档位和通用采样参数', async () => {
    const body = await request({ provider: 'openai-compatible', model: 'fixed-model', baseUrl,
      temperature: 0.6, topP: 0.8, reasoning: { enabled: true, effort: 'high' },
      contextWindowTokens: 32768, outputReserveTokens: 4096 })
    expect(body.thinking).toBeUndefined()
    expect(body.reasoning_effort).toBe('high')
    expect(body.temperature).toBe(0.6)
    expect(body.top_p).toBe(0.8)
  })

  it('助手历史里的思考内容会作为 reasoning_content 回传', async () => {
    await generateText({
      model: createCompanionLanguageModel('fake-api-key', { ...DEEPSEEK_MODEL_CONNECTION, baseUrl,
        reasoning: { enabled: true, effort: 'high' } }),
      messages: [
        { role: 'user', content: '第一句' },
        { role: 'assistant', content: [
          { type: 'reasoning', text: '先想一下再回答。' },
          { type: 'text', text: '第一句回复' },
        ] },
        { role: 'user', content: '第二句' },
      ],
    })
    const sent = bodies.at(-1)!.messages as Array<{ role: string; reasoning_content?: string }>
    expect(sent.find((message) => message.role === 'assistant')?.reasoning_content).toBe('先想一下再回答。')
  })
})
