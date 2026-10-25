/** 草稿边界检查：取消不污染原件、旧文本不丢失、保存不交两份人设。 */
import { describe, expect, it } from 'vitest'
import { bodyFromDraft, draftFromCharacter, switchDraftMode, validateDraft } from '../src/ui/settings/character-draft'
import type { CharacterOverview } from '../src/shared/data-types'

const character: CharacterOverview = {
  characterId: 'fixed-character', name: '六花', desktopImagePath: null, portraitImagePath: null,
  activeVersion: { versionNo: 1, personaText: '旧的人设正文', initialRelationship: '恋人', userNickname: null,
    dialogueExamples: [{ scene: '开心', user: '完成了', character: '突破了' }] },
  versions: [{ versionNo: 1, isActive: true, createdAt: 0 }],
}

describe('编辑草稿的数据边界', () => {
  it('修改示例不会污染已读取的原件，重新复制可恢复取消前状态', () => {
    const draft = draftFromCharacter(character)
    draft.dialogueExamples[0].user = '已修改'
    expect(character.activeVersion?.dialogueExamples[0].user).toBe('完成了')
    expect(draftFromCharacter(character).dialogueExamples[0].user).toBe('完成了')
  })
  it('旧全文切到分区失败时不丢原文', () => {
    const draft = draftFromCharacter(character)
    expect(switchDraftMode(draft, 'sections')).toBeNull()
    expect(draft.fullText).toBe('旧的人设正文')
  })
  it('有标准标题但前面还有正文时保留全文，避免丢掉共同规则', () => {
    const text = '共同规则不能丢\n【核心性格】\n认真\n【语言习惯】\n简短\n【背景边界】\n不猜'
    const draft = draftFromCharacter({ ...character, activeVersion: { ...character.activeVersion!, personaText: text } })
    expect(draft.mode).toBe('full')
    expect(draft.fullText).toBe(text)
  })
  it('分区和全文往返后正文不变，每次保存只传一种模式', () => {
    const draft = { ...draftFromCharacter(character), mode: 'sections' as const, sections: { core: '认真', speech: '简短', background: '不猜' } }
    const full = switchDraftMode(draft, 'full')!
    expect(switchDraftMode(full, 'sections')?.sections).toEqual(draft.sections)
    expect(bodyFromDraft(draft, 'same-request')).not.toHaveProperty('personaFullText')
    expect(bodyFromDraft(full, 'same-request')).not.toHaveProperty('personaSections')
  })
  it('空的人设、空示例和超出二十条的示例不能送去保存', () => {
    const draft = draftFromCharacter(character)
    expect(validateDraft({ ...draft, fullText: '  ' })).toContain('人设')
    expect(validateDraft({ ...draft, dialogueExamples: [{ scene: '', user: '', character: '答' }] })).toContain('第 1 条')
    expect(validateDraft({ ...draft, dialogueExamples: Array(21).fill(draft.dialogueExamples[0]) })).toContain('20')
    expect(validateDraft(draft)).toBeNull()
  })
})
