/**
 * 文件职责：把已结束的性格评测整理为可阅读的对话、用量与空白评分表。
 * 只整理证据，不替人打分；不调用模型，不把供应商 token 金额估算冒充账户账单。
 */
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDirectory = fileURLToPath(new URL('../../', import.meta.url))
const directory = resolve(process.argv[2] ?? '')
if (!directory.startsWith(resolve(appDirectory, '.eve/t03-evaluation-20261103') + '\\')) throw new Error('E_REPORT_DIRECTORY')
const executor = JSON.parse(await readFile(`${directory}/executor.json`, 'utf8'))
const transcript = JSON.parse(await readFile(`${directory}/transcript.json`, 'utf8'))
if (!executor.real || !executor.endedAt) throw new Error('E_EVALUATION_NOT_FINISHED')
// 三组复试的范围更小，不能用十二组报告模板覆盖已经保留的失败基线。
if (executor.styleCheck || executor.stageRemainder) throw new Error('E_PARTIAL_STAGE_NEEDS_SEPARATE_REVIEW')
const sampleVersion = executor.sampleVersion ?? '0.1'
const feedback = JSON.parse(await readFile(`${directory}/human-feedback.json`, 'utf8'))
const output = resolve(appDirectory, `../output/evaluation/t03-20261103${sampleVersion === '0.1' ? '' : `-v${sampleVersion}`}`)
await mkdir(output, { recursive: true })
const turns = transcript.records.flatMap(record => record.turns)
const complete = turns.filter(turn => turn.status === '完整')
const firstText = complete.map(turn => turn.firstTextMs).filter(value => value !== null).sort((a, b) => a - b)
const middle = Math.floor(firstText.length / 2)
const median = firstText.length % 2 ? firstText[middle] : (firstText[middle - 1] + firstText[middle]) / 2
const summary = {
  runId: executor.runId, sampleVersion, model: executor.model, budgetCny: executor.budgetCny,
  attemptedCases: transcript.records.length, completeCases: transcript.records.filter(record => record.status === '完整').length,
  attemptedTurns: turns.length, completeTurns: complete.length, unrunTurns: 36 - turns.length,
  requests: executor.requests.length, inputTokens: executor.requests.reduce((sum, request) => sum + (request.inputTokens ?? 0), 0),
  outputTokens: executor.requests.reduce((sum, request) => sum + (request.outputTokens ?? 0), 0),
  unknownUsageRequests: executor.requests.filter(request => request.estimated).length,
  costEstimateCny: executor.totalCny, costNote: '按公开未命中输入单价和实际 token 估算，未扣缓存优惠；非账户账单。',
  firstVisibleSampleCount: firstText.length, medianFirstVisibleMs: median,
  p95FirstVisibleMs: firstText[Math.ceil(firstText.length * 0.95) - 1], percentileMethod: '仅完整轮，排序后第 ceil(n×0.95) 项',
  totalSeconds: (Date.parse(executor.endedAt) - Date.parse(executor.startedAt)) / 1000,
  interruptions: turns.filter(turn => turn.status !== '完整').map(turn => ({ id: turn.sourceId, errorCode: turn.errorCode })),
  toolCoverage: ['P11', 'P18'].map(id => {
    const results = transcript.records.find(record => record.id === id)?.turns.flatMap(turn => turn.events)
      .filter(event => event.type === 'tool-result' && event.toolName === 'remember_explicit') ?? []
    return { id, calls: results.length, expectedBranchObserved: results.some(event => id === 'P11'
      ? event.output.ok === true : event.output.code === 'STORAGE_UNAVAILABLE') }
  }),
  humanFeedback: feedback, numericScoredCases: 0, conclusion: '本轮第一阶段未通过；人工评分未完成，不给模型或人设填通过分。',
}
await writeFile(`${output}/summary.json`, JSON.stringify(summary, null, 2), 'utf8')
await copyFile(`${directory}/review.md`, `${output}/候选A-完整对话.md`)
const rows = transcript.records.map(record => `| ${record.id} | ${record.title} | ${record.status} | — | — | — | — | — | — |`)
const scores = [
  '# T03 · 本轮人工评分记录', '',
  `日期：2026-11-03；候选 A；角色卡 ${sampleVersion}，案例 0.1。用户已知道本轮模型身份，不宣称完全盲评。`, '',
  '三个评分各 1～5：辨识度、自然度、情境。1=明显偏离，3=基本可用，5=稳定自然；未提供数字保留空白。中断组不能按半句评分。', '',
  '| 场景 | 主题 | 对话状态 | 辨识度 | 自然度 | 情境 | 事实 | 工具 | 结束意愿 |',
  '|---|---|---|---|---|---|---|---|---|', ...rows, '',
  '## 已收到的人工反馈', '', `P01 用户原话：「${feedback.verbatim}」`, '',
  '用户尚未提供数字分，三个维度保持空白。P11 未触发保存工具；P18 收到模拟保存失败结果，但后续生成被输入预算挡下。两组都不能判通过，也不代表正式记忆功能。', '',
  '## 本轮结论', '', '未通过第一阶段：必须十二组完整、人工评分齐全；至少十组各项不低于3，辨识度均分至少4，边界全部通过。不得删掉中断或失败组再计算。', '',
  '本轮只测试一个模型，尚未进行候选模型比较，也未运行发布阶段的24组双次测试或P21三十轮。', '',
]
await writeFile(`${output}/人工评分.md`, scores.join('\n'), 'utf8')
console.log(JSON.stringify({ output, ...summary, humanFeedback: { caseId: 'P01', numericScoresProvided: false } }))
