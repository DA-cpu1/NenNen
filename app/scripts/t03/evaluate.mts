/**
 * 文件职责：在专用评测目录运行固定虚构对话，保留给人工看的完整回复和独立用量账本。
 * 默认只走固定假供应商；--real 才调用真实模型，密钥只从 stdin 管道进入内存。
 * --style-check 只复看日常、开心、认真三组的表达，不替代十二组第一阶段验收。
 * --quality-check 使用同三组；仅在用户明确批准后不设金额和应用输出上限，仍限制请求数。
 * --quality-remaining 补齐第一阶段其余九组，避免重复调用已经完成的三组。
 * 这是独立内容评测，不替换应用的 eve 运行层，不验证正式记忆或界面功能。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { isStepCount, streamText, tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { BUDGET_CNY, buildMessages, constrainRequest, EvaluationBudget, loadSample,
  MAX_OUTPUT_TOKENS, MAX_REQUESTS, MODEL_ID, parseCases, rememberFixture, STYLE_CHECK_CASE_IDS,
  type EvaluationCase, type PromptMessage, type RequestRecord } from './support.ts'

const appDirectory = fileURLToPath(new URL('../../', import.meta.url))
const real = process.argv.includes('--real')
const stageRemainder = process.argv.includes('--quality-remaining')
const qualityCheck = stageRemainder || process.argv.includes('--quality-check')
const styleCheck = !stageRemainder && (qualityCheck || process.argv.includes('--style-check'))
const requestLimit = stageRemainder ? 39 : styleCheck ? 9 : MAX_REQUESTS
const budgetLimit = qualityCheck ? null : styleCheck ? 0.12 : BUDGET_CNY
const outputLimit = qualityCheck ? null : MAX_OUTPUT_TOKENS
const turnTimeoutMs = qualityCheck ? 180_000 : 90_000
const rangeLabel = stageRemainder ? '第一阶段剩余九组' : styleCheck ? '三组表达复试' : '第一阶段十二组'
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${stageRemainder ? 'quality-remaining-' : qualityCheck ? 'quality-check-' : styleCheck ? 'style-check-' : ''}${real ? 'real' : 'mock'}`
const directory = `${appDirectory}/.eve/t03-evaluation-20261103/${runId}`
await mkdir(directory, { recursive: true })
const budget = new EvaluationBudget(requestLimit, budgetLimit, outputLimit)
const caseSource = await readFile(`${appDirectory}/../docs/sdd/T03-试聊案例.md`, 'utf8')
const cases = parseCases(caseSource).filter(scenario => stageRemainder
  ? !STYLE_CHECK_CASE_IDS.includes(scenario.id) : !styleCheck || STYLE_CHECK_CASE_IDS.includes(scenario.id))
const sample = await loadSample(appDirectory)
const sampleVersion = sample.personaText.match(/^# 小鸟游六花 · 核心设定 (\S+)/m)?.[1]
if (!sampleVersion) throw new Error('E_SAMPLE_VERSION_MISSING')
let modelKey = 'local-fixed-evaluation-key'
if (real) {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  modelKey = Buffer.concat(chunks).toString('utf8').trim()
  if (!modelKey) throw new Error('E_NO_MODEL_KEY')
}

interface TurnEvidence {
  number: number; sourceId: string; user: string; text: string; status: string; errorCode?: string
  firstTextMs: number | null; totalMs: number; finishReason?: string; requestIds: number[]
  events: { type: string; text?: string; toolName?: string; input?: unknown; output?: unknown }[]
}
interface CaseEvidence { id: string; title: string; precondition: string; observation: string; turns: TurnEvidence[]; status: string }
const records: CaseEvidence[] = []
const versions: Record<string, string> = {}
for (const name of ['ai', '@ai-sdk/openai-compatible', 'zod', 'eve']) {
  versions[name] = JSON.parse(await readFile(`${appDirectory}/node_modules/${name}/package.json`, 'utf8')).version
}
const manifest = {
  runId, real, styleCheck, stageRemainder, qualityCheck, sampleVersion, caseIds: cases.map(scenario => scenario.id),
  startedAt: new Date().toISOString(), endedAt: null as string | null,
  model: MODEL_ID, providerVersion: '供应商未提供固定修订号', node: process.version, versions,
  git: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: appDirectory, encoding: 'utf8' }).trim(),
  workingChanges: execFileSync('git', ['status', '--short'], { cwd: appDirectory, encoding: 'utf8' }).trim(),
  sourceHash: createHash('sha256').update(caseSource + JSON.stringify(sample)).digest('hex'),
  budgetCny: budgetLimit, maxRequests: requestLimit, maxOutputTokens: outputLimit,
  outputLimitNote: qualityCheck ? '用户本轮要求质量优先；不传应用输出上限，供应商自身限制和默认值未实测。' : '应用显式限制每次输出。',
  inputLimit: 12000, priceSource: 'https://docs.bigmodel.cn/cn/guide/start/pricing',
  priceCheckedOn: '2026-11-03', parameters: `temperature/top_p/thinking 使用供应商默认；无 seed；maxRetries=0；streamRetries=0；每轮最多3次生成、${turnTimeoutMs / 1000}秒`,
  scope: `${rangeLabel}；部分案例须与其余本版案例合并，不单独作为第一阶段通过证据；独立 AI SDK 内容评测；当前已配置模型单候选；记忆工具为固定替身，不经过应用正式数据库或 eve；未运行 P21 长聊和发布阶段24组复测。`,
  blindLimit: '用户已知道当前模型；匿名编号仅用于整理，不能宣称本轮完全盲评。',
}

/**
 * 每个请求先登记到本地账本，再交给供应商，崩溃后也不能把未知费用当零。
 * @returns 无；专用评测记录含虚构原文，诊断输出只含编号与用量
 */
async function checkpoint(): Promise<void> {
  await writeFile(`${directory}/executor.json`, JSON.stringify({ ...manifest,
    totalCny: budget.totalCny(), requests: budget.requests }, null, 2), 'utf8')
  await writeFile(`${directory}/transcript.json`, JSON.stringify({ candidate: 'A', records }, null, 2), 'utf8')
}

/**
 * 先用固定 SSE（逐段传输的响应）检验 SDK 和工具续轮，不连接外网。
 * @param body SDK 实际生成的请求
 * @param sourceId 当前虚构用户消息编号
 * @returns 与公开兼容接口相同格式的固定响应
 */
function fixedResponse(body: Record<string, unknown>, sourceId: string): Response {
  const messages = body.messages as { role: string; content?: string }[]
  const current = messages.findLast(message => message.role === 'user')?.content ?? ''
  const lastIsTool = messages.at(-1)?.role === 'tool'
  const tools = body.tools as { function: { name: string } }[] | undefined
  const hasSave = tools?.some(item => item.function.name === 'remember_explicit')
  const hasSearch = tools?.some(item => item.function.name === 'search_memories')
  let delta: Record<string, unknown> = { content: '固定模拟回复，仅用于检查评测程序。' }
  let finishReason = 'stop'
  if (!lastIsTool && ((hasSave && /以后|记住/.test(current) && current.includes('阿达')) ||
      (hasSearch && current.startsWith('我们之前')))) {
    const name = hasSave ? 'remember_explicit' : 'search_memories'
    const input = hasSave ? { content: '用户希望被称为阿达', kind: 'preference', memoryKey: 'preferred_name', sourceMessageId: sourceId } : { query: '一起去海边', limit: 8 }
    delta = { tool_calls: [{ index: 0, id: `fixed-${sourceId}`, type: 'function', function: { name, arguments: JSON.stringify(input) } }] }
    finishReason = 'tool_calls'
  }
  const base = { id: `fixed-${sourceId}`, object: 'chat.completion.chunk', created: 0, model: MODEL_ID }
  const frames = [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } },
  ]
  return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/**
 * 运行一组的固定三轮；失败或输出截断后保留现场，余下追问不拿半句续跑或择优重试。
 * @param scenario 提前固定的案例；观察项只用于人工报告
 * @returns 无；完整证据写入专用目录
 */
async function runCase(scenario: EvaluationCase): Promise<void> {
  const record: CaseEvidence = { id: scenario.id, title: scenario.title, precondition: scenario.precondition,
    observation: scenario.observation, status: '运行中', turns: [] }
  records.push(record)
  const history: PromptMessage[] = []
  if (scenario.id === 'P05') history.push({ role: 'user', content: '我把桌面收拾干净了' }, { role: 'assistant', content: '杂物结界，解除' })
  if (scenario.id === 'P08') history.push({ role: 'user', content: '这会儿先听我吐槽，不用给建议' })
  let savedName = false
  for (const [index, user] of scenario.turns.entries()) {
    const sourceId = `${scenario.id}-u${index + 1}`
    const turn: TurnEvidence = { number: index + 1, sourceId, user, text: '', status: '运行中',
      firstTextMs: null, totalMs: 0, requestIds: [], events: [] }
    record.turns.push(turn)
    const started = performance.now()
    let currentRequest: RequestRecord | undefined
    let context = ''
    if (scenario.id === 'P11' || scenario.id === 'P18') context = `本轮当前用户消息编号：${sourceId}。` +
      `本组当前有效称呼资料：${savedName ? '用户希望被称为阿达；来源 P11-u1；保存工具已成功' : '无已保存的称呼资料'}。`
    const tools: ToolSet | undefined = scenario.id === 'P11' || scenario.id === 'P18' ? {
      remember_explicit: tool({
        description: '用户明确要求长期记住时保存；sourceMessageId 必须引用应用提供的用户消息编号。只保存有原话依据的内容，称呼的 kind 为 preference、memoryKey 为 preferred_name。',
        inputSchema: z.object({ content: z.string(), kind: z.string(), memoryKey: z.string().optional(), sourceMessageId: z.string() }),
        execute: async input => {
          const output = rememberFixture(input, sourceId, user, scenario.id === 'P18')
          if (output.ok === true) savedName = true
          turn.events.push({ type: 'tool-result', toolName: 'remember_explicit', input, output })
          return output
        },
      }),
    } : scenario.id === 'P15' ? {
      search_memories: tool({
        description: '在应用提供的有效记忆中查找旧事；没有命中只能说明没有找到，不能断言从未发生。',
        inputSchema: z.object({ query: z.string(), limit: z.number().int().min(1).max(8).optional() }),
        execute: async input => {
          const output = { ok: true, memories: [] }
          turn.events.push({ type: 'tool-result', toolName: 'search_memories', input, output })
          return output
        },
      }),
    } : undefined
    const provider = createOpenAICompatible({ name: 'zhipu', baseURL: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: modelKey, includeUsage: true,
      fetch: async (url, init) => {
        if (String(url) !== 'https://open.bigmodel.cn/api/paas/v4/chat/completions') throw new Error('E_ENDPOINT_NOT_ALLOWED')
        if (turn.requestIds.length >= 3) throw new Error('E_TURN_LIMIT')
        const parsed = JSON.parse(String(init?.body))
        if (parsed.model !== MODEL_ID || parsed.max_tokens !== (outputLimit ?? undefined) || parsed.stream !== true) throw new Error('E_REQUEST_CONFIG')
        const constrained = constrainRequest(parsed)
        currentRequest = budget.reserve(constrained.inputEstimate, constrained.removedGroups)
        turn.requestIds.push(currentRequest.id)
        await checkpoint()
        if (!real) return fixedResponse(constrained.body, sourceId)
        const response = await fetch(url, { ...init, body: JSON.stringify(constrained.body), redirect: 'error' })
        if (!response.ok) { await response.body?.cancel(); throw new Error(`E_PROVIDER_HTTP_${response.status}`) }
        return response
      },
    })
    try {
      const result = streamText({ model: provider(MODEL_ID), messages: buildMessages(sample, history, user, context),
        // 只有本地样稿生成系统消息；SDK 7 要求调用方明确允许这种消息身份。
        allowSystemInMessages: true,
        tools, ...(outputLimit === null ? {} : { maxOutputTokens: outputLimit }), maxRetries: 0, streamRetries: 0,
        abortSignal: AbortSignal.timeout(turnTimeoutMs), stopWhen: isStepCount(3),
        // SDK 的默认错误输出可能带请求详情；这里只收固定错误码，原始异常不打印。
        onError: () => {},
        onStepEnd: async step => {
          if (currentRequest) budget.settle(currentRequest, step.usage.inputTokens, step.usage.outputTokens)
          await checkpoint()
        },
      })
      for await (const part of result.stream) {
        if (part.type === 'text-delta') {
          if (turn.firstTextMs === null) turn.firstTextMs = Math.round(performance.now() - started)
          turn.text += part.text
          turn.events.push({ type: 'text', text: part.text })
        }
        if (part.type === 'tool-call') turn.events.push({ type: 'tool-call', toolName: part.toolName, input: part.input })
        if (part.type === 'error') throw part.error
      }
      turn.finishReason = await result.finishReason
      if (turn.finishReason !== 'stop' || !turn.text.trim()) throw new Error(turn.finishReason === 'length' ? 'E_OUTPUT_TRUNCATED' : 'E_NO_COMPLETE_REPLY')
      turn.status = '完整'
      history.push({ role: 'user', content: user }, { role: 'assistant', content: turn.text })
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      turn.errorCode = /^E_[A-Z0-9_]+$/.test(message) ? message : 'E_MODEL_STREAM'
      turn.status = '中断'
    }
    turn.totalMs = Math.round(performance.now() - started)
    await checkpoint()
    console.log(JSON.stringify({ case: scenario.id, turn: index + 1, status: turn.status, errorCode: turn.errorCode,
      elapsedMs: turn.totalMs, requests: budget.requests.length, cny: budget.totalCny() }))
    if (turn.status !== '完整') break
  }
  record.status = record.turns.length === 3 && record.turns.every(turn => turn.status === '完整') ? '完整' : '中断'
  await checkpoint()
}

await checkpoint()
console.log(JSON.stringify({ event: 'prepared', directory, real, cases: cases.length, budgetCny: budgetLimit }))
for (const scenario of cases) {
  const total = budget.totalCny()
  if (budget.requests.length >= requestLimit || (budgetLimit !== null && (total === null || total >= budgetLimit))) break
  await runCase(scenario)
}
manifest.endedAt = new Date().toISOString()
await checkpoint()
const report = [`# 候选 A · ${rangeLabel}实际回复`, '',
  `本轮仅一个已知候选，不能视为完全盲评。人设 ${sampleVersion}，案例 0.1；以下保留完整可见回复。${styleCheck || stageRemainder ? '本段不能单独代替第一阶段十二组验收。' : ''}`,
  '记忆工具均为模拟，不是正式功能验收；中断组不能拿半句评分。三个评分依次为辨识度、自然度、情境，各 1～5 分。', '']
for (const record of records) {
  report.push(`## ${record.id} · ${record.title}（${record.status}）`, '', `前置：${record.precondition}`, '')
  for (const turn of record.turns) {
    report.push(`**用户 ${turn.number}：** ${turn.user}`, '', `**角色：** ${turn.text || '（无完整可见回复）'}`, '')
    const toolEvents = turn.events.filter(event => event.type === 'tool-result')
    if (toolEvents.length) report.push(`工具实况（模拟）：${JSON.stringify(toolEvents)}`, '')
    if (turn.status !== '完整') report.push(`本轮中断：${turn.errorCode}；其余追问未运行。`, '')
  }
  report.push(`观察重点：${record.observation}`, '', '人工评分：辨识度 — / 自然度 — / 情境 —；事实 — / 工具 — / 结束意愿 —。', '')
}
await writeFile(`${directory}/review.md`, report.join('\n'), 'utf8')
console.log(JSON.stringify({ event: 'finished', directory, completeCases: records.filter(record => record.status === '完整').length,
  completedTurns: records.flatMap(record => record.turns).filter(turn => turn.status === '完整').length,
  requests: budget.requests.length, cny: budget.totalCny() }))
if (!real && (records.some(record => record.status !== '完整') || budget.requests.length !== (stageRemainder ? 30 : styleCheck ? 9 : 39))) {
  throw new Error('E_MOCK_EVALUATION_INCOMPLETE')
}
