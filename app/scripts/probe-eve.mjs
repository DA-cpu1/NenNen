/**
 * T01 完整链路检查：真实后台进程和 eve 配本机假供应商，固定回复、零付费调用。
 * 连续启动两次：第一次含「运行期换密钥」（供应商只认新密钥后后台整体换 eve）；
 * 两次分别验证正常关闭和强制结束后台时密钥重传与 eve 无残留；
 * 两轮共用同一个数据库文件：第一轮写入的值，第二轮重启后必须原样读到。
 * --packaged 改用实际随包 exe 和归档入口，防止开发态能跑、安装后却缺文件。
 * --package-dir 可指定从安装包解出的目录，复查最终交付的文件，而不安装到用户目录。
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn, execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, resolve, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const appDir = resolve(import.meta.dirname, '..')
const packageDirIndex = process.argv.indexOf('--package-dir')
if (packageDirIndex >= 0 && !process.argv[packageDirIndex + 1]) throw new Error('E_PACKAGE_DIRECTORY_REQUIRED')
const packaged = process.argv.includes('--packaged') || packageDirIndex >= 0
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

// 假供应商：只认当前密钥，返回固定的 OpenAI 兼容文字流
const provider = createServer(async (request, response) => {
  let body = ''
  for await (const chunk of request) body += chunk
  calls += 1
  if (request.headers.authorization !== `Bearer ${acceptedKey}`) {
    // 模拟真实供应商的 401 口吻；不含任何密钥内容
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { code: '1001', message: '无效的API密钥' } }))
    return
  }
  authenticatedCalls += 1
  const parsed = JSON.parse(body)
  toolCount += (parsed.tools ?? []).length
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const payload of [
    { choices: [{ index: 0, delta: { role: 'assistant', content: '收到' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } },
  ]) response.write(`data: ${JSON.stringify({ id: 'fixed-test', object: 'chat.completion.chunk', created: 0, model: 'glm-5.3-flash', ...payload })}\n\n`)
  response.end('data: [DONE]\n\n')
})

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

provider.listen(0, '127.0.0.1')
await once(provider, 'listening')
try {
  let expectedCalls = 0
  for (let index = 0; index < 2; index += 1) {
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
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { ok: true, text: '收到', usage: { inputTokens: 8, outputTokens: 2 } })
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
      const chatResponse = await fetch(`${url}/chat/turn`, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId: conversation.conversationId,
          requestId: `package-probe-${index}`, content: '请只回复两个字：收到' }),
        signal: AbortSignal.timeout(35_000),
      })
      assert.equal(chatResponse.status, 200)
      const chatEvents = await chatResponse.text()
      assert.ok(chatEvents.includes('"type":"done"'))
      assert.ok(chatEvents.includes('"delta":"收到"'))
      expectedCalls += 1
      assert.equal(calls, expectedCalls)
      console.log(JSON.stringify({ run: index + 1, characterReadable: true,
        imagesPersisted: index === 1, formalChatCompleted: true }))

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
  // 除回合目录外，框架还会留下执行锁文件；整个运行目录都要查，避免漏掉机密。
  const leaks = await secretFiles(join(runtimeDir, '.eve')) + await secretFiles(join(runtimeDir, '.output'))
  assert.equal(leaks, 0)
  assert.equal([modelKeyA, modelKeyB, ...tokens, '请只回复两个字'].some((text) => logs.includes(text)), false)
  assert.equal(authenticatedCalls, 5)
  assert.equal(toolCount, 0)
  console.log(JSON.stringify({ packaged, calls, authenticatedCalls, toolCount, secretFiles: leaks, logsClean: true }))
} finally {
  await new Promise((done) => provider.close(done))
  // 临时数据库目录整体清理；库文件内容不含机密，删除即止
  assert.equal(resolve(dbDir, '..'), resolve(tmpdir()), '只清理系统临时目录内的本轮测试库')
  assert.ok(basename(dbDir).startsWith('companion-db-probe-'))
  await rm(dbDir, { recursive: true, force: true })
}
