/** 基本信息和人设输入框。这里只编辑草稿，不发请求、不直接写数据库。 */
import { draftBudgetWarning, switchDraftMode, type CharacterDraft } from './character-draft'
import styles from './SettingsPage.module.css'

interface PersonaFieldsProps {
  draft: CharacterDraft
  onChange: (draft: CharacterDraft) => void
  onError: (message: string) => void
}

/**
 * 展示名字、关系、称呼和两种人设填写模式。
 * @param props 草稿、更新草稿与显示错误的回调
 * @returns 基本信息与人设卡片
 */
export default function PersonaFields({ draft, onChange, onError }: PersonaFieldsProps) {
  const budgetWarning = draftBudgetWarning(draft)
  /** 全文拆不开就留在原模式，明确告诉用户标准标题是什么。 */
  function changeMode(mode: CharacterDraft['mode']): void {
    const next = switchDraftMode(draft, mode)
    if (next) onChange(next)
    else onError('原文已保留。分区填写需要依次独占一行的【核心性格】【语言习惯】【背景边界】标题，请先在全文中整理。')
  }

  return <>
    <section className={styles.card}>
      <h2 className={styles.sectionTitle}><span className={styles.sectionIcon} aria-hidden="true">
        <svg viewBox="0 0 24 24"><circle cx="9" cy="7" r="3" /><path d="M3 20v-3a5 5 0 0 1 10 0v3H3Zm13-9h5m-5 4h5m-5 4h5" /></svg>
      </span>基本信息</h2>
      <div className={styles.columns}>
        <label className={styles.formRow}><span>角色名字</span><input value={draft.name} onChange={(event) => onChange({ ...draft, name: event.target.value })} /></label>
        <label className={styles.formRow}><span>称呼设定</span><input value={draft.userNickname} placeholder="留空时自然称呼" onChange={(event) => onChange({ ...draft, userNickname: event.target.value })} /></label>
      </div>
      <label className={styles.formRow}><span>初始关系</span><textarea rows={1} value={draft.initialRelationship} onChange={(event) => onChange({ ...draft, initialRelationship: event.target.value })} /></label>
      <p className={`${styles.hint} ${styles.alignedHint}`}>自由填写，不会自动升级关系。称呼随人设版本保存。</p>
    </section>
    <section className={styles.card}>
      <div className={styles.cardHeader}>
        <h2 className={styles.sectionTitle}><span className={styles.sectionIcon} aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="m14 4 6 6M4 20l5-1 12-12-4-4L5 15l-1 5Zm0 0h16" /></svg>
        </span>人设与表达</h2>
        <div className={styles.segment} aria-label="人设填写模式">
          <button type="button" aria-pressed={draft.mode === 'sections'} onClick={() => changeMode('sections')}>分区填写</button>
          <button type="button" aria-pressed={draft.mode === 'full'} onClick={() => changeMode('full')}>完整文本</button>
        </div>
      </div>
      {draft.mode === 'full'
        ? <label>完整人设<textarea rows={12} value={draft.fullText} onChange={(event) => onChange({ ...draft, fullText: event.target.value })} /></label>
        : (['core', 'speech', 'background'] as const).map((key, index) => <label key={key} className={styles.formRow}>
          <span>{['核心性格', '语言习惯', '背景边界'][index]}</span>
          <span className={styles.fieldControl}><span className={styles.hint}>
            {['她在乎什么、怎样表达关心、遇事会怎么反应。', '句长、用词、比喻与表达习惯。', '哪些情景沿用、哪些未知、哪些不能当成共同往事。'][index]}
          </span><textarea rows={3} value={draft.sections[key]} onChange={(event) => onChange({ ...draft, sections: { ...draft.sections, [key]: event.target.value } })} /></span>
        </label>)}
      {budgetWarning && <p role="status" className={styles.hint}>{budgetWarning}</p>}
      <aside className={styles.principles}><strong>共同原则 · 始终生效</strong><p>不编造共同经历 · 不用内疚迫使你聊天 · 操作成功后才确认</p></aside>
    </section>
  </>
}
