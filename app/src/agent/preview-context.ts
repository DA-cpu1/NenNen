/**
 * 从 SQLite 与编辑页草稿准备一轮试聊上下文（H1 隔离的上下文侧）。
 * 与正式路径的差别：人设来自请求携带的草稿，不读 character_versions——
 * 用户改了草稿立即生效，保存/回退不影响试聊；历史只来自 preview 会话自身。
 * 反方向同样拒绝：正式会话不能走试聊入口「借道换人设」。
 */
import { and, asc, eq, lt } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { characters, conversations, messages } from '../data/tables'
import type { PreviewPersonaDraft } from '../shared/chat-turn'
import { usableHistory, type TurnContext } from './turn-context'

export type { PreviewPersonaDraft }

/** 试聊上下文准备的输入。 */
export interface BuildPreviewTurnContextInput {
  conversationId: string
  userMessageId: string
  commonRules: string
  draft: PreviewPersonaDraft
}

/**
 * 读取一轮试聊的人设（草稿）与历史，规则与正式路径共用同一段筛选代码。
 * @param db 后台数据库连接
 * @param input preview 会话、已保存用户消息、共同规则与草稿人设
 * @returns 草稿人设（versionId 为 null）、preview 历史与当前消息的独立副本
 * @throws E_COMMON_RULES_REQUIRED 缺共同规则；E_INVALID_DRAFT_PERSONA 草稿正文或关系为空；
 * E_CONVERSATION_NOT_FOUND 会话不存在；E_PREVIEW_REQUIRED 传来的不是 preview 会话；
 * E_USER_MESSAGE_NOT_ALLOWED 当前消息不在这条 preview 会话里或不可用
 */
export function buildPreviewTurnContext(
  db: BetterSQLite3Database,
  input: BuildPreviewTurnContextInput,
): TurnContext {
  if (!input.commonRules.trim()) throw new Error('E_COMMON_RULES_REQUIRED')
  if (!input.draft.personaText.trim() || !input.draft.initialRelationship.trim()) {
    throw new Error('E_INVALID_DRAFT_PERSONA')
  }
  return db.transaction((tx) => {
    const conversation = tx.select().from(conversations)
      .where(eq(conversations.id, input.conversationId)).get()
    if (!conversation) throw new Error('E_CONVERSATION_NOT_FOUND')
    // 对称隔离：正式入口拒绝 preview（buildTurnContext），试聊入口拒绝正式会话。
    if (conversation.mode !== 'preview') throw new Error('E_PREVIEW_REQUIRED')
    const current = tx.select().from(messages).where(and(
      eq(messages.id, input.userMessageId), eq(messages.conversationId, conversation.id),
      eq(messages.role, 'user'),
    )).get()
    if (!current || current.status !== 'completed' || current.content.trim() === '') {
      throw new Error('E_USER_MESSAGE_NOT_ALLOWED')
    }
    const character = tx.select().from(characters)
      .where(eq(characters.id, conversation.characterId)).get()
    if (!character) throw new Error('E_CHARACTER_NOT_FOUND')

    const previous = tx.select().from(messages).where(and(
      eq(messages.conversationId, conversation.id), lt(messages.seq, current.seq),
    )).orderBy(asc(messages.seq)).all()

    return {
      conversationId: conversation.id, conversationMode: 'preview',
      characterId: character.id, characterName: character.name,
      contextEpoch: conversation.contextEpoch, commonRules: input.commonRules,
      persona: {
        // 试聊没有保存的版本可追溯：编号留空、版本号 0，运行账本同样记空版本。
        versionId: null, versionNo: 0, personaText: input.draft.personaText,
        initialRelationship: input.draft.initialRelationship, userNickname: input.draft.userNickname,
        dialogueExamples: input.draft.dialogueExamples,
      },
      history: usableHistory(previous), currentMessage: {
        id: current.id, seq: current.seq, role: 'user',
        content: current.content, replyToId: current.replyToId, createdAt: current.createdAt,
      },
    }
  })
}
