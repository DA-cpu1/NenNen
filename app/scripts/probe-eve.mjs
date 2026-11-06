/**
 * T01 完整链路检查：真实后台进程和 eve 配本机假供应商，固定回复、零付费调用。
 * 连续启动两次：第一次含「运行期换密钥」（供应商只认新密钥后后台整体换 eve）；
 * 两次分别验证正常关闭和强制结束后台时密钥重传与 eve 无残留；
 * 两轮共用同一个数据库文件：第一轮写入的值，第二轮重启后必须原样读到。
 * --packaged 改用实际随包 exe 和归档入口，防止开发态能跑、安装后却缺文件。
 * --package-dir 可指定从安装包解出的目录，复查最终交付的文件，而不安装到用户目录。
 * --memory 让正式长消息触发整理，并在第二次启动检查同一来源和记忆是否用于聊天。
 * --memory-management 检查真实纠正工具、忘记中止旧流及两次重启，仍只使用本机固定供应商。
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn, execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, resolve, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const appDir = resolve(import.meta.dirname, '..')
const packageDirIndex = process.argv.indexOf('--package-dir')
if (packageDirIndex >= 0 && !process.argv[packageDirIndex + 1]) throw new Error('E_PACKAGE_DIRECTORY_REQUIRED')
const packaged = process.argv.includes('--packaged') || packageDirIndex >= 0
const checkMemory = process.argv.includes('--memory')
const checkManagement = process.argv.includes('--memory-management')
const packageDir = packageDirIndex >= 0
  ? resolve(process.argv[packageDirIndex + 1]) : join(appDir, 'release/win-unpacked')
const runtimeDir = packaged ? join(packageDir, 'resources/app.asar.unpacked') : appDir
const executable = packaged ? join(packageDir, '二次元女友.exe') : process.execPath
const runtimeProcessName = packaged ? '二次元女友.exe' : 'node.exe'
const serviceEntry = packaged
  ? join(packageDir, 'resources/app.asar/out/main/service.js')
  : join(appDir, 'out/main/service.js')
// 两轮共用的临时数据库目录，结束时整体删除。放系统临时目录而不是仓库里：
// 数据库开着 WAL 模式，旁边会多出 -wal/-shm 两个附属文件，别让它们混进项目
const dbDir = await mkdtemp(join(tmpdir(), 'companion-db-probe-'))
const dbPath = join(dbDir, 'probe.db')
// 这些只是测试库里的固定相对路径，检查升级重启会不会把两张图片的设置丢掉。
const imagePaths = {
  desktopImagePath: 'characters/package-probe/desktop-fixed.png',
  portraitImagePath: 'characters/package-probe/portrait-fixed.png',
}
const probeStartedAt = Date.now() - 1_000 // 给文件时间戳的取整留一秒。
// 两把假密钥：A 是开机的，B 是运行期换上的
const modelKeyA = randomBytes(32).toString('base64url')
const modelKeyB = randomBytes(32).toString('base64url')
const tokens = [randomBytes(32).toString('base64url'), randomBytes(32).toString('base64url')]
// 供应商当前认的密钥；换钥测试时切到 B，模拟「旧密钥已在供应商侧作废」
let acceptedKey = modelKeyA
let calls = 0
let authenticatedCalls = 0
let toolCount = 0
let logs = ''
let memoryCalls = 0
let restartedChatUsedMemory = false
const memoryContent = '用户喜欢用水彩画植物。'
const correctedContent = '用户现在用彩铅画植物。'
const correctionRequest = '我以前用水彩画植物，现在改成彩铅。'
const holdingRequest = '我现在用什么画植物？'
const cleanRequest = '我们聊过哪些画画资料？'
let correctedWasUsed = false
let cleanInputChecked = false

/** 输出 OpenAI 兼容的一帧，真实 eve 负责解包文字与工具调用。 */
function providerFrame(response, payload) {
  response.write(`data: ${JSON.stringify({ id: 'fixed-test', object: 'chat.completion.chunk', created: 0, model: 'glm-5.3-flash', ...payload })}\n\n`)
}

// 假供应商：只认当前密钥，返回固定的 OpenAI 兼容文字流
const provider = createServer(async (request, response) => {
  let body = ''
  request.setEncoding('utf8')
  for await (const chunk of request) body += chunk
  const parsed = JSON.parse(body)
  const batch = parsed.messages.find(({ role, content }) => role === 'user' &&
    typeof content === 'string' && content.startsWith('{"sources":'))
  if (batch) memoryCalls += 1
  else calls += 1
  if (request.headers.authorization !== `Bearer ${acceptedKey}`) {
    // 模拟真实供应商的 401 口吻；不含任何密钥内容
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { code: '1001', message: '无效的API密钥' } }))
    return
  }
  if (batch) {
    const { sources } = JSON.parse(batch.content)
    const source = sources.find(({ content }) => content.startsWith('我喜欢用水彩画植物。'))
    assert.ok((checkMemory || checkManagement) && source && sources.length === 1 && !parsed.stream)
    assert.equal(parsed.max_tokens ?? parsed.max_completion_tokens, 2_048)
    const content = JSON.stringify({ candidates: [{ action: 'add', kind: 'preference', memoryKey: null,
      content: memoryContent, sourceMessageIds: [source.id], expiresAt: null, replacesMemoryId: null }] })
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ id: 'fixed-memory', object: 'chat.completion', created: 0, model: 'glm-5.3-flash',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 18, completion_tokens: 6, total_tokens: 24 } }))
    return
  }
  authenticatedCalls += 1
  if (parsed.messages.some(({ role, content }) => role === 'system' &&
      typeof content === 'string' && content.startsWith('以下是用户资料') && content.includes(memoryContent))) {
    restartedChatUsedMemory = parsed.tools?.some((tool) => tool.function?.name === 'search_memories') === true
  }
  // 检查实际eve发出的HTTP请求，避免只改后台而仍被框架塞回旧的输出额度。
  assert.equal(parsed.max_tokens, undefined, '产品请求不应设置应用输出上限')
  assert.equal(parsed.max_completion_tokens, undefined, '产品请求不应设置另一种输出上限字段')
  const offered = parsed.tools ?? []
  const lastUser = parsed.messages.findLast(({ role }) => role === 'user')?.content
  if (checkManagement && lastUser === correctionRequest) {
    assert.ok(offered.some((tool) => tool.function?.name === 'correct_memory'))
    const toolResult = parsed.messages.find(({ role }) => role === 'tool')
    const currentId = parsed.messages.find(({ role, content }) => role === 'system' &&
      content.includes('仅供本轮记忆修改工具使用'))?.content.match(/：([^\s]+)$/u)?.[1]
    assert.ok(currentId)
    const found = toolResult && JSON.parse(toolResult.content).memories[0]
    const operation = found ? { name: 'correct_memory', arguments: JSON.stringify({
      memoryId: found.id, expectedRevision: found.revision, sourceMessageId: currentId, content: correctedContent,
    }) } : { name: 'search_memories', arguments: '{"query":"水彩画植物"}' }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    providerFrame(response, { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [
      { index: 0, id: `fixed-${operation.name}`, type: 'function', function: operation },
    ] }, finish_reason: null }] })
    providerFrame(response, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } })
    response.end('data: [DONE]\n\n')
    return
  }
  if (checkManagement && lastUser === holdingRequest) {
    const system = parsed.messages.filter(({ role }) => role === 'system').map(({ content }) => content).join('\n')
    correctedWasUsed = system.includes(correctedContent) && !system.includes(memoryContent)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    providerFrame(response, { choices: [{ index: 0, delta: { role: 'assistant', content: '已收到半截' }, finish_reason: null }] })
    // 留出确定的窗口，让管理请求在旧流尚未结束时修改资料。
    const timer = setTimeout(() => {
      providerFrame(response, { choices: [{ index: 0, delta: { content: '不应显示的晚到片段' }, finish_reason: 'stop' }] })
      response.end('data: [DONE]\n\n')
    }, 8_000)
    response.once('close', () => clearTimeout(timer))
    return
  }
  if (checkManagement && lastUser === cleanRequest) {
    const text = JSON.stringify(parsed.messages)
    cleanInputChecked = ![memoryContent, correctedContent, correctionRequest, '我喜欢用水彩画植物。', '已收到半截']
      .some((old) => text.includes(old))
  }
  // C15 已取消保存关键词门槛：正式回合可以自主选择保存，固定供应商仍只返回文字。
  // 只放行检索和普通保存；纠正、忘记等修改工具没有本轮授权仍不能出现。
  assert.ok(offered.every((tool) => ['search_memories', 'remember_explicit'].includes(tool.function?.name)))
  toolCount += offered.length
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const payload of [
    { choices: [{ index: 0, delta: { role: 'assistant', content: '收到' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } },
  ]) providerFrame(response, payload)
  response.end('data: [DONE]\n\n')
})

/** 只读临时库，确认来源、整理书签和用量都已经写入，避免只测到模型返回。 */
async function verifyMemory() {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const query = db.prepare(`SELECT m.content, msg.client_request_id, c.last_processed_seq, msg.seq,
      r.input_tokens, r.output_tokens, r.usage_estimated
      FROM memories m JOIN memory_sources s ON s.memory_id = m.id JOIN messages msg ON msg.id = s.message_id
      JOIN conversations c ON c.id = msg.conversation_id
      JOIN agent_runs r ON r.conversation_id = c.id AND r.trigger_type = 'memory' AND r.status = 'completed'`)
    let rows = query.all()
    for (let attempt = 0; attempt < 100 && rows.length === 0; attempt += 1) {
      await delay(50)
      rows = query.all()
    }
    assert.equal(rows.length, 1)
    const row = rows[0]
    assert.ok(row.content === memoryContent && row.client_request_id === 'package-probe-0')
    assert.equal(row.last_processed_seq, row.seq)
    assert.deepEqual([row.input_tokens, row.output_tokens, row.usage_estimated], [18, 6, 0])
    assert.equal(memoryCalls, 1)
  } finally {
    db.close()
  }
}

/** 查找后台的直接子进程编号；本项目的目标平台是 Windows。 */
async function childPids(parentPid) {
  // Windows 还可能创建 conhost.exe（控制台辅助进程）；它不是第二个 eve。
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command',
    `@(Get-CimInstance Win32_Process -Filter "ParentProcessId = ${parentPid} AND Name = '${runtimeProcessName}'" | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress`], { timeout: 15_000, windowsHide: true })
  const parsed = stdout.trim() ? JSON.parse(stdout) : []
  return Array.isArray(parsed) ? parsed : [parsed]
}

/** 判断特定进程是否仍存在，不按进程名字批量结束其他程序。 */
function isAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** 检查运行文件是否出现假密钥或后台令牌，只输出命中文件数。 */
async function secretFiles(directory) {
  let matches = 0
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) matches += await secretFiles(path)
    else if (entry.isFile()) {
      // 这两把随机假密钥刚生成，旧文件不可能含它们；只读本次新建或更新的文件。
      const info = await stat(path)
      if (info.mtimeMs < probeStartedAt) continue
      const content = await readFile(path)
      if ([modelKeyA, modelKeyB, ...tokens].some((secret) => content.includes(secret))) matches += 1
    }
  }
  return matches
}

/** 启动真实业务后台，以两行 stdin 交付假机密，并等 READY。
 *  数据库路径走命令行参数（不是机密，不占密钥管子），两轮传同一个文件。 */
async function boot(token, modelKey, providerPort) {
  const child = spawn(executable, [serviceEntry, '--db', dbPath], {
    cwd: appDir,
    env: {
      ...process.env,
      ...(packaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      COMPANION_MODEL_BASE_URL: `http://127.0.0.1:${providerPort}/v1`,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdin.on('error', () => {})
  try {
    const port = await new Promise((accept, reject) => {
      let buffer = ''
      const timer = setTimeout(() => reject(new Error('E_READY_TIMEOUT')), 20_000)
      child.once('exit', () => { clearTimeout(timer); reject(new Error('E_BACKEND_EXIT')) })
      child.once('error', () => { clearTimeout(timer); reject(new Error('E_BACKEND_SPAWN')) })
      child.stdout.on('data', (chunk) => {
        const text = chunk.toString()
        logs += text
        buffer += text
        const match = /^READY (\d+)\r?\n/.exec(buffer)
        if (match) { clearTimeout(timer); accept(Number(match[1])) }
      })
      child.stderr.on('data', (chunk) => { logs += chunk.toString() })
      // 发送端明确分行，不依赖密钥文本末尾是否有换行。
      child.stdin.write(`${token}\n${modelKey}\n`)
    })
    return { child, port }
  } catch (error) {
    child.kill()
    throw error
  }
}

/** 三轮打开真实后台，分别验证纠正、回合中忘记和重新打开后的干净输入。 */
async function verifyMemoryManagement(providerPort) {
  const runtime = `${dbPath}.eve`
  const oldSources = ['package-probe-0', 't08-correct']
  for (let round = 0; round < 3; round += 1) {
    const token = tokens[round % tokens.length]
    const { child, port } = await boot(token, modelKeyA, providerPort)
    const call = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { 'x-session-token': token, 'content-type': 'application/json' }, method: body ? 'POST' : 'GET',
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000),
    })
    try {
      const { conversation } = await (await call('/formal-conversation')).json()
      const chat = (requestId, content) => call('/chat/turn', { conversationId: conversation.conversationId, requestId, content })
      const [runDir] = await readdir(runtime)
      assert.equal((await readdir(runtime)).length, 1)
      if (round === 0) {
        const initial = await chat(oldSources[0], '我喜欢用水彩画植物。' + '中'.repeat(6_001))
        assert.ok((await initial.text()).includes('"type":"done"'))
        await verifyMemory()
        const events = await (await chat(oldSources[1], correctionRequest)).text()
        const frames = [...events.matchAll(/^data: (.*)$/gm)].map(([, json]) => JSON.parse(json))
        const cleanupErrors = logs.match(/^E_[A-Z_]+$/gm)?.join(',') ?? ''
        assert.ok(frames.some(({ status }) => status === 'memory-corrected'),
          `A11 缺少纠正回执（请求数 ${calls}，帧 ${frames.map(({ type, code }) => code ?? type).join(',')}，后台 ${cleanupErrors}）`)
        assert.ok(events.includes('"type":"cancelled"') && !events.includes('"type":"done"'))
        assert.equal((await readdir(runtime)).length, 1)
        assert.ok(!(await readdir(runtime)).includes(runDir), '纠正回执发出前旧 eve 文件已删除')
        console.log(JSON.stringify({ case: 'A11', nativeTool: true, oldRuntimeRemoved: true }))
      } else if (round === 1) {
        const list = await (await call('/memory')).json()
        const [corrected] = list.memories.filter(({ status }) => status === 'active')
        assert.equal(corrected.content, correctedContent)
        assert.deepEqual(list.memories.filter(({ status }) => status === 'superseded').map(({ content }) => content), [memoryContent])
        const stream = await chat('t08-holding', holdingRequest)
        const reader = stream.body.getReader()
        const decoder = new TextDecoder()
        let events = ''
        while (!events.includes('已收到半截')) {
          const item = await reader.read()
          assert.equal(item.done, false)
          events += decoder.decode(item.value, { stream: true })
        }
        assert.ok(correctedWasUsed)
        const forgot = await (await call('/memory', { action: 'forget', requestId: randomUUID(), memoryId: corrected.id,
          expectedRevision: corrected.revision, deleteSources: false })).json()
        assert.equal(forgot.ok, true)
        assert.equal(forgot.receipt.affectedMemories, 2)
        for (let item = await reader.read(); !item.done; item = await reader.read()) events += decoder.decode(item.value, { stream: true })
        assert.ok(events.includes('"type":"cancelled"') && !events.includes('不应显示的晚到片段'))
        assert.equal((await readdir(runtime)).length, 1)
        assert.ok(!(await readdir(runtime)).includes(runDir))
        // 模拟硬退出留下待清理文件。下一次启动必须只从 SQLite 重建。
        const residue = await mkdtemp(join(runtime, 'run-'))
        await writeFile(join(residue, 'fixed-residue.txt'), memoryContent)
        console.log(JSON.stringify({ case: 'A12', oldReplyStopped: true, correctedValueUsedAfterRestart: true, oldRuntimeRemoved: true }))
      } else {
        const { memories } = await (await call('/memory')).json()
        assert.deepEqual(memories, [])
        const events = await (await chat('t08-clean', cleanRequest)).text()
        assert.ok(events.includes('"type":"done"') && cleanInputChecked)
        const db = new DatabaseSync(dbPath, { readOnly: true })
        try {
          const sources = db.prepare('SELECT excluded_from_context FROM messages WHERE client_request_id IN (?,?)').all(...oldSources)
          assert.equal(sources.length, 2)
          assert.ok(sources.every(({ excluded_from_context }) => excluded_from_context === 1))
          assert.equal(db.prepare("SELECT count(*) n FROM memories WHERE content <> ''").get().n, 0)
          assert.equal(db.prepare("SELECT status FROM messages WHERE reply_to_id = (SELECT id FROM messages WHERE client_request_id = 't08-holding')").get().status, 'cancelled')
        } finally { db.close() }
        assert.equal(memoryCalls, 1)
        console.log(JSON.stringify({ case: 'A12', restartClearedOldRuntime: true, oldHistoryExcluded: 2, noOldContext: true, memoryCalls }))
      }
    } finally {
      const exited = once(child, 'exit')
      if (round === 1) child.kill()
      else child.stdin.end()
      await exited
      // 硬退出时 eve 用父进程检查退场，确认它已离开才开始下一轮。
      if (round === 1) await delay(700)
    }
  }
}

provider.listen(0, '127.0.0.1')
await once(provider, 'listening')
try {
  if (checkManagement) await verifyMemoryManagement(provider.address().port)
  let expectedCalls = 0
  for (let index = 0; !checkManagement && index < 2; index += 1) {
    // 每轮开机前供应商都回到「只认 A」：第二轮是纯重启测试，
    // 不该被上一轮换钥测试留下的状态影响
    acceptedKey = modelKeyA
    const { child, port } = await boot(tokens[index], modelKeyA, provider.address().port)
    let pids = []
    try {
      pids = await childPids(child.pid)
      assert.equal(pids.length, 1, '后台应只有一个 eve 子进程')
      const url = `http://127.0.0.1:${port}`
      const noToken = await fetch(`${url}/agent/ping`)
      assert.equal(noToken.status, 401)
      const wrongToken = await fetch(`${url}/agent/ping`, { headers: { 'x-session-token': index ? tokens[0] : 'wrong' } })
      assert.equal(wrongToken.status, 401)
      const started = Date.now()
      const response = await fetch(`${url}/agent/ping`, {
        headers: { 'x-session-token': tokens[index] }, signal: AbortSignal.timeout(35_000),
      })
      const pingResult = await response.json()
      assert.equal(response.status, 200, JSON.stringify({ code: pingResult.code }))
      assert.deepEqual(pingResult, { ok: true, text: '收到', usage: { inputTokens: 8, outputTokens: 2 } })
      // 每个实际请求都单独累计，避免少跑一步却误报整条链路通过。
      expectedCalls += 1
      assert.equal(calls, expectedCalls, '模拟模型请求数应与预期完全一致')
      console.log(JSON.stringify({ run: index + 1, unauthorized: 401, wrongOrOldToken: 401, replyMatches: true, inputTokens: 8, outputTokens: 2, elapsedMs: Date.now() - started }))

      // ── 数据库持久化：第一轮写入业务值，第二轮重启后必须原样读到 ──
      const dbRead = await fetch(`${url}/db/ping`, { headers: { 'x-session-token': tokens[index] } })
      assert.equal(dbRead.status, 200)
      const dbState = await dbRead.json()
      if (index === 0) {
        // 全新库：迁移建好 app_state 初始行，版本号从 0 开始
        assert.deepEqual(dbState, { ok: true, globalMemoryEpoch: 0 })
        const dbWrite = await fetch(`${url}/db/ping`, { method: 'POST', headers: { 'x-session-token': tokens[index] } })
        assert.equal(dbWrite.status, 200)
        assert.deepEqual(await dbWrite.json(), { ok: true, globalMemoryEpoch: 1 })
        console.log(JSON.stringify({ run: 1, dbInitial: 0, dbWritten: 1 }))
      } else {
        // 上一轮的后台进程已整个退出：这里仍读到 1，才证明值写在文件里
        // 而不是只活在内存里（T01 持久化验收的核心断言）
        assert.deepEqual(dbState, { ok: true, globalMemoryEpoch: 1 }, '重启后必须读到上一轮写入的值')
        console.log(JSON.stringify({ run: 2, dbPersisted: 1 }))
      }

      // 角色读取失败正是本次用户看到的症状；图片路径也必须跨后台重启保留。
      const headers = { 'x-session-token': tokens[index] }
      const characterResponse = await fetch(`${url}/character`, { headers })
      assert.equal(characterResponse.status, 200)
      const { character } = await characterResponse.json()
      assert.ok(character.activeVersion.personaText.trim())
      if (index === 0) {
        const savedImages = await fetch(`${url}/character/images`, {
          method: 'PUT', headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify(imagePaths),
        })
        assert.equal(savedImages.status, 200)
      } else {
        assert.equal(character.desktopImagePath, imagePaths.desktopImagePath)
        assert.equal(character.portraitImagePath, imagePaths.portraitImagePath)
      }
      const conversationResponse = await fetch(`${url}/formal-conversation`, { headers })
      assert.equal(conversationResponse.status, 200)
      const { conversation } = await conversationResponse.json()
      // 还要跑正式聊天，而不只跑固定连通探针；固定输入与回复都不打印到日志。
      // 第一轮仍覆盖超过旧输入额度。普通探针的第二轮用短句，以免碰到累计整理条件。
      const content = checkMemory
        ? (index === 0 ? '我喜欢用水彩画植物。' + '中'.repeat(6_001) : '我平常用哪种水彩画植物？')
        : (index === 0 ? '中'.repeat(5_000) : '收到')
      const chatResponse = await fetch(`${url}/chat/turn`, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId: conversation.conversationId,
          requestId: `package-probe-${index}`, content }),
        signal: AbortSignal.timeout(35_000),
      })
      assert.equal(chatResponse.status, 200)
      const chatEvents = await chatResponse.text()
      assert.ok(chatEvents.includes('"type":"done"'), JSON.stringify({
        eventTypes: [...chatEvents.matchAll(/"type":"([a-z-]+)"/g)].map((match) => match[1]),
        errorCodes: [...chatEvents.matchAll(/"code":"([A-Z_]+)"/g)].map((match) => match[1]),
      }))
      assert.ok(chatEvents.includes('"delta":"收到"'))
      expectedCalls += 1
      assert.equal(calls, expectedCalls)
      console.log(JSON.stringify({ run: index + 1, characterReadable: true,
        imagesPersisted: index === 1, formalChatCompleted: true }))
      if (checkMemory) {
        await verifyMemory()
        if (index === 1) assert.equal(restartedChatUsedMemory, true)
        console.log(JSON.stringify({ run: index + 1, memoryCalls, memorySourceMatches: true,
          inputTokens: 18, outputTokens: 6, restartedChatUsedMemory }))
      }

      // ── 运行期换密钥（只测第一轮）：供应商作废旧密钥 → 送新密钥进后台 ──
      if (index === 0) {
        acceptedKey = modelKeyB
        const rotateNoToken = await fetch(`${url}/model/key`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ apiKey: modelKeyB }),
        })
        assert.equal(rotateNoToken.status, 401, '换密钥同样必须带令牌')
        const rotate = await fetch(`${url}/model/key`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-session-token': tokens[index] },
          body: JSON.stringify({ apiKey: modelKeyB }),
          signal: AbortSignal.timeout(25_000),
        })
        assert.equal(rotate.status, 200)
        assert.deepEqual(await rotate.json(), { ok: true })
        await delay(500)
        const rotatedPids = await childPids(child.pid)
        assert.equal(rotatedPids.length, 1, '换钥后仍应只有一个 eve')
        assert.notEqual(rotatedPids[0], pids[0], 'eve 必须是换密钥后新起的进程')
        assert.equal(isAlive(pids[0]), false, '旧 eve 必须已退出')
        pids = rotatedPids
        const afterRotate = await fetch(`${url}/agent/ping`, {
          headers: { 'x-session-token': tokens[index] }, signal: AbortSignal.timeout(35_000),
        })
        assert.equal(afterRotate.status, 200)
        assert.deepEqual(await afterRotate.json(), { ok: true, text: '收到', usage: { inputTokens: 8, outputTokens: 2 } })
        expectedCalls += 1
        assert.equal(calls, expectedCalls, '换钥后那次调用也应计入总账')
        console.log(JSON.stringify({ run: 1, keyRotated: true, oldEveExited: true, pingAfterRotate: true }))
      }
    } finally {
      const exited = once(child, 'exit')
      if (index === 0) child.stdin.end()
      else child.kill()
      await exited
      for (let attempt = 0; attempt < 30 && pids.some(isAlive); attempt += 1) await delay(100)
      assert.equal(pids.some(isAlive), false, '后台退出后 eve 不应残留')
      console.log(JSON.stringify({ run: index + 1, shutdown: index === 0 ? 'normal' : 'forced', eveExited: true }))
    }
  }
  // 检查框架实际写入的工作区和锁目录，跳过旧安装包和构建产物。
  const runtimeData = ['smoke', 'locks', '.workflow-data'].map((name) => join(runtimeDir, '.eve', name))
  runtimeData.push(join(runtimeDir, '.output', '.eve'), `${dbPath}.eve`)
  const leaks = (await Promise.all(runtimeData.map(secretFiles))).reduce((total, count) => total + count, 0)
  assert.equal(leaks, 0)
  assert.equal([modelKeyA, modelKeyB, ...tokens, '请只回复两个字'].some((text) => logs.includes(text)), false)
  // T08 的五次分别是原话回复、查询工具、纠正工具、被中止的回复、清理后回复。
  assert.equal(authenticatedCalls, 5)
  assert.equal(memoryCalls, checkMemory || checkManagement ? 1 : 0)
  console.log(JSON.stringify({ packaged, calls, authenticatedCalls, memoryCalls, toolCount, secretFiles: leaks, logsClean: true }))
} finally {
  await new Promise((done) => provider.close(done))
  // 临时数据库目录整体清理；库文件内容不含机密，删除即止
  assert.equal(resolve(dbDir, '..'), resolve(tmpdir()), '只清理系统临时目录内的本轮测试库')
  assert.ok(basename(dbDir).startsWith('companion-db-probe-'))
  await rm(dbDir, { recursive: true, force: true })
}
