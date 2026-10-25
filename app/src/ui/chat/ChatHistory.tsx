/**
 * 显示当前角色的正式历史与更早记录；半截回复保留文字并明确标成未完成。
 * 切页或重读后，旧请求回包不能覆盖新页面，所以每次读取都核对本次读取编号。
 */
import { useEffect, useRef, useState } from 'react'
import type { ChatHistoryPage } from '../../shared/chat-history'
import styles from './ChatHistory.module.css'

/** 历史列表只需知道当前角色，不接收数据库连接或模型配置。 */
interface ChatHistoryProps {
  characterId?: string
  displayName: string
}

/** 消息时间使用设备本地时区显示；库里仍保存统一的 UTC 毫秒。 */
const timeFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' })

/**
 * 读取并展示一条正式会话的历史，不提供新建或清空会话入口。
 * @param props 当前角色编号与显示名
 * @returns 只读消息列表、分页按钮与读取状态
 */
export default function ChatHistory({ characterId, displayName }: ChatHistoryProps) {
  const [page, setPage] = useState<ChatHistoryPage | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadAttempt, setReloadAttempt] = useState(0)
  const generation = useRef(0)
  const scrollArea = useRef<HTMLDivElement>(null)
  const scrollLatest = useRef(false)

  useEffect(() => {
    const current = ++generation.current
    if (!characterId) { setBusy(false); return }
    setBusy(true)
    setError(null)
    setPage(null)
    /** 会话编号由后台解析，拿到后再读历史，不能靠界面猜一个编号。 */
    async function readInitial() {
      try {
        const api = window.appApi
        if (!api) throw new Error('CHANNEL_MISSING')
        const formal = await api.getFormalConversation()
        if (!formal.ok) throw new Error(formal.code ?? 'READ_FAILED')
        const conversation = formal.data?.conversation
        if (!conversation || conversation.characterId !== characterId) throw new Error('CONVERSATION_MISMATCH')
        const result = await api.getChatHistory(conversation.conversationId)
        if (!result.ok) throw new Error(result.code ?? 'READ_FAILED')
        if (result.data?.history.characterId !== characterId) throw new Error('CONVERSATION_MISMATCH')
        if (generation.current !== current) return
        scrollLatest.current = true
        setPage(result.data.history)
      } catch (cause) {
        if (generation.current === current) setError(cause instanceof Error ? cause.message : 'READ_FAILED')
      } finally {
        if (generation.current === current) setBusy(false)
      }
    }
    void readInitial()
    // 页面卸载后，旧回包即使晚到也不能再改动它的状态。
    return () => { generation.current++ }
  }, [characterId, reloadAttempt])

  useEffect(() => {
    if (scrollLatest.current && scrollArea.current) {
      scrollArea.current.scrollTop = scrollArea.current.scrollHeight
      scrollLatest.current = false
    }
  }, [page])

  /** 更早记录加在前面；只有初次读取滚到最下方，翻旧记录时保留当前阅读位置。 */
  async function loadOlder() {
    if (!page?.hasMore || busy || !window.appApi) return
    const current = generation.current
    setBusy(true)
    setError(null)
    try {
      const result = await window.appApi.getChatHistory(page.conversationId, page.messages[0]?.seq)
      if (!result.ok) throw new Error(result.code ?? 'READ_FAILED')
      const older = result.data?.history
      if (!older || older.conversationId !== page.conversationId || older.characterId !== characterId) {
        throw new Error('CONVERSATION_MISMATCH')
      }
      if (generation.current === current) setPage({ ...older, messages: [...older.messages, ...page.messages] })
    } catch (cause) {
      if (generation.current === current) setError(cause instanceof Error ? cause.message : 'READ_FAILED')
    } finally {
      if (generation.current === current) setBusy(false)
    }
  }

  return (
    <div className={styles.history} ref={scrollArea} aria-busy={busy}>
      {page?.hasMore && <button className={styles.more} type="button" disabled={busy}
        onClick={() => void loadOlder()}>加载更早记录</button>}
      {busy && <p className={styles.notice} role="status">正在读取聊天记录…</p>}
      {!characterId && <p className={styles.notice} role="status">正在读取角色资料…</p>}
      {error && <div className={styles.notice} role="alert">
        <p>历史读取失败（{error}）</p>
        <button type="button" disabled={busy} onClick={() => {
          // 翻旧记录失败时沿用原边界重试，不清空用户已经读到的消息。
          if (page) void loadOlder()
          else setReloadAttempt((value) => value + 1)
        }}>重试读取</button>
      </div>}
      {!busy && !error && page?.messages.length === 0 &&
        <p className={styles.empty}>还没有聊天记录</p>}
      <ol className={styles.list} aria-label="聊天记录">
        {page?.messages.map((message) => <li key={message.id}
          className={message.role === 'user' ? styles.user : styles.character}>
          <div className={styles.meta}>
            <span>{message.role === 'user' ? '你' : displayName}{message.role === 'proactive' ? ' · 主动问候' : ''}</span>
            <time dateTime={new Date(message.createdAt).toISOString()}>{timeFormat.format(message.createdAt)}</time>
          </div>
          <p className={styles.text}>{message.content ||
            (message.status === 'pending' || message.status === 'streaming' ? '等待回复…' : '未收到回复文字')}</p>
          {message.status !== 'completed' && <p className={styles.incomplete}>
            未完成 · {message.status === 'failed' ? '回复失败' : message.status === 'cancelled' ? '已取消' : '等待或生成中'}
          </p>}
        </li>)}
      </ol>
    </div>
  )
}
