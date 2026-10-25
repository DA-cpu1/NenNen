/**
 * 界面允许发送的「固定请求」清单（03 §4 的 bridge 层）。
 * 渲染进程（聊天窗/桌宠窗）不许直接连后台服务——它连端口号和暗号都
 * 没有；一切数据都要经 preload 的门（contextBridge）走到这里，由主进程
 * 拿着暗号代理访问后台。这一层只做「搬运 + 透传结果」，不加业务判断：
 * 值合不合法由后台的 Zod 关卡把关（03 §2），界面怎么展示由 React 决定。
 *
 * 为什么用 ipcMain.handle（请求-应答式）而不是 send（单向喊话）：
 * 界面要的是「发一个请求、拿一份结果」，handle/invoke 天然是这种形状，
 * 还自动带 Promise；send 得自己发明回执机制。
 */
import { ipcMain } from 'electron'
import type { BackendHandle } from '../desktop/backend'

/** 后台 HTTP 请求的通用结果：成功带数据，失败只带错误码（03 §7：
 *  状态码可以给，原始错误文本不出后台） */
export interface BridgeResult<T> {
  ok: boolean
  data?: T
  code?: string
}

/**
 * 打后台的 GET/POST/PUT 并把 JSON 回包原样交回界面。
 * 三种失败都归成「ok:false + code」：后台没起（BACKEND_NOT_READY）、
 * HTTP 层炸了（网络中断等，BACKEND_UNREACHABLE）、后台回了错误状态
 * （把后台的 code 原样转交，界面按它提示）。
 */
async function callBackend<T>(
  handle: BackendHandle | undefined,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
): Promise<BridgeResult<T>> {
  if (!handle) return { ok: false, code: 'BACKEND_NOT_READY' }
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-session-token': handle.token,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const parsed = (await res.json()) as Record<string, unknown>
    if (!res.ok || parsed.ok !== true) {
      return { ok: false, code: typeof parsed.code === 'string' ? parsed.code : `HTTP_${res.status}` }
    }
    return { ok: true, data: parsed as T }
  } catch {
    return { ok: false, code: 'BACKEND_UNREACHABLE' }
  }
}

/**
 * 注册全部固定请求通道。调用方（main.ts）传一个「现在后台是谁」的取值
 * 函数而不是一次性句柄：后台句柄是启动后才有的，注册通道时它还不存在。
 * @param getBackend 取当前后台句柄；还没就绪时返回 undefined
 */
export function registerBridgeRequests(getBackend: () => BackendHandle | undefined): void {
  // 角色编辑概览：打开设置页/聊天页时各取一次（聊天页要名字和立绘）
  ipcMain.handle('character:get', () =>
    callBackend(getBackend(), 'GET', '/character'),
  )

  // 保存人设版本：请求体由界面按 shared/character-schema 的形状组装，
  // 合法性由后台把关；这里的 body 只是搬运
  ipcMain.handle('character:save-version', (_event, body: unknown) =>
    callBackend(getBackend(), 'POST', '/character/version', body),
  )

  // 回退到指定人设版本
  ipcMain.handle('character:activate-version', (_event, body: unknown) =>
    callBackend(getBackend(), 'POST', '/character/version/activate', body),
  )
}
