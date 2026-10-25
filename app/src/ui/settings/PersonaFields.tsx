/** 基本信息和人设输入框。这里只编辑草稿，不发请求、不直接写数据库。 */
import { switchDraftMode, type CharacterDraft } from './character-draft'
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
  /** 全文拆不开就留在原模式，明确告诉用户标准标题是什么。 */
  function changeMode(mode: CharacterDraft['mode']): void {
    const next = switchDraftMode(draft, mode)
    if (next) onChange(next)
    else onError('原文已保留。分区填写需要依次独占一行的【核心性格】【语言习惯】【背景边界】标题，请先在全文中整理。')
  }

  return <>
    <section className={styles.card}>
      <h2>基本信息</h2>
      <div className={styles.columns}>
        <label>角色名字<input value={draft.name} onChange={(event) => onChange({ ...draft, name: event.target.value })} /></label>
        <label>称呼设定<input value={draft.userNickname} placeholder="留空时由角色自然称呼" onChange={(event) => onChange({ ...draft, userNickname: event.target.value })} /></label>
      </div>
      <label>初始关系<textarea rows={2} value={draft.initialRelationship} onChange={(event) => onChange({ ...draft, initialRelationship: event.target.value })} /></label>
      <p className={styles.hint}>自由填写，不会自动升级关系。称呼随人设版本保存。</p>
    </section>
    <section className={styles.card}>
      <div className={styles.cardHeader}>
        <h2>人设与表达</h2>
        <div className={styles.segment} aria-label="人设填写模式">
          <button type="button" aria-pressed={draft.mode === 'sections'} onClick={() => changeMode('sections')}>分区填写</button>
          <button type="button" aria-pressed={draft.mode === 'full'} onClick={() => changeMode('full')}>完整文本</button>
        </div>
      </div>
      {draft.mode === 'full'
        ? <label>完整人设<textarea rows={12} value={draft.fullText} onChange={(event) => onChange({ ...draft, fullText: event.target.value })} /></label>
        : (['core', 'speech', 'background'] as const).map((key, index) => <label key={key}>
          {['核心性格', '语言习惯', '背景边界'][index]}
          <textarea rows={4} value={draft.sections[key]} onChange={(event) => onChange({ ...draft, sections: { ...draft.sections, [key]: event.target.value } })} />
        </label>)}
      <aside className={styles.principles}><strong>共同原则 · 始终生效</strong><p>不编造共同经历 · 不用内疚迫使你聊天 · 操作成功后才确认</p></aside>
    </section>
  </>
}
