/**
 * 桌宠窗口的内容：整窗只画一张占位角色图。
 * 鼠标命中靠系统对全透明像素的原生穿透（真机已验证：alpha=0 穿透、实心
 * 挡住），本组件只负责两件事：显示图、发出「开始/结束拖动」信号——
 * 窗口跟着光标走的活由主进程干（见 desktop/main.ts 的 startPetDrag）。
 */
import { useEffect } from 'react'
import styles from './PetWindow.module.css'
// Vite 会把图片 import 变成「能直接放进 <img src> 的地址字符串」：
// 开发时指向开发服务器上的文件，打包后指向输出目录里的文件
import petSampleUrl from './assets/pet-sample.svg'

/** 桌宠组件：一张占位图铺满整个窗口，按住左键可拖动 */
export default function PetWindow() {
  // 组件卸载时兜底停一次拖动：开发热更新重载页面时，「松开」事件可能
  // 丢在旧页面里，不停掉窗口就会一直黏在光标上。用 ?. 容错——
  // preload 未就绪时窗口本来也拖不起来，没必要为它崩溃
  useEffect(() => () => window.petDrag?.stop(), [])

  return (
    <main className={styles.stage}>
      <img
        className={styles.pet}
        src={petSampleUrl}
        alt="占位角色"
        draggable={false}
        onPointerDown={(event) => {
          // 只响应左键；右键留给以后的菜单（01 §5 桌宠右键菜单）
          if (event.button !== 0) return
          // 阻止选中文字/拖动图片等浏览器默认行为，免得和窗口拖动打架
          event.preventDefault()
          // 「指针捕获」：按住不放期间，移动事件持续送给这张图，
          // 即使光标短暂跑出窗口边界也不丢
          event.currentTarget.setPointerCapture(event.pointerId)
          window.petDrag?.start()
        }}
        onPointerUp={() => window.petDrag?.stop()}
        // 捕获被系统收回（比如窗口失焦）时的兜底；和上面重复停一次无害
        onLostPointerCapture={() => window.petDrag?.stop()}
      />
    </main>
  )
}
