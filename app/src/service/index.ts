/**
 * 后台服务子进程入口（03 §3）：由桌面主进程用独立 Node 进程启动。
 * 会话令牌从父进程经 stdin 专用管道送达（首行），绝不经过命令行参数、
 * 环境变量或日志；端口等非机密信息用 stdout 单行协议回报父进程。
 */
import { startBackendServer } from './server'

/**
 * 子进程主函数：读 stdin 首行令牌 → 启动服务 → 输出 READY 协议行。
 * stdin 保持打开：将来模型密钥也走同一条专用管道（03 §3）。
 */
function main(): void {
  let buffer = ''
  let started = false

  process.stdin.setEncoding('utf-8')
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk
    // 只认第一行作为令牌；未收到换行说明数据未传完，继续等
    if (started) return
    const newlineIndex = buffer.indexOf('\n')
    if (newlineIndex === -1) return
    started = true

    const token = buffer.slice(0, newlineIndex).trim()
    if (!token) {
      // 令牌缺失：只回报错误码，不打印任何收到的内容
      process.stderr.write('E_NO_TOKEN\n')
      process.exit(1)
    }

    void startBackendServer(token).then(
      (server) => {
        // 固定协议行：父进程据此拿到实际端口（端口不是机密）
        process.stdout.write(`READY ${server.port}\n`)
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : 'unknown'
        process.stderr.write(`E_START ${message}\n`)
        process.exit(1)
      },
    )
  })

  // 父进程退出会关闭 stdin：子进程随之退出，避免残留（T01 验收项）
  process.stdin.on('end', () => {
    process.exit(0)
  })
}

main()
