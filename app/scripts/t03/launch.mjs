/**
 * 文件职责：本次人工批准后启动真实性格评测；密钥只在父进程读取一次，通过 stdin 管道交付。
 * 不把密钥放进命令行、环境变量、日志或评测文件，不下载或安装任何工具。
 */
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// 各范围使用自己的批准标记，用户同意的小范围不会误启动完整十二组或不限金额模式。
const stageRemainder = process.argv.includes('--quality-remaining')
const qualityCheck = stageRemainder || process.argv.includes('--quality-check')
const styleCheck = !qualityCheck && process.argv.includes('--style-check')
const approvalFlag = qualityCheck ? '--approved-quality-priority' : styleCheck ? '--approved-cny-0.12' : '--approved-cny-0.60'
if (!process.argv.includes(approvalFlag)) throw new Error('E_EXPLICIT_BUDGET_REQUIRED')
const appDirectory = fileURLToPath(new URL('../../', import.meta.url))
const modelKey = (await readFile(`${appDirectory}/local.key`, 'utf8')).trim()
if (!modelKey) throw new Error('E_NO_MODEL_KEY')
const child = spawn(process.execPath, ['scripts/t03/evaluate.mts', '--real',
  ...(stageRemainder ? ['--quality-remaining'] : qualityCheck ? ['--quality-check'] : styleCheck ? ['--style-check'] : [])], {
  cwd: appDirectory, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true,
})
child.stdin.end(`${modelKey}\n`)
child.on('error', () => { console.error('E_EVALUATION_START'); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
