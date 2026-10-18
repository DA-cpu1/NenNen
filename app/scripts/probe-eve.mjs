/**
 * T01 完整链路检查：真实后台进程和 eve 配本机假供应商，固定回复、零付费调用。
 * 连续启动两次，分别正常关闭和强制结束后台，检查密钥重传与 eve 无残留。
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn, execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { readdir, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const appDir = resolve(import.meta.dirname, '..')
const modelKey = randomBytes(32).toString('base64url')
const tokens = [randomBytes(32).toString('base64url'), randomBytes(32).toString('base64url')]
let calls = 0
let authenticatedCalls = 0
let toolCount = 0
let logs = ''

// 假供应商只收本次随机假密钥，返回固定的 OpenAI 兼容文字流。
const provider = createServer(async (request, response) => {
  let body = ''
  for await (const chunk of request) body += chunk
  const parsed = JSON.parse(body)
  calls += 1
  if (request.headers.authorization === `Bearer ${modelKey}`) authenticatedCalls += 1
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
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command',
    `@(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${parentPid}' | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress`], { timeout: 15_000 })
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
      if ([modelKey, ...tokens].some((secret) => content.includes(secret))) matches += 1
    }
  }
  return matches
}

/** 启动真实业务后台，以两行 stdin 交付假机密，并等 READY。 */
async function boot(token, providerPort) {
  const child = spawn(process.execPath, ['out/main/service.js'], {
    cwd: appDir,
    env: { ...process.env, COMPANION_MODEL_BASE_URL: `http://127.0.0.1:${providerPort}/v1` },
    stdio: ['pipe', 'pipe', 'pipe'],
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
  for (let index = 0; index < 2; index += 1) {
    const { child, port } = await boot(tokens[index], provider.address().port)
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
      assert.equal(calls, index + 1, '每次启动只允许一次模拟模型请求')
      console.log(JSON.stringify({ run: index + 1, unauthorized: 401, wrongOrOldToken: 401, replyMatches: true, inputTokens: 8, outputTokens: 2, elapsedMs: Date.now() - started }))
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
  const leaks = await secretFiles(join(appDir, '.eve')) + await secretFiles(join(appDir, '.output'))
  assert.equal(leaks, 0)
  assert.equal([modelKey, ...tokens, '请只回复两个字'].some((text) => logs.includes(text)), false)
  assert.equal(authenticatedCalls, 2)
  assert.equal(toolCount, 0)
  console.log(JSON.stringify({ calls, authenticatedCalls, toolCount, secretFiles: leaks, logsClean: true }))
} finally {
  await new Promise((done) => provider.close(done))
}
