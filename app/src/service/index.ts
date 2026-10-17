/**
 * 后台进程的入口：被主进程雇来后——从管子收暗号、开始接电话、回头报到。
 * 暗号只走 stdin 管道（命令行参数、环境变量、日志里都不许出现）；
 * 端口号不是机密，从 stdout 报给主进程。
 */
import { startBackendServer } from './server'

/**
 * 流程：读管子第一行当暗号 → 启动总机 → 输出「READY 端口号」报到。
 * 管子保持打开不关：将来模型密钥也从这条管子送来（03 §3）。
 */
function main(): void {
  let buffer = ''
  let started = false

  process.stdin.setEncoding('utf-8')
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk
    if (started) return
    // 还没见到换行 = 暗号没传完，继续等
    const newlineIndex = buffer.indexOf('\n')
    if (newlineIndex === -1) return
    started = true

    const token = buffer.slice(0, newlineIndex).trim()
    if (!token) {
      // 空暗号：只报错误码，不打印收到的任何内容
      process.stderr.write('E_NO_TOKEN\n')
      process.exit(1)
    }

    void startBackendServer(token).then(
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
