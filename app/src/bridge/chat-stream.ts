/**
 * 聊天回合的流式桥接：主进程替界面发起 SSE 请求，把逐帧到达的回复事件
 * 推进聊天窗口。界面仍然拿不到后台地址与令牌（03 §7：界面进程无 Node、
 * 无直接后台访问）；这里与 requests.ts 的差别是生命周期——普通代办是
 * 「一发一收」，流式通道是「先受理、后持续推送」，所以单独一个文件。
 */
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type { BackendHandle } from '../desktop/backend'
import { chatTurnCancelSchema, chatTurnRequestSchema, type SseTurnEvent } from '../shared/chat-turn'

/** 推给界面的消息：frame 为 null 表示该回合的事件流已结束（无论成败）。 */
export interface ChatStreamMessage {
  requestId: string
  frame: SseTurnEvent | null
}

/**
 * 从一个 SSE 块（空行分隔出的文本段）里取 data 帧。
 * @param block 不含结尾空行的块文本
 * @returns 解析出的事件；块里没有 data 行或 JSON 损坏时为 null
 */
export function parseSseBlock(block: string): SseTurnEvent | null {
  for (const line of block.split('\n')) {
    if (!line.startsWith('data: ')) continue
    try { return JSON.parse(line.slice(6)) as SseTurnEvent } catch { return null }
  }
  return null
}

/**
 * 注册流式聊天通道。只能在主进程启动时调用一次（ipcMain.handle 同名重复注册会报错）。
 * @param getBackend 取当前后台句柄；未就绪时返回 undefined
 * @param getChatPage 取聊天窗口主页面身份；只接该页面的请求与推送
 */
export function registerChatStreamBridge(
  getBackend: () => BackendHandle | undefined,
  getChatPage: () => { id: number; url: string } | undefined,
): void {
  // 进行中的流读取：requestId → 中止控制器。窗口销毁或出错时断开读取，
  // 后台发现连接断开会自己取消回合（服务层已实现），不需要额外通知。
  const streams = new Map<string, AbortController>()

  /** 只接聊天窗口主页面，防止桌宠或嵌入子页面借道发起模型调用。 */
  function isChatPage(event: IpcMainInvokeEvent): boolean {
    const expected = getChatPage()
    return expected !== undefined && event.sender.id === expected.id
      && event.senderFrame === event.sender.mainFrame && event.senderFrame?.url === expected.url
  }

  /** 把 SSE 响应体逐块读出、解析成帧并推给发起页面；结束时补发结束标记。 */
  async function pumpStream(
    sender: WebContents, requestId: string, response: Response, controller: AbortController,
  ): Promise<void> {
    const reader = response.body?.getReader()
    try {
      if (!reader) throw new Error('no body')
      const decoder = new TextDecoder()
      // SSE 以空行分块；网络分片可能把一个块劈成两半，缓冲区攒到齐再解析。
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        for (;;) {
          const index = buffer.indexOf('\n\n')
          if (index < 0) break
          const frame = parseSseBlock(buffer.slice(0, index))
          buffer = buffer.slice(index + 2)
          if (frame !== null && !sender.isDestroyed()) {
            sender.send('chat:turn-event', { requestId, frame } satisfies ChatStreamMessage)
          }
        }
      }
    } catch {
      // 读取中断（中止/网络断）：不需要转发错误详情，结束标记就是界面的收尾信号。
    } finally {
      streams.delete(requestId)
      // 页面可能已经销毁（窗口被真正关闭）：发送前必须检查，否则会抛错。
      if (!sender.isDestroyed()) sender.send('chat:turn-event', { requestId, frame: null })
    }
  }

  ipcMain.handle('chat:turn-start', async (event, body: unknown) => {
    if (!isChatPage(event)) return { ok: false, code: 'UNAUTHORIZED' }
    const checked = chatTurnRequestSchema.safeParse(body)
    if (!checked.success) return { ok: false, code: 'INVALID_INPUT' }
    const backend = getBackend()
    if (!backend) return { ok: false, code: 'BACKEND_NOT_READY' }
    // 同一编号重复启动：沿用旧的中止控制器没有必要，直接顶替并断开旧的。
    streams.get(checked.data.requestId)?.abort()
    const controller = new AbortController()
    streams.set(checked.data.requestId, controller)
    try {
      const response = await fetch(`http://127.0.0.1:${backend.port}/chat/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session-token': backend.token },
        body: JSON.stringify(checked.data),
        signal: controller.signal,
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { code?: string } | null
        streams.delete(checked.data.requestId)
        // 后台的 code 原样转交（TURN_IN_PROGRESS 等），界面按它提示。
        return { ok: false, code: payload?.code ?? `HTTP_${response.status}` }
      }
      // invoke 到这里就返回；后续帧经 chat:turn-event 推送。界面必须先订阅再启动。
      void pumpStream(event.sender, checked.data.requestId, response, controller)
      return { ok: true }
    } catch {
      streams.delete(checked.data.requestId)
      return { ok: false, code: 'BACKEND_UNREACHABLE' }
    }
  })

  ipcMain.handle('chat:turn-cancel', async (event, body: unknown) => {
    if (!isChatPage(event)) return { ok: false, code: 'UNAUTHORIZED' }
    const checked = chatTurnCancelSchema.safeParse(body)
    if (!checked.success) return { ok: false, code: 'INVALID_INPUT' }
    const backend = getBackend()
    if (!backend) return { ok: false, code: 'BACKEND_NOT_READY' }
    try {
      // 只通知后台取消；本地流不必强行断开——后台取消后会发 cancelled 帧
      // 并正常关流，界面沿统一路径收尾。
      const res = await fetch(`http://127.0.0.1:${backend.port}/chat/turn/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session-token': backend.token },
        body: JSON.stringify({ conversationId: checked.data.conversationId }),
      })
      const payload = await res.json().catch(() => null) as { ok?: boolean; cancelled?: boolean; code?: string } | null
      if (!res.ok || payload?.ok !== true) {
        return { ok: false, code: payload?.code ?? `HTTP_${res.status}` }
      }
      return { ok: true, cancelled: payload.cancelled === true }
    } catch {
      return { ok: false, code: 'BACKEND_UNREACHABLE' }
    }
  })
}
