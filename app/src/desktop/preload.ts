/**
 * 卡在"窗口界面"和"大管家"之间的一道门：界面想请主进程办事，只能走这道门
 * 放行的固定操作，不能直接伸手拿东西。
 * 现在开着三扇小窗，全部「只带信号/极小参数，不带坐标等复杂数据」：
 * - petDrag：开始/结束拖动
 * - petZoom：按方向放大/缩小一档
 * - petMenu：请求弹出桌宠右键菜单
 * 就算界面代码被人做手脚，能做的也只限于拖动、缩放、弹菜单这几个动作。
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
