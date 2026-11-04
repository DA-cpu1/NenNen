/** 真正启动 eve 与业务 HTTP 服务，用本机固定供应商验证工具来回和试聊隔离。 */
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { startEve, type EveHandle } from '../src/agent/eve-process'
import { initializeFirstCharacter } from '../src/data/character-init'
import { openCompanionDatabase } from '../src/data/db'
import { saveCharacterMemory } from '../src/data/memories'
import { saveUserMessage } from '../src/data/messages'
import { runMigrations } from '../src/data/migrations'
import { memories } from '../src/data/tables'
import { createChatTurnService } from '../src/service/chat-turns'
import { startBackendServer, type BackendServer } from '../src/service/server'

interface FixedRequest {
  tools?: Array<{ function?: { name: string } }>
  messages: Array<{ role: string; content: unknown }>
}

/** 启动本机链路，检索结果必须出现在模型续轮，试聊请求则没有工具或正式记忆。 */
async function main(): Promise<void> {
  const received: FixedRequest[] = []
  const provider = createServer(async (request, response) => {
    let body = ''
    request.setEncoding('utf8')
    for await (const chunk of request) body += chunk
    const input = JSON.parse(body) as FixedRequest
    received.push(input)
    const remember = received.length === 4
    const invoke = received.length === 1 || remember
    const sourceId = input.messages.flatMap(({ content }) => typeof content === 'string'
      ? [content.match(/当前用户消息编号（仅供立即记忆工具使用）：(\S+)/u)?.[1]] : []).find(Boolean)
    const delta = invoke ? { role: 'assistant', ...(remember ? { content: '提前声称已经保存。' } : {}), tool_calls: [{
      index: 0, id: 'fixed-search', type: 'function',
      function: remember ? { name: 'remember_explicit', arguments: JSON.stringify({
        content: '用户希望被称为阿达', kind: 'preference', memoryKey: 'preferred_name', sourceMessageId: sourceId,
      }) } : { name: 'search_memories', arguments: '{"query":"水彩"}' },
    }] } : { role: 'assistant', content: '固定回复' }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const payload of [
      { choices: [{ index: 0, delta, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: invoke ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } },
    ]) response.write('data: ' + JSON.stringify({
      id: `fixed-${received.length}`, object: 'chat.completion.chunk', created: 0, model: 'glm-5.3-flash', ...payload,
    }) + '\n\n')
    response.end('data: [DONE]\n\n')
  })
  const companion = openCompanionDatabase(':memory:')
  let eve: EveHandle | undefined
  let server: BackendServer | undefined
  try {
    await new Promise<void>((accept) => provider.listen(0, '127.0.0.1', accept))
    const address = provider.address()
    assert(address && typeof address !== 'string')
    runMigrations(companion.sqlite)
    const { db } = companion
    const { conversationId } = initializeFirstCharacter(db, {
      name: '测试角色', personaText: '固定性格', initialRelationship: '恋人', timezone: 'Asia/Hong_Kong',
    })
    const source = saveUserMessage(db, { conversationId, requestId: 'source', content: '我喜欢画水彩。' }).message
    assert.equal(saveCharacterMemory(db, {
      conversationId, kind: 'preference', memoryKey: null, content: '用户喜欢用水彩画动物。',
      origin: 'user_explicit', sourceMessageIds: [source.id], expiresAt: null, now: Date.now(),
    }).status, 'saved')
    const turns = createChatTurnService({
      getDb: () => db, getEve: () => eve, limits: { modelWindowTokens: 32_000 },
    })
    server = await startBackendServer('fixed-backend-test-token', {
      memoryTools: { getToken: () => eve?.token, execute: turns.executeMemoryTool },
    })
    eve = await startEve({
      appDir: resolve(process.cwd()), modelApiKey: 'fixed-native-test-key',
      modelBaseUrl: `http://127.0.0.1:${address.port}/v1`, memoryToolPort: server.port,
    })
    const formal = turns.startTurn({ conversationId, requestId: 'formal', content: '请帮我找一下画画的偏好。' })
    let formalEnd = ''
    for await (const frame of formal.events) formalEnd = frame.type
    assert.equal(formalEnd, 'done')
    assert.equal(received.length, 2)
    assert(received[0].tools?.some((tool) => tool.function?.name === 'search_memories'))
    const toolOutput = received[1].messages.find((message) => message.role === 'tool')
    assert(toolOutput && JSON.stringify(toolOutput.content).includes('用户喜欢用水彩画动物。'))

    const preview = turns.startPreviewTurn({ requestId: 'preview', content: '我喜欢用水彩画什么？',
      draft: { personaFullText: '试聊草稿', initialRelationship: '恋人' } })
    let previewEnd = ''
    for await (const frame of preview.events) previewEnd = frame.type
    assert.equal(previewEnd, 'done')
    assert.equal(received.length, 3)
    assert(!received[2].tools?.some((tool) => tool.function?.name === 'search_memories'))
    assert(!received[2].tools?.some((tool) => tool.function?.name === 'remember_explicit'))
    assert(!JSON.stringify(received[2].messages).includes('用户喜欢用水彩画动物。'))

    const write = turns.startTurn({ conversationId, requestId: 'remember', content: '以后叫我阿达。' })
    let visible = ''
    let writeEnd = ''
    let toolStatus = ''
    for await (const frame of write.events) {
      if (frame.type === 'text') visible += frame.delta
      if (frame.type === 'tool-status') toolStatus = frame.status
      writeEnd = frame.type
    }
    assert.equal(writeEnd, 'done')
    assert.equal(received.length, 5)
    assert(received[3].tools?.some((tool) => tool.function?.name === 'remember_explicit'))
    const writeOutput = received[4].messages.find((message) => message.role === 'tool')
    assert(writeOutput && JSON.stringify(writeOutput.content).includes('saved'))
    assert.equal(db.select().from(memories).where(eq(memories.memoryKey, 'preferred_name')).all().length, 1)
    assert.equal(visible, '固定回复')
    assert.equal(toolStatus, 'memory-saved')
    process.stdout.write(JSON.stringify({ formalRequests: 4, toolResults: 2, previewRequests: 1,
      previewMemoryTools: 0, memoriesSaved: 1, interimTextDisplayed: 0 }) + '\n')
  } finally {
    try { await eve?.stop() } finally { await server?.stop() }
    companion.close()
    provider.closeAllConnections()
    await new Promise<void>((accept) => provider.close(() => accept()))
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? `${error.message}\n` : 'E_NATIVE_TOOL_CHECK\n')
  process.exitCode = 1
})
