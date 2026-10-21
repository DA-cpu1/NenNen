/**
 * 主进程这边的后台进程"管家"：雇人、发暗号、等报到、失联处理、叫下班。
 * 暗号只存在于两个进程的内存里——绝不进命令行参数（系统进程列表谁都能查）、
 * 不进环境变量（子进程里任何代码都能读）、不进日志、不给窗口界面（03 §3）。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { app } from 'electron'

/** 后台进程的"工作证"：端口号 + 暗号 + 下班按钮 */
export interface BackendHandle {
  /** 后台正在监听的端口号（不是机密，可以记日志） */
  port: number
  /** 暗号：主进程打电话时用。只存在内存里——不打印、不给窗口界面 */
  token: string
  /** 让后台进程下班；对已退出的进程再按也无害 */
  stop(): void
}

/** 等报到的闹钟：后台还要等 eve 启动，给 20 秒；超时明确失败，避免窗口永远等。 */
const START_TIMEOUT_MS = 20_000

/**
 * 雇一个后台进程并等它报到。
 * 开发时用系统 Node 24.10.0 跑构建产物；打包后用应用自己的 exe 运行后台脚本。
 * eve 要求 Node 至少为 24；安装后和无开发环境下的数据库读写仍待验证（08 V06）。
 * @param modelApiKey 模型密钥（可选）：和暗号一样从管子送过去，只进内存
 * @returns 工作证（端口号 + 暗号 + 下班按钮）
 */
export function startBackend(modelApiKey?: string): Promise<BackendHandle> {
  return new Promise((resolve, reject) => {
    // 每次开机现编一个新暗号：32 字节纯随机数，自己编给自己用——
    // 两个进程都是本程序的，不像网页登录那样由服务器"下发"。
    // 每次都换新的，就算哪次泄露了，重启就作废
    const token = randomBytes(32).toString('base64url')

    // 跑后台用哪个程序：开发环境用系统 node；打包后用户机器上未必装了 Node，
    // 改用应用自己的 exe 客串（ELECTRON_RUN_AS_NODE=1 让它以 Node 模式运行脚本）。
    // 既有记录报告内嵌 Node 24.22.0，并验证过免安装目录中的后台/eve 启动与请求送达；
    // 后台尚未接入数据库，不能把这些结果写成安装后数据库也已通过（08 C02）。
    // 后台脚本的位置也分两套：打包后它被放在 asar 档案外的
    // app.asar.unpacked 目录——独立进程读不了 asar 档案里的文件
    const packaged = app.isPackaged
    const serviceEntry = packaged
      ? join(process.resourcesPath, 'app.asar.unpacked', 'out', 'main', 'service.js')
      : join(__dirname, 'service.js')

    // spawn = 启动一个全新进程。三根管子 = stdin/stdout/stderr：操作系统
    // 在父子进程之间接的"私有线"，流过的内容只有这两家看得见，不进任何
    // 文件、日志或系统记录——所以传机密只走这里
    const child: ChildProcess = spawn(packaged ? process.execPath : 'node', [serviceEntry], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // 注意：暗号绝不放进启动参数或环境变量，唯一出路是下面的输入管子。
      // 打包时多带的 ELECTRON_RUN_AS_NODE 是公开的运行方式开关，不是机密
      ...(packaged ? { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } } : {}),
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

    // 管道协议：第 1 行暗号，第 2 行模型密钥（没配置就发空行占位）。
    // 这两样东西离开主进程内存的唯一一条路就是这根管子
    child.stdin?.write(`${token}\n${modelApiKey ?? ''}\n`)
  })
}
