/**
 * 后台子进程管理（03 §3 后台部分的桌面侧）：
 * 生成会话令牌 → 启动独立 Node 子进程 → 经 stdin 安全交付令牌 →
 * 解析 READY 协议行获得端口 → 退出时回收子进程。
 * 令牌只存在于主进程与子进程的内存，绝不写入命令行、环境变量、日志或渲染进程。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

/** 后台子进程句柄 */
export interface BackendHandle {
  /** 子进程实际监听的回环端口（非机密，可记录日志） */
  port: number
  /** 本次会话令牌：仅主进程内存使用，不打印、不下发渲染进程 */
  token: string
  /** 回收子进程；已在退出中则幂等 */
  stop(): void
}

/** 等待 READY 协议行的超时时间；超时按启动失败处理并回收子进程 */
const START_TIMEOUT_MS = 10_000

/**
 * 启动后台服务子进程。
 * 开发阶段用系统 PATH 里的 Node（当前 24.10.0，满足 eve 要求）运行构建产物；
 * 打包版将改用随安装包提供的独立 Node 运行环境（03 §2 运行环境、08 V06，后续步骤验证）。
 * @returns 端口与令牌句柄
 */
export function startBackend(): Promise<BackendHandle> {
  return new Promise((resolve, reject) => {
    // 每次启动生成新的会话令牌（03 §3：每次启动生成）
    const token = randomBytes(32).toString('base64url')
    // 与 out/main/index.js 同目录的构建产物：out/main/service.js
    const serviceEntry = join(__dirname, 'service.js')

    const child: ChildProcess = spawn('node', [serviceEntry], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // 不把令牌放进 env 或 args——唯一交付通道是 stdin（03 §3）
    })

    let settled = false
    let stdoutBuffer = ''

    const timeout = setTimeout(() => {
      fail(new Error(`后台服务 ${START_TIMEOUT_MS}ms 内未就绪`))
    }, START_TIMEOUT_MS)

    /** 统一收尾：只允许成功或失败二选一，重复调用无副作用 */
    function fail(error: Error): void {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      child.kill()
      reject(error)
    }

    child.on('error', (error) => fail(error))
    child.on('exit', (code) => {
      if (!settled) fail(new Error(`后台服务提前退出，退出码 ${code ?? 'null'}`))
    })

    child.stdout?.setEncoding('utf-8')
    child.stdout?.on('data', (chunk: string) => {
      if (settled) return
      stdoutBuffer += chunk
      const newlineIndex = stdoutBuffer.indexOf('\n')
      if (newlineIndex === -1) return
      const line = stdoutBuffer.slice(0, newlineIndex).trim()
      // 固定协议：READY <port>
      const match = /^READY (\d+)$/.exec(line)
      if (!match) {
        fail(new Error('后台服务返回了无法识别的协议行'))
        return
      }
      settled = true
      clearTimeout(timeout)
      resolve({
        port: Number(match[1]),
        token,
        stop: () => {
          // Windows 上 kill 默认即终止进程；幂等
          child.kill()
        },
      })
    })

    // 令牌经专用 stdin 管道交付（首行），这是它离开主进程内存的唯一路径
    child.stdin?.write(`${token}\n`)
  })
}
