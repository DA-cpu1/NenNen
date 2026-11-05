/** 记忆页提供筛选、选中记录的详情，以及纠正或忘记操作。 */
import { useEffect, useRef, useState } from 'react'
import type { ChatSourceLocation } from '../../shared/chat-history'
import type { ManagedMemory, MemoryChange, MemoryDeletionPreview, MemoryManagementOverview, MemoryScope } from '../../shared/memory-management'
import ConfirmationDialog from '../settings/ConfirmationDialog'
import styles from './MemoryPage.module.css'

const kinds: Record<ManagedMemory['kind'], string> = {
  fact: '事实', preference: '偏好', episode: '共同经历', temporary: '近期状态', interaction_request: '相处方式',
}
const statuses = { active: '有效', superseded: '已替代', expired: '已过期' }
const statusFilters = ['all', 'active', 'superseded', 'expired'] as const
const timeFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
const failureMessages: Record<string, string> = {
  STALE_REVISION: '这条记忆刚刚有变化，已重新读取。请核对后再操作。',
  NOT_FOUND: '这条记忆已找不到，请重新读取列表。',
  MEMORY_CLEANUP_FAILED: '记忆已经更新，但本地清理未完成。请重试清理。',
  MEMORY_CLEANUP_PENDING: '本地正在清理上一项变更，请稍后再试。',
  SOURCE_PREVIEW_CHANGED: '相关原话有变化，请重新查看删除范围。',
}
const sourceRoles: Record<string, string> = { user: '你', assistant: '角色', system: '系统' }
const origins: Record<string, string> = { user_edit: '用户编辑', user_explicit: '用户明确交代', conversation_event: '聊天整理' }

type Selection = { memory: ManagedMemory; action: 'correct' | 'forget' }
type DeletionReview = 'loading' | 'failed' | MemoryDeletionPreview | null
type ForgetFeedback = { phase: 'working' | 'failed' | 'done'; title: string; message: string }

interface MemoryPageProps {
  characterId?: string
  characterName?: string
  onHistoryChanged: () => void
  onOpenSource: (source: ChatSourceLocation) => void
}

/** 用替代关系串起新旧值，不靠文字猜测哪些记录属于同一次改动。 */
function memoryHistory(memory: ManagedMemory, memories: ManagedMemory[]): ManagedMemory[] {
  const versions = new Map(memories.map((row) => [row.id, row]))
  const successors = new Map<string, ManagedMemory[]>()
  for (const row of memories) {
    if (!row.supersedesId) continue
    const newer = successors.get(row.supersedesId) ?? []
    newer.push(row)
    successors.set(row.supersedesId, newer)
  }
  const history = new Set<ManagedMemory>([versions.get(memory.id) ?? memory])
  // 往两个方向找，用户点中旧值时也看得见后续版本。已看过的记录只加入一次。
  for (const row of history) {
    const previous = row.supersedesId && versions.get(row.supersedesId)
    if (previous) history.add(previous)
    for (const newer of successors.get(row.id) ?? []) history.add(newer)
  }
  return [...history].sort((a, b) => b.validFrom - a.validFrom)
}

/** 展示选中记录的详情与历史，操作目标始终是当前选中的记录。 */
function MemoryDetail({ memory, memories, privateScope, busy, onSelect, onOpenSource }: {
  memory: ManagedMemory
  memories: ManagedMemory[]
  privateScope: string
  busy: boolean
  onSelect: (memory: ManagedMemory, action: Selection['action']) => void
  onOpenSource: MemoryPageProps['onOpenSource']
}) {
  const history = memoryHistory(memory, memories)
  const previous = history.find((row) => row.id === memory.supersedesId)
  return <aside className={styles.detail} aria-labelledby="memory-detail-title">
    <header className={styles.detailHeader}>
      <h2 id="memory-detail-title">记忆详情</h2>
      <span className={styles.state} data-state={memory.status}>{statuses[memory.status]}</span>
    </header>
    <p className={styles.content}>{memory.content}</p>
    <dl className={styles.metadata}>
      <dt>使用范围</dt><dd>{memory.scope === 'global' ? '用户明确共享' : privateScope}</dd>
      <dt>记录时间</dt><dd>{timeFormat.format(memory.validFrom)}</dd>
      <dt>更新时间</dt><dd>{timeFormat.format(memory.updatedAt)}</dd>
      <dt>记录方式</dt><dd>{origins[memory.origin] ?? '已保存'}</dd>
      {previous ? <><dt>替代了</dt><dd>{previous.content}</dd></> : null}
      {memory.expiresAt !== null ? <><dt>有效期至</dt><dd>{timeFormat.format(memory.expiresAt)}</dd></> : null}
    </dl>
    <section className={styles.detailSection}>
      <h3>来源</h3>
      {memory.sources.length ? <div className={styles.sources}>
        {memory.sources.map((source) => <blockquote key={source.id}>
          <p>{source.content}</p>
          <footer>{timeFormat.format(source.createdAt)}{source.excluded ? ' · 已停止用作聊天背景' : ''}</footer>
          {source.location ? <button type="button" className={styles.button} disabled={busy}
            onClick={() => { if (source.location) onOpenSource(source.location) }}>跳到原聊天</button> : null}
        </blockquote>)}
      </div> : <p className={styles.date}>无关联聊天原话</p>}
    </section>
    <section className={styles.detailSection}>
      <h3>历史变化</h3>
      <ol className={styles.timeline}>
        {history.map((row) => <li key={row.id}>
          <time dateTime={new Date(row.validFrom).toISOString()}>{timeFormat.format(row.validFrom)}</time>
          <p>{row.supersedesId ? '更新为' : '首次记录'} · {row.content}</p>
        </li>)}
      </ol>
    </section>
    <div className={styles.actions}>
      {memory.status === 'active' ? <button type="button" className={styles.primary} disabled={busy}
        onClick={() => onSelect(memory, 'correct')}>编辑纠正</button> : null}
      <button type="button" className={styles.danger} disabled={busy} onClick={() => onSelect(memory, 'forget')}>忘记此信息…</button>
    </div>
  </aside>
}

/**
 * 渲染正式角色的记忆手记，管理操作通过应用的受信通道交给后台。
 * @param props 当前角色用于显示；操作成功或待清理时通知聊天页重读历史
 * @returns 列表、来源和确认框
 */
export default function MemoryPage({ characterId, characterName, onHistoryChanged, onOpenSource }: MemoryPageProps) {
  const [overview, setOverview] = useState<MemoryManagementOverview | null>(null)
  const [filter, setFilter] = useState<typeof statusFilters[number]>('all')
  const [category, setCategory] = useState('all')
  const [query, setQuery] = useState('')
  const [detailId, setDetailId] = useState<string | null>(null)
  const [sharedView, setSharedView] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [createScope, setCreateScope] = useState<MemoryScope | null>(null)
  const [createRequestId, setCreateRequestId] = useState<string | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [deletionReview, setDeletionReview] = useState<DeletionReview>(null)
  const [draft, setDraft] = useState('')
  const [conflictChoice, setConflictChoice] = useState<'keep' | 'replace' | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [forgetFeedback, setForgetFeedback] = useState<ForgetFeedback | null>(null)
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
      if (current === readGeneration.current) {
        setOverview(response.data)
        return response.data
      }
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
    setConflictChoice(null)
    setNotice(null)
    setForgetFeedback(null)
    setError(null)
    previousRequest.current = null
  }

  /** 新资料每次都从空白范围开始，由用户明确选择可使用的角色。 */
  function openCreate(): void {
    setCreateOpen(true)
    setCreateScope(null)
    setCreateRequestId(null)
    setDraft('')
    setNotice(null)
    setError(null)
  }

  /** 一旦提交，重试继续使用原编号和范围，防止同一份资料被保存两次。 */
  async function saveMaterial(): Promise<void> {
    const content = draft.trim()
    if (!createScope || !content || saving.current) return
    const requestId = createRequestId ?? crypto.randomUUID()
    saving.current = true
    setCreateRequestId(requestId)
    setBusy(true)
    setError(null)
    try {
      const result = await window.appApi?.changeMemory({ action: 'create', content, scope: createScope, requestId })
      if (result?.ok && result.data?.receipt) {
        setCreateOpen(false)
        setNotice(createScope === 'global' ? '共享资料已保存。' : '已保存为当前角色的私有记忆。')
      } else {
        setError(failureMessages[result?.code ?? ''] ?? '暂时无法确认保存结果，请重试。')
      }
    } catch {
      setError('暂时无法确认保存结果，请重试。')
    } finally {
      onHistoryChanged()
      await read()
      saving.current = false
      setBusy(false)
    }
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
    if (action === 'forget') {
      // 刚提交的内容可能已经删了，等后台重读结果前不再渲染旧列表和确认原话。
      readGeneration.current++
      setOverview(null)
      setForgetFeedback({
        phase: 'working', title: '正在处理',
        message: deletion ? '正在清理记忆、相关聊天原文和本地缓存…' : '正在清理记忆和本地缓存…',
      })
    }
    let reloaded = false
    try {
      const result = await window.appApi?.changeMemory(change)
      if (result?.ok && result.data?.receipt) {
        const receipt = result.data.receipt
        const persona = receipt.personaContainsContent ? ' 角色设定里还有相同文字，可以在角色设置里修改。' : ''
        if (action === 'correct') setNotice(sharedView ? '共享资料已更新。' : '记忆已纠正，原来的值可在「已替代」中查看。')
        else setForgetFeedback({
          phase: 'done', title: sharedView ? '共享资料已删除' : receipt.removedSources ? '已忘记，相关聊天原文已删除' : '已忘记此信息',
          message: (receipt.removedSources ? `已删除 ${receipt.removedSources} 条聊天原文，本地缓存已清理。`
            : deletion ? '本地缓存已清理。该记忆没有关联原话。' : '本地缓存已清理，聊天原文仍保留。') + persona,
        })
        setSelection(null)
        setDeletionReview(null)
      } else {
        const code = result?.code ?? ''
        if (action === 'correct' && code === 'STALE_REVISION') {
          // 冲突时保留草稿，但只允许针对最新有效版本重新选择。
          const fresh = await read()
          reloaded = true
          const latest = fresh && memoryHistory(memory, fresh.memories).find((row) =>
            row.status === 'active' && (row.id !== memory.id || row.revision !== memory.revision))
          if (latest) {
            setSelection({ memory: latest, action })
            setConflictChoice('keep')
          } else {
            setSelection(null)
            setError('这条记忆已过期、被忘记或无法重新读取。请刷新列表后核对。')
          }
        } else if (action === 'forget' && !['STALE_REVISION', 'NOT_FOUND', 'SOURCE_PREVIEW_CHANGED'].includes(code)) {
          setForgetFeedback({ phase: 'failed', title: '尚未完成忘记',
            message: failureMessages[code] ?? '暂时无法确认清理结果，请重试。' })
        } else {
          setForgetFeedback(null)
          setError(failureMessages[code] ?? '暂时无法确认操作结果，请重试。')
          if (['MEMORY_CLEANUP_FAILED', 'STALE_REVISION', 'NOT_FOUND'].includes(code)) setSelection(null)
          if (code === 'SOURCE_PREVIEW_CHANGED') setDeletionReview('failed')
        }
      }
    } catch {
      if (action === 'forget') setForgetFeedback({ phase: 'failed', title: '尚未完成忘记', message: '暂时无法确认清理结果，请重试。' })
      else setError('暂时无法确认操作结果，请重试。')
    } finally {
      onHistoryChanged()
      if (!reloaded) await read()
      saving.current = false
      setBusy(false)
    }
  }

  /** 关闭结果时丢掉本次确认内容，已清理的正文不会在下一次打开时出现。 */
  function closeForgetFeedback(): void {
    if (busy) return
    setForgetFeedback(null)
    setSelection(null)
    setDeletionReview(null)
    setDraft('')
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
  const keyword = query.trim().toLocaleLowerCase('zh-CN')
  const counts = { all: memories.length, active: 0, superseded: 0, expired: 0 }
  const shown = memories.filter((memory) => {
    counts[memory.status]++
    return (filter === 'all' || memory.status === filter) &&
      (category === 'all' || memory.kind === category) &&
      memory.content.toLocaleLowerCase('zh-CN').includes(keyword)
  })
  const detail = shown.find((memory) => memory.id === detailId) ?? shown[0]
  const shared = memories.filter((memory) => memory.scope === 'global' && memory.status === 'active')
  const privateScope = characterName ? `仅${characterName}可用` : '仅当前角色可用'
  const deletion = typeof deletionReview === 'object' ? deletionReview : null
  const dialogBusy = busy || deletionReview === 'loading'

  return <section className={styles.page} aria-labelledby="memory-title">
    <header className={styles.header}>
      <span className={styles.eyebrow}>{characterName ? `${characterName}的手记` : '角色手记'}</span>
      <div className={styles.headerRow}>
        <h1 id="memory-title">{sharedView ? '共享资料' : '记忆'}</h1>
        <div className={styles.actions}>
          <button type="button" className={styles.button} disabled={busy}
            onClick={() => { setSharedView(!sharedView); setNotice(null) }}>{sharedView ? '返回记忆' : '共享资料'}</button>
          {sharedView ? <button type="button" className={styles.primary} disabled={busy || loading}
            onClick={openCreate}>新增资料…</button> : null}
        </div>
      </div>
      <p>{sharedView ? '角色可以使用你明确共享的资料。聊天记录和私有记忆仍各自独立。'
        : '看看角色记下了什么。你可以查看原话、纠正旧信息，或让角色忘记一条记忆。'}</p>
    </header>
    {!sharedView ? <>
    <div className={styles.search}>
      <input type="search" aria-label="搜索记忆内容" placeholder="搜索记忆内容"
        value={query} onChange={(event) => setQuery(event.target.value)} />
      <select aria-label="记忆类别" value={category} onChange={(event) => setCategory(event.target.value)}>
        <option value="all">全部类别</option>
        {Object.entries(kinds).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
      </select>
    </div>
    <div className={styles.filters} role="group" aria-label="记忆状态">
      {statusFilters.map((status) => <button key={status} type="button" aria-pressed={filter === status} onClick={() => setFilter(status)}>
        {status === 'all' ? '全部' : statuses[status]} <span>{counts[status]}</span>
      </button>)}
      <button className={styles.refresh} type="button" disabled={loading || busy} onClick={() => { setError(null); void read() }}>刷新</button>
    </div>
    </> : null}
    <div className={styles.scroll} aria-busy={loading || busy}>
      {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
      {error && !selection && !createOpen ? <p className={styles.error} role="alert">{error}</p> : null}
      {overview?.cleanupPending ? <div className={styles.cleanup}>
        <p>还有本地缓存待清理，相关聊天会暂时停用。</p>
        <button type="button" className={styles.button} disabled={busy} onClick={() => void retryCleanup()}>重试清理</button>
      </div> : null}
      {loading && !overview ? <p role="status" className={styles.empty}>正在读取记忆…</p> : null}
      {!loading && overview && sharedView && shared.length === 0 ? <div className={styles.empty}>
        <h2>还没有共享资料</h2>
        <p>你明确共享的资料会出现在这里。</p>
      </div> : null}
      {sharedView && shared.length > 0 ? <ol className={styles.list} aria-label="共享资料列表">
        {shared.map((memory) => <li key={memory.id} className={styles.sharedItem}>
          <p className={styles.content}>{memory.content}</p>
          <span className={styles.kind}>用户明确共享</span>
          <time className={styles.date} dateTime={new Date(memory.updatedAt).toISOString()}>{timeFormat.format(memory.updatedAt)}</time>
          <div className={styles.actions}>
            <button type="button" className={styles.button} disabled={busy} onClick={() => select(memory, 'correct')}>编辑</button>
            <button type="button" className={styles.danger} disabled={busy} onClick={() => select(memory, 'forget')}>删除…</button>
          </div>
        </li>)}
      </ol> : null}
      {!sharedView && !loading && overview && shown.length === 0 ? <div className={styles.empty}>
        {memories.length === 0 ? <>
          <h2>还没有记忆</h2>
          <p>正式聊天里保存的记忆会出现在这里。</p>
        </> : <>
          <h2>没有找到相关记忆</h2>
          <p>试试换个关键词，或调整筛选条件。</p>
          <button type="button" className={styles.button} onClick={() => { setQuery(''); setCategory('all'); setFilter('all') }}>
            清除筛选
          </button>
        </>}
      </div> : null}
      {!sharedView && detail ? <div className={styles.workspace}>
        <ol className={styles.list} aria-label="记忆列表">
          {shown.map((memory) => <li key={memory.id}>
            <button type="button" className={styles.card} aria-pressed={detail.id === memory.id} onClick={() => setDetailId(memory.id)}>
              <span className={styles.cardText}>{memory.content}</span>
              <span className={styles.kind}>{kinds[memory.kind]}</span>
              <span className={styles.cardScope}>{memory.scope === 'global' ? '共享资料' : privateScope}</span>
              <span className={styles.state} data-state={memory.status}>{statuses[memory.status]}</span>
            </button>
          </li>)}
        </ol>
        <MemoryDetail memory={detail} memories={memories} privateScope={privateScope} busy={busy}
          onSelect={select} onOpenSource={onOpenSource} />
      </div> : null}
    </div>
    {createOpen ? <ConfirmationDialog title="新增资料" onCancel={() => { if (!busy) setCreateOpen(false) }} actions={<>
      <button type="button" className={styles.button} disabled={busy} onClick={() => setCreateOpen(false)}>关闭</button>
      <button type="button" className={styles.primary} disabled={busy || !draft.trim() || !createScope}
        onClick={() => void saveMaterial()}>{error && createRequestId ? '重试' : createScope === 'global' ? '确认共享' : '保存资料'}</button>
    </>}>
      <label className={styles.edit}>资料内容
        <textarea rows={4} maxLength={400} value={draft} disabled={createRequestId !== null}
          onChange={(event) => setDraft(event.target.value)} />
      </label>
      <fieldset className={styles.choices} disabled={createRequestId !== null}>
        <legend>使用范围</legend>
        <label><input type="radio" name="memory-scope" checked={createScope === 'character'}
          onChange={() => setCreateScope('character')} />{privateScope}</label>
        <label><input type="radio" name="memory-scope" checked={createScope === 'global'}
          onChange={() => setCreateScope('global')} />用户明确共享</label>
      </fieldset>
      <p>共享后，角色可以使用这条资料。聊天记录和其他私有记忆仍各自独立。</p>
      {busy ? <p role="status">正在保存资料…</p> : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </ConfirmationDialog> : null}
    {forgetFeedback ? <ConfirmationDialog title={forgetFeedback.title} onCancel={closeForgetFeedback} actions={<>
      {forgetFeedback.phase === 'working' ? <button type="button" className={styles.button} disabled>处理中…</button>
        : forgetFeedback.phase === 'done' ? <button type="button" className={styles.primary} disabled={busy}
          onClick={closeForgetFeedback}>完成</button>
        : <>
          <button type="button" className={styles.button} disabled={busy} onClick={closeForgetFeedback}>关闭</button>
          <button type="button" className={styles.primary} disabled={busy} onClick={() => void save(deletion ?? undefined)}>重试</button>
        </>}
    </>}>
      <div className={styles.feedback} data-phase={forgetFeedback.phase}
        role={forgetFeedback.phase === 'failed' ? 'alert' : 'status'}>
        <p>{forgetFeedback.message}</p>
        {forgetFeedback.phase === 'failed' ? <p>重试会继续原操作，已保存的部分不会重复写入。</p> : null}
      </div>
    </ConfirmationDialog> : selection ? <ConfirmationDialog title={selection.action === 'correct' ? conflictChoice ? '这条记忆已有更新'
      : sharedView ? '编辑共享资料' : '纠正这条记忆'
      : sharedView ? '删除这条共享资料？' : deletionReview ? '忘记并删除相关原文？' : '忘记这条记忆？'}
      onCancel={() => { if (!dialogBusy) { setSelection(null); setDeletionReview(null) } }} actions={<>
        <button type="button" className={styles.button} disabled={dialogBusy}
          onClick={() => { setSelection(null); setDeletionReview(null) }}>取消</button>
        {selection.action === 'correct' ? <button type="button" className={styles.primary}
          disabled={busy || (conflictChoice !== 'keep' && (!draft.trim() || draft.trim() === selection.memory.content))}
          onClick={() => { if (conflictChoice === 'keep') setSelection(null); else void save() }}>
          {conflictChoice ? '确认选择' : '保存纠正'}
        </button>
          : sharedView ? <button type="button" className={styles.danger} disabled={busy} onClick={() => void save()}>删除共享资料</button>
          : deletion ? <button type="button" className={styles.danger} disabled={busy}
            onClick={() => void save(deletion)}>确认忘记并删除</button>
          : deletionReview ? <button type="button" className={styles.button} disabled={dialogBusy}
            onClick={() => void reviewDeletion()}>重新查看删除范围</button>
          : <>
            <button type="button" className={styles.button} disabled={busy} onClick={() => void save()}>忘记此信息（聊天原文仍保留）</button>
            <button type="button" className={styles.danger} disabled={busy} onClick={() => void reviewDeletion()}>查看并删除相关原文…</button>
          </>}
      </>}>
      {selection.action === 'correct' ? <>
        <div className={styles.comparison}>
          <div><strong>当前内容</strong><p className={styles.target}>{selection.memory.content}</p></div>
          {conflictChoice ? <div><strong>本次填写</strong><p className={styles.target}>{draft.trim()}</p></div>
            : <label className={styles.edit}>改为
              <textarea rows={4} maxLength={400} value={draft} disabled={busy} onChange={(event) => setDraft(event.target.value)} />
            </label>}
        </div>
        {conflictChoice ? <fieldset className={styles.choices} disabled={busy}>
          <legend>请选择要保留的内容</legend>
          <label><input type="radio" name="memory-conflict" checked={conflictChoice === 'keep'}
            onChange={() => setConflictChoice('keep')} />保留当前内容</label>
          <label><input type="radio" name="memory-conflict" checked={conflictChoice === 'replace'}
            disabled={draft.trim() === selection.memory.content} onChange={() => setConflictChoice('replace')} />改用本次填写</label>
        </fieldset> : <p>保存后会保留旧记录，并让新内容生效。</p>}
        <p>{selection.memory.scope === 'global' ? '用户明确共享' : privateScope}</p>
      </> : <>
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
        <p>{sharedView ? '聊天原文仍保留。早先已导出的备份仍可能包含这些资料。'
          : '选择删除原文会把对应消息从聊天记录移除。早先已导出的备份仍可能包含这些原话。'}</p>
        {selection.memory.scope === 'global' ? <p>这是共享资料，忘记后会影响可使用它的角色。</p> : null}
      </>}
      {busy ? <p role="status">正在保存并清理本地上下文…</p> : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </ConfirmationDialog> : null}
  </section>
}
