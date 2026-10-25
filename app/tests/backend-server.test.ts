/**
 * 后台服务最小行为检查（T01 / 03 §3）：
 * 随机端口、令牌认证、未认证拒绝、模型自测端点。
 * 使用固定输入与固定令牌，模型一律用注入的假函数——自动检查不真调付费接口（07 §3）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startBackendServer, type BackendServer } from '../src/service/server'

// 测试专用固定令牌，与生产生成的随机令牌无关
const TOKEN = 'test-fixed-token'

/** 全部用例共享的服务句柄，最后统一关闭 */
let server: BackendServer | undefined
/** 各用例自己开的额外服务，一并登记统一关闭 */
const extraServers: BackendServer[] = []

beforeAll(async () => {
  server = await startBackendServer(TOKEN)
})

afterAll(async () => {
  await server?.stop()
  for (const s of extraServers) await s.stop()
})

describe('后台服务监听', () => {
  it('绑定 127.0.0.1 的随机端口', () => {
    expect(server).toBeDefined()
    expect(server!.port).toBeGreaterThan(0)
    expect(server!.port).toBeLessThanOrEqual(65535)
  })
})

describe('后台服务认证', () => {
  it('携带正确令牌访问 /health 返回 200 与 ok:true', async () => {
    const res = await fetch(`http://127.0.0.1:${server!.port}/health`, {
      headers: { 'x-session-token': TOKEN },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('未带令牌返回 401', async () => {
    const res = await fetch(`http://127.0.0.1:${server!.port}/health`)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ ok: false, code: 'UNAUTHORIZED' })
  })

  it('令牌错误同样返回 401（不泄露令牌对错细节）', async () => {
    const res = await fetch(`http://127.0.0.1:${server!.port}/health`, {
      headers: { 'x-session-token': 'wrong-token' },
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ ok: false, code: 'UNAUTHORIZED' })
  })

  it('认证通过但路径不存在返回 404', async () => {
    const res = await fetch(`http://127.0.0.1:${server!.port}/no-such-path`, {
      headers: { 'x-session-token': TOKEN },
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ ok: false, code: 'NOT_FOUND' })
  })
})

describe('eve 自测端点 /agent/ping', () => {
  it('未认证时不会启动 Agent 调用', async () => {
    let calls = 0
    const fake = await startBackendServer(TOKEN, {
      modelApiKey: 'fake-key',
      pingAgent: async () => {
        calls += 1
        return { text: '收到', usage: undefined }
      },
    })
    extraServers.push(fake)
    const response = await fetch(`http://127.0.0.1:${fake.port}/agent/ping`)
    expect(response.status).toBe(401)
    expect(calls).toBe(0)
  })

  it('缺密钥与未启动 eve 都明确拒绝，不假装成功', async () => {
    const headers = { 'x-session-token': TOKEN }
    const noKey = await fetch(`http://127.0.0.1:${server!.port}/agent/ping`, { headers })
    expect(noKey.status).toBe(503)
    expect(await noKey.json()).toEqual({ ok: false, code: 'NO_KEY' })
    const withoutAgent = await startBackendServer(TOKEN, { modelApiKey: 'fake-key' })
    extraServers.push(withoutAgent)
    const noAgent = await fetch(`http://127.0.0.1:${withoutAgent.port}/agent/ping`, { headers })
    expect(await noAgent.json()).toEqual({ ok: false, code: 'AGENT_UNAVAILABLE' })
  })

  it('完整调用成功才返回文字与用量', async () => {
    const fake = await startBackendServer(TOKEN, {
      modelApiKey: 'fake-key',
      pingAgent: async (signal) => {
        expect(signal.aborted).toBe(false)
        return { text: '收到', usage: { inputTokens: 8, outputTokens: 2 } }
      },
    })
    extraServers.push(fake)
    const response = await fetch(`http://127.0.0.1:${fake.port}/agent/ping`, {
      headers: { 'x-session-token': TOKEN },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true, text: '收到', usage: { inputTokens: 8, outputTokens: 2 },
    })
  })

  it('失败只返回错误码，不泄露异常里的机密或提示词', async () => {
    const fake = await startBackendServer(TOKEN, {
      modelApiKey: 'fake-key',
      pingAgent: async () => { throw new Error('fake-key + 不应泄露的提示词') },
    })
    extraServers.push(fake)
    const response = await fetch(`http://127.0.0.1:${fake.port}/agent/ping`, {
      headers: { 'x-session-token': TOKEN },
    })
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ ok: false, code: 'AGENT_ERROR' })
  })
})

describe('运行期换密钥 /model/key', () => {
  const post = (port: number, body: unknown, token = TOKEN) =>
    fetch(`http://127.0.0.1:${port}/model/key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-token': token },
      body: JSON.stringify(body),
    })

  it('不带令牌返回 401，换钥函数不被触碰', async () => {
    let rotated = false
    const fake = await startBackendServer(TOKEN, {
      rotateModelKey: async () => { rotated = true },
    })
    extraServers.push(fake)
    const res = await fetch(`http://127.0.0.1:${fake.port}/model/key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'new-key' }),
    })
    expect(res.status).toBe(401)
    expect(rotated).toBe(false)
  })

  it('密钥缺失、空串或非字符串都按 400 INVALID_INPUT 回绝', async () => {
    const fake = await startBackendServer(TOKEN, { rotateModelKey: async () => {} })
    extraServers.push(fake)
    for (const body of [{}, { apiKey: '' }, { apiKey: 123 }, 'not-json']) {
      const res = await post(fake.port, body)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ ok: false, code: 'INVALID_INPUT' })
    }
  })

  it('合法输入：去掉首尾空白后原样交给换钥函数，返回 200', async () => {
    let received = ''
    const fake = await startBackendServer(TOKEN, {
      rotateModelKey: async (newKey) => { received = newKey },
    })
    extraServers.push(fake)
    const res = await post(fake.port, { apiKey: '  new-key-1  \r\n' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(received).toBe('new-key-1')
  })

  it('换钥失败返回 502 AGENT_ERROR，不转发异常内容', async () => {
    const fake = await startBackendServer(TOKEN, {
      rotateModelKey: async () => { throw new Error('内部路径不应泄露') },
    })
    extraServers.push(fake)
    const res = await post(fake.port, { apiKey: 'new-key' })
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ ok: false, code: 'AGENT_ERROR' })
  })

  it('未提供换钥能力时明确 503，不假装成功', async () => {
    const res = await post(server!.port, { apiKey: 'new-key' })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false, code: 'AGENT_UNAVAILABLE' })
  })
})

describe('数据库自测端点 /db/ping', () => {
  // 与 /model/key 相同的固定令牌访问方式
  const get = (port: number, token = TOKEN) =>
    fetch(`http://127.0.0.1:${port}/db/ping`, { headers: { 'x-session-token': token } })
  const post = (port: number, token = TOKEN) =>
    fetch(`http://127.0.0.1:${port}/db/ping`, { method: 'POST', headers: { 'x-session-token': token } })

  it('未带令牌返回 401，读写函数不被触碰', async () => {
    let touched = false
    const fake = await startBackendServer(TOKEN, {
      db: {
        readEpoch: () => { touched = true; return 0 },
        bumpEpoch: () => { touched = true; return 1 },
        // 本组用例只关心 epoch 函数；窗口位置、会话与角色函数放无害存根补齐接口
        readWindowState: () => undefined,
        writeWindowState: () => {},
        readFormalConversation: () => { touched = true; return null },
        readCharacterOverview: () => { touched = true; return undefined },
        readChatWindowState: () => { touched = true; return undefined },
        writeChatWindowState: () => { touched = true },
      },
    })
    extraServers.push(fake)
    for (const res of [await get(fake.port, 'wrong-token'), await post(fake.port, 'wrong-token')]) {
      expect(res.status).toBe(401)
    }
    expect(touched).toBe(false)
  })

  it('未接数据库时 GET 与 POST 都明确返回 503，不假装可用', async () => {
    // 共享的 server 启动时没传 db，正好代表「入口没接库」的状态
    const readRes = await get(server!.port)
    expect(readRes.status).toBe(503)
    expect(await readRes.json()).toEqual({ ok: false, code: 'DB_UNAVAILABLE' })
    const writeRes = await post(server!.port)
    expect(writeRes.status).toBe(503)
    expect(await writeRes.json()).toEqual({ ok: false, code: 'DB_UNAVAILABLE' })
  })

  it('GET 读到注入函数返回的当前值', async () => {
    const fake = await startBackendServer(TOKEN, {
      db: {
        readEpoch: () => 7,
        bumpEpoch: () => 8,
        readWindowState: () => undefined,
        writeWindowState: () => {},
        readFormalConversation: () => null,
        readCharacterOverview: () => undefined,
        readChatWindowState: () => undefined,
        writeChatWindowState: () => {},
      },
    })
    extraServers.push(fake)
    const res = await get(fake.port)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, globalMemoryEpoch: 7 })
  })

  it('POST 调用写入函数并返回新值', async () => {
    let bumped = 0
    const fake = await startBackendServer(TOKEN, {
      db: {
        readEpoch: () => bumped,
        bumpEpoch: () => (bumped += 1),
        readWindowState: () => undefined,
        writeWindowState: () => {},
        readFormalConversation: () => null,
        readCharacterOverview: () => undefined,
        readChatWindowState: () => undefined,
        writeChatWindowState: () => {},
      },
    })
    extraServers.push(fake)
    const res = await post(fake.port)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, globalMemoryEpoch: 1 })
    expect(bumped).toBe(1)
  })

  it('读写出错返回 502 DB_ERROR，不转发错误内容', async () => {
    const fake = await startBackendServer(TOKEN, {
      db: {
        readEpoch: () => { throw new Error('内部路径不应泄露') },
        bumpEpoch: () => { throw new Error('内部路径不应泄露') },
        readWindowState: () => { throw new Error('内部路径不应泄露') },
        writeWindowState: () => { throw new Error('内部路径不应泄露') },
        readFormalConversation: () => { throw new Error('内部路径不应泄露') },
        readCharacterOverview: () => { throw new Error('内部路径不应泄露') },
        readChatWindowState: () => { throw new Error('内部路径不应泄露') },
        writeChatWindowState: () => { throw new Error('内部路径不应泄露') },
      },
    })
    extraServers.push(fake)
    for (const res of [await get(fake.port), await post(fake.port)]) {
      expect(res.status).toBe(502)
      expect(await res.json()).toEqual({ ok: false, code: 'DB_ERROR' })
    }
  })
})

describe('窗口状态端点 /window-state（T02 位置恢复）', () => {
  const get = (port: number, token = TOKEN) =>
    fetch(`http://127.0.0.1:${port}/window-state`, { headers: { 'x-session-token': token } })
  const put = (port: number, body: unknown, token = TOKEN) =>
    fetch(`http://127.0.0.1:${port}/window-state`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-session-token': token },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  /** 省得每个用例都抄四遍注入函数：给两个可观察行为的假实现；
   *  其余端点的函数放无害存根补齐接口（本组不关心它们） */
  const fakeDb = (read: () => unknown, write: (value: unknown) => void) => ({
    readEpoch: () => 0,
    bumpEpoch: () => 1,
    readWindowState: read,
    writeWindowState: write as (value: never) => void,
    readFormalConversation: () => null,
    readCharacterOverview: () => undefined,
    readChatWindowState: () => undefined,
    writeChatWindowState: () => {},
  })

  it('未带令牌返回 401，读写函数不被触碰', async () => {
    let touched = false
    const fake = await startBackendServer(TOKEN, {
      db: fakeDb(
        () => { touched = true; return undefined },
        () => { touched = true },
      ),
    })
    extraServers.push(fake)
    const res = await fetch(`http://127.0.0.1:${fake.port}/window-state`)
    expect(res.status).toBe(401)
    expect(touched).toBe(false)
  })

  it('未接数据库时 GET 与 PUT 都返回 503，不假装可用', async () => {
    // 共享的 server 启动时没传 db，正好代表「入口没接库」的状态
    const readRes = await get(server!.port)
    expect(readRes.status).toBe(503)
    expect(await readRes.json()).toEqual({ ok: false, code: 'DB_UNAVAILABLE' })
    const writeRes = await put(server!.port, { x: 1, y: 2, width: 3, height: 4 })
    expect(writeRes.status).toBe(503)
    expect(await writeRes.json()).toEqual({ ok: false, code: 'DB_UNAVAILABLE' })
  })

  it('GET 返回注入函数读到的已存值；没存过时是 null', async () => {
    const saved = await startBackendServer(TOKEN, {
      db: fakeDb(() => ({ x: 10, y: 20, width: 200, height: 260 }), () => {}),
    })
    extraServers.push(saved)
    const res = await get(saved.port)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, state: { x: 10, y: 20, width: 200, height: 260 } })

    const empty = await startBackendServer(TOKEN, {
      db: fakeDb(() => undefined, () => {}),
    })
    extraServers.push(empty)
    const res2 = await get(empty.port)
    expect(await res2.json()).toEqual({ ok: true, state: null })
  })

  it('PUT 合法输入整体交给写入函数并返回 200', async () => {
    let written: unknown
    const fake = await startBackendServer(TOKEN, {
      db: fakeDb(() => undefined, (value) => { written = value }),
    })
    extraServers.push(fake)
    const res = await put(fake.port, { x: -5, y: 0, width: 400, height: 520 })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(written).toEqual({ x: -5, y: 0, width: 400, height: 520 })
  })

  it('PUT 缺字段/类型错/非正宽高/小数/多余字段/非 JSON 一律 400', async () => {
    const fake = await startBackendServer(TOKEN, {
      db: fakeDb(() => undefined, () => {}),
    })
    extraServers.push(fake)
    const badBodies = [
      {},
      { x: 1, y: 2, width: 3 },
      { x: 'a', y: 2, width: 3, height: 4 },
      { x: 1, y: 2, width: -3, height: 4 },
      { x: 1, y: 2, width: 0, height: 4 },
      { x: 1.5, y: 2, width: 3, height: 4 },
      { x: 1, y: 2, width: 3, height: 4, extra: 1 },
      'not-json',
    ]
    for (const body of badBodies) {
      const res = await put(fake.port, body)
      expect(res.status, `请求体 ${JSON.stringify(body)} 应被回绝`).toBe(400)
      expect(await res.json()).toEqual({ ok: false, code: 'INVALID_INPUT' })
    }
  })

  it('读写函数抛错返回 502 DB_ERROR，不转发错误内容', async () => {
    const fake = await startBackendServer(TOKEN, {
      db: fakeDb(
        () => { throw new Error('内部路径不应泄露') },
        () => { throw new Error('内部路径不应泄露') },
      ),
    })
    extraServers.push(fake)
    const readRes = await get(fake.port)
    expect(readRes.status).toBe(502)
    expect(await readRes.json()).toEqual({ ok: false, code: 'DB_ERROR' })
    const writeRes = await put(fake.port, { x: 1, y: 2, width: 3, height: 4 })
    expect(writeRes.status).toBe(502)
    expect(await writeRes.json()).toEqual({ ok: false, code: 'DB_ERROR' })
  })
})

describe('正式会话端点 /formal-conversation（T04 应用接口）', () => {
  const get = (port: number, token = TOKEN) =>
    fetch(`http://127.0.0.1:${port}/formal-conversation`, {
      headers: { 'x-session-token': token },
    })

  it('未带令牌返回 401', async () => {
    const res = await fetch(`http://127.0.0.1:${server!.port}/formal-conversation`)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ ok: false, code: 'UNAUTHORIZED' })
  })

  it('未接数据库时明确 503，不假装可用', async () => {
    // 共享的 server 启动时没传 db，正好代表「入口没接库」的状态
    const res = await get(server!.port)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false, code: 'DB_UNAVAILABLE' })
  })

  it('已初始化时返回角色与会话信息（框架 ID 可为 null）', async () => {
    const fake = await startBackendServer(TOKEN, {
      db: {
        readEpoch: () => 0,
        bumpEpoch: () => 1,
        readWindowState: () => undefined,
        writeWindowState: () => {},
        readFormalConversation: () => ({
          characterId: 'char-x',
          conversationId: 'conv-x',
          runtimeSessionId: null,
          contextEpoch: 0,
        }),
        readCharacterOverview: () => undefined,
        readChatWindowState: () => undefined,
        writeChatWindowState: () => {},
      },
    })
    extraServers.push(fake)
    const res = await get(fake.port)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      conversation: {
        characterId: 'char-x',
        conversationId: 'conv-x',
        runtimeSessionId: null,
        contextEpoch: 0,
      },
    })
  })

  it('还没初始化角色时 conversation 明确为 null，不是 500', async () => {
    const fake = await startBackendServer(TOKEN, {
      db: {
        readEpoch: () => 0,
        bumpEpoch: () => 1,
        readWindowState: () => undefined,
        writeWindowState: () => {},
        readFormalConversation: () => null,
        readCharacterOverview: () => undefined,
        readChatWindowState: () => undefined,
        writeChatWindowState: () => {},
      },
    })
    extraServers.push(fake)
    const res = await get(fake.port)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, conversation: null })
  })

  it('读函数抛错返回 502 DB_ERROR，不转发错误内容', async () => {
    const fake = await startBackendServer(TOKEN, {
      db: {
        readEpoch: () => 0,
        bumpEpoch: () => 1,
        readWindowState: () => undefined,
        writeWindowState: () => {},
        readFormalConversation: () => { throw new Error('内部路径不应泄露') },
        readCharacterOverview: () => { throw new Error('内部路径不应泄露') },
        readChatWindowState: () => { throw new Error('内部路径不应泄露') },
        writeChatWindowState: () => { throw new Error('内部路径不应泄露') },
      },
    })
    extraServers.push(fake)
    const res = await get(fake.port)
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ ok: false, code: 'DB_ERROR' })
  })
})

describe('模型自测端点 /model/ping', () => {
  it('未配置密钥返回 503 NO_KEY', async () => {
    const res = await fetch(`http://127.0.0.1:${server!.port}/model/ping`, {
      headers: { 'x-session-token': TOKEN },
    })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false, code: 'NO_KEY' })
  })

  it('注入假模型函数：返回 200 与固定回复，且密钥原样传给模型层', async () => {
    let receivedKey = ''
    let receivedPrompt = ''
    const fake = await startBackendServer(TOKEN, {
      modelApiKey: 'fake-key-123',
      callModel: async (key, prompt) => {
        receivedKey = key
        receivedPrompt = prompt
        return { text: '收到', usage: { inputTokens: 5, outputTokens: 2 } }
      },
    })
    extraServers.push(fake)
    const res = await fetch(`http://127.0.0.1:${fake.port}/model/ping`, {
      headers: { 'x-session-token': TOKEN },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      text: '收到',
      usage: { inputTokens: 5, outputTokens: 2 },
    })
    // 验证密钥从服务层原样到达模型连接层（管道没丢没改）
    expect(receivedKey).toBe('fake-key-123')
    expect(receivedPrompt).toBe('请只回复两个字：收到')
  })

  it('模型函数抛错时返回 502 MODEL_ERROR 并带原因', async () => {
    const fake = await startBackendServer(TOKEN, {
      modelApiKey: 'fake-key-123',
      callModel: async () => {
        throw new Error('模拟供应商断线')
      },
    })
    extraServers.push(fake)
    const res = await fetch(`http://127.0.0.1:${fake.port}/model/ping`, {
      headers: { 'x-session-token': TOKEN },
    })
    expect(res.status).toBe(502)
    const body = (await res.json()) as { ok: boolean; code: string; message: string }
    expect(body.ok).toBe(false)
    expect(body.code).toBe('MODEL_ERROR')
    expect(body.message).toContain('模拟供应商断线')
  })

  it('不带令牌打 /model/ping 同样 401', async () => {
    const res = await fetch(`http://127.0.0.1:${server!.port}/model/ping`)
    expect(res.status).toBe(401)
  })
})

describe('角色编辑端点 /character（T05，01 R05）', () => {
  const get = (port: number, token = TOKEN) =>
    fetch(`http://127.0.0.1:${port}/character`, { headers: { 'x-session-token': token } })

  it('未带令牌返回 401，读函数不被触碰', async () => {
    let touched = false
    const fake = await startBackendServer(TOKEN, {
      db: {
        readEpoch: () => 0,
        bumpEpoch: () => 1,
        readWindowState: () => undefined,
        writeWindowState: () => {},
        readFormalConversation: () => null,
        readCharacterOverview: () => { touched = true; return undefined },
        readChatWindowState: () => undefined,
        writeChatWindowState: () => {},
      },
    })
    extraServers.push(fake)
    const res = await fetch(`http://127.0.0.1:${fake.port}/character`)
    expect(res.status).toBe(401)
    expect(touched).toBe(false)
  })

  it('未接数据库时明确 503', async () => {
    const res = await get(server!.port)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false, code: 'DB_UNAVAILABLE' })
  })

  it('返回注入的完整概览（当前版本 + 版本列表）', async () => {
    const overview = {
      characterId: 'char-x',
      name: '六花',
      desktopImagePath: null,
      portraitImagePath: 'characters/char-x/portrait.png',
      activeVersion: {
        versionNo: 2,
        personaText: '【核心性格】\n认真维护幻想小世界。',
        initialRelationship: '已经确定恋人关系',
        userNickname: '阿达',
        dialogueExamples: [
          { scene: '分享开心的事', user: '界面弄完了。', character: '结界突破了。' },
        ],
      },
      versions: [
        { versionNo: 2, isActive: true, createdAt: 1740000100000 },
        { versionNo: 1, isActive: false, createdAt: 1740000000000 },
      ],
    }
    const fake = await startBackendServer(TOKEN, {
      db: {
        readEpoch: () => 0,
        bumpEpoch: () => 1,
        readWindowState: () => undefined,
        writeWindowState: () => {},
        readFormalConversation: () => null,
        readCharacterOverview: () => overview,
        readChatWindowState: () => undefined,
        writeChatWindowState: () => {},
      },
    })
    extraServers.push(fake)
    const res = await get(fake.port)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, character: overview })
  })

  it('读函数抛错返回 502，不转发错误内容', async () => {
    const fake = await startBackendServer(TOKEN, {
      db: {
        readEpoch: () => 0,
        bumpEpoch: () => 1,
        readWindowState: () => undefined,
        writeWindowState: () => {},
        readFormalConversation: () => null,
        readCharacterOverview: () => { throw new Error('内部路径不应泄露') },
        readChatWindowState: () => undefined,
        writeChatWindowState: () => {},
      },
    })
    extraServers.push(fake)
    const res = await get(fake.port)
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ ok: false, code: 'DB_ERROR' })
  })
})

describe('聊天窗口状态端点 /chat-window-state（T05 位置保存）', () => {
  const get = (port: number, token = TOKEN) =>
    fetch(`http://127.0.0.1:${port}/chat-window-state`, { headers: { 'x-session-token': token } })
  const put = (port: number, body: unknown, token = TOKEN) =>
    fetch(`http://127.0.0.1:${port}/chat-window-state`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-session-token': token },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })

  it('GET 未存过返回 state:null；PUT 合法值写入且函数收到解析后的对象', async () => {
    let saved: unknown
    const fake = await startBackendServer(TOKEN, {
      db: {
        readEpoch: () => 0,
        bumpEpoch: () => 1,
        readWindowState: () => undefined,
        writeWindowState: () => {},
        readFormalConversation: () => null,
        readCharacterOverview: () => undefined,
        readChatWindowState: () => (saved ?? undefined),
        writeChatWindowState: (value) => { saved = value },
      },
    })
    extraServers.push(fake)
    const first = await get(fake.port)
    expect(await first.json()).toEqual({ ok: true, state: null })

    const payload = { x: 120, y: 80, width: 980, height: 640, maximized: false }
    const putRes = await put(fake.port, payload)
    expect(putRes.status).toBe(200)
    expect(await putRes.json()).toEqual({ ok: true })
    // 写入函数收到的是过完 Zod 关卡的对象，不是原始 JSON 字符串
    expect(saved).toEqual(payload)

    const second = await get(fake.port)
    expect(await second.json()).toEqual({ ok: true, state: payload })
  })

  it('缺 maximized 或负尺寸过不了格式关卡，返回 400 不写入', async () => {
    let writes = 0
    const fake = await startBackendServer(TOKEN, {
      db: {
        readEpoch: () => 0,
        bumpEpoch: () => 1,
        readWindowState: () => undefined,
        writeWindowState: () => {},
        readFormalConversation: () => null,
        readCharacterOverview: () => undefined,
        readChatWindowState: () => undefined,
        writeChatWindowState: () => { writes += 1 },
      },
    })
    extraServers.push(fake)
    for (const bad of [
      { x: 1, y: 1, width: 100, height: 100 }, // 缺 maximized
      { x: 1, y: 1, width: -5, height: 100, maximized: false }, // 尺寸非正
      { x: 1.5, y: 1, width: 100, height: 100, maximized: false }, // 坐标非整数
      '不是对象',
    ]) {
      const res = await put(fake.port, bad)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ ok: false, code: 'INVALID_INPUT' })
    }
    expect(writes).toBe(0)
  })

  it('写入失败返回 502，不假装成功（01 R17）', async () => {
    const fake = await startBackendServer(TOKEN, {
      db: {
        readEpoch: () => 0,
        bumpEpoch: () => 1,
        readWindowState: () => undefined,
        writeWindowState: () => {},
        readFormalConversation: () => null,
        readCharacterOverview: () => undefined,
        readChatWindowState: () => undefined,
        writeChatWindowState: () => { throw new Error('库写入失败') },
      },
    })
    extraServers.push(fake)
    const res = await put(fake.port, { x: 0, y: 0, width: 100, height: 100, maximized: true })
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ ok: false, code: 'DB_ERROR' })
  })
})
