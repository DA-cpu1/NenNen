/**
 * 把正式设定复制成页面草稿。用户输入时只改这份副本，明确保存才写库，
 * 取消修改不会误删已经保存的人设。
 */
import type { DialogueExample, SaveCharacterVersionBody } from '../../shared/character-schema'
import type { CharacterOverview } from '../../shared/data-types'
import type { PreviewTurnRequest } from '../../shared/chat-turn'
import { COMMON_FACT_RULES, RIKKA_SAMPLE } from '../../shared/character-sample'
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
 * 试聊复制本次草稿，不保存版本；重试持有这份副本，之后继续编辑不会改变它。
 * @param draft 当前编辑内容
 * @returns 只含人设、关系、称呼和示例的试聊资料
 */
export function previewFromDraft(draft: CharacterDraft): PreviewTurnRequest['draft'] {
  return {
    initialRelationship: draft.initialRelationship,
    userNickname: draft.userNickname,
    dialogueExamples: draft.dialogueExamples.map((example) => ({ ...example })),
    ...(draft.mode === 'sections'
      ? { personaSections: { ...draft.sections } }
      : { personaFullText: draft.fullText }),
  }
}

/**
 * 主动载入当前候选样稿，只替换草稿中的人设、关系和示例；保存前不会改变数据库。
 * @param draft 当前草稿，保留用户已经填写的名字和称呼
 * @returns 新草稿，示例逐条复制，编辑时不改到随包样稿
 */
export function draftWithRikkaSample(draft: CharacterDraft): CharacterDraft {
  return {
    ...draft, mode: 'full', fullText: RIKKA_SAMPLE.personaText,
    initialRelationship: RIKKA_SAMPLE.initialRelationship,
    dialogueExamples: RIKKA_SAMPLE.dialogueExamples.map((example) => ({ ...example })),
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
 * 提前提示人设本身已放不下；不截短、不阻止用户保存原稿。
 * @param draft 当前草稿，示例是可选内容，所以不拿它们误判核心人设过长
 * @returns 明确超限时的中文建议；null只代表未触发此提示，不保证实际请求能放下
 */
export function draftBudgetWarning(draft: CharacterDraft): string | null {
  const personaText = draft.mode === 'full' ? draft.fullText.trim() : personaFromSections(draft.sections)
  // TextEncoder在普通浏览器就能按UTF-8数出字节，不需要给界面开启Node权限。
  // 这里只算已知的必需部分；发送时后台还会检查版本、当前消息与完整协议开销。
  const mandatory = [
    { role: 'system', content: COMMON_FACT_RULES },
    { role: 'system', content: '本轮角色设定：\n' + JSON.stringify({
      name: draft.name, personaText, initialRelationship: draft.initialRelationship, userNickname: draft.userNickname,
    }) },
    { role: 'user', content: '' },
  ]
  const estimate = new TextEncoder().encode(JSON.stringify(mandatory)).byteLength + 256
  return estimate > 12_000 ? '人设、关系和称呼已超过本轮输入预算，请缩短设定后再试聊；还需要为你的消息留出空间。' : null
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
