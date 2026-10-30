/** 草稿试聊面板：只展示独立试聊结果，不保存正式人设或修改正式历史。 */
import { useEffect, useRef, useState } from 'react'
import ChatComposer, { type VisibleAttempt } from '../chat/ChatComposer'
import { previewFromDraft, validateDraft, type CharacterDraft } from './character-draft'
import styles from './PreviewChat.module.css'

/** 试聊不刷新正式聊天历史；两者在后台也是不同会话。 */
function keepFormalHistory(): void {}

/**
 * 用当前草稿开始下一轮；已经开始的回复与重试继续使用发送时的草稿。
 * @param props 草稿、可用性、忙碌通知和关闭动作
 * @returns 独立的试聊面板
 */
export default function PreviewChat({ draft, enabled, busy, onBusyChange, onClose }: {
  draft: CharacterDraft
  enabled: boolean
  busy: boolean
  onBusyChange: (busy: boolean) => void
  onClose: () => void
}) {
  const [attempts, setAttempts] = useState<VisibleAttempt[]>([])
  const history = useRef<HTMLDivElement>(null)
  // 回复落定后看最新结果，避免窄窗口只露出前面的用户问句。
  useEffect(() => {
    if (history.current) history.current.scrollTop = history.current.scrollHeight
  }, [attempts])
  const invalid = validateDraft(draft)
  return <section className={styles.panel} aria-label="草稿试聊">
    <header className={styles.header}><div><h2>试聊当前草稿</h2>
      <p>每轮使用发送时的草稿。试聊接续独立记录，不写入正式聊天与记忆；保存人设后才对正式聊天生效。</p></div>
      <button type="button" disabled={busy} onClick={onClose}>收起试聊</button></header>
    <div className={styles.history} ref={history} aria-label="本次试聊回复">
      {attempts.length === 0 && <p className={styles.hint}>试着说一句话，看看这份设定如何回应。</p>}
      {attempts.map((attempt, index) => <article key={index}>
        {!attempts.slice(0, index).some((previous) => previous.requestId === attempt.requestId)
          && <p className={styles.user}><strong>你</strong>{attempt.content}</p>}
        <p className={styles.reply}><strong>角色{attempt.status !== 'completed' ? ' · 未完成' : ''}</strong>
          {attempt.text || '未收到回复文字'}</p>
      </article>)}
    </div>
    {invalid && <p className={styles.hint}>{invalid}</p>}
    <ChatComposer enabled={enabled && invalid === null} previewDraft={previewFromDraft(draft)}
      onTurnSettled={keepFormalHistory} onBusyChange={onBusyChange}
      onAttemptSettled={(attempt) => setAttempts((previous) => [...previous, attempt])} />
  </section>
}
