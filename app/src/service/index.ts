/**
 * 后台进程入口：从主进程管道收令牌和密钥，启动业务 HTTP 服务及 eve 子进程。
 * 机密只通过 stdin 在内存间交付；stdout 只报 READY 端口，stderr 只报固定错误码。
 */
import { resolve } from 'node:path'
import { startBackendServer, type BackendOptions, type BackendServer } from './server'
import { startEve, type EveHandle } from '../agent/eve-process'
import { pingEve } from '../agent/eve-client'

/** 应用根目录：编译产物在 out/main/，往上两级正好是 app/ */
const APP_DIR = resolve(__dirname, '../..')

/**
 * 接收两行启动消息并等待服务就绪；主进程断线时回收 eve 后退出。
 * @returns 无返回值；启动结果用 READY 协议或错误码通知主进程。
 */
function main(): void {
  let buffer = ''
  let started = false
  let closing = false
  /** 当前在岗的 eve；换密钥时整个换人，这个变量永远只指向「现在这个」 */
  let eve: EveHandle | undefined
  let server: BackendServer | undefined

  /**
   * 后台服务的选项表。特意用「一张可原地更新的表」而不是一次性常量：
   * 换密钥时更新 modelApiKey，服务处理每个请求都现读这张表，
   * 不会拿到换钥前的旧值
   */
  const options: BackendOptions = {
    pingAgent: (signal) => {
      if (!eve) return Promise.reject(new Error('E_EVE_NOT_RUNNING'))
      return pingEve(eve, signal)
    },
    rotateModelKey: (newKey) => rotateModelKey(newKey),
  }

  /** 只执行一次关闭：先停业务请求，再结束 eve，最后退出后台。 */
  async function shutdown(): Promise<void> {
    if (closing) return
    closing = true
    await server?.stop()
    await eve?.stop()
    process.exit(0)
  }

  /** 用指定密钥起一个 eve。失败向外抛，由调用方决定善后。 */
  async function startEveWith(key: string): Promise<void> {
    eve = await startEve({
      appDir: APP_DIR,
      modelApiKey: key,
      // 只传公开测试地址；自动检查让请求落到本机假供应商，避免误花钱
      modelBaseUrl: process.env.COMPANION_MODEL_BASE_URL || undefined,
    })
  }

  /** 开机：有密钥先起 eve，再起业务总机，报到端口。 */
  async function start(token: string, modelApiKey: string): Promise<void> {
    if (modelApiKey) await startEveWith(modelApiKey)
    if (closing) {
      await eve?.stop()
      return
    }
    options.modelApiKey = modelApiKey || undefined
    server = await startBackendServer(token, options)
    if (closing) {
      await server.stop()
      await eve?.stop()
      return
    }
    process.stdout.write(`READY ${server.port}\n`)
  }

  /**
   * 运行期换密钥（03 §3「重新配置」通道）：先停旧 eve、再用新密钥起全新的。
   * 为什么整体换进程而不是原地改：密钥在 eve 里只存在于进程内存和管道里，
   * 「换人」是唯一不残留旧密钥的办法。换机期间 modelApiKey 置空——
   * 这段时间自测请求得到明确的 AGENT_ERROR，而不是拿旧密钥硬试；
   * 新进程起失败则保持「无 eve」，绝不回退用旧密钥。
   */
  async function rotateModelKey(newKey: string): Promise<void> {
    const previous = eve
    eve = undefined
    options.modelApiKey = undefined
    await previous?.stop()
    await startEveWith(newKey)
    options.modelApiKey = newKey
  }

  process.stdin.setEncoding('utf-8')
  process.stdin.on('data', (chunk: string) => {
    if (started) return
    buffer += chunk
    const first = buffer.indexOf('\n')
    const second = first < 0 ? -1 : buffer.indexOf('\n', first + 1)
    if (second < 0) return
    started = true
    const token = buffer.slice(0, first).trim()
    const modelApiKey = buffer.slice(first + 1, second).trim()
    buffer = ''
    if (!token) {
      process.stderr.write('E_NO_TOKEN\n')
      process.exit(1)
    }
    void start(token, modelApiKey).catch(async () => {
      await eve?.stop()
      process.stderr.write('E_START\n')
      process.exit(1)
    })
  })
  process.stdin.on('end', () => { void shutdown() })
  process.stdin.on('error', () => { void shutdown() })
}

main()
