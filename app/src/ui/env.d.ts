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
    /** 模型设置的读取回包只包含公开资料和保管方式。 */
    getModelSettings: () => Promise<import('../bridge/requests').BridgeResult<import('../shared/model-settings').ModelSettingsOverview>>
    saveModelSettings: (body: import('../shared/model-settings').SaveModelSettings) =>
      Promise<import('../bridge/requests').BridgeResult<import('../shared/model-settings').ModelSettingsOverview>>
    deleteModelCredential: () => Promise<import('../bridge/requests').BridgeResult<import('../shared/model-settings').ModelSettingsOverview>>
    testModelConnection: (requestId: string) => Promise<import('../bridge/requests').BridgeResult<import('../shared/model-settings').ModelConnectionTest>>
    cancelModelConnectionTest: () => Promise<import('../bridge/requests').BridgeResult<{ cancelled: boolean }>>
    onModelSettingsChanged: (callback: () => void) => () => void
    completeOnboarding: () => Promise<import('../bridge/requests').BridgeResult<import('../shared/model-settings').ModelSettingsOverview>>
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
    /** 只读当前角色记忆管理资料，由后台选择角色。 */
    getMemories: () => Promise<{
      ok: boolean
      data?: import('../shared/memory-management').MemoryManagementOverview
      code?: string
    }>
    /** 只读将删除的原话，用户确认后才提交修改。 */
    previewMemoryDeletion: (target: import('../shared/memory-management').MemoryTarget) => Promise<{
      ok: boolean
      data?: import('../shared/memory-management').MemoryDeletionPreview
      code?: string
    }>
    /** 修改一条记忆，只有本地清理完成才返回成功。 */
    changeMemory: (change: import('../shared/memory-management').MemoryChange) => Promise<{
      ok: boolean
      data?: { receipt: import('../shared/memory-management').MemoryChangeReceipt }
      code?: string
    }>
    /** 重试刚才没能完成的本地缓存清理。 */
    retryMemoryCleanup: () => Promise<{ ok: boolean; code?: string }>
    /** 发起聊天回合；受理立即返回，回复帧经 onChatTurnEvent 推送。 */
    startChatTurn: (conversationId: string, requestId: string, content: string) => Promise<{
      ok: boolean
      code?: string
    }>
    /** 发起试聊回合（草稿人设）；事件流与正式回合共用 onChatTurnEvent。 */
    startPreviewTurn: (requestId: string, content: string, draft: unknown) => Promise<{
      ok: boolean
      code?: string
    }>
    /** 请求停止当前活动回合。 */
    cancelChatTurn: (conversationId: string) => Promise<{
      ok: boolean
      cancelled?: boolean
      code?: string
    }>
    /** 先订阅再启动；有终态以终态为准，缺终态的断流才用frame:null通知收尾。 */
    onChatTurnEvent: (callback: (message: {
      requestId: string
      frame: import('../shared/chat-turn').SseTurnEvent | null
    }) => void) => () => void
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
