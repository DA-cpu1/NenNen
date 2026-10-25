/** 情境示例编辑器：增删只改页面草稿，保存整份人设时才一起入库。 */
import type { DialogueExample } from '../../shared/character-schema'
import styles from './SettingsPage.module.css'

interface ExamplesEditorProps {
  examples: DialogueExample[]
  onChange: (examples: DialogueExample[]) => void
}

/**
 * 编辑最多二十条「场景、用户话语、角色回应」。空条目保存时会被指出。
 * @param props 当前示例及替换示例列表的回调
 * @returns 示例表单
 */
export default function ExamplesEditor({ examples, onChange }: ExamplesEditorProps) {
  return <section className={styles.card}>
    <div className={styles.cardHeader}>
      <h2>情境示例 <small>{examples.length} / 20</small></h2>
      <button type="button" className={styles.secondary} disabled={examples.length >= 20}
        onClick={() => onChange([...examples, { scene: '', user: '', character: '' }])}>添加示例</button>
    </div>
    <p className={styles.hint}>用具体对话展示她会怎样回应。每条都需要用户话语和角色回应。</p>
    {examples.length === 0 && <p className={styles.hint}>还没有情境示例，可以从一条日常对话开始。</p>}
    {examples.map((example, index) => <article className={styles.example} key={index}>
      <div className={styles.cardHeader}><h3>示例 {index + 1}</h3>
        <button type="button" className={styles.textButton} aria-label={`删除示例 ${index + 1}`}
          onClick={() => onChange(examples.filter((_, itemIndex) => itemIndex !== index))}>删除</button>
      </div>
      {(['scene', 'user', 'character'] as const).map((field, fieldIndex) => <label key={field}>
        {['场景', '用户话语', '角色回应'][fieldIndex]}
        <textarea rows={field === 'scene' ? 1 : 3} value={example[field]}
          onChange={(event) => onChange(examples.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: event.target.value } : item))} />
      </label>)}
    </article>)}
  </section>
}
