/**
 * 确认框负责拦住会丢草稿的操作。原生 dialog 会限制键盘焦点留在框内，
 * 用户按 Tab 不会误点到被遮住的保存按钮；关闭后焦点回到原来的位置。
 */
import { useEffect, useId, useRef, type ReactNode } from 'react'
import styles from './SettingsPage.module.css'

interface ConfirmationDialogProps {
  title: string
  children: ReactNode
  actions: ReactNode
  onCancel: () => void
}

/**
 * 挂载时打开模态框；Escape 等同于「继续编辑」，不会丢弃草稿。
 * @param props 标题、说明、操作按钮与取消回调
 * @returns 原生确认框
 */
export default function ConfirmationDialog({ title, children, actions, onCancel }: ConfirmationDialogProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])
  return <dialog ref={ref} className={styles.dialog} aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); onCancel() }}>
    <h2 id={titleId}>{title}</h2><div>{children}</div><div className={styles.dialogActions}>{actions}</div>
  </dialog>
}
