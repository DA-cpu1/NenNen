/**
 * 在隔离用户目录运行真实应用，验证模型设置、系统加密、聊天、记忆和重启。
 * 模型供应商仅绑定本机随机端口；随机假密钥只留在脚本内存，不接触正式资料。
 * 运行前先构建应用；--packaged 改用实际 win-unpacked 程序，不更改安装配置。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'

const appDir = resolve(import.meta.dirname, '..')
const packaged = process.argv.includes('--packaged')
const fixture = await mkdtemp(join(appDir, '.eve/model-native-'))
const profile = join(fixture, 'profile')
const copy = join(fixture, 'app')
await mkdir(profile)
if (!packaged) {
  await mkdir(copy)
  for (const path of ['out', '.output', 'scripts/eve-entry.mjs']) await cp(join(appDir, path), join(copy, path), { recursive: true })
  await writeFile(join(copy, 'package.json'), JSON.stringify({ name: 'companion-model-native-probe', main: 'out/main/index.js' }))
}
const executable = packaged ? join(appDir, 'release/win-unpacked/二次元女友.exe') : join(appDir, 'node_modules/electron/dist/electron.exe')
const firstKey = randomBytes(32).toString('base64url')
const secondKey = randomBytes(32).toString('base64url')
let acceptedKey = firstKey
let mode = 'passed'
const requests = []
let appLogs = ''
const memoryContent = '用户喜欢用水彩画植物。'

/** 固定供应商只返回本次检查需要的结构；不转发请求、不保留用户正文。 */
const provider = createServer(async (request, response) => {
  let text = ''
  for await (const chunk of request) text += chunk
  const input = JSON.parse(text)
  const names = (input.tools ?? []).map((tool) => tool.function.name)
  const batch = input.messages.find((message) => message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('{"sources":'))
  const kind = names.includes('connection_check') ? 'connection' : batch ? 'memory' : 'chat'
  requests.push({ kind, model: input.model, tools: names, usedMemory: JSON.stringify(input.messages).includes(memoryContent) })
  if (request.headers.authorization !== `Bearer ${acceptedKey}` || (kind === 'connection' && mode === 'failed')) {
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'fixed-auth-failed' } }))
    return
  }
  if (kind === 'connection' && mode === 'hold') return
  let content = '固定回复：收到。'
  if (batch) {
    const { sources } = JSON.parse(batch.content)
    const source = sources.find((item) => item.content.includes('水彩画植物')) ?? sources[0]
    content = JSON.stringify({ candidates: [{ action: 'add', kind: 'preference', memoryKey: null,
      content: memoryContent, sourceMessageIds: [source.id], expiresAt: null, replacesMemoryId: null }] })
  }
  if (!input.stream) {
    const tool = kind === 'connection' && mode === 'passed'
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ id: 'fixed-response', object: 'chat.completion', created: 0, model: input.model,
      choices: [{ index: 0, message: tool ? { role: 'assistant', content: null, tool_calls: [{ id: 'fixed-tool', type: 'function',
        function: { name: 'connection_check', arguments: '{"confirmation":"ok"}' } }] } : { role: 'assistant', content },
      finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 18, completion_tokens: 6, total_tokens: 24 } }))
  } else {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const chunk of [{ delta: { role: 'assistant', content }, finish_reason: null }, { delta: {}, finish_reason: 'stop' }]) {
      response.write('data: ' + JSON.stringify({ id: 'fixed-stream', object: 'chat.completion.chunk', created: 0, model: input.model,
        choices: [{ index: 0, ...chunk }], ...(chunk.finish_reason ? { usage: { prompt_tokens: 18, completion_tokens: 6, total_tokens: 24 } } : {}) }) + '\n\n')
    }
    response.end('data: [DONE]\n\n')
  }
})
await new Promise((accept) => provider.listen(0, '127.0.0.1', accept))
const baseUrl = `http://127.0.0.1:${provider.address().port}/v1`

/** 等异步操作完成；失败抛固定码，避免把调试通道的请求正文打印出来。 */
async function waitFor(check, code) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const value = await check()
    if (value) return value
    await delay(100)
  }
  throw new Error(code)
}

/** 只连接本脚本启动的窗口调试口，用于真实页面操作和截图。 */
async function connect(url) {
  const socket = new WebSocket(url)
  await once(socket, 'open')
  const pending = new Map()
  let id = 0
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    const current = pending.get(message.id)
    if (!current) return
    pending.delete(message.id)
    if (message.error) current.reject(new Error('E_DEBUG_COMMAND'))
    else current.accept(message.result)
  })
  return { call: (method, params = {}) => new Promise((accept, reject) => {
    pending.set(++id, { accept, reject }); socket.send(JSON.stringify({ id, method, params }))
  }), close: () => socket.close() }
}

/** 每轮使用相同隔离目录；重新启动时必须删除旧调试端口文件，防止连回旧窗口。 */
async function boot() {
  await unlink(join(profile, 'DevToolsActivePort')).catch((error) => { if (error.code !== 'ENOENT') throw error })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const child = spawn(executable, [...(packaged ? [] : [copy]), `--user-data-dir=${profile}`,
    '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdout.on('data', (value) => { appLogs += value.toString() })
  child.stderr.on('data', (value) => { appLogs += value.toString() })
  const port = await waitFor(async () => Number.parseInt(await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => ''), 10), 'E_DEBUG_PORT')
  const address = `http://127.0.0.1:${port}`
  const browser = await connect((await (await fetch(`${address}/json/version`)).json()).webSocketDebuggerUrl)
  const target = await waitFor(async () => (await (await fetch(`${address}/json/list`)).json()).find((item) => item.url.endsWith('/renderer/index.html')), 'E_CHAT_WINDOW')
  const page = await connect(target.webSocketDebuggerUrl)
  /** 不把异常内容带出页面；测试资料与凭据不会进入报告。 */
  async function evaluate(expression) {
    const result = await page.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error('E_PAGE_OPERATION')
    return result.result.value
  }
  const click = (text, root = 'document') => evaluate(`[...${root}.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(text)})?.click()`)
  const visible = (text) => waitFor(() => evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`), 'E_UI_STATE')
  /** 使用浏览器原生 setter 触发 React 的输入事件，实际保存仍走产品按钮。 */
  async function input(selector, value, select = false) {
    await evaluate(`(() => { const element = ${selector}; if (!element) throw new Error('missing');
      Object.getOwnPropertyDescriptor(${select ? 'HTMLSelectElement' : 'HTMLInputElement'}.prototype, 'value').set.call(element, ${JSON.stringify(value)});
      element.dispatchEvent(new Event('${select ? 'change' : 'input'}', { bubbles: true })); })()`)
  }
  const byLabel = (label) => `[...document.querySelectorAll('label')].find(label => label.firstElementChild?.textContent === ${JSON.stringify(label)})?.querySelector('input')`
  const state = () => evaluate('window.appApi.getModelSettings().then(result => result.ok ? result.data : null)')
  async function screenshot(name) {
    const result = await page.call('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(fixture, `${name}.png`), Buffer.from(result.data, 'base64'))
  }
  /** 正常关闭以等待取消及落盘；兜底只结束本脚本创建的进程。 */
  async function stop() {
    page.close()
    if (child.exitCode === null) {
      const exited = once(child, 'exit')
      void browser.call('Browser.close').catch(() => {})
      await Promise.race([exited, delay(5_000)])
      if (child.exitCode === null) { child.kill(); await exited }
    }
    browser.close()
  }
  await waitFor(() => state().then((value) => value !== null), 'E_MODEL_STATE')
  return { child, evaluate, click, visible, input, byLabel, state, screenshot, stop }
}

/** 用只读连接核对隔离库，不能误写正在运行的应用数据。 */
function readDatabase(check) {
  const database = new DatabaseSync(join(profile, 'companion.db'), { readOnly: true })
  try { return check(database) } finally { database.close() }
}

let application
try {
  application = await boot()
  let app = application
  await app.visible('下一步：模型连接')
  await app.click('下一步：模型连接')
  await app.visible('保存配置')
  await app.input('document.querySelector("select")', 'openai-compatible', true)
  for (const [label, value] of [['模型', 'native-fixed-model'], ['服务地址', baseUrl], ['模型总容量', '262144'], ['回复预留', '32768'], ['API 密钥', firstKey]]) {
    await app.input(app.byLabel(label), value)
  }
  await app.click('保存配置')
  await waitFor(() => app.state().then((value) => value?.credentialStorage === 'encrypted'), 'E_ENCRYPTED_SAVE')
  await waitFor(() => app.evaluate('[...document.querySelectorAll("button")].some(button => button.textContent === "测试连接" && !button.disabled)'), 'E_TEST_BUTTON_READY')
  assert.equal(requests.length, 0, '保存配置不应请求模型')
  await app.click('测试连接')
  await waitFor(() => app.state().then((value) => value?.ready), 'E_TOOL_TEST')
  await app.click('下一步：试聊预览')
  await app.visible('试聊当前草稿')
  // 试聊按钮通过真实界面操作，不能绕过 preview 的服务层隔离。
  await app.evaluate(`(() => { const input = document.querySelector('[aria-label=试聊输入框]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '固定试聊问候');
    input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await app.click('发送', 'document.querySelector("[aria-label=草稿试聊]")')
  await app.visible('固定回复：收到。')
  await waitFor(() => app.evaluate('[...document.querySelectorAll("button")].some(button => button.textContent === "下一步：开始相处" && !button.disabled)'), 'E_PREVIEW_FINISHED')
  await app.screenshot('preview')
  assert.equal(readDatabase((db) => db.prepare('SELECT count(*) AS count FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.mode=\'normal\'').get().count), 0)
  await app.click('下一步：开始相处')
  await app.click('开始聊天')
  await waitFor(() => app.state().then((value) => value?.onboardingCompleted), 'E_ONBOARDING_COMPLETE')
  const formal = await app.evaluate('window.appApi.getFormalConversation().then(result => result.data.conversation.conversationId)')
  /** 固定回合走正式 preload 和事件流；只把终态、错误码及字数交给检查脚本。 */
  async function send(content) {
    return app.evaluate(`new Promise(async resolve => {
      const id = ${JSON.stringify(randomUUID())}; let length = 0;
      const off = window.appApi.onChatTurnEvent(message => { if (message.requestId !== id) return;
        const frame = message.frame; if (frame?.type === 'text') length += frame.delta.length;
        if (!frame || ['done','failed','cancelled'].includes(frame.type)) { off(); resolve({ status: frame?.type, code: frame?.code, length }); } });
      const result = await window.appApi.startChatTurn(${JSON.stringify(formal)}, id, ${JSON.stringify(content)});
      if (!result.ok) { off(); resolve({ status: 'rejected', code: result.code }); }
    })`)
  }
  for (let turn = 0; turn < 10; turn += 1) assert.equal((await send(turn === 0 ? '我喜欢用水彩画植物。' : `固定日常问候${turn}`)).status, 'done')
  await waitFor(() => readDatabase((db) => db.prepare("SELECT count(*) AS count FROM memories WHERE status='active'").get().count > 0), 'E_MEMORY_SAVED')
  assert(requests.some((request) => request.kind === 'memory' && request.model === 'native-fixed-model'))
  const beforeRestart = requests.length
  console.log(JSON.stringify({ checkpoint: 'chat-preview-memory', modelCalls: beforeRestart }))
  await app.stop()
  application = await boot()
  app = application
  await waitFor(() => app.state().then((value) => value?.ready && value.onboardingCompleted), 'E_RESTORE')
  assert.equal(requests.length, beforeRestart, '重启不能自动调用模型')
  assert.equal(await app.evaluate('window.appApi.getFormalConversation().then(result => result.data.conversation.conversationId)'), formal)
  assert.equal((await send('我们聊过的水彩画植物呢？')).status, 'done')
  assert(requests.at(-1).usedMemory)
  await app.click('设置', 'document.querySelector("nav[aria-label=应用页面]")')
  await app.visible('更换凭据')
  await app.click('更换凭据')
  await app.visible('新 API 密钥')
  await app.input('document.querySelector("dialog input")', secondKey)
  await app.screenshot('replace-credential')
  acceptedKey = secondKey
  await app.click('保存新凭据', 'document.querySelector("dialog")')
  await waitFor(() => app.evaluate('!document.querySelector("dialog[open]")'), 'E_REPLACE_CREDENTIAL')
  await waitFor(() => app.evaluate('[...document.querySelectorAll("button")].some(button => button.textContent === "测试连接" && !button.disabled)'), 'E_TEST_BUTTON_READY')
  assert.equal((await app.state()).ready, false)
  await app.click('测试连接')
  await waitFor(() => app.state().then((value) => value?.ready), 'E_NEW_CREDENTIAL_TEST')
  const files = await readdir(join(profile, 'model-credentials'))
  assert.equal(files.length, 1)
  for (const file of files) {
    const bytes = await readFile(join(profile, 'model-credentials', file))
    assert(!bytes.includes(Buffer.from(firstKey)) && !bytes.includes(Buffer.from(secondKey)))
  }
  await app.screenshot('configured')
  await app.evaluate('document.querySelector("[aria-label=模型连接测试]").scrollIntoView({ block: "center" })')
  await app.screenshot('configured-connection')
  for (const state of ['unsupported', 'failed']) {
    mode = state
    await app.click('测试连接')
    await waitFor(() => app.state().then((value) => value?.settings.testStatus === state && !value.ready), `E_TEST_${state.toUpperCase()}`)
    await waitFor(() => app.evaluate('[...document.querySelectorAll("button")].some(button => button.textContent === "测试连接" && !button.disabled)'), 'E_TEST_FINISHED')
    const beforeRejected = requests.length
    assert.equal(await app.evaluate(`window.appApi.startChatTurn(${JSON.stringify(formal)}, ${JSON.stringify(randomUUID())}, '固定拒绝检查').then(result => result.ok)`), false)
    assert.equal(requests.length, beforeRejected)
    await app.screenshot(state)
  }
  mode = 'hold'
  const count = requests.length
  await app.click('测试连接')
  await waitFor(() => requests.length > count, 'E_TEST_STARTED')
  await app.click('取消测试')
  await waitFor(() => app.state().then((value) => value?.settings.testStatus === 'untested'), 'E_TEST_CANCELLED')
  await app.visible('连接测试已取消')
  await app.click('删除凭据')
  await app.visible('删除 API 凭据？')
  await app.screenshot('delete-confirmation')
  await app.click('删除凭据', 'document.querySelector("dialog")')
  await waitFor(() => app.state().then((value) => value?.settings.credentialRef === null && !value.ready), 'E_CREDENTIAL_DELETE')
  await app.visible('凭据已删除')
  await waitFor(() => app.evaluate('!document.querySelector("dialog[open]")'), 'E_DELETE_FINISHED')
  assert.deepEqual(await readdir(join(profile, 'model-credentials')), [])
  await app.click('聊天', 'document.querySelector("nav[aria-label=应用页面]")')
  await app.visible('去模型与连接')
  assert(await app.evaluate('document.querySelector("[aria-label=聊天输入框]").disabled'))
  await app.screenshot('deleted-history')
  const formalMessages = readDatabase((db) => db.prepare("SELECT count(*) AS count FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.mode='normal'").get().count)
  assert.equal(formalMessages, 22)
  assert.equal(readDatabase((db) => db.prepare("SELECT count(*) AS count FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.mode='preview'").get().count), 2)
  const beforeFinalRestart = requests.length
  await app.stop()
  application = await boot()
  app = application
  assert.equal((await app.state()).ready, false)
  assert.equal((await app.state()).settings.credentialRef, null)
  assert.equal(requests.length, beforeFinalRestart)
  const report = { packaged, fixture, formalConversationRetained: true, encryptedCredentials: true, replacedAndDeleted: true,
    noAutomaticModelCalls: true, previewIsolated: true, formalMessages, memorySavedAndReused: true, unsupportedBlocked: true, failedAndCancelled: true,
    requestCounts: { connection: requests.filter((value) => value.kind === 'connection').length,
      chat: requests.filter((value) => value.kind === 'chat').length, memory: requests.filter((value) => value.kind === 'memory').length },
    actualModels: [...new Set(requests.map((value) => value.model))], logsContainFakeSecrets: appLogs.includes(firstKey) || appLogs.includes(secondKey) }
  assert.equal(report.logsContainFakeSecrets, false)
  await writeFile(join(fixture, 'result.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} finally {
  await application?.stop()
  provider.closeAllConnections()
  await new Promise((accept) => provider.close(accept))
}
