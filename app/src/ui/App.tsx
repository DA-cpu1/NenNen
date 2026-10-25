/**
 * 聊天窗的「壳」：左边一条窄导航（聊天 / 角色设置，设计稿 full-ui-v1），
 * 右边是当前页。T05 只有两页；聊天功能本身（消息收发）是 T06 的活，
 * 这里的聊天页只是「已就绪」的空状态。
 *
 * 角色概览（名字、图片路径、人设版本）在这里统一取一次、传给两页：
 * 设置页保存后调 reload() 刷新，聊天页跟着换新名字/新立绘——
 * 数据一份来源，两页不会各拿各的旧账。
 */
import { useCallback, useEffect, useState } from 'react'
import type { CharacterOverview } from '../shared/data-types'
import ChatPage from './chat/ChatPage'
import SettingsPage from './settings/SettingsPage'
import styles from './App.module.css'

/** 页面标识：聊天页 / 角色设置页 */
export type PageId = 'chat' | 'settings'

/** 传给两页的角色概览与刷新函数（设置页保存成功后会调它） */
export interface CharacterProps {
  character: CharacterOverview | null
  /** 重新向后台取一份概览；后台没就绪时置错误状态 */
  reload: () => Promise<void>
  /** 概览加载失败时的错误码（BACKEND_NOT_READY 等），成功后清空 */
  loadError: string | null
}

export default function App() {
  const [page, setPage] = useState<PageId>('chat')
  const [character, setCharacter] = useState<CharacterOverview | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  /** 取角色概览（经 preload 的 appApi 通道，主进程代查后台） */
  const reload = useCallback(async () => {
    // preload 未就绪（理论上不会，但类型上可能）：按通道不可用处理
    if (!window.appApi) {
      setLoadError('CHANNEL_MISSING')
      return
    }
    const res = await window.appApi.getCharacter()
    if (!res.ok) {
      setLoadError(res.code ?? 'UNKNOWN')
      return
    }
    const payload = res.data as { character?: CharacterOverview | null } | undefined
    setCharacter(payload?.character ?? null)
    setLoadError(null)
  }, [])

  // 打开窗口时取一次
  useEffect(() => {
    void reload()
  }, [reload])

  // 托盘/桌宠菜单点「打开聊天/角色设置」：主进程把窗口亮出来的同时
  // 发来切页指令，这里跟着切（订阅函数返回「取消订阅」，交给 React 卸载时调）
  useEffect(
    () => window.appApi?.onNavGoto((target) => setPage(target)) ?? undefined,
    [],
  )

  // 两页共用的props包
  const shared: CharacterProps = { character, reload, loadError }

  return (
    <div className={styles.shell}>
      <nav className={styles.rail}>
        <button
          type="button"
          className={page === 'chat' ? styles.railItemActive : styles.railItem}
          onClick={() => setPage('chat')}
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
          onClick={() => setPage('settings')}
        >
          {/* 简笔图标：一个齿轮（简化为圆+齿） */}
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm9 4 2-1.5-2-3.5-2.4.8a7.6 7.6 0 0 0-1.7-1L16.5 4h-4l-.4 2.8a7.6 7.6 0 0 0-1.7 1L8 7 6 10.5 8 12l-2 1.5 2 3.5 2.4-.8c.5.4 1.1.8 1.7 1l.4 2.8h4l.4-2.8c.6-.2 1.2-.6 1.7-1l2.4.8 2-3.5L21 12z" />
          </svg>
          <span>角色设置</span>
        </button>
      </nav>
      <main className={styles.body}>
        {page === 'chat' ? <ChatPage {...shared} /> : <SettingsPage {...shared} />}
      </main>
    </div>
  )
}
