/// <reference types="vite/client" />
/**
 * 告诉 TypeScript：*.module.css 这类导入是 Vite（构建工具）提供的，
 * 别报"找不到模块"——CSS 文件本来不是 TS 认识的东西。
 */
/**
 * preload 通过 contextBridge 放进页面的桌宠拖动控制（见 desktop/preload.ts）。
 * 声明为「可能不存在」：preload 没就绪、或页面被拿到普通浏览器里打开时，
 * 访问它得到 undefined，调用处用 ?. 容错而不是崩溃。
 */
interface Window {
  petDrag?: {
    start: () => void
    stop: () => void
    release: () => void
  }
  /** 缩放一档：1 放大，-1 缩小（见 desktop/preload.ts） */
  petZoom?: {
    by: (direction: 1 | -1) => void
  }
  /** 请求弹出桌宠右键菜单 */
  petMenu?: {
    open: () => void
  }
  /** 桌宠获得键盘焦点后，Enter/空格打开聊天。 */
  petChat?: { open: () => void }
  /** 应用数据代办通道（desktop/preload.ts 的 appApi；通道实现见
   *  bridge/requests.ts 与 desktop/character-images.ts） */
  appApi?: {
    /** 读取唯一正式会话的编号，仍由后台决定它属于哪个角色。 */
    getFormalConversation: () => Promise<{
      ok: boolean
      data?: { conversation?: { conversationId: string; characterId: string } | null }
      code?: string
    }>
    /** 返回正式会话的一页历史，早于 beforeSeq；省略时读最近一页。 */
    getChatHistory: (conversationId: string, beforeSeq?: number) => Promise<{
      ok: boolean
      data?: { history: import('../shared/chat-history').ChatHistoryPage }
      code?: string
    }>
    /** 取角色编辑概览；结果 { ok, data?: { character } | null, code? } */
    getCharacter: () => Promise<{
      ok: boolean
      data?: { character?: unknown }
      code?: string
    }>
    /** 保存一版新人设；结果 { ok, data?: { versionNo, created }, code? } */
    saveCharacterVersion: (body: unknown) => Promise<{
      ok: boolean
      data?: { versionNo?: number; created?: boolean }
      code?: string
    }>
    /** 回退到指定人设版本；结果 { ok, data?: { versionNo }, code? } */
    activateVersion: (versionNo: number) => Promise<{
      ok: boolean
      data?: { versionNo?: number }
      code?: string
    }>
    /** 换角色图片；结果 { ok, relativePath?, width?, height?, code? } */
    pickImage: (slot: 'desktop' | 'portrait') => Promise<{
      ok: boolean
      relativePath?: string
      width?: number
      height?: number
      code?: string
    }>
    /** 后台就绪和图片保存后重读角色资料；返回取消监听函数。 */
    onCharacterChanged: (callback: () => void) => () => void
    /** 订阅主进程的切页指令；返回取消订阅函数 */
    onNavGoto: (callback: (page: 'chat' | 'settings') => void) => () => void
  }
}
