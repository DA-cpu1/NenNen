/**
 * 在隔离用户目录运行真实应用，验证模型设置、系统加密、聊天、记忆和重启。
 * 模型供应商仅绑定本机随机端口；随机假密钥只留在脚本内存，不接触正式资料。
 * 运行前先构建应用；--packaged 用 win-unpacked，--package-dir 可指定从安装包解出的目录。
 * --deepseek 按 DeepSeek 的规则检查关闭思考，并模拟一轮立即记忆工具调用。
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
const packageDirIndex = process.argv.indexOf('--package-dir')
if (packageDirIndex >= 0 && !process.argv[packageDirIndex + 1]) throw new Error('E_PACKAGE_DIRECTORY_REQUIRED')
const packaged = process.argv.includes('--packaged') || packageDirIndex >= 0
const packageDir = packageDirIndex >= 0 ? resolve(process.argv[packageDirIndex + 1]) : join(appDir, 'release/win-unpacked')
const deepSeek = process.argv.includes('--deepseek')
const model = deepSeek ? 'deepseek-flash' : 'native-fixed-model'
const fixture = await mkdtemp(join(appDir, '.eve/model-native-'))
const profile = join(fixture, 'profile')
const copy = join(fixture, 'app')
await mkdir(profile)
if (!packaged) {
  await mkdir(copy)
  for (const path of ['out', '.output', 'scripts/eve-entry.mjs']) await cp(join(appDir, path), join(copy, path), { recursive: true })
  await writeFile(join(copy, 'package.json'), JSON.stringify({ name: 'companion-model-native-probe', main: 'out/main/index.js' }))
}
const executable = packaged ? join(packageDir, '二次元女友.exe') : join(appDir, 'node_modules/electron/dist/electron.exe')
const firstKey = randomBytes(32).toString('base64url')
const secondKey = randomBytes(32).toString('base64url')
let acceptedKey = firstKey
let mode = 'passed'
const requests = []
let appLogs = ''
const memoryContent = '用户喜欢用水彩画植物。'
const rememberMessage = '我平时用蓝色马克杯喝茶。'
const rememberedContent = '用户平时用蓝色马克杯喝茶。'

/** 固定供应商只返回本次检查需要的结构；不转发请求、不保留用户正文。 */
const provider = createServer(async (request, response) => {
  let text = ''
  for await (const chunk of request) text += chunk
  const input = JSON.parse(text)
  const names = (input.tools ?? []).map((tool) => tool.function.name)
  const batch = input.messages.find((message) => message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('{"sources":'))
  const kind = names.includes('connection_check') ? 'connection' : batch ? 'memory' : 'chat'
  const record = { kind, model: input.model, tools: names, thinkingDisabled: input.thinking?.type === 'disabled',
    usedMemory: JSON.stringify(input.messages).includes(memoryContent), toolReceipt: false }
  requests.push(record)
  if (input.model !== model || (deepSeek ? !record.thinkingDisabled : input.thinking !== undefined)) {
    response.writeHead(400, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'fixed-invalid-model-or-thinking-mode' } }))
    return
  }
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
    let delta = { role: 'assistant', content }
    let finishReason = 'stop'
    if (deepSeek && input.messages.findLast((message) => message.role === 'user')?.content === rememberMessage) {
      const lastMessage = input.messages.at(-1)
      if (lastMessage.role === 'tool') {
        // 只有收到业务后台的真实保存回执，假模型才说“已记下”。
        const receipt = JSON.parse(lastMessage.content)
        record.toolReceipt = receipt.ok === true && receipt.status === 'saved'
        delta = { role: 'assistant', content: record.toolReceipt ? '固定回复：已记下。' : '固定回复：保存未完成。' }
      } else {
        const sourceId = input.messages.find((message) => message.role === 'system' &&
          message.content.includes('仅供立即记忆工具使用'))?.content.match(/：([^\s]+)$/u)?.[1]
        delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'fixed-remember', type: 'function', function: {
          name: 'remember_explicit', arguments: JSON.stringify({ kind: 'preference', content: rememberedContent, sourceMessageId: sourceId }),
        } }] }
        finishReason = 'tool_calls'
      }
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const chunk of [{ delta, finish_reason: null }, { delta: {}, finish_reason: finishReason }]) {
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
  async function input(selector, value) {
    await evaluate(`(() => { const element = ${selector}; if (!element) throw new Error('missing');
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value').set.call(element, ${JSON.stringify(value)});
      element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); })()`)
  }
  const byLabel = (label) => `[...document.querySelectorAll('label')].find(label => label.firstElementChild?.textContent === ${JSON.stringify(label)})?.querySelector('input')`
  // 刚找到窗口时，预加载脚本可能还没把接口放到页面上。等到接口可用再读状态。
  const state = () => evaluate('window.appApi?.getModelSettings().then(result => result.ok ? result.data : null) ?? null')
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
  try { await waitFor(() => state().then((value) => value !== null), 'E_MODEL_STATE') }
  catch (error) { await stop(); throw error }
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
  await app.input('document.querySelector("select")', deepSeek ? 'deepseek' : 'openai-compatible')
  if (deepSeek) {
    // 直接检查开关，确认预设默认关闭思考，同时允许用户打开。
    await waitFor(() => app.evaluate('document.querySelector(\'[role="switch"][aria-checked="false"]:enabled\') !== null'),
      'E_DEEPSEEK_THINKING_DEFAULT')
    for (const [label, value] of [['模型 ID', model], ['API 地址', 'https://api.deepseek.com'],
      ['模型总容量', '1000000'], ['回复预留', '8192']]) {
      assert.equal(await app.evaluate(`${app.byLabel(label)}.value`), value)
    }
    await app.screenshot('deepseek-preset')
  } else {
    for (const [label, value] of [['模型 ID', model], ['模型总容量', '262144'], ['回复预留', '32768']]) {
      await app.input(app.byLabel(label), value)
    }
  }
  await app.input(app.byLabel('API 地址'), baseUrl)
  await app.input('document.querySelector("#model-api-key")', firstKey)
  await app.screenshot('settings-draft')
  await app.click('保存配置')
  await waitFor(() => app.state().then((value) => value?.credentialStorage === 'encrypted'), 'E_ENCRYPTED_SAVE')
  await waitFor(() => app.evaluate('[...document.querySelectorAll("button")].some(button => button.textContent === "测试连接" && !button.disabled)'), 'E_TEST_BUTTON_READY')
  assert.equal(requests.length, 0, '保存配置不应请求模型')
  await app.click('测试连接')
  await waitFor(() => app.state().then((value) => value?.ready), 'E_TOOL_TEST')
  await app.screenshot('settings-saved')
  await app.evaluate('[...document.querySelectorAll("h2")].find(h => h.textContent === "回复参数")?.scrollIntoView({ block: "start" })')
  await delay(400)
  await app.screenshot('settings-params')
  await app.click('下一步：试聊预览')
  await app.visible('试聊当前草稿')
  // 试聊按钮通过真实界面操作，不能绕过 preview 的服务层隔离。
  await app.input('document.querySelector("[aria-label=试聊输入框]")', '固定试聊问候')
  await app.click('发送', 'document.querySelector("[aria-label=草稿试聊]")')
  await delay(1200)
  await app.screenshot('preview-sent')
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
  // 第一条正式消息用真实输入框和发送按钮，后续重复回合沿用同一个界面桥接。
  const composer = 'document.querySelector("[aria-label=聊天输入框]")'
  await waitFor(() => app.evaluate(`${composer}?.disabled === false`), 'E_FORMAL_COMPOSER')
  await app.input(composer, '我喜欢用水彩画植物。')
  await app.click('发送')
  await app.visible('固定回复：收到。')
  await waitFor(() => readDatabase((db) => db.prepare("SELECT count(*) AS count FROM agent_runs WHERE trigger_type='chat' AND status='completed'").get().count === 1), 'E_FORMAL_REPLY')
  await waitFor(() => app.evaluate('[...document.querySelectorAll("button")].some(button => button.textContent === "发送")'), 'E_FORMAL_READY')
  for (let turn = 1; turn < 10; turn += 1) {
    const content = deepSeek && turn === 1 ? rememberMessage : `固定日常问候${turn}`
    assert.equal((await send(content)).status, 'done')
  }
  await waitFor(() => readDatabase((db) => db.prepare("SELECT count(*) AS count FROM memories WHERE status='active' AND content=?").get(memoryContent).count === 1), 'E_MEMORY_SAVED')
  assert(requests.some((request) => request.kind === 'memory' && request.model === model))
  if (deepSeek) {
    assert(requests.some((request) => request.toolReceipt), '供应商必须收到立即记忆保存回执')
    assert.equal(readDatabase((db) => db.prepare("SELECT count(*) AS count FROM tool_operations WHERE tool_name='remember_explicit' AND status='committed'").get().count), 1)
  }
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
  await app.visible('更换')
  const savedConnection = (await app.state()).settings.connection
  const beforeServiceChange = requests.length
  await app.input('document.querySelector("select")', 'zhipu')
  await app.input(app.byLabel('API 地址'), baseUrl + '/other-service')
  await app.visible('填写新服务的 API 密钥后再保存。')
  await app.click('保存配置')
  await app.visible('服务地址或供应商已更改，请重新填写对应的 API 密钥。')
  assert.deepEqual((await app.state()).settings.connection, savedConnection)
  assert.equal(requests.length, beforeServiceChange)
  await waitFor(() => app.evaluate('[...document.querySelectorAll("button")].some(button => button.textContent === "取消修改" && !button.disabled)'), 'E_REJECTED_SAVE_FINISHED')
  await app.click('取消修改')
  await app.visible('已取消修改。')
  await app.click('更换')
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
  await app.evaluate('document.querySelector("footer").scrollIntoView({ block: "end" })')
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
  const report = { packaged, deepSeek, fixture, formalConversationRetained: true, encryptedCredentials: true, replacedAndDeleted: true,
    noAutomaticModelCalls: true, previewIsolated: true, formalMessages, memorySavedAndReused: true, unsupportedBlocked: true, failedAndCancelled: true,
    serviceChangeRequiresNewKey: true, immediateMemoryToolRoundTrip: requests.some((value) => value.toolReceipt),
    thinkingDisabledRequests: requests.filter((value) => value.thinkingDisabled).length,
    requestCounts: { connection: requests.filter((value) => value.kind === 'connection').length,
      chat: requests.filter((value) => value.kind === 'chat').length, memory: requests.filter((value) => value.kind === 'memory').length },
    actualModels: [...new Set(requests.map((value) => value.model))], logsContainFakeSecrets: appLogs.includes(firstKey) || appLogs.includes(secondKey) }
  assert.equal(report.logsContainFakeSecrets, false)
  await writeFile(join(fixture, 'result.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} catch (error) {
  // 失败也保留可定位的状态与固定码，仍不写密钥、请求正文或框架原始输出。
  await writeFile(join(fixture, 'failure.json'), JSON.stringify({ code: /^E_[A-Z_]+$/.test(error.message) ? error.message : 'E_PROBE_ASSERTION',
    requests: requests.map((request) => ({ kind: request.kind, model: request.model, tools: request.tools })),
    appCodes: [...new Set(appLogs.match(/E_[A-Z_]+/g) ?? [])] }, null, 2))
  console.error(JSON.stringify({ fixture, code: 'E_NATIVE_MODEL_PROBE_FAILED' }))
  throw error
} finally {
  await application?.stop()
  provider.closeAllConnections()
  await new Promise((accept) => provider.close(accept))
}
