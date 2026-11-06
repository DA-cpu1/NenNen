/** 模型设置的固定 IPC 通道：只接受聊天窗口主页面，不接桌宠、外站或子页面。 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { DesktopModelSettings } from '../desktop/model-settings-controller'

/**
 * 注册模型设置操作，明文只允许随用户的新输入送往主进程。
 * @param controller 主进程专用操作，不提供已保存密钥的读取入口
 * @param getChatPage 当前受信聊天页面的编号和完整地址
 * @returns 无；结果通过各通道的 Promise 返回
 */
export function registerModelSettingsBridge(
  controller: DesktopModelSettings,
  getChatPage: () => { id: number; url: string } | undefined,
): void {
  /** 主页面编号和来源地址都要匹配，嵌入子页面没有权限借用保存能力。 */
  function allowed(event: IpcMainInvokeEvent): boolean {
    const page = getChatPage()
    return !!page && event.sender.id === page.id && event.senderFrame === event.sender.mainFrame
      && event.senderFrame?.url === page.url
  }
  ipcMain.handle('model:settings', (event) => allowed(event) ? controller.read() : { ok: false, code: 'UNAUTHORIZED' })
  ipcMain.handle('model:save', (event, body: unknown) => allowed(event) ? controller.save(body) : { ok: false, code: 'UNAUTHORIZED' })
  ipcMain.handle('model:delete', (event) => allowed(event) ? controller.remove() : { ok: false, code: 'UNAUTHORIZED' })
  ipcMain.handle('model:test', (event, requestId: unknown) => {
    if (!allowed(event)) return { ok: false, code: 'UNAUTHORIZED' }
    return typeof requestId === 'string' ? controller.test(requestId) : { ok: false, code: 'INVALID_INPUT' }
  })
  ipcMain.handle('model:test-cancel', (event) => allowed(event) ? controller.cancelTest() : { ok: false, code: 'UNAUTHORIZED' })
  ipcMain.handle('onboarding:complete', (event) => allowed(event) ? controller.completeOnboarding() : { ok: false, code: 'UNAUTHORIZED' })
}
