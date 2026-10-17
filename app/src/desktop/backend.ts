/**
 * 主进程这边的后台进程"管家"：雇人、发暗号、等报到、失联处理、叫下班。
 * 暗号只存在于两个进程的内存里——绝不进命令行参数（系统进程列表谁都能查）、
 * 不进环境变量（子进程里任何代码都能读）、不进日志、不给窗口界面（03 §3）。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

/** 后台进程的"工作证"：端口号 + 暗号 + 下班按钮 */
export interface BackendHandle {
  /** 后台正在监听的端口号（不是机密，可以记日志） */
  port: number
  /** 暗号：主进程打电话时用。只存在内存里——不打印、不给窗口界面 */
  token: string
  /** 让后台进程下班；对已退出的进程再按也无害 */
  stop(): void
}

/** 等报到的闹钟：超过 10 秒还没收到 READY 就当启动失败，
 * 免得子进程卡死把整个程序挂住 */
const START_TIMEOUT_MS = 10_000

/**
 * 雇一个后台进程并等它报到。
 * 现在用系统里的 node（24.10.0，后台框架 eve 要求这个版本）跑构建产物；
 * 打包成安装包后会改用随包自带的 node（08 V06，到打包那步再验证）。
 * @returns 工作证（端口号 + 暗号 + 下班按钮）
 */
export function startBackend(): Promise<BackendHandle> {
  return new Promise((resolve, reject) => {
    // 每次开机现编一个新暗号：32 字节纯随机数。每次都换新的——
    // 就算哪次泄露了，重启就作废
    const token = randomBytes(32).toString('base64url')
    // 要跑的文件：和本文件（out/main/index.js）同目录的 service.js（构建时一起生成）
    const serviceEntry = join(__dirname, 'service.js')

    // spawn = 启动一个全新进程。三根管子（输入/输出/错误）全接到自己手上
    const child: ChildProcess = spawn('node', [serviceEntry], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // 注意：暗号绝不放进启动参数或环境变量，唯一出路是下面的输入管子
    })

    // "结局只定一次"的标记：闹钟、崩溃、报到三处都可能宣布结局，
    // 谁先到谁算，后来的直接忽略，收尾动作不重复做
    let settled = false
    let stdoutBuffer = ''

    const timeout = setTimeout(() => {
      fail(new Error(`后台服务 ${START_TIMEOUT_MS}ms 内未就绪`))
    }, START_TIMEOUT_MS)

    /** 失败收尾：停闹钟、收尸、把失败原因报出去 */
    function fail(error: Error): void {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      child.kill()
      reject(error)
    }

    // 死法一：进程压根没起来（比如系统里找不到 node）
    child.on('error', (error) => fail(error))
    // 死法二：起来了又自己崩了（多半是 service.js 抛了异常）
    child.on('exit', (code) => {
      if (!settled) fail(new Error(`后台服务提前退出，退出码 ${code ?? 'null'}`))
    })

    child.stdout?.setEncoding('utf-8')
    child.stdout?.on('data', (chunk: string) => {
      if (settled) return
      // 管道是"流"：一次事件可能只送到半截（比如先来 "REA" 再来 "DY 4633"），
      // 所以先攒进 buffer，见到换行符才算一行凑齐
      stdoutBuffer += chunk
      const newlineIndex = stdoutBuffer.indexOf('\n')
      if (newlineIndex === -1) return
      const line = stdoutBuffer.slice(0, newlineIndex).trim()
      // 只认「READY 空格 数字」这一种格式，别的全当故障——
      // 防止子进程意外输出的内容被误当成端口号
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
          child.kill()
        },
      })
    })

    // 把暗号从输入管子塞过去（换行 = "暗号到此为止"）。
    // 这是暗号离开主进程内存的唯一一条路
    child.stdin?.write(`${token}\n`)
  })
}
