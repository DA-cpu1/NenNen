/**
 * 检查流式聊天桥接：来源身份核对、SSE 帧解析与逐帧推送、结束标记、
 * 后台错误透传与取消转发。用模拟 ipcMain 与本机假后台，不启动 Electron。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import type { BackendHandle } from '../src/desktop/backend'
import type { ChatStreamMessage } from '../src/bridge/chat-stream'

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>() }))
vi.mock('electron', () => ({ ipcMain: {
  handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
} }))
import { registerChatStreamBridge, parseSseBlock } from '../src/bridge/chat-stream'

/** 假后台的行为开关与请求观察。 */
let behavior: 'ok' | 'conflict' | 'drop-mid'
let turnRequests: number
let cancelRequests: number
let seenToken: string | undefined
let server: Server
let port = 0
const pushed: ChatStreamMessage[] = []

beforeEach(async () => {
  behavior = 'ok'
  turnRequests = 0
  cancelRequests = 0
  seenToken = undefined
  pushed.length = 0
  handlers.clear()
  server = createServer((request, response) => {
    seenToken = request.headers['x-session-token'] as string | undefined
    if (request.url === '/chat/turn') {
      turnRequests += 1
      if (behavior === 'conflict') {
        response.writeHead(409, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: false, code: 'TURN_IN_PROGRESS' }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (behavior === 'drop-mid') {
        // 先给出一帧、等客户端真正开始收流后再摧毁连接：模拟流中途崩溃。
        // （同 tick 摧毁的话 fetch 连响应头都收不到，那是「未开始」的另一条路径。）
        response.write('data: {"type":"saved","userMessageId":"u1"}\n\n')
        setTimeout(() => response.destroy(), 30)
        return
      }
      for (const frame of [
        { type: 'saved', userMessageId: 'u1' },
        { type: 'text', delta: '你' },
        { type: 'done', replyId: 'r1' },
      ]) response.write(`data: ${JSON.stringify(frame)}\n\n`)
      response.end()
      return
    }
    if (request.url === '/chat/turn/cancel') {
      cancelRequests += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, cancelled: true }))
      return
    }
    response.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
  registerChatStreamBridge(
    () => ({ port, token: 'stream-test-token' } as BackendHandle),
    () => ({ id: 42, url: 'file:///app/index.html' }),
  )
})
afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** 模拟聊天窗主页面的 invoke 事件；send 把推送收进 pushed 数组。 */
function event(senderId = 42, main = true, url = 'file:///app/index.html'): IpcMainInvokeEvent {
  const mainFrame = { url }
  const sender = {
    id: senderId, mainFrame,
    send: (_channel: string, message: ChatStreamMessage) => { pushed.push(message) },
    isDestroyed: () => false,
  } as unknown as WebContents
  return { sender, senderFrame: main ? mainFrame : {} } as IpcMainInvokeEvent
}

const turnBody = { conversationId: 'conv-1', requestId: 'r1', content: '问题' }

describe('流式聊天桥接（T06⑪d）', () => {
  it('SSE 块解析：取 data 行成帧，坏 JSON 或无 data 行返回 null', () => {
    expect(parseSseBlock('data: {"type":"text","delta":"你"}')).toEqual({ type: 'text', delta: '你' })
    expect(parseSseBlock(': 注释行\ndata: {"type":"cancelled"}')).toEqual({ type: 'cancelled' })
    expect(parseSseBlock('data: {坏的')).toBeNull()
    expect(parseSseBlock('event: x')).toBeNull()
  })

  it('其他窗口、子页面或外站不能启动或取消，后台不会收到请求', async () => {
    for (const source of [event(43), event(42, false), event(42, true, 'https://external.example/')]) {
      expect(await handlers.get('chat:turn-start')!(source, turnBody)).toEqual({ ok: false, code: 'UNAUTHORIZED' })
      expect(await handlers.get('chat:turn-cancel')!(source, { conversationId: 'conv-1' }))
        .toEqual({ ok: false, code: 'UNAUTHORIZED' })
    }
    expect(turnRequests).toBe(0)
    expect(cancelRequests).toBe(0)
  })

  it('合法启动后逐帧推送，流结束补发结束标记；令牌只在请求头', async () => {
    expect(await handlers.get('chat:turn-start')!(event(), turnBody)).toEqual({ ok: true })
    await vi.waitFor(() => expect(pushed).toHaveLength(4))
    expect(pushed).toEqual([
      { requestId: 'r1', frame: { type: 'saved', userMessageId: 'u1' } },
      { requestId: 'r1', frame: { type: 'text', delta: '你' } },
      { requestId: 'r1', frame: { type: 'done', replyId: 'r1' } },
      { requestId: 'r1', frame: null },
    ])
    expect(seenToken).toBe('stream-test-token')
  })

  it('后台同步错误原样透传，不推送任何帧', async () => {
    behavior = 'conflict'
    expect(await handlers.get('chat:turn-start')!(event(), turnBody))
      .toEqual({ ok: false, code: 'TURN_IN_PROGRESS' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(pushed).toEqual([])
  })

  it('流中途断开也要发结束标记，界面不会永远等下去', async () => {
    behavior = 'drop-mid'
    expect(await handlers.get('chat:turn-start')!(event(), turnBody)).toEqual({ ok: true })
    await vi.waitFor(() => expect(pushed.at(-1)).toEqual({ requestId: 'r1', frame: null }))
    expect(pushed[0]).toEqual({ requestId: 'r1', frame: { type: 'saved', userMessageId: 'u1' } })
  })

  it('取消转发到固定端点并回传结果；参数不合法直接拒绝', async () => {
    expect(await handlers.get('chat:turn-cancel')!(event(), { conversationId: 'conv-1' }))
      .toEqual({ ok: true, cancelled: true })
    expect(cancelRequests).toBe(1)
    expect(await handlers.get('chat:turn-cancel')!(event(), { conversationId: '' }))
      .toEqual({ ok: false, code: 'INVALID_INPUT' })
    expect(cancelRequests).toBe(1)
  })
})
