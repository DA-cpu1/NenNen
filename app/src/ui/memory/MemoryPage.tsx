/** 记忆页显示当前与过去的资料，让用户核对来源并明确选择纠正或忘记范围。 */
import { useEffect, useRef, useState } from 'react'
import type { ManagedMemory, MemoryChange, MemoryDeletionPreview, MemoryManagementOverview } from '../../shared/memory-management'
import ConfirmationDialog from '../settings/ConfirmationDialog'
import styles from './MemoryPage.module.css'

const kinds: Record<ManagedMemory['kind'], string> = {
  fact: '事实', preference: '偏好', episode: '共同经历', temporary: '近期状态', interaction_request: '相处方式',
}
const statuses = { active: '生效中', superseded: '已被纠正', expired: '已过期' }
const timeFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
const failureMessages: Record<string, string> = {
  STALE_REVISION: '这条记忆刚刚有变化，已重新读取。请核对后再操作。',
  NOT_FOUND: '这条记忆已找不到，请重新读取列表。',
  MEMORY_CLEANUP_FAILED: '记忆已经更新，但本地清理未完成。请重试清理。',
  MEMORY_CLEANUP_PENDING: '本地正在清理上一项变更，请稍后再试。',
  SOURCE_PREVIEW_CHANGED: '相关原话有变化，请重新查看删除范围。',
}
const sourceRoles: Record<string, string> = { user: '你', assistant: '角色', system: '系统' }

type Selection = { memory: ManagedMemory; action: 'correct' | 'forget' }
type DeletionReview = 'loading' | 'failed' | MemoryDeletionPreview | null

interface MemoryPageProps {
  characterId?: string
  characterName?: string
  onHistoryChanged: () => void
}

/**
 * 渲染正式角色的记忆手记，管理操作通过应用的受信通道交给后台。
 * @param props 当前角色用于显示；操作成功或待清理时通知聊天页重读历史
 * @returns 列表、来源和确认框
 */
export default function MemoryPage({ characterId, characterName, onHistoryChanged }: MemoryPageProps) {
  const [overview, setOverview] = useState<MemoryManagementOverview | null>(null)
  const [filter, setFilter] = useState<'active' | 'past'>('active')
  const [selection, setSelection] = useState<Selection | null>(null)
  const [deletionReview, setDeletionReview] = useState<DeletionReview>(null)
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const readGeneration = useRef(0)
  const saving = useRef(false)
  const previousRequest = useRef<{ key: string; id: string } | null>(null)

  /** 旧窗口请求晚回来时，不能把刚更新的记录盖成旧版本。 */
  async function read() {
    const current = ++readGeneration.current
    setLoading(true)
    try {
      const response = await window.appApi?.getMemories()
      if (!response?.ok || !response.data) throw new Error('READ_FAILED')
      if (current === readGeneration.current) setOverview(response.data)
    } catch {
      if (current === readGeneration.current) setError('暂时无法读取记忆，请重试。')
    } finally {
      if (current === readGeneration.current) setLoading(false)
    }
  }

  useEffect(() => {
    setError(null)
    void read()
    return () => { readGeneration.current++ }
  }, [characterId])

  /** 打开确认框时固定记忆修订号。保存前即使后台修改了它，也不能把别人更新覆盖掉。 */
  function select(memory: ManagedMemory, action: Selection['action']): void {
    setSelection({ memory, action })
    setDeletionReview(null)
    setDraft(memory.content)
    setNotice(null)
    setError(null)
    previousRequest.current = null
  }

  /** 第一次点击只向后台读名单。用户看完完整消息后才能确认删除。 */
  async function reviewDeletion(): Promise<void> {
    if (!selection || deletionReview === 'loading') return
    const { id, revision } = selection.memory
    setDeletionReview('loading')
    setError(null)
    try {
      const result = await window.appApi?.previewMemoryDeletion({ memoryId: id, expectedRevision: revision })
      if (result?.ok && result.data) {
        setDeletionReview(result.data)
        return
      }
      if (result?.code === 'STALE_REVISION' || result?.code === 'NOT_FOUND') {
        setSelection(null)
        setError(failureMessages[result.code])
        await read()
        return
      }
    } catch { /* 读取失败仍停在确认框，用户可以重读。 */ }
    setDeletionReview('failed')
    setError('暂时无法读取将删除的原话，请重试。')
  }

  /** 同一按钮的重试沿用请求编号；改文案或换删除范围时属于另一项操作。 */
  async function save(deletion?: MemoryDeletionPreview): Promise<void> {
    if (!selection || saving.current) return
    const { memory, action } = selection
    const content = draft.trim()
    if (action === 'correct' && (!content || content === memory.content)) return
    const key = JSON.stringify([memory.id, memory.revision, action, action === 'correct' ? content : deletion?.sourceFingerprint])
    if (previousRequest.current?.key !== key) previousRequest.current = { key, id: crypto.randomUUID() }
    const base = { memoryId: memory.id, expectedRevision: memory.revision, requestId: previousRequest.current.id }
    const change: MemoryChange = action === 'correct' ? { ...base, action, content } : {
      ...base, action, deleteSources: deletion !== undefined, sourceFingerprint: deletion?.sourceFingerprint,
    }
    saving.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await window.appApi?.changeMemory(change)
      if (result?.ok && result.data?.receipt) {
        const receipt = result.data.receipt
        const scope = receipt.removedSources ? `，已删除 ${receipt.removedSources} 条聊天原文` : '，聊天原文仍保留'
        const persona = receipt.personaContainsContent ? '。角色设定里还有相同文字，可以在角色设置里修改。' : '。'
        setNotice((action === 'correct' ? '记忆已纠正，原来的值已收进「过去的记忆」' : `已忘记这条信息${scope}`) + persona)
        setSelection(null)
        setDeletionReview(null)
      } else {
        const code = result?.code ?? ''
        setError(failureMessages[code] ?? '暂时无法确认操作结果，请重试。')
        if (['MEMORY_CLEANUP_FAILED', 'STALE_REVISION', 'NOT_FOUND'].includes(code)) setSelection(null)
        if (code === 'SOURCE_PREVIEW_CHANGED') setDeletionReview('failed')
      }
    } catch {
      setError('暂时无法确认操作结果，请重试。')
    } finally {
      onHistoryChanged()
      await read()
      saving.current = false
      setBusy(false)
    }
  }

  /** 清理可以单独重试，已经保存的纠正和删除无需再执行一遍。 */
  async function retryCleanup(): Promise<void> {
    if (saving.current) return
    saving.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await window.appApi?.retryMemoryCleanup()
      if (!result?.ok) throw new Error('MEMORY_CLEANUP_FAILED')
      setNotice('本地清理完成，可以继续聊天。')
    } catch {
      setError(failureMessages.MEMORY_CLEANUP_FAILED)
    } finally {
      onHistoryChanged()
      await read()
      saving.current = false
      setBusy(false)
    }
  }

  const memories = overview?.memories ?? []
  const current = memories.filter((memory) => memory.status === 'active')
  const past = memories.filter((memory) => memory.status !== 'active')
  const shown = filter === 'active' ? current : past
  const deletion = typeof deletionReview === 'object' ? deletionReview : null
  const dialogBusy = busy || deletionReview === 'loading'

  return <section className={styles.page} aria-labelledby="memory-title">
    <header className={styles.header}>
      <span className={styles.eyebrow}>{characterName ? `${characterName}的手记` : '角色手记'}</span>
      <h1 id="memory-title">记忆</h1>
      <p>看看角色记下了什么。你可以查看原话、纠正旧信息，或让角色忘记一条记忆。</p>
    </header>
    <div className={styles.filters} aria-label="记忆时段">
      <button type="button" aria-pressed={filter === 'active'} onClick={() => setFilter('active')}>当前记忆 <span>{current.length}</span></button>
      <button type="button" aria-pressed={filter === 'past'} onClick={() => setFilter('past')}>过去的记忆 <span>{past.length}</span></button>
      <button className={styles.refresh} type="button" disabled={loading || busy} onClick={() => { setError(null); void read() }}>刷新</button>
    </div>
    <div className={styles.scroll} aria-busy={loading || busy}>
      {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
      {error && !selection ? <p className={styles.error} role="alert">{error}</p> : null}
      {overview?.cleanupPending ? <div className={styles.cleanup}>
        <p>还有本地缓存待清理，相关聊天会暂时停用。</p>
        <button type="button" className={styles.button} disabled={busy} onClick={() => void retryCleanup()}>重试清理</button>
      </div> : null}
      {loading && !overview ? <p role="status" className={styles.empty}>正在读取记忆…</p> : null}
      {!loading && overview && shown.length === 0 ? <div className={styles.empty}>
        <h2>{filter === 'active' ? '还没有当前记忆' : '还没有过去的记忆'}</h2>
        <p>{filter === 'active' ? '聊天里保存的记忆会出现在这里。' : '被纠正的旧值和过期记忆会收在这里。'}</p>
      </div> : null}
      <ol className={styles.list}>
        {shown.map((memory) => <li key={memory.id} className={styles.card}>
          <div className={styles.meta}>
            <span className={styles.kind}>{kinds[memory.kind]}</span>
            <span>{statuses[memory.status]}</span>
            {memory.scope === 'global' ? <span>共享资料</span> : null}
            <time dateTime={new Date(memory.validFrom).toISOString()}>{timeFormat.format(memory.validFrom)}</time>
          </div>
          <p className={styles.content}>{memory.content}</p>
          {memory.expiresAt !== null ? <p className={styles.date}>有效期至 {timeFormat.format(memory.expiresAt)}</p> : null}
          <div className={styles.cardFooter}>
            {memory.sources.length ? <details className={styles.sources}>
              <summary>查看原话（{memory.sources.length}）</summary>
              {memory.sources.map((source) => <blockquote key={source.id}>
                <p>{source.content}</p>
                <footer>{timeFormat.format(source.createdAt)}{source.excluded ? ' · 已停止用作聊天背景' : ''}</footer>
              </blockquote>)}
            </details> : <span className={styles.date}>无关联聊天原话</span>}
            <div className={styles.actions}>
              {memory.status === 'active' ? <button type="button" className={styles.button} disabled={busy}
                onClick={() => select(memory, 'correct')}>纠正</button> : null}
              <button type="button" className={styles.button} disabled={busy} onClick={() => select(memory, 'forget')}>忘记…</button>
            </div>
          </div>
        </li>)}
      </ol>
    </div>
    {selection ? <ConfirmationDialog title={selection.action === 'correct' ? '纠正这条记忆' :
      deletionReview ? '忘记并删除相关原文？' : '忘记这条记忆？'}
      onCancel={() => { if (!dialogBusy) { setSelection(null); setDeletionReview(null) } }} actions={<>
        <button type="button" className={styles.button} disabled={dialogBusy}
          onClick={() => { setSelection(null); setDeletionReview(null) }}>取消</button>
        {selection.action === 'correct' ? <button type="button" className={styles.primary}
          disabled={busy || !draft.trim() || draft.trim() === selection.memory.content} onClick={() => void save()}>保存纠正</button>
          : deletion ? <button type="button" className={styles.danger} disabled={busy}
            onClick={() => void save(deletion)}>确认忘记并删除</button>
          : deletionReview ? <button type="button" className={styles.button} disabled={dialogBusy}
            onClick={() => void reviewDeletion()}>重新查看删除范围</button>
          : <>
            <button type="button" className={styles.button} disabled={busy} onClick={() => void save()}>忘记此信息（聊天原文仍保留）</button>
            <button type="button" className={styles.danger} disabled={busy} onClick={() => void reviewDeletion()}>查看并删除相关原文…</button>
          </>}
      </>}>
      {selection.action === 'correct' ? <label className={styles.edit}>新的记忆内容
        <textarea rows={4} maxLength={400} value={draft} disabled={busy} onChange={(event) => setDraft(event.target.value)} />
      </label> : <>
        <p className={styles.target}>{selection.memory.content}</p>
        <p>同一信息的旧值也会忘记。相关原话将整条停止用于回复和整理，依赖这些原话的记忆也可能失效。</p>
        {deletionReview === 'loading' ? <p role="status">正在读取将删除的原话…</p> : null}
        {deletion ? <div className={styles.deletionPreview}>
          <h3>即将删除的来源消息（{deletion.sources.length} 条）</h3>
          {deletion.sources.length === 0 ? <p>没有关联原话，这次只会忘记资料。</p> : <ol aria-label="即将删除的来源消息">
            {deletion.sources.map((source) => <li key={source.id}>
              <time dateTime={new Date(source.createdAt).toISOString()}>{timeFormat.format(source.createdAt)}</time>
              <p><strong>{sourceRoles[source.role] ?? '消息'} · </strong>{source.content}</p>
            </li>)}
          </ol>}
        </div> : null}
        <p>选择删除原文会把对应消息从聊天记录移除。早先已导出的备份仍可能包含这些原话。</p>
        {selection.memory.scope === 'global' ? <p>这是共享资料，忘记后会影响可使用它的角色。</p> : null}
      </>}
      {busy ? <p role="status">正在保存并清理本地上下文…</p> : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </ConfirmationDialog> : null}
  </section>
}
