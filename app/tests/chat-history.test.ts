/** 用真实本地 HTTP 与内存库检查历史分页、身份隔离和错误返回；不访问正式用户资料。 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openCompanionDatabase, type CompanionDb } from '../src/data/db'
import { runMigrations } from '../src/data/migrations'
import { initializeFirstCharacter } from '../src/data/character-init'
import { saveUserMessage } from '../src/data/messages'
import { readChatHistory } from '../src/data/chat-history'
import { characters, characterVersions, companionSettings, conversations, messages } from '../src/data/tables'
import { startBackendServer, type BackendServer } from '../src/service/server'

let companion: CompanionDb
let server: BackendServer
let conversationId: string
const token = 'history-test-token'
const now = 1740000005000

beforeEach(async () => {
  companion = openCompanionDatabase(':memory:')
  runMigrations(companion.sqlite)
  conversationId = initializeFirstCharacter(companion.db, {
    name: '检查角色', personaText: '检查人设', initialRelationship: '恋人',
    timezone: 'Asia/Hong_Kong', now,
  }).conversationId
  for (let i = 1; i <= 5; i++) saveUserMessage(companion.db, {
    conversationId, requestId: `request-${i}`, content: `第${i}句`, now: now + i,
  })
  server = await startBackendServer(token, { readChatHistory: (query) => readChatHistory(companion.db, query) })
})

afterEach(async () => {
  await server.stop()
  companion.close()
})

/** 带测试令牌请求实际服务；参数只包含会话编号和分页边界。 */
function get(query: string) {
  return fetch(`http://127.0.0.1:${server.port}/chat/history?${query}`, { headers: { 'x-session-token': token } })
}

describe('正式历史读取（T06⑥）', () => {
  it('先读最近一页，再往前翻，不丢失也不重复消息', async () => {
    const latest = await (await get(`conversationId=${conversationId}&limit=2`)).json()
    expect(latest.history.messages.map((row: { seq: number }) => row.seq)).toEqual([4, 5])
    expect(latest.history.hasMore).toBe(true)
    const previous = await (await get(`conversationId=${conversationId}&limit=2&beforeSeq=4`)).json()
    expect(previous.history.messages.map((row: { seq: number }) => row.seq)).toEqual([2, 3])
    const first = await (await get(`conversationId=${conversationId}&limit=2&beforeSeq=2`)).json()
    expect(first.history.messages.map((row: { seq: number }) => row.seq)).toEqual([1])
    expect(first.history.hasMore).toBe(false)
  })

  it('历史可查看被排除出上下文的原文，并保留失败或取消状态', async () => {
    companion.db.insert(messages).values({
      id: 'excluded-reply', conversationId, seq: 6, role: 'assistant', content: '半截文字',
      status: 'cancelled', excludedFromContext: 1, createdAt: now,
    }).run()
    const result = await (await get(`conversationId=${conversationId}`)).json()
    expect(result.history.messages.at(-1)).toMatchObject({ content: '半截文字', status: 'cancelled', excludedFromContext: true })
  })

  it('试聊记录不混进正式历史，正式端点也拒绝直接读取试聊会话', async () => {
    const formal = companion.db.select().from(conversations).get()!
    companion.db.insert(conversations).values({ ...formal, id: 'preview-check', mode: 'preview' }).run()
    saveUserMessage(companion.db, { conversationId: 'preview-check', requestId: 'request-1', content: '试聊私有文本', now })
    const result = await (await get(`conversationId=${conversationId}`)).json()
    expect(result.history.messages).toHaveLength(5)
    const preview = await get('conversationId=preview-check')
    expect(preview.status).toBe(403)
    expect(await preview.json()).toEqual({ ok: false, code: 'PREVIEW_NOT_ALLOWED' })
  })

  it('两角色各自返回自己的正式历史，不能按同一顺序号串出另一角色的话', async () => {
    const character = companion.db.select().from(characters).get()!
    const version = companion.db.select().from(characterVersions).get()!
    const conversation = companion.db.select().from(conversations).get()!
    const settings = companion.db.select().from(companionSettings).get()!
    // 测试角色也建齐四件套，保证它是真正独立的正式会话。
    companion.db.transaction((tx) => {
      tx.insert(characters).values({ ...character, id: 'other', name: '乙' }).run()
      tx.insert(characterVersions).values({ ...version, id: 'other-version', characterId: 'other' }).run()
      tx.insert(conversations).values({ ...conversation, id: 'other-conversation', characterId: 'other' }).run()
      tx.insert(companionSettings).values({ ...settings, characterId: 'other' }).run()
    })
    saveUserMessage(companion.db, { conversationId: 'other-conversation', requestId: 'request-1', content: '另一角色私有文本', now })
    const first = await (await get(`conversationId=${conversationId}`)).json()
    const second = await (await get('conversationId=other-conversation')).json()
    expect(first.history.characterId).toBe(character.id)
    expect(first.history.messages).toHaveLength(5)
    expect(second.history.characterId).toBe('other')
    expect(second.history.messages.map((row: { content: string }) => row.content)).toEqual(['另一角色私有文本'])
  })

  it('拒绝缺参数、非法边界和未知参数，会话不存在时如实返回', async () => {
    for (const query of ['', `conversationId=${conversationId}&limit=101`,
      `conversationId=${conversationId}&beforeSeq=0`, `conversationId=${conversationId}&role=other`]) {
      expect((await get(query)).status).toBe(400)
    }
    expect((await get('conversationId=missing')).status).toBe(404)
  })

  it('没有令牌不能读取历史，读取失败只返回固定错误码', async () => {
    const unauthorized = await fetch(`http://127.0.0.1:${server.port}/chat/history?conversationId=${conversationId}`)
    expect(unauthorized.status).toBe(401)
    await server.stop()
    server = await startBackendServer(token, { readChatHistory: () => { throw new Error('不应返回的私人正文') } })
    const failed = await get(`conversationId=${conversationId}`)
    expect(failed.status).toBe(502)
    expect(await failed.json()).toEqual({ ok: false, code: 'DB_ERROR' })
  })
})
