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
  }
  /** 缩放一档：1 放大，-1 缩小（见 desktop/preload.ts） */
  petZoom?: {
    by: (direction: 1 | -1) => void
  }
  /** 请求弹出桌宠右键菜单 */
  petMenu?: {
    open: () => void
  }
}
