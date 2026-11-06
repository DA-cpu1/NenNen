/** 手动测试连接与工具能力；测试中允许取消，失败保留明确状态，不自动重试请求。 */
import { useRef, useState } from 'react'
import type { ModelSettingsOverview } from '../../shared/model-settings'
import { modelSettingsMessage } from './model-settings-messages'
import styles from './ModelSettingsPage.module.css'

/**
 * 展示当前已保存配置的真实能力结论，编辑中的草稿必须先保存。
 * @param props 已保存状态、表单是否可测试、处理状态通知及重读动作
 * @returns 测试卡片和测试中、成功、失败或不支持工具的反馈
 */
export default function ConnectionTestCard({ overview, blocked, onBusyChange, reload }: {
  overview: ModelSettingsOverview; blocked: boolean; onBusyChange: (busy: boolean) => void; reload: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState('')
  const requestId = useRef<string | null>(null)
  const running = useRef(false)
  const hasCredential = !!overview.settings?.credentialRef && !['missing', 'unavailable'].includes(overview.credentialStorage)

  /** 同一次传输失败沿用编号，后台会读已有回执，不重复请求供应商。 */
  async function test(): Promise<void> {
    if (running.current || blocked || !window.appApi) return
    running.current = true; setBusy(true); setError(''); onBusyChange(true)
    requestId.current ??= crypto.randomUUID()
    try {
      const result = await window.appApi.testModelConnection(requestId.current)
      if (!result.ok) {
        setError(modelSettingsMessage(result.code))
        if (result.code !== 'BACKEND_UNREACHABLE') requestId.current = null
      } else requestId.current = null
      await reload()
    } catch { setError('测试回执尚未收到，重试会先读取本次结果。') }
    finally { running.current = false; setBusy(false); setCancelling(false); onBusyChange(false) }
  }

  /** 取消需要后台实际结束测试，不能刚点按钮就显示测试已完成。 */
  async function cancel(): Promise<void> {
    setCancelling(true)
    try {
      const result = await window.appApi?.cancelModelConnectionTest()
      if (!result?.ok) { setError('取消尚未确认，请重试取消。'); setCancelling(false) }
    } catch { setError('取消尚未确认，请重试取消。'); setCancelling(false) }
  }

  const status = overview.settings?.testStatus
  const text = busy ? '正在测试连接…' : overview.ready ? '连接正常 · 支持工具调用'
    : status === 'unsupported' ? '可以连接，但不支持工具调用'
      : status === 'failed' ? '连接失败，请检查密钥、模型和服务地址'
        : !hasCredential ? '尚未配置模型' : status === 'passed' ? '模型尚未就绪，请重新保存配置' : '配置已保存，请测试连接'
  return <section className={styles.card} aria-label="模型连接测试"><h2><span aria-hidden="true">↔</span>连接测试</h2>
    <div className={styles.testActions}><button type="button" className={styles.primary} disabled={!hasCredential || blocked || busy} onClick={() => void test()}>测试连接</button>
      {busy ? <button type="button" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? '正在取消…' : '取消测试'}</button> : null}</div>
    <p className={status === 'unsupported' ? styles.warning : styles.status} role="status">{text}</p>
    {status === 'unsupported' ? <p className={styles.hint}>记忆操作无法完成，请更换模型并重新测试。</p> : null}
    {blocked ? <p className={styles.hint}>请先保存本次配置，再测试连接。</p> : null}
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    <p className={styles.hint}>模型回复和记忆整理会联网。连接测试也可能产生用量。</p>
  </section>
}
