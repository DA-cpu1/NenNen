/**
 * 后台服务这一侧的 eve 进程管理：分配本机端口、管道送机密、等健康检查、退出回收。
 * eve 的原始输出可能包含模型请求，全部丢弃；应用只报告我们定义的错误码。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { cleanupEveRuntimeDirectory } from './eve-runtime'
import { modelConnectionSchema, type ModelConnection } from '../shared/model-settings'

/** eve 服务的工作凭证；令牌只在后台内存里，不能交给界面。 */
export interface EveHandle {
  port: number
  token: string
  /** 只含执行进度的可丢弃目录，不能据此恢复用户聊天或记忆。 */
  dataDir: string
  stop(): Promise<void>
}

/** 启动参数：路径和模拟供应商地址均是公开配置，密钥仍只经 stdin。 */
export interface EveStartOptions {
  appDir: string
  modelApiKey?: string
  /** 自动检查可用本机假接口，真实运行省略此项。 */
  modelBaseUrl?: string
  /** 正式配置是公开资料；密钥仍独立走 stdin，不能放进这个对象。 */
  modelConnection?: ModelConnection
  /** 本机业务服务的公开端口；工具令牌仍经 stdin。 */
  memoryToolPort?: number
  /** 正式后台按数据库划分执行目录；独立探针可沿用仓库下的临时目录。 */
  runtimeRoot?: string
}

/**
 * 请系统挑一个空闲端口，随后交给 eve 使用。
 * @returns 可用端口号；端口 0 只负责分配，不能出现在工作流的内部回调地址里。
 */
function choosePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const reservation = createServer()
    reservation.once('error', reject)
    reservation.listen(0, '127.0.0.1', () => {
      const address = reservation.address()
      if (!address || typeof address === 'string') {
        reservation.close()
        reject(new Error('E_EVE_PORT'))
        return
      }
      reservation.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

/**
 * 关闭子进程并等它真正退出；重复调用共用同一次关闭。
 * @param child 本次启动的 eve 子进程
 * @param runtimeRoot 本次运行目录的固定父目录
 * @param dataDir 只属于本次进程的 run-目录
 * @returns 可重复调用的异步关闭函数
 */
export function makeEveStop(child: ChildProcess, runtimeRoot: string, dataDir: string): () => Promise<void> {
  const exited = new Promise<void>((resolve) => {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) resolve()
    else child.once('exit', () => resolve())
  })
  // 正常停止和自行退出都走同一个回收；必须先见到 exit，才允许删除执行文件。
  let stopped: Promise<void> | undefined
  /** 文件暂被系统占用时允许下一次重试清理，仍只删这个已经退出的进程目录。 */
  function cleanup(): Promise<void> {
    if (!stopped) {
      stopped = exited.then(() => cleanupEveRuntimeDirectory(runtimeRoot, dataDir)).catch((error: unknown) => {
        stopped = undefined
        throw error
      })
    }
    return stopped
  }
  // 自行退出也要收尾；没人等待时接住错误，之后仍可通过 stop() 重试。
  void cleanup().catch(() => {})
  let stopRequested = false
  return () => {
    if (!stopRequested) {
      stopRequested = true
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        child.stdin?.destroy()
        child.kill()
      }
    }
    return cleanup()
  }
}

/**
 * 启动一份 eve 服务；任何失败都会先回收子进程再返回错误。
 * @param options 应用根目录、可选密钥和测试地址
 * @returns 已通过健康检查的 eve 句柄
 */
export async function startEve(options: EveStartOptions): Promise<EveHandle> {
  const entry = join(options.appDir, '.output/server/index.mjs')
  const wrapper = join(options.appDir, 'scripts/eve-entry.mjs')
  if (!existsSync(entry) || !existsSync(wrapper)) throw new Error('E_EVE_BUILD_MISSING')

  const port = await choosePort()
  const token = randomBytes(32).toString('base64url')
  const runtimeRoot = options.runtimeRoot ?? join(options.appDir, '.eve/smoke')
  await mkdir(runtimeRoot, { recursive: true })
  // 每次用干净目录，防止框架重发上次请求；聊天只从 SQLite 重建。
  // 目录由这个进程捕获，退出后只回收这一项，不扫描清理其他 run-目录。
  const dataDir = await mkdtemp(join(runtimeRoot, 'run-'))
  const child = spawn(process.execPath, [wrapper, entry], {
    cwd: options.appDir,
    env: {
      ...process.env,
      // 打包后本进程自身就是应用 exe 客串的 Node，process.execPath 已指向
      // 应用 exe——孙进程要当 Node 用就得带同一个开关。开发环境下跑在
      // 真 node.exe 里，这个变量会被直接忽略，带着无害
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      HOST: '127.0.0.1',
      PORT: String(port),
      WORKFLOW_LOCAL_BASE_URL: `http://127.0.0.1:${port}`,
      WORKFLOW_LOCAL_DATA_DIR: dataDir,
      WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS: '0',
      EVE_TELEMETRY_DISABLED: '1',
      EVE_LOG_LEVEL: 'error',
      // 不继承外部测试地址，只有显式传入时才切换供应商。
      COMPANION_MODEL_BASE_URL: options.modelBaseUrl ?? '',
      COMPANION_MODEL_CONFIG: options.modelConnection ? JSON.stringify(modelConnectionSchema.parse(options.modelConnection)) : '',
      COMPANION_MEMORY_TOOL_PORT: options.memoryToolPort?.toString() ?? '',
    },
    // stdout/stderr 不落盘也不转发；框架错误对象可能含完整提示词。
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
  })
  const stop = makeEveStop(child, runtimeRoot, dataDir)
  let failed = false
  child.once('error', () => { failed = true })
  child.stdin?.on('error', () => { failed = true })
  child.stdin?.write(`${options.modelApiKey ?? ''}\n${token}\n`)

  try {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (failed || child.exitCode !== null || child.signalCode !== null) {
        throw new Error('E_EVE_EXIT')
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/eve/v1/health`, {
          signal: AbortSignal.timeout(500),
        })
        const health = await response.json() as { ok?: boolean; status?: string }
        if (response.status === 200 && health.ok && health.status === 'ready') {
          return { port, token, dataDir, stop }
        }
      } catch {
        // 监听刚开始可能还没就绪；只在启动时限内重试健康检查，不重试模型调用。
      }
      await delay(100)
    }
    throw new Error('E_EVE_START_TIMEOUT')
  } catch (error) {
    await stop()
    throw error
  }
}
