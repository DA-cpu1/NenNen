/**
 * 聊天页：展示正式历史并接入消息收发（T06⑪e）。
 * 左边 40% 是全高立绘区（角色图没设时显示占位说明），右边是
 * 历史列表 + 输入区（沿用设计稿 full-ui-v1 的结构）。
 * 回合保存或落定时 +1 刷新信号，历史列表重读最近一页。
 */
import { useState } from 'react'
import type { CharacterProps } from '../App'
import type { ChatSourceLocation } from '../../shared/chat-history'
import { assetUrl } from '../../shared/asset-url'
import styles from './ChatPage.module.css'
import ChatHistory from './ChatHistory'
import ChatComposer from './ChatComposer'

/**
 * 展示立绘与历史；记忆页修改原话后也要重读，输入草稿仍留在原处。
 * @param props 共用角色资料、历史刷新信号和原话定位动作
 * @returns 设计稿中的立绘与正式聊天两栏
 */
export default function ChatPage({ character, loadError, reload, historyVersion, source, onCloseSource, onReturnToMemory }:
  CharacterProps & {
    historyVersion: number
    source: ChatSourceLocation | null
    onCloseSource: () => void
    onReturnToMemory: () => void
  }) {
  // 立绘路径 → app-asset URL；没设图片时为 null，显示占位块
  const portraitUrl = assetUrl(character?.portraitImagePath)
  const displayName = character?.name ?? ''
  // 回合事件驱动的刷新信号：用户消息入库、回合落定都会 +1。
  const [historyRefresh, setHistoryRefresh] = useState(0)

  return (
    <div className={styles.page}>
      {/* 背景圆环只做装饰，不拦住鼠标；角色图保持原比例，不裁头和脚。 */}
      <aside className={styles.art}>
        <div className={styles.ring} aria-hidden="true" />
        {portraitUrl ? (
          <img className={styles.portrait} src={portraitUrl} alt={`${displayName} 立绘`} />
        ) : (
          <div className={styles.portraitPlaceholder}>立绘待设置</div>
        )}
        <div className={styles.artCaption}>
          <p className={styles.artName}>{displayName || '　'}</p>
          <p className={styles.artHint}>今天，也一起跨越结界。</p>
        </div>
      </aside>

      {/* 右：正式历史；角色变化时用 key 重建列表，避免短暂显示旧角色的记录。 */}
      <section className={styles.chat}>
        <header className={styles.header}>
          <h1>{displayName || '　'}</h1>
          <p>接着上次的话题聊吧</p>
        </header>
        {loadError ? <div className={styles.historyError} role="alert">
          <p>角色资料读取失败（{loadError}）</p>
          <button type="button" onClick={() => void reload()}>重试读取角色</button>
        </div> : <ChatHistory key={character?.characterId ?? 'loading'} characterId={character?.characterId}
          displayName={displayName} refreshKey={historyRefresh + historyVersion}
          source={source} onCloseSource={onCloseSource} onReturnToMemory={onReturnToMemory} />}
        <ChatComposer enabled={!!character && !loadError}
          onTurnSettled={() => { onCloseSource(); setHistoryRefresh((value) => value + 1) }} />
      </section>
    </div>
  )
}
