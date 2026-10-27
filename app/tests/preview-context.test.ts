/**
 * 用内存库检查试聊草稿上下文：草稿原样带入、与正式会话双向隔离、
 * 历史只来自 preview 会话自身。不读正式用户资料、不启动框架。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { openCompanionDatabase, type CompanionDb } from '../src/data/db'
import { runMigrations } from '../src/data/migrations'
import { initializeFirstCharacter } from '../src/data/character-init'
import { saveUserMessage, createAssistantReply, updateAssistantReply } from '../src/data/messages'
import { conversations } from '../src/data/tables'
import { buildPreviewTurnContext, type PreviewPersonaDraft } from '../src/agent/preview-context'

let companion: CompanionDb
let formalId: string
let previewId: string

beforeEach(() => {
  companion = openCompanionDatabase(':memory:')
  runMigrations(companion.sqlite)
  formalId = initializeFirstCharacter(companion.db, {
    name: '测试角色', personaText: '正式人设', initialRelationship: '恋人', timezone: 'Asia/Hong_Kong',
  }).conversationId
  // 同一角色再开一条 preview 会话：正式与试聊并存、互不串线（05 §3）。
  const formal = companion.db.select().from(conversations).where(eq(conversations.id, formalId)).get()!
  companion.db.insert(conversations).values({ ...formal, id: 'preview-1', mode: 'preview' }).run()
  previewId = 'preview-1'
})
afterEach(() => companion.close())

/** 固定草稿；个别检查按需替换字段。 */
function draft(overrides: Partial<PreviewPersonaDraft> = {}): PreviewPersonaDraft {
  return {
    personaText: '草稿人设：说话带「哼」。', initialRelationship: '暧昧',
    userNickname: '小试', dialogueExamples: [{ scene: '打招呼', user: '在吗', character: '哼，才来。' }],
    ...overrides,
  }
}

function previewMessage(requestId: string, content: string): string {
  return saveUserMessage(companion.db, { conversationId: previewId, requestId, content }).message.id
}

describe('试聊草稿上下文（T06⑪f）', () => {
  it('草稿原样带入：无版本号、关系称呼示例齐全，历史只来自 preview 会话', () => {
    // preview 里有一轮完成问答；正式会话里也有一轮——后者不得混入。
    const first = previewMessage('p1', '试聊第一句')
    const reply = createAssistantReply(companion.db, { userMessageId: first })
    updateAssistantReply(companion.db, { messageId: reply.id, content: '试聊第一答', status: 'completed' })
    const formalMessage = saveUserMessage(companion.db, {
      conversationId: formalId, requestId: 'f1', content: '正式会话的话',
    }).message.id
    const formalReply = createAssistantReply(companion.db, { userMessageId: formalMessage })
    updateAssistantReply(companion.db, { messageId: formalReply.id, content: '正式会话的答', status: 'completed' })

    const current = previewMessage('p2', '试聊当前句')
    const context = buildPreviewTurnContext(companion.db, {
      conversationId: previewId, userMessageId: current, commonRules: '不编造经历。', draft: draft(),
    })
    expect(context.persona.versionId).toBeNull()
    expect(context.persona.versionNo).toBe(0)
    expect(context.persona.personaText).toContain('草稿人设')
    expect(context.persona.initialRelationship).toBe('暧昧')
    expect(context.persona.userNickname).toBe('小试')
    expect(context.persona.dialogueExamples).toHaveLength(1)
    expect(context.characterName).toBe('测试角色')
    expect(context.conversationMode).toBe('preview')
    expect(context.history.map((message) => message.content))
      .toEqual(['试聊第一句', '试聊第一答'])
    expect(context.currentMessage.id).toBe(current)
  })

  it('正式会话不能走试聊入口，对称隔离', () => {
    const formalMessage = saveUserMessage(companion.db, {
      conversationId: formalId, requestId: 'f1', content: '正式的话',
    }).message.id
    expect(() => buildPreviewTurnContext(companion.db, {
      conversationId: formalId, userMessageId: formalMessage, commonRules: '规则', draft: draft(),
    })).toThrow('E_PREVIEW_REQUIRED')
  })

  it.each([
    { personaText: '  ', label: '正文空白' },
    { initialRelationship: '', label: '关系为空' },
  ])('草稿 $label 被拒绝', (overrides) => {
    const message = previewMessage('p1', '你好')
    expect(() => buildPreviewTurnContext(companion.db, {
      conversationId: previewId, userMessageId: message, commonRules: '规则',
      draft: draft(overrides as Partial<PreviewPersonaDraft>),
    })).toThrow('E_INVALID_DRAFT_PERSONA')
  })

  it('当前消息属于别的会话时拒绝，不能借试聊入口读正式聊天', () => {
    const formalMessage = saveUserMessage(companion.db, {
      conversationId: formalId, requestId: 'f1', content: '正式的问题',
    }).message.id
    expect(() => buildPreviewTurnContext(companion.db, {
      conversationId: previewId, userMessageId: formalMessage, commonRules: '规则', draft: draft(),
    })).toThrow('E_USER_MESSAGE_NOT_ALLOWED')
  })
})
