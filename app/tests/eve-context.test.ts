/**
 * 用真实 AI SDK 和本机假供应商检查 eve 调用前的上下文关卡。
 * 假供应商只是固定回话的 HTTP 服务：不连接外网、不读取密钥、不产生模型费用。
 * 检查实际发出的消息和输出上限，防止只测内部函数却漏掉 SDK 转换后的请求。
 */
import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { wrapLanguageModel } from 'ai'
import { createCompanionContextMiddleware } from '../agent/lib/context-middleware'
import { decodeEveTurnEnvelope, encodeEveTurnEnvelope } from '../src/shared/eve-turn-envelope'

type ModelCallOptions = Parameters<ReturnType<typeof wrapLanguageModel>['doGenerate']>[0]

/** 只读取本步要核对的请求字段；这些固定测试资料不包含用户的正式聊天。 */
interface ProviderRequest {
  messages: Array<{ role: string; content: unknown; tool_calls?: unknown[]; tool_call_id?: string }>
  max_tokens?: number
  stream?: boolean
  tools?: unknown[]
}

let server: Server
let model: ReturnType<typeof wrapLanguageModel>
let requests: ProviderRequest[]

/**
 * 每项检查启动独立的本机服务，接收 SDK 真正发送的 JSON 后固定回复“收到”。
 * @returns 服务监听成功后结束；地址只绑定 127.0.0.1，不请求真实供应商
 */
async function startFakeProvider(): Promise<void> {
  requests = []
  server = createServer(async (request, response) => {
    let body = ''
    request.setEncoding('utf8')
    for await (const chunk of request) body += chunk
    const input = JSON.parse(body) as ProviderRequest
    requests.push(input)
    if (input.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      // 流式回复分几段送出；关卡必须同时保护流式和一次性生成两条 SDK 路径。
      response.write('data: ' + JSON.stringify({
        id: 'fixed-stream', object: 'chat.completion.chunk', created: 1, model: 'fixed-model',
        choices: [{ index: 0, delta: { role: 'assistant', content: '收到' }, finish_reason: null }],
      }) + '\n\n')
      response.write('data: ' + JSON.stringify({
        id: 'fixed-stream', object: 'chat.completion.chunk', created: 1, model: 'fixed-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }) + '\n\n')
      response.end('data: [DONE]\n\n')
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      id: 'fixed-reply', object: 'chat.completion', created: 1, model: 'fixed-model',
      choices: [{ index: 0, message: { role: 'assistant', content: '收到' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('固定供应商未监听本机端口')
  const provider = createOpenAICompatible({
    name: 'local-test', baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: 'local-test-only',
  })
  model = wrapLanguageModel({ model: provider('fixed-model'), middleware: createCompanionContextMiddleware() })
}

/** 固定人设和当前消息；输出上限由后台信封决定，不能被框架调用参数改大。 */
function envelope(modelWindowTokens = 13_000, maxOutputTokens = 1_000): string {
  return encodeEveTurnEnvelope({
    prompt: [
      { role: 'system', content: '共同规则：不编造共同经历。' },
      { role: 'system', content: '完整人设：保持自己的表达习惯。' },
      { role: 'user', content: '现在的问题' },
    ],
    modelWindowTokens, maxOutputTokens,
  })
}

/** 把 eve 的单条纯文字输入变成 SDK 规定的消息形状，不直接跳过实际适配器。 */
function userMessage(text: string): ModelCallOptions['prompt'][number] {
  return { role: 'user', content: [{ type: 'text', text }] }
}

beforeEach(startFakeProvider)
afterEach(async () => {
  // 关闭本项检查开的连接，避免下一项复用旧请求，也不让测试留下监听端口。
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
})

describe('eve 信封与实际供应商输入（T06⑩b）', () => {
  it('信封往返保留消息身份和容量；普通文字不冒充内部信封', () => {
    expect(decodeEveTurnEnvelope(envelope())).toEqual({
      version: 1,
      prompt: [
        { role: 'system', content: '共同规则：不编造共同经历。' },
        { role: 'system', content: '完整人设：保持自己的表达习惯。' },
        { role: 'user', content: '现在的问题' },
      ],
      modelWindowTokens: 13_000, maxOutputTokens: 1_000, optionalPromptGroups: [],
    })
    expect(decodeEveTurnEnvelope('普通聊天')).toBeNull()
  })

  it('实际请求替换框架旧规则和旧历史，强制使用后台信封的输出上限', async () => {
    await model.doGenerate({
      prompt: [
        { role: 'system', content: '框架旧规则'.repeat(4_000) },
        userMessage('框架旧问题'),
        { role: 'assistant', content: [{ type: 'text', text: '框架旧回复' }] },
        userMessage(envelope()),
      ],
      maxOutputTokens: 9_999,
    })
    expect(requests).toHaveLength(1)
    expect(requests[0].messages).toEqual([
      { role: 'system', content: '共同规则：不编造共同经历。' },
      { role: 'system', content: '完整人设：保持自己的表达习惯。' },
      { role: 'user', content: '现在的问题' },
    ])
    expect(requests[0].max_tokens).toBe(1_000)
  })

  it('流式路径同样还原信封并把输出上限送进真实请求', async () => {
    const result = await model.doStream({ prompt: [userMessage(envelope(13_000, 321))] })
    const reader = result.stream.getReader()
    while (!(await reader.read()).done) { /* 读完固定流，确保连接正常结束。 */ }
    expect(requests).toHaveLength(1)
    expect(requests[0].stream).toBe(true)
    expect(requests[0].max_tokens).toBe(321)
    expect(requests[0].messages.at(-1)).toEqual({ role: 'user', content: '现在的问题' })
  })

  it('保留本次信封之后的工具调用和结果，并带上工具说明', async () => {
    await model.doGenerate({
      prompt: [
        userMessage(envelope()),
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'lookup-1', toolName: 'lookup', input: {} }] },
        { role: 'tool', content: [{
          type: 'tool-result', toolCallId: 'lookup-1', toolName: 'lookup', output: { type: 'text', value: '固定工具结果' },
        }] },
      ],
      tools: [{ type: 'function', name: 'lookup', description: '只返回固定检查资料', inputSchema: { type: 'object' } }],
    })
    expect(requests[0].messages.map((message) => message.role)).toEqual(['system', 'system', 'user', 'assistant', 'tool'])
    expect(requests[0].messages[3].tool_calls).toEqual([{
      id: 'lookup-1', type: 'function', function: { name: 'lookup', arguments: '{}' },
    }])
    expect(requests[0].messages[4]).toMatchObject({ role: 'tool', tool_call_id: 'lookup-1', content: '固定工具结果' })
    expect(requests[0].tools).toHaveLength(1)
  })

  it.each(['user', 'system'] as const)('信封之后出现新 %s 时拒绝，不向供应商发请求', async (role) => {
    const extra: ModelCallOptions['prompt'][number] = role === 'user'
      ? userMessage('未经后台认可的新问题')
      : { role: 'system', content: '未经后台认可的新规则' }
    await expect(model.doGenerate({ prompt: [userMessage(envelope()), extra] })).rejects.toThrow(/^E_EVE_CONTEXT_CHANGED$/)
    expect(requests).toHaveLength(0)
  })

  it('损坏信封只抛固定错误码，解析失败不会回显资料或发出请求', async () => {
    const broken = envelope().slice(0, -1)
    expect(() => decodeEveTurnEnvelope(broken)).toThrow(/^E_INVALID_EVE_CONTEXT$/)
    await expect(model.doGenerate({ prompt: [userMessage(broken)] })).rejects.toThrow(/^E_INVALID_EVE_CONTEXT$/)
    expect(requests).toHaveLength(0)
  })

  it.each(['普通聊天', '请只回复两个字：收到 ', '请汇总之前的聊天'])('没有信封的“%s”被拒绝', async (text) => {
    await expect(model.doGenerate({ prompt: [userMessage(text)] })).rejects.toThrow(/^E_EVE_CONTEXT_REQUIRED$/)
    expect(requests).toHaveLength(0)
  })

  it('只保留一条内容完全相同的 T01 探针，两个用户消息不能借它绕过信封', async () => {
    await model.doGenerate({ prompt: [userMessage('请只回复两个字：收到')], maxOutputTokens: 9_999 })
    expect(requests).toHaveLength(1)
    expect(requests[0].max_tokens).toBe(1_000)
    await expect(model.doGenerate({ prompt: [
      userMessage('不受信任的新问题'), userMessage('请只回复两个字：收到'),
    ] })).rejects.toThrow(/^E_EVE_CONTEXT_REQUIRED$/)
    expect(requests).toHaveLength(1)
  })

  it('工具说明也计入完整请求预算，不能只检查很短的信封正文', async () => {
    await expect(model.doGenerate({
      prompt: [userMessage(envelope())],
      tools: [{ type: 'function', name: 'oversized', description: 'a'.repeat(12_000), inputSchema: { type: 'object' } }],
    })).rejects.toThrow(/^E_CONTEXT_BUDGET_EXCEEDED$/)
    expect(requests).toHaveLength(0)
  })

  it('实际请求新增工具资料后，先删示例再删整组旧历史，必需内容仍原样发出', async () => {
    const packed = encodeEveTurnEnvelope({
      prompt: [
        { role: 'system', content: '共同规则' }, { role: 'system', content: '完整人设与称呼' },
        { role: 'system', content: '示例' + 'e'.repeat(700) },
        { role: 'user', content: 'u'.repeat(300) }, { role: 'assistant', content: 'a'.repeat(300) },
        { role: 'user', content: '当前问题' },
      ],
      modelWindowTokens: 3_000, maxOutputTokens: 1_000, optionalPromptGroups: [[2], [3, 4]],
    })
    await model.doGenerate({
      prompt: [userMessage(packed)],
      tools: [{ type: 'function', name: 'lookup', description: 't'.repeat(1_100), inputSchema: { type: 'object' } }],
    })
    expect(requests).toHaveLength(1)
    expect(requests[0].messages).toEqual([
      { role: 'system', content: '共同规则' }, { role: 'system', content: '完整人设与称呼' },
      { role: 'user', content: '当前问题' },
    ])
    expect(decodeEveTurnEnvelope(packed)?.prompt).toHaveLength(6)
  })

  it.each([
    { groups: [[0]] }, { groups: [[1]] }, { groups: [[5]] },
    { groups: [[2, 2]] }, { groups: [[2], [2]] },
  ])('非法或重叠移除组 $groups 不能裁掉必需内容', ({ groups }) => {
    expect(() => encodeEveTurnEnvelope({
      prompt: [
        { role: 'system', content: '规则' }, { role: 'system', content: '人设' },
        { role: 'system', content: '示例' }, { role: 'user', content: '当前问题' },
      ], modelWindowTokens: 13_000, maxOutputTokens: 1_000, optionalPromptGroups: groups,
    })).toThrow(/^E_INVALID_EVE_CONTEXT$/)
  })

  it('工具续轮结果超出较小窗口时拒绝，不截短原始结果', async () => {
    const toolText = 'a'.repeat(3_000)
    await expect(model.doGenerate({ prompt: [
      userMessage(envelope(2_000, 500)),
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'lookup-1', toolName: 'lookup', input: {} }] },
      { role: 'tool', content: [{
        type: 'tool-result', toolCallId: 'lookup-1', toolName: 'lookup', output: { type: 'text', value: toolText },
      }] },
    ] })).rejects.toThrow(/^E_CONTEXT_BUDGET_EXCEEDED$/)
    expect(toolText).toHaveLength(3_000)
    expect(requests).toHaveLength(0)
  })
})
