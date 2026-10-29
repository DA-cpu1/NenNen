/**
 * 正式聊天和草稿试聊共用的输入区：先订阅，再发送，按请求编号接收回复。
 * 每次尝试固定正文与草稿；重试复用它们，之后的编辑不会偷偷换掉本轮人设。
 */
import { useEffect, useRef, useState } from 'react'
import { MAX_CHAT_INPUT_CHARACTERS } from '../../shared/chat-input'
import type { PreviewTurnRequest } from '../../shared/chat-turn'
import styles from './ChatComposer.module.css'

/** 试聊页保存本次可见结果；正式历史仍以 SQLite 为准。 */
export interface VisibleAttempt {
  requestId: string
  content: string
  text: string
  status: 'completed' | 'failed' | 'cancelled'
}

interface ChatComposerProps {
  enabled: boolean
  onTurnSettled: () => void
  /** 有草稿即走试聊入口，不携带正式会话编号。 */
  previewDraft?: PreviewTurnRequest['draft']
  onAttemptSettled?: (attempt: VisibleAttempt) => void
  onBusyChange?: (busy: boolean) => void
}

type TurnPhase = 'idle' | 'sending' | 'stopping'
interface RetryPayload {
  requestId: string
  content: string
  draft?: PreviewTurnRequest['draft']
}

/**
 * 展示输入、实时回复和重试；停止结果由后台终态确认。
 * @param props 当前可用性、可选试聊草稿及刷新通知
 * @returns 发送区；没有后台通道时显示明确失败
 */
export default function ChatComposer({ enabled, onTurnSettled, previewDraft, onAttemptSettled, onBusyChange }: ChatComposerProps) {
  const [text, setText] = useState('')
  const [phase, setPhase] = useState<TurnPhase>('idle')
  const [streamText, setStreamText] = useState('')
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [waitingHint, setWaitingHint] = useState(false)
  const [retry, setRetry] = useState<RetryPayload | null>(null)
  const active = useRef<RetryPayload | null>(null)
  const conversationId = useRef<string | null>(null)
  const phaseRef = useRef<TurnPhase>('idle')
  const replyText = useRef('')
  const hintTimer = useRef<number | undefined>(undefined)
  const mounted = useRef(true)
  // ref 让一次订阅总能调用当前页面的通知函数，不捕获旧状态。
  const callbacks = useRef({ onTurnSettled, onAttemptSettled, onBusyChange })
  callbacks.current = { onTurnSettled, onAttemptSettled, onBusyChange }
  const codePoints = [...text].length
  const tooLong = codePoints > MAX_CHAT_INPUT_CHARACTERS

  /** 停止首字闹钟，防止结束后冒出过时提示。 */
  function clearHintTimer(): void {
    clearTimeout(hintTimer.current)
    hintTimer.current = undefined
  }

  /** 等待期间按钮可以改变阶段，所以每次从 ref 重新读停止意图。 */
  function isStopping(): boolean {
    return phaseRef.current === 'stopping'
  }

  /** 收尾只执行一次；未保存或断流的可见文字留下，不能假装已入库。 */
  function settleTurn(status: VisibleAttempt['status'], code: string | null): void {
    const payload = active.current
    if (!payload) return
    clearHintTimer()
    active.current = null
    conversationId.current = null
    phaseRef.current = 'idle'
    setPhase('idle')
    const unsaved = code === 'E_REPLY_SAVE_FAILED' || code === 'E_RUN_SAVE_FAILED' || code === 'STREAM_ENDED'
    setStreamText(unsaved ? replyText.current : '')
    setWaitingHint(false)
    setErrorCode(code)
    setRetry(status === 'failed' ? payload : null)
    callbacks.current.onBusyChange?.(false)
    callbacks.current.onAttemptSettled?.({ requestId: payload.requestId, content: payload.content, text: replyText.current, status })
    callbacks.current.onTurnSettled()
  }

  /** 请求失败允许再次按停止，只有后台终态才能确认已取消。 */
  async function cancelKnownTurn(): Promise<void> {
    const id = conversationId.current
    const request = active.current
    if (!id || !request) return
    try {
      const result = await window.appApi?.cancelChatTurn(id)
      if (active.current !== request || !mounted.current) return
      if (!result?.ok) throw new Error('E_CANCEL_FAILED')
    } catch {
      if (active.current !== request || !mounted.current) return
      phaseRef.current = 'sending'
      setPhase('sending')
      setErrorCode('CANCEL_FAILED')
    }
  }

  useEffect(() => {
    mounted.current = true
    const unsubscribe = window.appApi?.onChatTurnEvent((message) => {
      if (message.requestId !== active.current?.requestId) return
      const frame = message.frame
      if (!frame) { settleTurn('failed', 'STREAM_ENDED'); return }
      if (frame.type === 'text') {
        replyText.current += frame.delta
        clearHintTimer()
        setStreamText(replyText.current)
        setWaitingHint(false)
      } else if (frame.type === 'saved') {
        conversationId.current = frame.conversationId
        callbacks.current.onTurnSettled()
        // 先按停止再收到首帧时，等拿到真实会话编号再请求取消。
        if (phaseRef.current === 'stopping') void cancelKnownTurn()
      } else if (frame.type === 'done') settleTurn('completed', null)
      else if (frame.type === 'cancelled') settleTurn('cancelled', null)
      else settleTurn('failed', frame.code)
    })
    return () => {
      mounted.current = false
      unsubscribe?.()
      clearHintTimer()
      // 试聊离开设置页即停止；正式聊天切页后仍可从历史看到后台结果。
      if (active.current?.draft && conversationId.current) {
        void window.appApi?.cancelChatTurn(conversationId.current).catch(() => {})
      }
    }
  }, [])

  /** 固定请求再异步读取，按钮变灰前的连续点击也只能送出一轮。 */
  async function startTurn(payload: RetryPayload): Promise<void> {
    if (phaseRef.current !== 'idle' || !enabled) return
    const api = window.appApi
    if (!api?.onChatTurnEvent || !api.startChatTurn || !api.startPreviewTurn) {
      setErrorCode('CHANNEL_MISSING')
      return
    }
    active.current = payload
    conversationId.current = null
    phaseRef.current = 'sending'
    callbacks.current.onBusyChange?.(true)
    replyText.current = ''
    setPhase('sending')
    setStreamText('')
    setErrorCode(null)
    setRetry(null)
    setWaitingHint(false)
    clearHintTimer()
    hintTimer.current = window.setTimeout(() => setWaitingHint(true), 30_000)
    try {
      let result: { ok: boolean; code?: string }
      if (payload.draft) {
        result = await api.startPreviewTurn(payload.requestId, payload.content, payload.draft)
      } else {
        const formal = await api.getFormalConversation()
        if (!mounted.current || active.current !== payload) return
        if (isStopping()) { settleTurn('cancelled', null); return }
        if (!formal.ok || !formal.data?.conversation) {
          settleTurn('failed', formal.code ?? 'CONVERSATION_UNAVAILABLE')
          return
        }
        conversationId.current = formal.data.conversation.conversationId
        result = await api.startChatTurn(conversationId.current, payload.requestId, payload.content)
      }
      if (!mounted.current || active.current !== payload) return
      if (!result.ok) {
        settleTurn(result.code === 'ALREADY_REPLIED' ? 'completed' : 'failed',
          result.code === 'ALREADY_REPLIED' ? null : result.code ?? 'SEND_FAILED')
      } else if (isStopping()) void cancelKnownTurn()
    } catch {
      if (mounted.current && active.current === payload) settleTurn('failed', 'SEND_FAILED')
    }
  }

  /** 原样发送，包括首尾空白；后台仍会重新检查长度。 */
  function send(): void {
    if (phaseRef.current !== 'idle' || !enabled || !text.trim() || tooLong) return
    const payload = { requestId: crypto.randomUUID(), content: text, draft: previewDraft }
    setText('')
    void startTurn(payload)
  }

  /** 立即记下停止意图，等后台确认后才收成取消。 */
  function stop(): void {
    if (phaseRef.current !== 'sending') return
    phaseRef.current = 'stopping'
    setPhase('stopping')
    void cancelKnownTurn()
  }

  const busy = phase !== 'idle'
  return <footer className={styles.composer}>
    {(busy || streamText !== '') && <div className={styles.live} aria-live="polite">
      {streamText ? <p className={styles.liveText}>{streamText}</p>
        : <p className={styles.hint}>{phase === 'stopping' ? '正在停止…' : waitingHint ? '对方还在思考，稍等一下…' : '正在输入…'}</p>}
    </div>}
    {(errorCode || retry) && <div className={styles.notice}>
      {errorCode && <span role="alert" className={styles.error}>
        {errorCode === 'CANCEL_FAILED' ? '停止请求未确认，可再次停止' :
          ['E_REPLY_SAVE_FAILED', 'E_RUN_SAVE_FAILED'].includes(errorCode) ? '本轮未完整保存，请保留可见文字并重试' : `回复未完成（${errorCode}）`}
      </span>}
      {retry && !busy && <button type="button" className={styles.retry} disabled={!enabled}
        onClick={() => void startTurn(retry)}>重试</button>}
    </div>}
    <div className={styles.row}>
      <input className={styles.input} value={text} placeholder={enabled ? '说点什么…' : '请先补齐角色资料…'}
        disabled={!enabled} onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) send() }}
        aria-label={previewDraft ? '试聊输入框' : '聊天输入框'} />
      {busy ? <button type="button" className={styles.stop} disabled={phase === 'stopping'} onClick={stop}>
        {phase === 'stopping' ? '停止中' : '停止'}</button>
        : <button type="button" className={styles.send} disabled={!enabled || !text.trim() || tooLong} onClick={send}>发送</button>}
    </div>
    {tooLong && <p className={styles.error}>单条最多 {MAX_CHAT_INPUT_CHARACTERS} 个字符（当前 {codePoints}），请分段发送</p>}
  </footer>
}
