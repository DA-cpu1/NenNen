/**
 * 聊天页：展示正式历史；消息收发仍由后续独立步骤接入。
 * 左边 40% 是全高立绘区（角色图没设时显示占位说明），右边是
 * 历史列表 + 暂时禁用的输入框（沿用设计稿 full-ui-v1 的结构）。
 */
import type { CharacterProps } from '../App'
import { assetUrl } from '../../shared/asset-url'
import styles from './ChatPage.module.css'
import ChatHistory from './ChatHistory'

/** 聊天页组件：展示角色名、立绘和历史，发送功能后续接入。 */
export default function ChatPage({ character, loadError, reload }: CharacterProps) {
  // 立绘路径 → app-asset URL；没设图片时为 null，显示占位块
  const portraitUrl = assetUrl(character?.portraitImagePath)
  const displayName = character?.name ?? ''

  return (
    <div className={styles.page}>
      {/* 左：立绘区。淡紫圆环是设计稿的背景装饰（纯 CSS 画的圆） */}
      <aside className={styles.art}>
        <div className={styles.ring} aria-hidden="true" />
        {portraitUrl ? (
          <img className={styles.portrait} src={portraitUrl} alt={`${displayName} 立绘`} />
        ) : (
          <div className={styles.portraitPlaceholder}>立绘待设置</div>
        )}
        <p className={styles.artName}>{displayName || '　'}</p>
      </aside>

      {/* 右：正式历史；角色变化时用 key 重建列表，避免短暂显示旧角色的记录。 */}
      <section className={styles.chat}>
        <header className={styles.header}>{displayName || '　'}</header>
        {loadError ? <div className={styles.historyError} role="alert">
          <p>角色资料读取失败（{loadError}）</p>
          <button type="button" onClick={() => void reload()}>重试读取角色</button>
        </div> : <ChatHistory key={character?.characterId ?? 'loading'} characterId={character?.characterId}
          displayName={displayName} />}
        <footer className={styles.composer}>
          <input
            className={styles.input}
            placeholder="当前仅可查看聊天记录"
            disabled
            readOnly
          />
          <button type="button" className={styles.send} disabled>
            发送
          </button>
        </footer>
      </section>
    </div>
  )
}
