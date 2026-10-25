/**
 * 卡在"窗口界面"和"大管家"之间的一道门：界面想请主进程办事，只能走这道门
 * 放行的固定操作，不能直接伸手拿东西。
 * 两类通道：
 * - 桌宠控制（petDrag/petZoom/petMenu）：只带信号/极小参数的「喊话」；
 * - 应用数据（appApi）：请求-应答式的「代办」，真正访问后台服务的是
 *   主进程（bridge/requests.ts），界面只拿到结果。
 * 就算界面代码被人做手脚，能做的也只限于这些放行动作。
 */
import { contextBridge, ipcRenderer } from 'electron'

/** 拖动控制（页面里用 window.petDrag 访问） */
contextBridge.exposeInMainWorld('petDrag', {
  /** 用户按住左键抓住角色时调用 */
  start: () => ipcRenderer.send('pet:drag-start'),
  /** 松开或取消时调用；多调几次无害 */
  stop: () => ipcRenderer.send('pet:drag-end'),
})

/** 缩放控制（页面里用 window.petZoom 访问） */
contextBridge.exposeInMainWorld('petZoom', {
  /** 按滚轮方向缩放一档：1 = 放大（向上滚），-1 = 缩小 */
  by: (direction: 1 | -1) => ipcRenderer.send('pet:zoom', direction),
})

/** 右键菜单（页面里用 window.petMenu 访问） */
contextBridge.exposeInMainWorld('petMenu', {
  /** 请求在光标处弹出桌宠菜单 */
  open: () => ipcRenderer.send('pet:menu'),
})

/**
 * 应用数据代办（聊天窗与桌宠窗都用 window.appApi 访问）。
 * invoke = 「发请求等回执」的 IPC 形状；结果统一 { ok, data?, code? }。
 * 参数形状见各通道的注册处（bridge/requests.ts、desktop/character-images.ts）。
 */
contextBridge.exposeInMainWorld('appApi', {
  /** 取角色编辑概览（名字/图片路径/当前人设版本/版本列表） */
  getCharacter: () => ipcRenderer.invoke('character:get'),
  /** 保存一版新人设（请求体按 shared/character-schema 的形状组装） */
  saveCharacterVersion: (body: unknown) => ipcRenderer.invoke('character:save-version', body),
  /** 回退到指定人设版本 */
  activateVersion: (versionNo: number) =>
    ipcRenderer.invoke('character:activate-version', { versionNo }),
  /**
   * 换角色图片：主进程弹选图框、复制文件、记库，一步办完。
   * slot 'desktop' = 桌面形象，'portrait' = 聊天立绘
   */
  pickImage: (slot: 'desktop' | 'portrait') => ipcRenderer.invoke('character:pick-image', slot),
  /**
   * 订阅「切到某页」的指令（托盘/桌宠菜单点「打开聊天/角色设置」时，
   * 主进程把窗口亮出来的同时通知界面切页）。返回取消订阅的函数。
   */
  onNavGoto: (callback: (page: 'chat' | 'settings') => void) => {
    const listener = (_event: unknown, page: 'chat' | 'settings') => callback(page)
    ipcRenderer.on('nav:goto', listener)
    return () => ipcRenderer.removeListener('nav:goto', listener)
  },
})
