/** 更换凭据使用独立弹窗；输入只留本次窗口，取消或保存成功后随弹窗销毁。 */
import { useId, useState } from 'react'
import ConfirmationDialog from '../settings/ConfirmationDialog'
import styles from './ModelSettingsPage.module.css'

/**
 * 等主进程完成更换才关闭；失败保留本次输入，并显示明确的当前状态。
 * @param props 更换状态、失败说明、保存和取消操作
 * @returns 图 19 中的新凭据输入弹窗
 */
export default function CredentialDialog({ busy, error, onChange, onSave, onClose }: {
  busy: boolean; error: string; onChange: () => void; onSave: (key: string) => Promise<boolean>; onClose: () => void
}) {
  const [key, setKey] = useState('')
  const inputId = useId()
  return <ConfirmationDialog title="更换 API 凭据" onCancel={() => { if (!busy) onClose() }}
    actions={<><button type="button" disabled={busy} onClick={onClose}>取消</button>
      <button type="button" className={styles.primary} disabled={busy || !key.trim()}
        onClick={() => void onSave(key).then((saved) => { if (saved) onClose() })}>{busy ? '正在保存并更新…' : '保存新凭据'}</button></>}>
    <label className={styles.credentialLabel} htmlFor={inputId}>新 API 密钥</label>
    <input id={inputId} className={styles.credentialInput} type="password" value={key} autoComplete="off" spellCheck={false}
      disabled={busy} onChange={(event) => { setKey(event.target.value); onChange() }} />
    <p className={styles.hint}>请输入要使用的新凭据。</p>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
  </ConfirmationDialog>
}
