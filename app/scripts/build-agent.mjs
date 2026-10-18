/**
 * 构建 eve 作者目录：使用仓库已安装的精确版本，不下载依赖，并关闭 CLI 遥测。
 * 遥测是工具向作者上报使用情况；本项目不需要把开发活动发到外部。
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const appDir = fileURLToPath(new URL('../', import.meta.url))
const child = spawn(process.execPath, ['node_modules/eve/bin/eve.js', 'build', '--skip-sandbox-prewarm'], {
  cwd: appDir,
  env: { ...process.env, EVE_TELEMETRY_DISABLED: '1' },
  stdio: 'inherit',
})
child.on('error', () => { process.exitCode = 1 })
child.on('exit', (code) => { process.exitCode = code ?? 1 })
