/**
 * 卡在"窗口界面"和"大管家"之间的一道门：界面想请主进程办事，只能走这道门
 * 放行的固定操作，不能直接伸手拿东西。
 * 现在开着第一扇小窗：桌宠拖动控制——只允许发「开始拖 / 结束拖」两个信号，
 * 不带任何数据。就算界面代码被人做手脚，能做的也只是拖动自己这个窗口。
 */
import { contextBridge, ipcRenderer } from 'electron'

/** 暴露给桌宠页面的拖动控制（页面里用 window.petDrag 访问） */
contextBridge.exposeInMainWorld('petDrag', {
  /** 用户按住左键抓住角色时调用 */
  start: () => ipcRenderer.send('pet:drag-start'),
  /** 松开或取消时调用；多调几次无害 */
  stop: () => ipcRenderer.send('pet:drag-end'),
})
