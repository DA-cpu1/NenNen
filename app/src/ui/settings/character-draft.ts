/**
 * 把正式设定复制成页面草稿。用户输入时只改这份副本，明确保存才写库，
 * 取消修改不会误删已经保存的人设。
 */
import type { DialogueExample, SaveCharacterVersionBody } from '../../shared/character-schema'
import type { CharacterOverview } from '../../shared/data-types'
import { personaFromSections, sectionsFromPersona, type PersonaSections } from '../../shared/persona-format'

/** 两种编辑模式共用的草稿；切换时明确转换正文。 */
export interface CharacterDraft {
  name: string
  initialRelationship: string
  userNickname: string
  mode: 'sections' | 'full'
  sections: PersonaSections
  fullText: string
  dialogueExamples: DialogueExample[]
}

/**
 * 复制当前设定，示例数组也逐条复制，避免编辑时改到原件。
 * @param character 后台读出的角色概览
 * @returns 草稿；拆不开的旧人设完整保留
 */
export function draftFromCharacter(character: CharacterOverview): CharacterDraft {
  const version = character.activeVersion
  const persona = sectionsFromPersona(version?.personaText ?? '')
  return {
    name: character.name,
    initialRelationship: version?.initialRelationship ?? '',
    userNickname: version?.userNickname ?? '',
    mode: persona.structured ? 'sections' : 'full',
    sections: persona.sections,
    fullText: persona.fullText,
    dialogueExamples: (version?.dialogueExamples ?? []).map((example) => ({ ...example })),
  }
}

/**
 * 保存时只交一种人设模式，避免两份正文互相冲突。
 * @param draft 当前填写的内容
 * @param requestId 本次保存编号；同一次重试复用
 * @returns 现有保存端点接受的请求体
 */
export function bodyFromDraft(draft: CharacterDraft, requestId: string): SaveCharacterVersionBody {
  return {
    requestId, name: draft.name, initialRelationship: draft.initialRelationship,
    userNickname: draft.userNickname, dialogueExamples: draft.dialogueExamples,
    ...(draft.mode === 'sections' ? { personaSections: draft.sections } : { personaFullText: draft.fullText }),
  }
}

/**
 * 先用中文指出漏填项；后台仍会再次检查，不能只信页面。
 * @param draft 当前草稿
 * @returns 错误原因；null 表示可尝试保存
 */
export function validateDraft(draft: CharacterDraft): string | null {
  if (!draft.name.trim()) return '请填写角色名字。'
  if (!draft.initialRelationship.trim()) return '请填写初始关系。'
  const persona = draft.mode === 'full' ? draft.fullText : Object.values(draft.sections).join('')
  if (!persona.trim()) return '请至少填写一段人设。'
  if (draft.dialogueExamples.length > 20) return '情境示例最多保留 20 条。'
  const index = draft.dialogueExamples.findIndex((item) => !item.user.trim() || !item.character.trim())
  return index < 0 ? null : `请补齐第 ${index + 1} 条示例的用户话语和角色回应。`
}

/**
 * 全文没有标准标题时不硬拆，防止切模式悄悄丢掉用户的内容。
 * @param draft 当前草稿
 * @param mode 目标模式
 * @returns 新草稿；null 表示保留全文，请用户先整理标题
 */
export function switchDraftMode(draft: CharacterDraft, mode: CharacterDraft['mode']): CharacterDraft | null {
  if (draft.mode === mode) return draft
  if (mode === 'full') return { ...draft, mode, fullText: personaFromSections(draft.sections) }
  const parsed = sectionsFromPersona(draft.fullText)
  return parsed.structured ? { ...draft, mode, sections: parsed.sections, fullText: '' } : null
}
