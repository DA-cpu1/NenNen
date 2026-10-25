/**
 * 固定数据检查本轮上下文：版本切换不改旧结果，试聊/其他角色/半截与排除文字不混入。
 * 所有资料均在内存测试库构造，不读取正式聊天，不调用模型或依赖框架运行文件。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { openCompanionDatabase, type CompanionDb } from '../src/data/db'
import { runMigrations } from '../src/data/migrations'
import { initializeFirstCharacter } from '../src/data/character-init'
import { activateCharacterVersion, saveCharacterVersion } from '../src/data/character-edit'
import { createAssistantReply, saveUserMessage, updateAssistantReply } from '../src/data/messages'
import { buildTurnContext } from '../src/agent/turn-context'
import { characters, characterVersions, companionSettings, conversations, messages } from '../src/data/tables'

let companion: CompanionDb
let conversationId: string
const now = 1740000005000
const commonRules = '不编造共同经历；只有工具成功才说操作已完成。'
const edited = {
  name: '六花', personaText: '  核心设定\n保留原有全文与空白。 ', initialRelationship: '已经确定恋人关系',
  userNickname: '阿达', dialogueExamples: [{ scene: '示例', user: '示例问句', character: '示例回应' }],
  saveRequestId: 'persona-2', now,
}

beforeEach(() => {
  companion = openCompanionDatabase(':memory:')
  runMigrations(companion.sqlite)
  conversationId = initializeFirstCharacter(companion.db, {
    name: '六花', personaText: '初始人设', initialRelationship: '恋人', timezone: 'Asia/Hong_Kong', now,
  }).conversationId
  saveCharacterVersion(companion.db, edited)
})

afterEach(() => companion.close())

/** 每次新请求各自存一条原始用户消息；重试时测试会复用同一条。 */
function user(requestId: string, content = requestId, conversation = conversationId) {
  return saveUserMessage(companion.db, { conversationId: conversation, requestId, content, now }).message
}

/** 用固定模型输出完成一版回复，不实际调用模型。 */
function reply(userMessageId: string, content = '可靠回复') {
  const created = createAssistantReply(companion.db, { userMessageId, now })
  return updateAssistantReply(companion.db, { messageId: created.id, content, status: 'completed', now })
}

/** 模拟本轮内部入口，只注入共同规则和当前消息。 */
function build(userMessageId: string, conversation = conversationId) {
  return buildTurnContext(companion.db, { conversationId: conversation, userMessageId, commonRules })
}

describe('当轮人设固定与可用历史（T06⑧）', () => {
  it('原样读取完整人设、称呼和示例；示例与真实历史分开，整个过程只读', () => {
    const current = user('current', '当前用户原话')
    companion.sqlite.pragma('query_only = ON')
    const context = build(current.id)
    expect(context.commonRules).toBe(commonRules)
    expect(context.persona).toMatchObject({
      versionNo: 2, personaText: edited.personaText, initialRelationship: edited.initialRelationship,
      userNickname: '阿达', dialogueExamples: edited.dialogueExamples,
    })
    expect(context.history).toEqual([])
    expect(context.currentMessage).toMatchObject({ id: current.id, role: 'user', content: '当前用户原话' })
  })

  it('保存或回退人设后，新读取跟随新版，已准备的本轮仍保留旧设定', () => {
    const current = user('current')
    const original = build(current.id)
    const changed = { ...edited, personaText: '新的人设', initialRelationship: '新版关系', userNickname: '小陈',
      dialogueExamples: [{ scene: '新示例', user: '新问句', character: '新回应' }], saveRequestId: 'persona-3' }
    saveCharacterVersion(companion.db, changed)
    const next = build(current.id)
    activateCharacterVersion(companion.db, 2)
    const reverted = build(current.id)
    expect(original.persona).toMatchObject({ versionNo: 2, personaText: edited.personaText, userNickname: '阿达',
      initialRelationship: edited.initialRelationship, dialogueExamples: edited.dialogueExamples })
    expect(next.persona).toMatchObject({ versionNo: 3, personaText: changed.personaText, userNickname: '小陈',
      initialRelationship: changed.initialRelationship, dialogueExamples: changed.dialogueExamples })
    expect(reverted.persona).toEqual(original.persona)
    expect(reverted.persona.dialogueExamples).not.toBe(original.persona.dialogueExamples)
  })

  it('初始化重入不会把用户已编辑的人设换回样稿', () => {
    initializeFirstCharacter(companion.db, {
      name: '样稿名字', personaText: '样稿人设', initialRelationship: '样稿关系', timezone: 'Asia/Hong_Kong', now,
    })
    const context = build(user('current').id)
    expect(context.characterName).toBe('六花')
    expect(context.persona).toMatchObject({ versionNo: 2, personaText: edited.personaText, userNickname: '阿达' })
  })

  it('只取当前消息之前的历史，重试旧消息不读取后来消息或后来补出的回复版本', () => {
    const earlier = user('earlier')
    const earlierReply = reply(earlier.id)
    const current = user('current')
    reply(current.id, '这条回复不应被当成本轮过去经历')
    user('future', '之后聊的话')
    reply(earlier.id, '边界后新生成的旧消息重试')
    const context = build(current.id)
    expect(context.history.map((row) => row.id)).toEqual([earlier.id, earlierReply.id])
    expect(context.currentMessage.id).toBe(current.id)
    expect(JSON.stringify(context)).not.toContain('之后聊的话')
    expect(JSON.stringify(context)).not.toContain('边界后新生成')
  })

  it.each(['pending', 'streaming', 'failed', 'cancelled'] as const)('%s 的角色文字不作为可靠经历', (status) => {
    const earlier = user('earlier')
    const incomplete = createAssistantReply(companion.db, { userMessageId: earlier.id, now })
    if (status !== 'pending') updateAssistantReply(companion.db, {
      messageId: incomplete.id, content: '不可用的半截文字', status, now,
    })
    expect(build(user('current').id).history.map((row) => row.id)).toEqual([earlier.id])
  })

  it('排除用户原话时，依赖它的成功回复也不能带入，原文仍在本地库', () => {
    const earlier = user('earlier', '被排除的原话')
    reply(earlier.id, '依赖被排除原话的回应')
    companion.db.update(messages).set({ excludedFromContext: 1 }).where(eq(messages.id, earlier.id)).run()
    expect(build(user('current').id).history).toEqual([])
    expect(companion.db.select().from(messages).where(eq(messages.id, earlier.id)).get()?.content).toBe('被排除的原话')
  })

  it('同一用户消息只选最新成功回复，旧版本不重复带入', () => {
    const earlier = user('earlier')
    reply(earlier.id, '旧版回复')
    const latest = reply(earlier.id, '新版回复')
    expect(build(user('current').id).history.map((row) => row.id)).toEqual([earlier.id, latest.id])
  })

  it.each(['failed', 'cancelled', 'excluded'] as const)('最新回复 %s 时也不能退回旧成功版', (state) => {
    const earlier = user('earlier')
    reply(earlier.id, '不能复活的旧回复')
    const latest = createAssistantReply(companion.db, { userMessageId: earlier.id, now })
    updateAssistantReply(companion.db, { messageId: latest.id, content: '最新回复',
      status: state === 'excluded' ? 'completed' : state, now })
    if (state === 'excluded') companion.db.update(messages).set({ excludedFromContext: 1 })
      .where(eq(messages.id, latest.id)).run()
    expect(build(user('current').id).history.map((row) => row.id)).toEqual([earlier.id])
  })

  it('主动消息保留独立身份，排除后不再带入', () => {
    companion.db.insert(messages).values({ id: 'proactive', conversationId, seq: 1, role: 'proactive',
      content: '固定主动问候', status: 'completed', createdAt: now }).run()
    const current = user('current')
    expect(build(current.id).history).toMatchObject([{ id: 'proactive', role: 'proactive' }])
    companion.db.update(messages).set({ excludedFromContext: 1 }).where(eq(messages.id, 'proactive')).run()
    expect(build(current.id).history).toEqual([])
  })

  it('主动消息引用的原话被排除时，后续引用也不能把它带回来', () => {
    const source = user('source')
    const sourceReply = reply(source.id)
    companion.db.insert(messages).values([
      { id: 'proactive-1', conversationId, seq: 3, role: 'proactive', content: '引用旧回复的问候',
        status: 'completed', replyToId: sourceReply.id, createdAt: now },
      { id: 'proactive-2', conversationId, seq: 4, role: 'proactive', content: '接着上一条的问候',
        status: 'completed', replyToId: 'proactive-1', createdAt: now },
    ]).run()
    const current = user('current')
    expect(build(current.id).history.map((row) => row.id)).toEqual([source.id, sourceReply.id, 'proactive-1', 'proactive-2'])
    companion.db.update(messages).set({ excludedFromContext: 1 }).where(eq(messages.id, source.id)).run()
    expect(build(current.id).history).toEqual([])
  })

  it('主动消息不能引用另一试聊会话的原话作为正式经历', () => {
    const formal = companion.db.select().from(conversations).get()!
    companion.db.insert(conversations).values({ ...formal, id: 'preview', mode: 'preview' }).run()
    const source = user('preview-source', '试聊里的原话', 'preview')
    companion.db.insert(messages).values({ id: 'proactive', conversationId, seq: 1, role: 'proactive',
      content: '引用试聊的问候', status: 'completed', replyToId: source.id, createdAt: now }).run()
    expect(build(user('current').id).history).toEqual([])
  })

  it('主动消息不能依赖在它之后才出现的来源', () => {
    const earlier = user('earlier')
    // 先插入来源以满足外键，再按顺序号构造「问候竟引用未来消息」的错误关系。
    companion.db.insert(messages).values({ id: 'later-source', conversationId, seq: 3, role: 'user',
      content: '晚于问候的原话', status: 'completed', createdAt: now }).run()
    companion.db.insert(messages).values({ id: 'proactive', conversationId, seq: 2, role: 'proactive',
      content: '引用未来来源', status: 'completed', replyToId: 'later-source', createdAt: now }).run()
    expect(build(user('current').id).history.map((row) => row.id)).toEqual([earlier.id, 'later-source'])
  })

  it('两个完整角色各读自己的设定和历史，伪造跨角色消息关联也不能混入', () => {
    const character = companion.db.select().from(characters).get()!
    const version = companion.db.select().from(characterVersions).where(eq(characterVersions.isActive, 1)).get()!
    const conversation = companion.db.select().from(conversations).get()!
    const settings = companion.db.select().from(companionSettings).get()!
    companion.db.transaction((tx) => {
      tx.insert(characters).values({ ...character, id: 'other', name: '乙' }).run()
      tx.insert(characterVersions).values({ ...version, id: 'other-version', characterId: 'other', personaText: '乙的人设', saveRequestId: null }).run()
      tx.insert(conversations).values({ ...conversation, id: 'other-conversation', characterId: 'other' }).run()
      tx.insert(companionSettings).values({ ...settings, characterId: 'other' }).run()
    })
    const ours = user('ours')
    const theirs = user('theirs', '另一角色原话', 'other-conversation')
    const theirReply = reply(theirs.id, '另一角色回复')
    const theirCurrent = user('their-current', '乙的当前消息', 'other-conversation')
    companion.db.insert(messages).values({ id: 'forged', conversationId, seq: 2, role: 'assistant',
      content: '伪造跨角色来源', status: 'completed', replyToId: theirs.id, createdAt: now }).run()
    const current = user('current')
    expect(build(current.id).history.map((row) => row.id)).toEqual([ours.id])
    const other = build(theirCurrent.id, 'other-conversation')
    expect(other.characterId).toBe('other')
    expect(other.persona).toMatchObject({ versionId: 'other-version', personaText: '乙的人设' })
    expect(other.history.map((row) => row.id)).toEqual([theirs.id, theirReply.id])
    expect(() => build(theirCurrent.id)).toThrow('E_USER_MESSAGE_NOT_ALLOWED')
  })

  it('正式入口拒绝试聊，不把试聊草稿当成已保存的正式人设', () => {
    const formal = companion.db.select().from(conversations).get()!
    companion.db.insert(conversations).values({ ...formal, id: 'preview', mode: 'preview' }).run()
    const previewMessage = user('preview-message', '试聊原话', 'preview')
    expect(() => build(previewMessage.id, 'preview')).toThrow('E_PREVIEW_NOT_ALLOWED')
    expect(build(user('current').id).history).toEqual([])
  })

  it('当前消息缺失、不是用户、未完成或已被排除时明确拒绝', () => {
    const current = user('current')
    const assistant = reply(current.id)
    expect(() => build('missing')).toThrow('E_USER_MESSAGE_NOT_ALLOWED')
    expect(() => build(assistant.id)).toThrow('E_USER_MESSAGE_NOT_ALLOWED')
    companion.db.update(messages).set({ excludedFromContext: 1 }).where(eq(messages.id, current.id)).run()
    expect(() => build(current.id)).toThrow('E_USER_MESSAGE_NOT_ALLOWED')
    companion.db.update(messages).set({ excludedFromContext: 0, status: 'failed' }).where(eq(messages.id, current.id)).run()
    expect(() => build(current.id)).toThrow('E_USER_MESSAGE_NOT_ALLOWED')
    expect(() => build(current.id, 'missing')).toThrow('E_CONVERSATION_NOT_FOUND')
    expect(() => buildTurnContext(companion.db, { conversationId, userMessageId: current.id, commonRules: ' ' }))
      .toThrow('E_COMMON_RULES_REQUIRED')
  })

  it.each(['not-json', '{}', '[{"scene":"场景","user":"问句","character":""}]'])('示例损坏时拒绝，异常不包含原始示例：%s', (invalid) => {
    companion.db.update(characterVersions).set({ dialogueExamplesJson: invalid }).where(eq(characterVersions.isActive, 1)).run()
    expect(() => build(user('current').id)).toThrow(/^E_INVALID_DIALOGUE_EXAMPLES$/)
  })

  it('没有生效人设时明确失败，不擅自补写或退回样稿', () => {
    companion.db.update(characterVersions).set({ isActive: 0 }).run()
    expect(() => build(user('current').id)).toThrow('E_PERSONA_UNAVAILABLE')
    expect(companion.db.select().from(characterVersions).all()).toHaveLength(2)
  })
})
