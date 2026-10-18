/**
 * 后台进程入口：从主进程管道收令牌和密钥，启动业务 HTTP 服务及 eve 子进程。
 * 机密只通过 stdin 在内存间交付；stdout 只报 READY 端口，stderr 只报固定错误码。
 */
import { resolve } from 'node:path'
import { startBackendServer, type BackendServer } from './server'
import { startEve, type EveHandle } from '../agent/eve-process'
import { pingEve } from '../agent/eve-client'

/**
 * 接收两行启动消息并等待服务就绪；主进程断线时回收 eve 后退出。
 * @returns 无返回值；启动结果用 READY 协议或错误码通知主进程。
 */
function main(): void {
  let buffer = ''
  let started = false
  let closing = false
  let eve: EveHandle | undefined
  let server: BackendServer | undefined

  /** 只执行一次关闭：先停业务请求，再结束 eve，最后退出后台。 */
  async function shutdown(): Promise<void> {
    if (closing) return
    closing = true
    await server?.stop()
    await eve?.stop()
    process.exit(0)
  }

  /** 密钥收齐后启动 eve；没有密钥时保留基础服务，不触发付费调用。 */
  async function start(token: string, modelApiKey: string): Promise<void> {
    if (modelApiKey) {
      eve = await startEve({
        appDir: resolve(__dirname, '../..'),
        modelApiKey,
        // 只传公开测试地址；自动检查让请求落到本机假供应商，避免误花钱。
        modelBaseUrl: process.env.COMPANION_MODEL_BASE_URL || undefined,
      })
      if (closing) {
        await eve.stop()
        return
      }
    }
    const handle = eve
    server = await startBackendServer(token, {
      modelApiKey: modelApiKey || undefined,
      pingAgent: handle ? (signal) => pingEve(handle, signal) : undefined,
    })
    if (closing) {
      await server.stop()
      await eve?.stop()
      return
    }
    process.stdout.write(`READY ${server.port}\n`)
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
