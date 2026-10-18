/**
 * 后台进程的入口：被主进程雇来后——从管子收暗号和模型密钥、开始接电话、
 * 回头报到。两样东西都只走 stdin 管道（命令行参数、环境变量、日志里
 * 都不许出现）；端口号不是机密，从 stdout 报给主进程。
 */
import { startBackendServer } from './server'

/**
 * 管道协议（v2）：第 1 行 = 会话暗号（必填），第 2 行 = 模型密钥
 * （可为空行 = 未配置模型）。两行都到齐才启动服务。
 * 管子保持打开不关：以后还有别的机密从这条管子送来（03 §3）。
 */
function main(): void {
  let buffer = ''
  let started = false

  process.stdin.setEncoding('utf-8')
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk
    if (started) return
    const firstNl = buffer.indexOf('\n')
    if (firstNl === -1) return // 第 1 行没传完，继续等
    const secondNl = buffer.indexOf('\n', firstNl + 1)
    if (secondNl === -1) return // 第 2 行没传完，继续等
    started = true

    const token = buffer.slice(0, firstNl).trim()
    const modelApiKey = buffer.slice(firstNl + 1, secondNl).trim()
    if (!token) {
      // 空暗号：只报错误码，不打印收到的任何内容
      process.stderr.write('E_NO_TOKEN\n')
      process.exit(1)
    }

    void startBackendServer(token, { modelApiKey: modelApiKey || undefined }).then(
      (server) => {
        // 固定格式的报到行，主进程靠它拿到端口号
        process.stdout.write(`READY ${server.port}\n`)
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : 'unknown'
        process.stderr.write(`E_START ${message}\n`)
        process.exit(1)
      },
    )
  })

  // 第二道保险：主进程一死，管子就断（stdin 结束），我们立刻退，
  // 不留孤儿进程占着端口
  process.stdin.on('end', () => {
    process.exit(0)
  })
}

main()
