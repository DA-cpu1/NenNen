/**
 * 用真实本地 HTTP 检查聊天回合端点：SSE 帧序与响应头、同步错误的状态码
 * 翻译、请求体关卡（含超长正文不误拦）与客户端断开时的取消。
 * 回合服务是注入的假实现（帧固定），不访问数据库、不启动框架。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startBackendServer, type BackendServer } from '../src/service/server'
import type { ChatTurnRequest, SseTurnEvent } from '../src/shared/chat-turn'

let server: BackendServer
const token = 'chat-turn-http-token'
/** 各用例换装的假回合实现；记录收到的请求以便断言。 */
let startImpl: (request: ChatTurnRequest) => { userMessageId: string; events: AsyncGenerator<SseTurnEvent> }
const cancelledConversations: string[] = []

beforeEach(async () => {
  cancelledConversations.length = 0
  server = await startBackendServer(token, {
    startChatTurn: (request) => startImpl(request),
    cancelChatTurn: (conversationId) => {
      cancelledConversations.push(conversationId)
      return true
    },
  })
})
afterEach(async () => { await server.stop() })

/** 固定帧序列的事件流；ends 分支用于「流挂起等断开」的检查。 */
function frames(events: SseTurnEvent[]): AsyncGenerator<SseTurnEvent> {
  return (async function* generate() {
    for (const event of events) yield event
  })()
}

function post(path: string, body: unknown, useToken = true, signal?: AbortSignal) {
  return fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(useToken ? { 'x-session-token': token } : {}) },
    body: JSON.stringify(body),
    signal,
  })
}

/** 把 SSE 文本拆成帧对象列表。 */
function parseFrames(text: string): SseTurnEvent[] {
  return text.split('\n\n').filter((block) => block.startsWith('data: '))
    .map((block) => JSON.parse(block.slice(6)) as SseTurnEvent)
}

const validBody = { conversationId: 'conv-1', requestId: 'r1', content: '问题' }

describe('聊天回合 HTTP 端点（T06⑪c2）', () => {
  it('保存成功后以 SSE 转发：首帧 saved，其后文字与完成帧', async () => {
    startImpl = (request) => ({
      userMessageId: `user-${request.requestId}`,
      events: frames([
        { type: 'saved', userMessageId: `user-${request.requestId}` },
        { type: 'text', delta: '你' },
        { type: 'done', replyId: 'reply-1' },
      ]),
    })
    const res = await post('/chat/turn', validBody)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(parseFrames(await res.text())).toEqual([
      { type: 'saved', userMessageId: 'user-r1' },
      { type: 'text', delta: '你' },
      { type: 'done', replyId: 'reply-1' },
    ])
  })

  it.each([
    ['E_EVE_UNAVAILABLE', 503, 'AGENT_UNAVAILABLE'],
    ['E_TURN_IN_PROGRESS', 409, 'TURN_IN_PROGRESS'],
    ['E_MESSAGE_TOO_LONG', 400, 'MESSAGE_TOO_LONG'],
    ['别的意外错误', 500, 'INTERNAL'],
  ])('同步错误 %s 映射为 %d %s，不带原始正文', async (code, status, wire) => {
    startImpl = () => { throw new Error(code) }
    const res = await post('/chat/turn', validBody)
    expect(res.status).toBe(status)
    expect(await res.json()).toEqual({ ok: false, code: wire })
  })

  it('请求体不合法或未认证时直接拒绝', async () => {
    startImpl = () => { throw new Error('不应到达') }
    const badBody = await post('/chat/turn', { conversationId: 'conv-1', requestId: '', content: 'x' })
    expect(badBody.status).toBe(400)
    expect(await badBody.json()).toEqual({ ok: false, code: 'INVALID_INPUT' })
    const noToken = await post('/chat/turn', validBody, false)
    expect(noToken.status).toBe(401)
  })

  it('满长正文（约 30KB UTF-8）不被请求体关卡误拦', async () => {
    let received = ''
    startImpl = (request) => {
      received = request.content
      return { userMessageId: 'u', events: frames([{ type: 'saved', userMessageId: 'u' }]) }
    }
    const long = '汉'.repeat(10_000)
    const res = await post('/chat/turn', { ...validBody, content: long })
    expect(res.status).toBe(200)
    expect(received).toHaveLength(10_000)
  })

  it('客户端中途断开时取消该会话的活动回合', async () => {
    let release: () => void = () => { /* 未挂起时忽略 */ }
    const held = new Promise<void>((resolve) => { release = resolve })
    startImpl = () => ({
      userMessageId: 'u',
      events: (async function* generate() {
        yield { type: 'saved', userMessageId: 'u' }
        await held
      })(),
    })
    const controller = new AbortController()
    const res = await post('/chat/turn', validBody, true, controller.signal)
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    // 读到首帧说明流已建立；随后用中止信号模拟用户关闭窗口。
    await reader.read()
    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(cancelledConversations).toContain('conv-1')
    // 放行挂起的事件流，让路由处理函数自然退出，不把收尾留给 afterEach。
    release()
    await new Promise((resolve) => setTimeout(resolve, 50))
  })

  it('取消端点按会话取消并保持幂等语义', async () => {
    const res = await post('/chat/turn/cancel', { conversationId: 'conv-9' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, cancelled: true })
    expect(cancelledConversations).toEqual(['conv-9'])
    const bad = await post('/chat/turn/cancel', { conversationId: '' })
    expect(bad.status).toBe(400)
  })
})
