/**
 * 聊天页（T05 版）：只有「壳」没有「聊天」——消息收发是 T06 的活。
 * 左边 40% 是全高立绘区（角色图没设时显示占位说明），右边是
 * 「已就绪」空状态 + 禁用的输入框（设计稿 full-ui-v1 的 01 状态）。
 */
import type { CharacterProps } from '../App'
import { assetUrl } from '../../shared/asset-url'
import styles from './ChatPage.module.css'

/** 聊天页组件：展示角色名与立绘；输入区禁用到 T06 接入 */
export default function ChatPage({ character, loadError }: CharacterProps) {
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

      {/* 右：对话区。T05 阶段为空状态 */}
      <section className={styles.chat}>
        <header className={styles.header}>{displayName || '　'}</header>
        <div className={styles.messages}>
          <p className={styles.ready}>聊天界面已就绪</p>
          <p className={styles.hint}>聊天功能将在 T06 接入</p>
          {/* 概览都取不到时如实说，不假装一切正常（01 §3 未配置不伪装） */}
          {loadError && <p className={styles.error}>角色数据读取失败（{loadError}）</p>}
        </div>
        <footer className={styles.composer}>
          <input
            className={styles.input}
            placeholder="聊天功能将在 T06 接入"
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
