/**
 * 从 SQLite 准备本轮人设和可用历史，防止回复中途编辑人设后混用两版设定。
 * 这里只读出独立的数据副本；不调用模型、不写用户资料，预算裁剪由下一步处理。
 * 历史展示允许用户查看已排除的原文，本文件不能复用那个展示接口。
 */
import { and, asc, eq, lt } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import { characters, characterVersions, conversations, messages } from '../data/tables'
import { dialogueExampleSchema, type DialogueExample } from '../shared/character-schema'

/** 内部调用的输入；共同规则来自应用配置，角色归属从会话查，不能由模型指定。 */
export interface BuildTurnContextInput {
  conversationId: string
  userMessageId: string
  commonRules: string
}

/** 保留消息身份与来源编号；示例不能混成这里的真实聊天记录。 */
export interface ContextMessage {
  id: string
  seq: number
  role: 'user' | 'assistant' | 'proactive'
  content: string
  replyToId: string | null
  createdAt: number
}

/**
 * 本轮独立的输入资料：读取后整轮复用，不随编辑页的后续保存或回退变化。
 * history 目前是合格历史候选，尚未按 token 预算挑选近期部分，不能直接全发给模型。
 */
export interface TurnContext {
  conversationId: string
  characterId: string
  characterName: string
  contextEpoch: number
  commonRules: string
  persona: {
    versionId: string
    versionNo: number
    personaText: string
    initialRelationship: string
    userNickname: string | null
    dialogueExamples: DialogueExample[]
  }
  history: ContextMessage[]
  currentMessage: ContextMessage
}

const examplesSchema = z.array(dialogueExampleSchema).max(20)

/** 坏示例必须明确失败，不能悄悄当成没有示例，导致同一人设实际少带了内容。 */
function readExamples(json: string): DialogueExample[] {
  let parsed: unknown
  try { parsed = JSON.parse(json) }
  catch { throw new Error('E_INVALID_DIALOGUE_EXAMPLES') }
  const checked = examplesSchema.safeParse(parsed)
  if (!checked.success) throw new Error('E_INVALID_DIALOGUE_EXAMPLES')
  return checked.data
}

/** 一条资料可带入模型的前提；失败或被排除的片段不能当成可靠经历。 */
function isUsable(message: typeof messages.$inferSelect): boolean {
  return message.status === 'completed' && message.excludedFromContext === 0 && message.content.trim() !== ''
}

/** 只返回上下文实际需要的消息资料，不把数据库状态行或框架会话对象传下去。 */
function toContextMessage(message: typeof messages.$inferSelect): ContextMessage {
  return {
    id: message.id, seq: message.seq, role: message.role as ContextMessage['role'],
    content: message.content, replyToId: message.replyToId, createdAt: message.createdAt,
  }
}

/**
 * 读取一次正式聊天的人设与历史，当前消息单独放末尾，重试也不吃后续聊天。
 * 事务让这些读取看到同一时点的数据库资料；函数返回就结束，不在事务中等待模型。
 * @param db 后台数据库连接
 * @param input 正式会话、已保存用户消息及应用共同规则
 * @returns 固定本轮人设版本、有效历史和当前消息的独立副本
 * @throws E_COMMON_RULES_REQUIRED 缺共同规则；E_CONVERSATION_NOT_FOUND 会话不存在；
 * E_PREVIEW_NOT_ALLOWED 试聊尚不能走此正式入口；E_USER_MESSAGE_NOT_ALLOWED 当前消息不可用；
 * E_PERSONA_UNAVAILABLE 缺少有效人设；E_INVALID_DIALOGUE_EXAMPLES 示例资料损坏
 */
export function buildTurnContext(db: BetterSQLite3Database, input: BuildTurnContextInput): TurnContext {
  if (!input.commonRules.trim()) throw new Error('E_COMMON_RULES_REQUIRED')
  return db.transaction((tx) => {
    const conversation = tx.select().from(conversations).where(eq(conversations.id, input.conversationId)).get()
    if (!conversation) throw new Error('E_CONVERSATION_NOT_FOUND')
    if (conversation.mode !== 'normal') throw new Error('E_PREVIEW_NOT_ALLOWED')
    const current = tx.select().from(messages).where(and(
      eq(messages.id, input.userMessageId), eq(messages.conversationId, conversation.id),
      eq(messages.role, 'user'),
    )).get()
    if (!current || !isUsable(current)) throw new Error('E_USER_MESSAGE_NOT_ALLOWED')

    const character = tx.select().from(characters).where(eq(characters.id, conversation.characterId)).get()
    const version = tx.select().from(characterVersions).where(and(
      eq(characterVersions.characterId, conversation.characterId), eq(characterVersions.isActive, 1),
    )).get()
    if (!character || !version || !version.personaText.trim() || !version.initialRelationship.trim()) {
      throw new Error('E_PERSONA_UNAVAILABLE')
    }

    // 边界钉在当前用户消息之前；即使重试旧消息，也不能把后来聊的话混进当时的背景。
    const previous = tx.select().from(messages).where(and(
      eq(messages.conversationId, conversation.id), lt(messages.seq, current.seq),
    )).orderBy(asc(messages.seq)).all()
    // Map 按编号找记录，后面可直接核对回复对应的用户原话，而不用反复翻整段历史。
    const users = new Map(previous.filter((row) => row.role === 'user' && isUsable(row)).map((row) => [row.id, row]))
    const latestReplies = new Map<string, typeof messages.$inferSelect>()
    for (const row of previous) {
      // 必须先挑最新版本再判断它能否使用；反过来会在新版被排除时复活旧版文字。
      if (row.role === 'assistant' && row.replyToId !== null) latestReplies.set(row.replyToId, row)
    }
    const history: ContextMessage[] = []
    // Set 只记不重复的编号，用来判断主动消息引用的来源是否已经获准带入。
    const includedIds = new Set<string>()
    for (const row of previous) {
      if (!isUsable(row)) continue
      if (row.role === 'assistant') {
        const user = row.replyToId === null ? undefined : users.get(row.replyToId)
        if (!user || row.seq <= user.seq || latestReplies.get(user.id)?.id !== row.id) continue
      }
      // 主动消息也可能引用旧回复；只有来源已入选才带入，不能借它复述已排除的原文。
      // 按先后顺序检查还能挡住跨会话、未来来源和被排除来源的后续引用。
      if (row.role === 'proactive' && row.replyToId !== null && !includedIds.has(row.replyToId)) continue
      history.push(toContextMessage(row))
      includedIds.add(row.id)
    }

    return {
      conversationId: conversation.id, characterId: character.id, characterName: character.name,
      contextEpoch: conversation.contextEpoch, commonRules: input.commonRules,
      persona: {
        versionId: version.id, versionNo: version.versionNo, personaText: version.personaText,
        initialRelationship: version.initialRelationship, userNickname: version.userNickname,
        dialogueExamples: readExamples(version.dialogueExamplesJson),
      },
      history, currentMessage: toContextMessage(current),
    }
  })
}
