/**
 * 聊天页：展示正式历史并接入消息收发（T06⑪e）。
 * 左边 40% 是全高立绘区（角色图没设时显示占位说明），右边是
 * 历史列表 + 输入区（沿用设计稿 full-ui-v1 的结构）。
 * 回合保存或落定时 +1 刷新信号，历史列表重读最近一页。
 */
import { useState } from 'react'
import type { CharacterProps } from '../App'
import { assetUrl } from '../../shared/asset-url'
import styles from './ChatPage.module.css'
import ChatHistory from './ChatHistory'
import ChatComposer from './ChatComposer'

/** 聊天页组件：展示角色名、立绘和历史，输入区负责发送与实时回复。 */
export default function ChatPage({ character, loadError, reload }: CharacterProps) {
  // 立绘路径 → app-asset URL；没设图片时为 null，显示占位块
  const portraitUrl = assetUrl(character?.portraitImagePath)
  const displayName = character?.name ?? ''
  // 回合事件驱动的刷新信号：用户消息入库、回合落定都会 +1。
  const [historyRefresh, setHistoryRefresh] = useState(0)

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
          displayName={displayName} refreshKey={historyRefresh} />}
        <ChatComposer enabled={!!character && !loadError}
          onTurnSettled={() => setHistoryRefresh((value) => value + 1)} />
      </section>
    </div>
  )
}
