/** 两张角色图独立保存；换图后刷新概览，不碰正在编辑的人设草稿。 */
import { useState } from 'react'
import type { CharacterOverview } from '../../shared/data-types'
import { assetUrl } from '../../shared/asset-url'
import styles from './SettingsPage.module.css'

interface CharacterImagesProps {
  character: CharacterOverview
  reload: () => Promise<CharacterOverview | null>
  onBusy: (busy: boolean) => void
}

/**
 * 展示桌面图和聊天立绘，并通过主进程打开系统选图框。
 * @param props 已保存的图片路径、刷新函数、操作中状态回调
 * @returns 图片预览卡片
 */
export default function CharacterImages({ character, reload, onBusy }: CharacterImagesProps) {
  const [picking, setPicking] = useState(false)
  const [message, setMessage] = useState('')

  /** 取消选择安静返回；明确失败才提示，不能把未保存的图说成成功。 */
  async function pick(slot: 'desktop' | 'portrait'): Promise<void> {
    if (picking || !window.appApi) return
    setPicking(true)
    onBusy(true)
    setMessage('')
    try {
      const result = await window.appApi.pickImage(slot)
      if (result.code === 'CANCELLED') return
      if (!result.ok) { setMessage('这张图片未能保存，请重新选择有效的 PNG 图片。'); return }
      const fresh = await reload()
      setMessage(fresh ? '图片已保存，两个窗口会同步更新。' : '图片已保存，但预览刷新失败，请重新读取资料。')
    } catch { setMessage('图片保存未确认，请重试。') }
    finally { setPicking(false); onBusy(false) }
  }

  return <aside className={`${styles.card} ${styles.imagesPanel}`}>
    <h2 className={styles.sectionTitle}><span className={styles.sectionIcon} aria-hidden="true">
      <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8" cy="8" r="1.5" /><path d="m3 16 5-5 4 4 4-5 5 6" /></svg>
    </span>角色图片</h2><p className={styles.hint}>桌面形象与聊天立绘分别设置，支持 PNG。</p>
    {([['desktop', '桌面形象（Q 版）', character.desktopImagePath], ['portrait', '聊天立绘', character.portraitImagePath]] as const).map(([slot, title, path]) =>
      <section className={styles.imageCard} key={slot}>
        <h3>{title}</h3>
        <ImagePreview path={path} title={title} slot={slot} />
        <button type="button" className={styles.secondary} disabled={picking} onClick={() => void pick(slot)}>
          {slot === 'desktop' ? '更换桌面图片' : '更换聊天立绘'}
        </button>
      </section>)}
    <p className={styles.hint}>图片独立保存，不随人设版本回退。原始文件会保留。</p>
    {message && <p role="status" className={styles.hint}>{message}</p>}
  </aside>
}

/**
 * 图片不存在或读坏时显示说明；不同槽位只影响预览高度，不裁切原图。
 * @param props 已保存的路径、图片说明和桌面／立绘槽位
 * @returns 图片或读取失败的占位说明
 */
function ImagePreview({ path, title, slot }: { path: string | null; title: string; slot: 'desktop' | 'portrait' }) {
  const [failedPath, setFailedPath] = useState<string | null>(null)
  const url = assetUrl(path)
  return <div className={styles.imagePreview} data-slot={slot}>
    {url && failedPath !== path ? <img src={url} alt={title} onError={() => setFailedPath(path)} />
      : <p>{path ? '图片无法读取，请重新选择。' : '图片待设置'}</p>}
  </div>
}
