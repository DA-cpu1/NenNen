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
  /** 禁止新请求时说明原因，避免把缺少模型误说成缺少角色资料。 */
  disabledHint?: string
  onTurnSettled: () => void
  /** 有草稿即走试聊入口，不携带正式会话编号。 */
  previewDraft?: PreviewTurnRequest['draft']
  onAttemptSettled?: (attempt: VisibleAttempt) => void
  onBusyChange?: (busy: boolean) => void
}

type TurnPhase = 'idle' | 'sending' | 'stopping'

/** 固定失败码对应可执行的建议；未知失败保留固定码，方便定位，不显示供应商原始报错。 */
const failureHints: Record<string, string> = {
  E_CONTEXT_BUDGET_EXCEEDED: '本轮内容超过输入预算，请缩短消息或人设后再发送。',
  AGENT_UNAVAILABLE: '模型尚未连接，请先检查模型配置后重试。',
  TURN_IN_PROGRESS: '这个角色仍在回复，请等回复结束或先停止。',
  E_TURN_TIMEOUT: '本轮等待已超过90秒，回复已停止，可以重试。',
  E_TURN_LIMIT: '本轮已达到3次生成上限，回复未完成。',
  STREAM_ENDED: '回复连接已断开，已收到的文字仍保留，可以重试。',
  BACKEND_UNREACHABLE: '后台暂时无法连接，请稍后重试。',
  E_EVE_SEND_FAILED: '消息未能交给模型，请重试。',
  MEMORY_CLEANUP_PENDING: '本地记忆正在清理。请稍等，或去记忆页查看进度。',
  MEMORY_CLEANUP_FAILED: '记忆已经更新，但本地清理未完成。请到记忆页重试清理。',
  USER_MESSAGE_EXCLUDED: '这条原话已停止作为聊天背景。你可以发送新的消息。',
}
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
export default function ChatComposer({ enabled, disabledHint = '请先补齐角色资料…', onTurnSettled, previewDraft, onAttemptSettled, onBusyChange }: ChatComposerProps) {
  const [text, setText] = useState('')
  const [phase, setPhase] = useState<TurnPhase>('idle')
  const [streamText, setStreamText] = useState('')
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [waitingHint, setWaitingHint] = useState(false)
  const [retry, setRetry] = useState<RetryPayload | null>(null)
  const [memoryReceipt, setMemoryReceipt] = useState<{ requestId: string; text: string } | null>(null)
  const [memoryInterrupted, setMemoryInterrupted] = useState(false)
  const active = useRef<RetryPayload | null>(null)
  const conversationId = useRef<string | null>(null)
  const phaseRef = useRef<TurnPhase>('idle')
  const replyText = useRef('')
  /** 未保存的文字按原编号保留，不能借给下一条新消息。 */
  const pendingSave = useRef<{ requestId: string; text: string } | null>(null)
  const hintTimer = useRef<number | undefined>(undefined)
  const liveArea = useRef<HTMLDivElement>(null)
  const mounted = useRef(true)
  // ref 让一次订阅总能调用当前页面的通知函数，不捕获旧状态。
  const callbacks = useRef({ onTurnSettled, onAttemptSettled, onBusyChange })
  callbacks.current = { onTurnSettled, onAttemptSettled, onBusyChange }
  const codePoints = [...text].length
  const tooLong = codePoints > MAX_CHAT_INPUT_CHARACTERS
  // 文字逐段增长时，只滚动实时条自己的内容，不拉动整个设置页。
  useEffect(() => {
    if (liveArea.current) liveArea.current.scrollTop = liveArea.current.scrollHeight
  }, [streamText])

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
  function settleTurn(status: VisibleAttempt['status'], code: string | null, confirmed = false): void {
    const payload = active.current
    if (!payload) return
    clearHintTimer()
    active.current = null
    conversationId.current = null
    phaseRef.current = 'idle'
    setPhase('idle')
    const saveFailed = code === 'E_REPLY_SAVE_FAILED' || code === 'E_RUN_SAVE_FAILED'
    if (saveFailed) pendingSave.current = { requestId: payload.requestId, text: replyText.current }
    else if (confirmed && pendingSave.current?.requestId === payload.requestId) pendingSave.current = null
    const stillUnsaved = pendingSave.current?.requestId === payload.requestId
    setStreamText(stillUnsaved ? pendingSave.current!.text : code === 'STREAM_ENDED' ? replyText.current : '')
    setWaitingHint(false)
    setErrorCode(code)
    const canRetry = code !== 'MEMORY_CLEANUP_FAILED' && code !== 'USER_MESSAGE_EXCLUDED'
    setRetry((status === 'failed' && canRetry) || stillUnsaved ? payload : null)
    // 试聊未保存时也要保护面板，不能收起后把唯一可见副本丢掉。
    callbacks.current.onBusyChange?.(stillUnsaved)
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
      } else if (frame.type === 'tool-status') {
        // 保存和清理均由后台确认；角色回复是否完成是另一回事。
        const notices = {
          'memory-saved': '记忆已保存', 'memory-already-saved': '这条记忆已保存过',
          'memory-corrected': '记忆已纠正', 'memory-forgotten': '已忘记这条信息，聊天原文仍保留',
        }
        const personaHint = 'personaContainsContent' in frame && frame.personaContainsContent
          ? '。角色设定里还有相同文字，可以在角色设置里修改' : ''
        setMemoryReceipt({ requestId: message.requestId, text: notices[frame.status] + personaHint })
      } else if (frame.type === 'done') settleTurn('completed', null, true)
      else {
        setMemoryInterrupted(frame.reason === 'memory-changed')
        if (frame.type === 'cancelled') settleTurn('cancelled', null, true)
        else settleTurn('failed', frame.code, true)
      }
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
    // 待补写的回复不再请求模型，删除凭据后也应该允许把原结果保存完整。
    if (phaseRef.current !== 'idle' || (!enabled && !pendingSave.current)) return
    if (pendingSave.current && pendingSave.current.requestId !== payload.requestId) return
    const api = window.appApi
    if (!api?.onChatTurnEvent || !api.startChatTurn || !api.startPreviewTurn) {
      setErrorCode('CHANNEL_MISSING')
      setRetry(payload)
      return
    }
    active.current = payload
    conversationId.current = null
    phaseRef.current = 'sending'
    callbacks.current.onBusyChange?.(true)
    // 补写失败的重试没有新模型文字，继续留住原结果，不能一点重试就抹掉它。
    const retainedText = pendingSave.current?.requestId === payload.requestId ? pendingSave.current.text : ''
    replyText.current = retainedText
    setPhase('sending')
    setStreamText(retainedText)
    setErrorCode(null)
    setRetry(null)
    setMemoryReceipt((receipt) => receipt?.requestId === payload.requestId ? receipt : null)
    setMemoryInterrupted(false)
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
          result.code === 'ALREADY_REPLIED' ? null : result.code ?? 'SEND_FAILED', result.code === 'ALREADY_REPLIED')
      } else if (isStopping()) void cancelKnownTurn()
    } catch {
      if (mounted.current && active.current === payload) settleTurn('failed', 'SEND_FAILED')
    }
  }

  /** 原样发送，包括首尾空白；后台仍会重新检查长度。 */
  function send(): void {
    if (phaseRef.current !== 'idle' || !enabled || !text.trim() || tooLong || pendingSave.current) return
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
    {(busy || streamText !== '') && <div className={styles.live} ref={liveArea} aria-live="polite">
      {streamText ? <p className={styles.liveText}>{streamText}</p>
        : <p className={styles.hint}>{phase === 'stopping' ? '正在停止…' : waitingHint ? '对方还在思考，稍等一下…' : '正在输入…'}</p>}
    </div>}
    {memoryReceipt ? <p className={styles.hint} role="status">{memoryReceipt.text}</p> : null}
    {memoryInterrupted ? <p className={styles.memoryInterrupted} role="status">记忆已更新，使用旧内容的回复已停止。</p> : null}
    {(errorCode || retry) && <div className={styles.notice}>
      {errorCode && <span role="alert" className={styles.error}>
        {errorCode === 'CANCEL_FAILED' ? '停止请求未确认，可再次停止' :
          pendingSave.current ? '本轮未完整保存，请先重试保存，再发送新消息' : failureHints[errorCode] ?? `回复未完成（${errorCode}）`}
      </span>}
      {retry && !busy && <button type="button" className={styles.retry} disabled={!enabled && !pendingSave.current}
        onClick={() => void startTurn(retry)}>重试</button>}
    </div>}
    <div className={styles.row}>
      <textarea className={styles.input} rows={3} value={text} placeholder={enabled ? '想说些什么？' : disabledHint}
        disabled={!enabled} onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          // 中文输入法确认候选词和 Shift＋Enter 都不发送，避免一句话没写完就被送出。
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            send()
          }
        }}
        aria-label={previewDraft ? '试聊输入框' : '聊天输入框'} />
      <p className={styles.shortcut}>Enter 发送 · Shift + Enter 换行</p>
      {busy ? <button type="button" className={styles.stop} disabled={phase === 'stopping'} onClick={stop}>
        {phase === 'stopping' ? '停止中' : '停止'}</button>
        : <button type="button" className={styles.send} disabled={!enabled || !text.trim() || tooLong || pendingSave.current !== null} onClick={send}>发送</button>}
    </div>
    {tooLong && <p className={styles.error}>单条最多 {MAX_CHAT_INPUT_CHARACTERS} 个字符（当前 {codePoints}），请分段发送</p>}
  </footer>
}
