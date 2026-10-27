/**
 * 聊天输入区：发送、停止、重试，以及进行中回复的实时显示。
 * 事件经主进程推送（onChatTurnEvent），这里只按本次请求编号过滤；
 * 历史列表不在本组件里改——回合保存或落定时通知父层刷新。
 * 「先订阅、后启动」：受理回执与第一帧的先后不保证，订阅只建立一次。
 */
import { useEffect, useRef, useState } from 'react'
import { MAX_CHAT_INPUT_CHARACTERS } from '../../shared/chat-input'
import styles from './ChatComposer.module.css'

/** 输入区需要的两个外部条件。 */
interface ChatComposerProps {
  /** 角色未就绪或读取失败时禁用发送。 */
  enabled: boolean
  /** 用户消息已入库或回合落定时通知父层重读历史。 */
  onTurnSettled: () => void
}

/** 回合在界面上的阶段：空闲 / 发送中 / 已请求停止等收尾。 */
type TurnPhase = 'idle' | 'sending' | 'stopping'

/** 重试要复用的原请求：同编号同正文，后台据此建新回复行不重复保存用户消息。 */
interface RetryPayload {
  requestId: string
  content: string
}

/** 04 §2：首段文字等待超过 30 秒显示等待提示。 */
const FIRST_SEGMENT_HINT_MS = 30_000

export default function ChatComposer({ enabled, onTurnSettled }: ChatComposerProps) {
  const [text, setText] = useState('')
  const [phase, setPhase] = useState<TurnPhase>('idle')
  const [streamText, setStreamText] = useState('')
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [waitingHint, setWaitingHint] = useState(false)
  const [retry, setRetry] = useState<RetryPayload | null>(null)

  /** 事件过滤与阶段读取都用 ref：订阅只建一次，处理函数不能靠闭包里的旧状态。 */
  const activeRequestId = useRef<string | null>(null)
  const phaseRef = useRef<TurnPhase>('idle')
  const hintTimer = useRef<number | undefined>(undefined)
  /** 最近一次发出的正文，失败后重试复用。 */
  const lastSentRef = useRef('')
  const settledRef = useRef(onTurnSettled)
  settledRef.current = onTurnSettled

  /** 码点计数：与后台同一口径，中文和单个 emoji 各算一个。 */
  const codePoints = [...text].length
  const tooLong = codePoints > MAX_CHAT_INPUT_CHARACTERS

  /** 清理等待提示的计时器。 */
  function clearHintTimer(): void {
    if (hintTimer.current !== undefined) {
      clearTimeout(hintTimer.current)
      hintTimer.current = undefined
    }
  }

  /** 回合结束的公共收尾：回空闲、停计时、按情况留重试入口。 */
  function settleTurn(failedCode: string | null, retryPayload: RetryPayload | null): void {
    clearHintTimer()
    activeRequestId.current = null
    phaseRef.current = 'idle'
    setPhase('idle')
    setStreamText('')
    setWaitingHint(false)
    setErrorCode(failedCode)
    setRetry(retryPayload)
    settledRef.current()
  }

  // 订阅推送事件：挂载时建立、卸载时退订。切到设置页等场景退订后，
  // 后台仍会把回合写完，回到聊天页时历史里能看到最终结果。
  useEffect(() => {
    const api = window.appApi
    if (!api?.onChatTurnEvent) return
    return api.onChatTurnEvent((message) => {
      if (message.requestId !== activeRequestId.current) return
      if (message.frame === null) {
        // 流结束但没等到终态帧（如连接中断）：按未完成处理并给重试入口。
        if (phaseRef.current !== 'idle') {
          settleTurn('STREAM_ENDED', null)
        }
        return
      }
      const frame = message.frame
      if (frame.type === 'text') {
        setStreamText((previous) => previous + frame.delta)
        return
      }
      if (frame.type === 'saved') {
        // 用户消息已入库：先让历史显示它，回复继续在下方实时增长。
        settledRef.current()
        return
      }
      if (frame.type === 'done') {
        settleTurn(null, null)
        return
      }
      // cancelled / failed：半截文字由历史里的「未完成」标识展示，这里给重试。
      const payload: RetryPayload | null = frame.type === 'failed'
        ? { requestId: message.requestId, content: lastSentRef.current }
        : null
      settleTurn(frame.type === 'failed' ? frame.code : null, payload)
    })
  }, [])

  /** 发起（或重发）一次回合；requestId 重试时沿用原编号。 */
  async function startTurn(requestId: string, content: string): Promise<void> {
    const api = window.appApi
    if (!api?.startChatTurn || !api.getFormalConversation) {
      setErrorCode('CHANNEL_MISSING')
      return
    }
    // 会话编号由后台解析；界面不猜。拿不到会话按失败提示，不动输入。
    const formal = await api.getFormalConversation()
    if (!formal.ok || !formal.data?.conversation) {
      setErrorCode(formal.code ?? 'CONVERSATION_UNAVAILABLE')
      return
    }
    activeRequestId.current = requestId
    phaseRef.current = 'sending'
    setPhase('sending')
    setStreamText('')
    setErrorCode(null)
    setRetry(null)
    setWaitingHint(false)
    // 30 秒没等到第一个字就提示「还在想」，不算失败（总时限由后台把关）。
    clearHintTimer()
    hintTimer.current = window.setTimeout(() => setWaitingHint(true), FIRST_SEGMENT_HINT_MS)
    const result = await api.startChatTurn(formal.data.conversation.conversationId, requestId, content)
    if (!result.ok) {
      // 受理失败：立即回空闲。已回复过说明历史里早有答案，刷新即可。
      if (result.code === 'ALREADY_REPLIED') settleTurn(null, null)
      else settleTurn(result.code ?? 'SEND_FAILED', { requestId, content })
    }
  }

  async function send(): Promise<void> {
    if (phase !== 'idle' || !enabled || !text.trim() || tooLong) return
    const content = text // 原样发送，不改写用户原话（含首尾空白）
    lastSentRef.current = content
    setText('')
    await startTurn(crypto.randomUUID(), content)
  }

  async function stop(): Promise<void> {
    const api = window.appApi
    if (!api?.cancelChatTurn || phaseRef.current === 'idle') return
    phaseRef.current = 'stopping'
    setPhase('stopping')
    const formal = await api.getFormalConversation()
    if (formal.ok && formal.data?.conversation) {
      await api.cancelChatTurn(formal.data.conversation.conversationId)
    }
    // 取消的实际收尾由 cancelled 帧驱动；这里只改按钮状态。
  }

  // 卸载时停掉等待提示的计时器（订阅的退订由 useEffect 的清理函数负责）。
  useEffect(() => () => clearHintTimer(), [])

  const busy = phase !== 'idle'
  return (
    <footer className={styles.composer}>
      {/* 进行中的回复实时显示；等待提示只在还没有文字时出现。 */}
      {(busy || streamText !== '') && (
        <div className={styles.live} aria-live="polite">
          {streamText ? (
            <p className={styles.liveText}>{streamText}</p>
          ) : waitingHint ? (
            <p className={styles.hint}>{phase === 'stopping' ? '正在停止…' : '对方还在思考，稍等一下…'}</p>
          ) : (
            <p className={styles.hint}>{phase === 'stopping' ? '正在停止…' : '正在输入…'}</p>
          )}
        </div>
      )}
      {(errorCode || retry) && !busy && (
        <div className={styles.notice}>
          {errorCode && <span className={styles.error}>回复未完成（{errorCode}）</span>}
          {retry && <button type="button" className={styles.retry}
            onClick={() => void startTurn(retry.requestId, retry.content)}>重试</button>}
        </div>
      )}
      <div className={styles.row}>
        <input
          className={styles.input}
          value={text}
          placeholder={enabled ? '说点什么…' : '正在读取角色资料…'}
          disabled={!enabled}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) void send()
          }}
          aria-label="聊天输入框"
        />
        {busy ? (
          <button type="button" className={styles.stop} disabled={phase === 'stopping'} onClick={() => void stop()}>
            {phase === 'stopping' ? '停止中' : '停止'}
          </button>
        ) : (
          <button type="button" className={styles.send}
            disabled={!enabled || !text.trim() || tooLong} onClick={() => void send()}>
            发送
          </button>
        )}
      </div>
      {tooLong && <p className={styles.error}>单条最多 {MAX_CHAT_INPUT_CHARACTERS} 个字符（当前 {codePoints}），请分段发送</p>}
    </footer>
  )
}
