/** 检查新增只读桥接的请求来源和固定路径，不启动 Electron 窗口或访问真实用户资料。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { BackendHandle } from '../src/desktop/backend'

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>() }))
vi.mock('electron', () => ({ ipcMain: {
  handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
} }))
import { registerBridgeRequests } from '../src/bridge/requests'

/** 用同一个对象表示主页面，便于检查子页面不能冒充它。 */
function event(senderId = 42, main = true, url = 'file:///app/index.html'): IpcMainInvokeEvent {
  const mainFrame = { url }
  return { sender: { id: senderId, mainFrame }, senderFrame: main ? mainFrame : {} } as IpcMainInvokeEvent
}

beforeEach(() => {
  handlers.clear()
  vi.restoreAllMocks()
  registerBridgeRequests(() => ({ port: 12345, token: 'bridge-test-token' } as BackendHandle),
    () => ({ id: 42, url: 'file:///app/index.html' }))
})

describe('聊天只读桥接（T06⑦a）', () => {
  it('其他窗口和子页面不能读取正式会话或历史', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    for (const name of ['chat:formal-conversation', 'chat:history']) {
      for (const source of [event(43), event(42, false), event(42, true, 'https://external.example/')]) {
        expect(await handlers.get(name)!(source, { conversationId: 'conv-1' }))
          .toEqual({ ok: false, code: 'UNAUTHORIZED' })
      }
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('历史参数不合法时拒绝，不向后台发送请求', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    expect(await handlers.get('chat:history')!(event(), { conversationId: 'conv-1', beforeSeq: -1 }))
      .toEqual({ ok: false, code: 'INVALID_INPUT' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('合法请求只访问固定历史路径，编号正确编码且令牌不进网址', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true, history: {} })))
    expect(await handlers.get('chat:history')!(event(), { conversationId: 'conv & 1', beforeSeq: 20 }))
      .toEqual({ ok: true, data: { ok: true, history: {} } })
    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toBe('http://127.0.0.1:12345/chat/history?conversationId=conv+%26+1&limit=50&beforeSeq=20')
    expect(init?.headers).toMatchObject({ 'x-session-token': 'bridge-test-token' })
  })

  it('正式会话同样通过固定通道读取', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true, conversation: null })))
    await handlers.get('chat:formal-conversation')!(event())
    expect(fetchSpy.mock.calls[0][0]).toBe('http://127.0.0.1:12345/formal-conversation')
  })
})
