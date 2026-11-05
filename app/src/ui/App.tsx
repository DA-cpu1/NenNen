/**
 * 聊天窗的「壳」：左边是各页共用的导航（聊天 / 角色设置 / 记忆），
 * 右边是当前页。聊天页切到设置后仍保留，避免丢掉未保存文字和重试编号。
 *
 * 角色概览（名字、图片路径、人设版本）在这里统一取一次、传给各页：
 * 设置页保存后调 reload() 刷新，聊天页跟着换新名字/新立绘——
 * 数据一份来源，两页不会各拿各的旧账。
 */
import { useCallback, useEffect, useState } from 'react'
import type { ChatSourceLocation } from '../shared/chat-history'
import type { CharacterOverview } from '../shared/data-types'
import { assetUrl } from '../shared/asset-url'
import ChatPage from './chat/ChatPage'
import MemoryPage from './memory/MemoryPage'
import SettingsPage from './settings/SettingsPage'
import styles from './App.module.css'

/** 页面标识：聊天页 / 记忆页 / 角色设置页 */
export type PageId = 'chat' | 'memory' | 'settings'

/** 传给各页的角色概览与刷新函数（设置页保存成功后会调它） */
export interface CharacterProps {
  character: CharacterOverview | null
  /** 重新向后台取一份概览；后台没就绪时置错误状态 */
  reload: () => Promise<CharacterOverview | null>
  /** 概览加载失败时的错误码（BACKEND_NOT_READY 等），成功后清空 */
  loadError: string | null
}

/**
 * 统一读取角色，并把所有离开编辑页的入口交给草稿保护。
 * @returns 共用侧栏和当前页面；切页只改变选中项，不再换一套导航。
 */
export default function App() {
  const [page, setPage] = useState<PageId>('chat')
  const [leaveTarget, setLeaveTarget] = useState<PageId | null>(null)
  const [character, setCharacter] = useState<CharacterOverview | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [historyVersion, setHistoryVersion] = useState(0)
  const [chatSource, setChatSource] = useState<ChatSourceLocation | null>(null)

  /** 取角色概览（经 preload 的 appApi 通道，主进程代查后台） */
  const reload = useCallback(async () => {
    // preload 未就绪（理论上不会，但类型上可能）：按通道不可用处理
    if (!window.appApi) {
      setLoadError('CHANNEL_MISSING')
      return null
    }
    try {
      const res = await window.appApi.getCharacter()
      if (!res.ok) {
        setLoadError(res.code ?? 'UNKNOWN')
        return null
      }
      const payload = res.data as { character?: CharacterOverview | null } | undefined
      const next = payload?.character ?? null
      setCharacter(next)
      setLoadError(next ? null : 'NO_CHARACTER')
      return next
    } catch {
      setLoadError('CHANNEL_UNAVAILABLE')
      return null
    }
  }, [])

  /** 侧栏、托盘和桌宠菜单走同一条路，避免某个入口绕过未保存确认。 */
  const navigate = useCallback((target: PageId) => {
    setChatSource(null)
    if (page === 'settings' && target !== page) setLeaveTarget(target)
    else setPage(target)
  }, [page])

  /** 编辑页确认可离开后再切页；数据还未读到时也可以正常返回聊天。 */
  const completeLeave = useCallback(() => {
    setPage(leaveTarget ?? 'chat')
    setLeaveTarget(null)
  }, [leaveTarget])
  const cancelLeave = useCallback(() => setLeaveTarget(null), [])

  // 打开窗口时取一次
  useEffect(() => {
    void reload()
  }, [reload])
  // 启动时的第一次请求可能赶在后台就绪前；收到通知再读，不靠反复轮询。
  useEffect(() => window.appApi?.onCharacterChanged(() => void reload()), [reload])

  // 托盘/桌宠菜单点「打开聊天/角色设置」：主进程把窗口亮出来的同时
  // 发来切页指令，这里跟着切（订阅函数返回「取消订阅」，交给 React 卸载时调）
  useEffect(
    () => window.appApi?.onNavGoto(navigate) ?? undefined,
    [navigate],
  )

  // 各页共用同一份角色资料，保存后一起刷新。
  const shared: CharacterProps = { character, reload, loadError }
  const sidebarImage = assetUrl(character?.desktopImagePath ?? character?.portraitImagePath)

  return (
    <div className={styles.shell}>
      <nav className={styles.rail} aria-label="应用页面">
        <button
          type="button"
          className={page === 'chat' ? styles.railItemActive : styles.railItem}
          aria-current={page === 'chat' ? 'page' : undefined}
          onClick={() => navigate('chat')}
        >
          {/* 简笔图标：一个聊天气泡 */}
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-5 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" />
          </svg>
          <span>聊天</span>
        </button>
        <button
          type="button"
          className={page === 'settings' ? styles.railItemActive : styles.railItem}
          aria-current={page === 'settings' ? 'page' : undefined}
          onClick={() => navigate('settings')}
        >
          {/* 线条图标随选中项一起变色，与聊天和记忆保持同样的粗细。 */}
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m10 3-.6 2.3-1.5.9-2.3-.6-2 3.5 1.7 1.7v1.8l-1.7 1.7 2 3.5 2.3-.6 1.5.9L10 21h4l.6-2.9 1.5-.9 2.3.6 2-3.5-1.7-1.7v-1.8l1.7-1.7-2-3.5-2.3.6-1.5-.9L14 3h-4Z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          <span>角色设置</span>
        </button>
        <button type="button" className={page === 'memory' ? styles.railItemActive : styles.railItem}
          aria-current={page === 'memory' ? 'page' : undefined} onClick={() => navigate('memory')}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 5h6c1.7 0 3 1.1 3 2.6V21c0-1.5-1.3-2.6-3-2.6H3V5Zm9 2.6C12 6.1 13.3 5 15 5h6v13.4h-6c-1.7 0-3 1.1-3 2.6"
              fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          </svg>
          <span>记忆</span>
        </button>
        {character ? <div className={styles.railCharacter}>
          {sidebarImage ? <img src={sidebarImage} alt="" /> : <span aria-hidden="true">{character.name.slice(0, 1)}</span>}
          <strong>{character.name}</strong>
        </div> : null}
      </nav>
      <main className={styles.body}>
        {/* 隐藏只改变可见性，不卸载输入区；返回聊天时仍能重试保存原结果。 */}
        <div className={styles.pageSlot} hidden={page !== 'chat'}><ChatPage {...shared} historyVersion={historyVersion}
          source={chatSource} onCloseSource={() => setChatSource(null)} onReturnToMemory={() => navigate('memory')} /></div>
        {page === 'memory' ? <MemoryPage characterId={character?.characterId} characterName={character?.name}
          onOpenSource={(source) => { setChatSource(source); setPage('chat') }}
          onHistoryChanged={() => setHistoryVersion((version) => version + 1)} /> : null}
        {page === 'settings' && <SettingsPage {...shared}
          leaving={leaveTarget !== null} onLeave={completeLeave} onStay={cancelLeave} />}
      </main>
    </div>
  )
}
