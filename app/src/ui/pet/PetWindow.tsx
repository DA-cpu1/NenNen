/**
 * 桌宠窗口：显示用户设置的图片，后台就绪或换图后重读；坏图退回占位。
 * 鼠标命中靠系统对全透明像素的原生穿透（真机已验证：alpha=0 穿透、实心
 * 挡住）。本组件只发信号，真正干活的都在主进程：
 * - 拖动：petDrag（desktop/main.ts 的 startPetDrag）
 * - 缩放：petZoom（Ctrl+滚轮，03 §3）
 * - 右键菜单：petMenu（打开聊天、设置、缩放与复位）
 */
import { useEffect, useRef, useState } from 'react'
import type { CharacterOverview } from '../../shared/data-types'
import { assetUrl } from '../../shared/asset-url'
import styles from './PetWindow.module.css'
// Vite 会把图片 import 变成「能直接放进 <img src> 的地址字符串」：
// 开发时指向开发服务器上的文件，打包后指向输出目录里的文件
import petSampleUrl from './assets/pet-sample.svg'

/** 桌宠组件：一张占位图铺满整个窗口；可拖动、Ctrl+滚轮缩放、右键弹菜单 */
export default function PetWindow() {
  const [imageUrl, setImageUrl] = useState(petSampleUrl)
  const [name, setName] = useState('占位角色')
  const [imageError, setImageError] = useState(false)
  // 拿到 <img> 元素本身的引用：wheel 监听要亲手挂，见下面的说明
  const imgRef = useRef<HTMLImageElement>(null)

  useEffect(() => {
    let disposed = false
    /** 概览经固定通道读取，图片经受限协议加载，界面没有磁盘访问能力。 */
    async function reload(): Promise<void> {
      try {
        const result = await window.appApi?.getCharacter()
        const character = result?.data?.character as CharacterOverview | undefined
        if (disposed || !result?.ok || !character) return
        setImageUrl(assetUrl(character.desktopImagePath) ?? petSampleUrl)
        setName(character.name)
        setImageError(false)
      } catch { /* 后台未就绪时保留占位图，等待就绪通知。 */ }
    }
    void reload()
    const unsubscribe = window.appApi?.onCharacterChanged(() => void reload())
    return () => { disposed = true; unsubscribe?.() }
  }, [])

  // 组件卸载时兜底停一次拖动：开发热更新重载页面时，「松开」事件可能
  // 丢在旧页面里，不停掉窗口就会一直黏在光标上。用 ?. 容错——
  // preload 未就绪时窗口本来也拖不起来，没必要为它崩溃
  useEffect(() => () => window.petDrag?.stop(), [])

  // Ctrl+滚轮缩放。为什么要亲手 addEventListener 而不用 React 的 onWheel：
  // 浏览器默认把 wheel 监听当「被动」的——承诺不调用 preventDefault，
  // 想拦掉默认行为必须注册时写明 { passive: false }
  useEffect(() => {
    const img = imgRef.current
    if (!img) return
    const onWheel = (event: WheelEvent) => {
      // 只响应 Ctrl+滚轮（03 §3）；笔记本触摸板的双指捏合也表现为 Ctrl+滚轮
      if (!event.ctrlKey) return
      // 拦下 Chromium 默认的「缩放整个页面」：我们要缩的是窗口，不是网页
      event.preventDefault()
      window.petZoom?.by(event.deltaY < 0 ? 1 : -1)
    }
    img.addEventListener('wheel', onWheel, { passive: false })
    return () => img.removeEventListener('wheel', onWheel)
  }, [])

  return (
    <main className={styles.stage}>
      <img
        ref={imgRef}
        className={styles.pet}
        src={imageError ? petSampleUrl : imageUrl}
        alt={name}
        title={imageError ? '图片无法读取，暂用占位图；可在角色设置重新选择。' : name}
        onError={() => setImageError(true)}
        draggable={false}
        onPointerDown={(event) => {
          // 只响应左键；右键留给菜单
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
        onContextMenu={(event) => {
          // 拦掉浏览器对图片自带的「另存为」菜单，换我们的桌宠菜单。
          // 只有实心像素上才会触发——透明处的右键已经穿透给桌面了
          event.preventDefault()
          window.petMenu?.open()
        }}
      />
    </main>
  )
}
