/**
 * 软件设置中的模型与连接页：编辑公开连接资料，只在用户输入时暂存新密钥。
 * 保存成功才更新表单基线；失败保留草稿，离开页面前保护未保存内容。
 */
import { useEffect, useRef, useState } from 'react'
import type { CharacterOverview } from '../../shared/data-types'
import { DEFAULT_MODEL_CONNECTION, modelConnectionSchema, type ModelConnection, type ModelSettingsOverview } from '../../shared/model-settings'
import { assetUrl } from '../../shared/asset-url'
import ConfirmationDialog from '../settings/ConfirmationDialog'
import { modelSettingsMessage } from './model-settings-messages'
import styles from './ModelSettingsPage.module.css'

/** 公共状态来自应用壳，离开动作也由应用壳统一处理。 */
export interface ModelSettingsPageProps {
  overview: ModelSettingsOverview | null
  loadError: string | null
  reload: () => Promise<void>
  character: CharacterOverview | null
  leaving: boolean
  onLeave: () => void
  onStay: () => void
}

/**
 * 资料读到后才创建草稿，避免空表单覆盖已保存配置。
 * @param props 公开配置、角色图片、读取及草稿保护操作
 * @returns 模型设置页面或明确的读取状态
 */
export default function ModelSettingsPage(props: ModelSettingsPageProps) {
  useEffect(() => { if (!props.overview && props.leaving) props.onLeave() }, [props.overview, props.leaving, props.onLeave])
  if (!props.overview) return <div className={styles.empty}><h1>模型与连接</h1>
    <p>{props.loadError ? modelSettingsMessage(props.loadError) : '正在读取模型配置…'}</p>
    {props.loadError ? <button type="button" onClick={() => void props.reload()}>重新读取</button> : null}</div>
  return <ModelConnectionForm {...props} overview={props.overview} />
}

/** 表单里的数字暂存为文字，允许用户先删掉旧数字，再输入新的容量。 */
type ConnectionDraft = Omit<ModelConnection, 'contextWindowTokens' | 'outputReserveTokens'> & {
  contextWindowTokens: string; outputReserveTokens: string
}

/** 把已保存的公开配置转换成可逐字编辑的表单。 */
function toDraft(connection: ModelConnection): ConnectionDraft {
  return { ...connection, contextWindowTokens: String(connection.contextWindowTokens), outputReserveTokens: String(connection.outputReserveTokens) }
}

/** 仅在配置已读取后挂载，页面切换与保存请求分别保护草稿和重复点击。 */
function ModelConnectionForm(props: ModelSettingsPageProps & { overview: ModelSettingsOverview }) {
  const [draft, setDraft] = useState(() => toDraft(props.overview.settings?.connection ?? DEFAULT_MODEL_CONNECTION))
  const [saved, setSaved] = useState(draft)
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [busy, setBusy] = useState<'save' | 'delete' | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [deleteOpen, setDeleteOpen] = useState(false)
  const operation = useRef(false)
  const requestId = useRef<string | null>(null)
  const keyInput = useRef<HTMLInputElement>(null)
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved) || apiKey !== ''
  const hasCredential = !!props.overview.settings?.credentialRef
  const portrait = assetUrl(props.character?.portraitImagePath)
  const blocked = props.loadError !== null

  useEffect(() => {
    if (!props.leaving) return
    if (busy) { setError('正在处理，请稍候再离开。'); props.onStay() }
    else if (!dirty) props.onLeave()
  }, [props.leaving, busy, dirty, props.onLeave, props.onStay])

  /** 改了内容就换保存编号，只有同一份内容的重试才沿用原编号。 */
  function edit(next: ConnectionDraft): void {
    setDraft(next); requestId.current = null; setError(''); setNotice('')
  }

  /** 取消只清除本页草稿和新输入密钥，已保存的凭据不受影响。 */
  function discard(): void {
    setDraft(saved); setApiKey(''); requestId.current = null; setError(''); setNotice('已取消修改。')
  }

  /** 校验、保存并等待主进程确认；成功后清除窗口中的新密钥。 */
  async function save(): Promise<boolean> {
    if (operation.current || blocked || !window.appApi) return false
    const connection = modelConnectionSchema.safeParse({ ...draft,
      contextWindowTokens: Number(draft.contextWindowTokens), outputReserveTokens: Number(draft.outputReserveTokens) })
    if (!connection.success) { setError('请填写有效的模型名称、服务地址和容量；回复预留必须小于模型总容量。'); return false }
    operation.current = true; setBusy('save'); setError(''); setNotice('')
    requestId.current ??= crypto.randomUUID()
    try {
      const result = await window.appApi.saveModelSettings({ requestId: requestId.current, connection: connection.data,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) })
      if (!result.ok || !result.data) { setError(modelSettingsMessage(result.code)); await props.reload(); return false }
      const next = toDraft(result.data.settings!.connection)
      setDraft(next); setSaved(next); setApiKey(''); requestId.current = null
      setNotice(result.data.ready ? '配置已保存，后续请求使用当前配置。' : '配置已保存，请测试连接后开始聊天。')
      await props.reload()
      return true
    } catch { setError('保存尚未确认，请重试；填写内容仍保留。'); return false }
    finally { operation.current = false; setBusy(null) }
  }

  /** 只有主进程确认运行已停止且凭据已清理，才显示删除完成。 */
  async function remove(): Promise<void> {
    if (operation.current || !window.appApi) return
    operation.current = true; setBusy('delete'); setError(''); setNotice('')
    try {
      const result = await window.appApi.deleteModelCredential()
      if (!result.ok) { setError(modelSettingsMessage(result.code)); return }
      setApiKey(''); setDeleteOpen(false); setNotice('凭据已删除。本地聊天、记忆和人设仍保留。')
    } catch { setError('删除尚未完成，请重试。') }
    finally { operation.current = false; setBusy(null); await props.reload() }
  }

  const storageText = props.overview.credentialStorage === 'encrypted' ? '已加密保存到本机'
    : props.overview.credentialStorage === 'memory' ? '仅保存在本次内存中，退出后需重新填写'
      : props.overview.credentialStorage === 'unavailable' ? '已保存凭据暂不可读取，请重新填写' : '尚未配置 API 凭据'

  return <div className={styles.layout}>
    <nav className={styles.sections} aria-label="软件设置"><span className={styles.sectionActive}>◇<span>模型与连接</span></span></nav>
    <section className={styles.content} aria-label="模型与连接">
      <header className={styles.heading}><div><h1>模型与连接</h1><p>选择回复所用的模型，并安全保存凭据。</p></div>
        {dirty ? <span className={styles.unsaved}>未保存</span> : null}</header>
      <form onSubmit={(event) => { event.preventDefault(); void save() }}>
        <fieldset disabled={busy !== null || blocked} className={styles.fields}>
          <section className={styles.card}><h2><span aria-hidden="true">◇</span>模型配置</h2>
            <label className={styles.row}><span>供应商</span><select value={draft.provider} onChange={(event) => {
              setApiKey(''); edit(event.target.value === 'zhipu' ? toDraft(DEFAULT_MODEL_CONNECTION)
                : { provider: 'openai-compatible', model: '', baseUrl: '', contextWindowTokens: '', outputReserveTokens: '' })
            }}><option value="zhipu">智谱 · OpenAI 兼容接口</option><option value="openai-compatible">自定义兼容服务</option></select></label>
            <label className={styles.row}><span>模型</span><input value={draft.model} autoComplete="off" placeholder="填写服务商的模型名称"
              onChange={(event) => edit({ ...draft, model: event.target.value, contextWindowTokens: '', outputReserveTokens: '' })} /></label>
            <label className={styles.row}><span>服务地址</span><input value={draft.baseUrl} type="url" autoComplete="off" placeholder="https://api.example.com/v1"
              onChange={(event) => edit({ ...draft, baseUrl: event.target.value })} /></label>
            <details className={styles.capacity} open={!draft.contextWindowTokens || !draft.outputReserveTokens}>
              <summary>模型容量与回复预留</summary><p>按服务商说明填写，单位为 token。回复预留用于给回答留出空间。</p>
              <label className={styles.row}><span>模型总容量</span><input type="number" min="1" step="1" value={draft.contextWindowTokens}
                onChange={(event) => edit({ ...draft, contextWindowTokens: event.target.value })} /></label>
              <label className={styles.row}><span>回复预留</span><input type="number" min="1" step="1" value={draft.outputReserveTokens}
                onChange={(event) => edit({ ...draft, outputReserveTokens: event.target.value })} /></label>
            </details>
          </section>
          <section className={styles.card}><h2><span aria-hidden="true">⚿</span>API 凭据</h2>
            <label className={styles.row}><span>API 密钥</span><span className={styles.keyField}>
              <input ref={keyInput} type={showKey ? 'text' : 'password'} value={apiKey} autoComplete="off" spellCheck={false}
                placeholder={hasCredential ? '••••••••••••' : '请输入你的 API 密钥'} onChange={(event) => {
                  setApiKey(event.target.value); requestId.current = null; setError(''); setNotice('')
                }} /><button type="button" onClick={() => setShowKey(!showKey)} aria-label={showKey ? '隐藏新输入的密钥' : '显示新输入的密钥'}>{showKey ? '隐藏' : '显示'}</button>
            </span></label>
            <p className={styles.storage}>{storageText}</p>
            {hasCredential ? <div className={styles.actions}><button type="button" onClick={() => keyInput.current?.focus()}>更换凭据</button>
              <button type="button" className={styles.danger} onClick={() => setDeleteOpen(true)}>删除凭据</button></div> : null}
            <div className={styles.cardFooter}><p>凭据不会写入聊天、备份或日志。<br />已保存的密钥不会显示，留空可沿用。</p>
              <button type="submit" className={styles.primary}>{busy === 'save' ? '正在保存…' : '保存配置'}</button></div>
          </section>
        </fieldset>
      </form>
      <section className={styles.card}><h2><span aria-hidden="true">↔</span>连接测试</h2>
        <p className={styles.status}>{props.overview.ready ? '连接正常 · 支持工具调用' : hasCredential ? '配置已保存，尚未通过连接测试' : '尚未配置模型'}</p>
        <p className={styles.hint}>模型回复和记忆整理会联网。连接测试也可能产生用量。</p></section>
      {error || props.loadError || props.overview.code ? <p className={styles.error} role="alert">{error || modelSettingsMessage(props.loadError ?? props.overview.code)}</p> : null}
      {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
      <div className={styles.actions}><button type="button" disabled={!dirty || busy !== null} onClick={discard}>取消修改</button>
        {blocked ? <button type="button" onClick={() => void props.reload()}>重新读取</button> : null}</div>
    </section>
    <aside className={styles.art} aria-label="陪伴角色">{portrait ? <img src={portrait} alt={`${props.character?.name}立绘`} /> : <span className={styles.avatar}>{props.character?.name.slice(0, 1) ?? '伴'}</span>}
      <div><strong>{props.character?.name ?? '桌面陪伴'}</strong><p>准备好后，<br />接着上次的话题聊。</p></div></aside>
    {deleteOpen ? <ConfirmationDialog title="删除 API 凭据？" onCancel={() => { if (!busy) setDeleteOpen(false) }}
      actions={<><button disabled={busy !== null} onClick={() => setDeleteOpen(false)}>取消</button>
        <button className={styles.danger} disabled={busy !== null} onClick={() => void remove()}>{busy === 'delete' ? '正在删除…' : '删除凭据'}</button></>}>
      <p>删除后无法请求模型；已有本地聊天记录仍可查看。</p><p>不会删除聊天、记忆和人设。</p>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}</ConfirmationDialog> : null}
    {props.leaving && dirty && !busy ? <ConfirmationDialog title="模型配置尚未保存" onCancel={props.onStay}
      actions={<><button onClick={props.onStay}>继续编辑</button><button onClick={() => { discard(); props.onLeave() }}>放弃修改</button>
        <button className={styles.primary} onClick={() => void save().then((ok) => { if (ok) props.onLeave(); else props.onStay() })}>保存并离开</button></>}>
      <p>离开前保存配置，或放弃本次填写。</p></ConfirmationDialog> : null}
  </div>
}
