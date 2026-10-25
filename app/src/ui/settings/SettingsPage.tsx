/**
 * 角色设置页：在内存中编辑现有设定的副本，明确保存后才写库。
 * 保存失败保留草稿；同一内容的重试沿用请求编号，避免重复生成版本。
 */
import { useEffect, useRef, useState } from 'react'
import type { CharacterProps } from '../App'
import { bodyFromDraft, draftFromCharacter, validateDraft, type CharacterDraft } from './character-draft'
import PersonaFields from './PersonaFields'
import ExamplesEditor from './ExamplesEditor'
import ConfirmationDialog from './ConfirmationDialog'
import styles from './SettingsPage.module.css'

interface SettingsProps extends CharacterProps {
  leaving: boolean
  onLeave: () => void
  onStay: () => void
}

/**
 * 资料读到后才创建表单，避免用空白初值盖掉用户已有的设定。
 * @param props 角色概览、读取状态与重读函数
 * @returns 角色表单或加载失败说明
 */
export default function SettingsPage(props: SettingsProps) {
  // 没有表单就没有待保护的草稿，允许用户从加载失败页返回聊天。
  useEffect(() => { if (!props.character && props.leaving) props.onLeave() }, [props.character, props.leaving, props.onLeave])
  if (!props.character) return <div className={styles.empty}>
    <h1>角色设置</h1>
    <p>{props.loadError ? '角色资料读取失败，请重试。' : '正在读取角色资料…'}</p>
    {props.loadError && <button onClick={() => void props.reload()}>重新读取</button>}
  </div>
  return <CharacterEditor key={props.character.characterId} {...props} character={props.character} />
}

/** 资料就绪后的编辑器；草稿初值来自当前生效版本。 */
function CharacterEditor({ character, reload, loadError, leaving, onLeave, onStay }: SettingsProps & { character: NonNullable<CharacterProps['character']> }) {
  const [draft, setDraft] = useState(() => draftFromCharacter(character))
  const [savedDraft, setSavedDraft] = useState(() => draftFromCharacter(character))
  const [tab, setTab] = useState<'basic' | 'examples' | 'versions'>('basic')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const [cancelRequested, setCancelRequested] = useState(false)
  const [activateNo, setActivateNo] = useState<number | null>(null)
  // ref 是跨渲染保留的小盒子：连点发生在按钮来得及变灰前，也只能发一次请求。
  const operationRunning = useRef(false)
  const saveRequest = useRef<{ content: string; id: string } | null>(null)
  const dirty = JSON.stringify(draft) !== JSON.stringify(savedDraft)
  // 共享的读取错误跨页面保留：离开再回来也不能拿过期概览继续覆盖当前版本。
  const blocked = needsRefresh || loadError !== null

  useEffect(() => {
    if (!leaving) return
    if (busy) { setError('正在保存，请稍候再离开。'); onStay() }
    else if (!dirty) onLeave()
  }, [leaving, busy, dirty, onLeave, onStay])

  /** 修改后的内容是新请求；保持同一内容时失败重试才复用原编号。 */
  function changeDraft(next: CharacterDraft): void {
    if (JSON.stringify(next) === JSON.stringify(draft)) return
    setDraft(next)
    saveRequest.current = null
    setError('')
    setNotice('')
  }

  /** 只恢复内存草稿，不改正式版本。 */
  function discard(): void {
    setDraft(savedDraft)
    saveRequest.current = null
    setError('')
    setNotice('已取消修改。')
    setCancelRequested(false)
  }

  /**
   * 等后台确认成功才报告保存；读取刷新失败与保存失败分开，避免误导重试。
   * @returns 是否已经保存成功；保存并离开仅在 true 时切页
   */
  async function save(): Promise<boolean> {
    if (operationRunning.current || blocked) return false
    const invalid = validateDraft(draft)
    if (invalid) { setError(invalid); return false }
    if (!window.appApi) { setError('保存通道不可用，请重新打开应用。'); return false }
    operationRunning.current = true
    setBusy(true)
    setError('')
    setNotice('')
    const content = JSON.stringify(draft)
    if (saveRequest.current?.content !== content) saveRequest.current = { content, id: crypto.randomUUID() }
    try {
      const result = await window.appApi.saveCharacterVersion(bodyFromDraft(draft, saveRequest.current.id))
      if (!result.ok || !result.data?.versionNo) {
        setError('保存未确认，请重试；草稿已保留。')
        return false
      }
      setSavedDraft(draft)
      const fresh = await reload()
      if (fresh) {
        const next = draftFromCharacter(fresh)
        setDraft(next)
        setSavedDraft(next)
        setNotice(`已保存为 v${result.data.versionNo}，从下一轮聊天生效。`)
      } else {
        setNeedsRefresh(true)
        setNotice(`v${result.data.versionNo} 已保存，但资料刷新失败，请重新读取。`)
      }
      return true
    } catch {
      setError('保存未确认，请重试；草稿已保留。')
      return false
    } finally {
      operationRunning.current = false
      setBusy(false)
    }
  }

  /**
   * 确认后切回旧版；失败时保留草稿，成功后才替换成后台读回的内容。
   * @param versionNo 要重新生效的历史版本号
   */
  async function activate(versionNo: number): Promise<void> {
    if (operationRunning.current || blocked || !window.appApi) return
    operationRunning.current = true
    setBusy(true)
    setError('')
    setNotice('')
    setActivateNo(null)
    try {
      const result = await window.appApi.activateVersion(versionNo)
      if (!result.ok) { setError('回退未确认，请重试；草稿已保留。'); return }
      saveRequest.current = null
      const fresh = await reload()
      if (fresh) {
        const next = draftFromCharacter(fresh)
        setDraft(next)
        setSavedDraft(next)
        setNotice(`已回退到 v${versionNo}，从下一轮聊天生效。`)
      } else {
        setNeedsRefresh(true)
        setNotice(`已回退到 v${versionNo}，但资料刷新失败，请重新读取后编辑。`)
      }
    } catch { setError('回退未确认，请重试；草稿已保留。') }
    finally { operationRunning.current = false; setBusy(false) }
  }

  /** 保存或回退已成功、刷新失败时，先读清当前版本再允许继续编辑。 */
  async function refresh(): Promise<void> {
    if (operationRunning.current) return
    operationRunning.current = true
    setBusy(true)
    try {
    const fresh = await reload()
    if (fresh && blocked) {
      const next = draftFromCharacter(fresh)
      setDraft(next)
      setSavedDraft(next)
      setNeedsRefresh(false)
      setNotice('已重新读取当前设定。')
    }
    } finally { operationRunning.current = false; setBusy(false) }
  }

  return <section className={styles.page}>
    <header className={styles.header}><div className={styles.cardHeader}><h1>角色设置</h1>
      <span className={styles.badge}>{blocked ? '等待重新读取' : dirty ? '有未保存的修改' : `当前 v${character.activeVersion?.versionNo ?? '—'}`}</span></div>
      <p>把性格、说话方式与相处起点写清楚。</p></header>
    <nav className={styles.tabs} aria-label="角色设置分类">
      {([['basic', '基本信息与人设'], ['examples', '情境示例'], ['versions', '人设版本']] as const).map(([id, label]) =>
        <button key={id} type="button" aria-pressed={tab === id} onClick={() => setTab(id)}>{label}</button>)}
    </nav>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {notice && <p role="status" className={styles.notice}>{notice}</p>}
    {(loadError || needsRefresh) && <p className={styles.error}>资料刷新失败。<button disabled={busy} onClick={() => void refresh()}>重新读取</button></p>}
    <fieldset className={styles.scroll} disabled={busy || blocked} aria-busy={busy}>
      {tab === 'basic' && <PersonaFields draft={draft} onChange={changeDraft} onError={setError} />}
      {tab === 'examples' && <ExamplesEditor examples={draft.dialogueExamples} onChange={(dialogueExamples) => changeDraft({ ...draft, dialogueExamples })} />}
      {tab === 'versions' && <section className={styles.card}><h2>已保存的人设版本</h2>
        <p className={styles.hint}>回退恢复人设、关系、称呼与示例；名字和图片保持当前设置。</p>
        {character.versions.map((version) => <article className={styles.version} key={version.versionNo}>
          <strong>v{version.versionNo}{version.isActive ? ' · 当前生效' : ''}</strong>
          <time>{new Date(version.createdAt).toLocaleString('zh-CN')}</time>
          {!version.isActive && <button type="button" className={styles.secondary} onClick={() => setActivateNo(version.versionNo)}>回退到 v{version.versionNo}</button>}
        </article>)}
      </section>}
    </fieldset>
    <footer className={styles.footer}><p>保存生成新版本，从下一轮聊天生效。</p><div>
      <button type="button" className={styles.secondary} disabled={busy || !dirty} onClick={() => setCancelRequested(true)}>取消修改</button>
      <button type="button" className={styles.primary} disabled={busy || blocked || !dirty} onClick={() => void save()}>{busy ? '正在处理…' : '保存人设版本'}</button>
    </div></footer>
    {(cancelRequested || (leaving && dirty && !busy)) && <ConfirmationDialog title="有未保存的修改"
      onCancel={() => { setCancelRequested(false); onStay() }}
      actions={<>
        <button autoFocus className={styles.secondary} onClick={() => { setCancelRequested(false); onStay() }}>继续编辑</button>
        <button className={styles.secondary} onClick={() => { discard(); if (leaving) onLeave() }}>放弃修改</button>
        {leaving && <button className={styles.primary} disabled={blocked} onClick={() => { onStay(); void save().then((ok) => { if (ok) onLeave() }) }}>保存并离开</button>}
      </>}><p>{leaving ? '离开前要保存这次人设修改吗？' : '放弃后将恢复为上次保存的设定。'}</p></ConfirmationDialog>}
    {activateNo !== null && <ConfirmationDialog title={`回退到 v${activateNo}？`} onCancel={() => setActivateNo(null)}
      actions={<><button autoFocus className={styles.secondary} onClick={() => setActivateNo(null)}>取消</button>
        <button className={styles.primary} onClick={() => void activate(activateNo)}>确认回退</button></>}>
      <p>将这份历史人设设为当前版本，已有聊天不重写。名字和图片保持当前设置。</p>
      {dirty && <p className={styles.error}>回退成功后将放弃当前未保存的修改。</p>}
    </ConfirmationDialog>}
  </section>
}
