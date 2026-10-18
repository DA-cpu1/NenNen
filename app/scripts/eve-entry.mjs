/**
 * eve 子进程的启动入口：运行编译产物，并在父进程消失时退出。
 * 只接收公开的构建文件路径；密钥和令牌由作者目录的代码从 stdin 读取。
 */
import { pathToFileURL } from 'node:url'

// Windows 强制结束后台时不会执行后台的清理函数；定期检查原父进程是否还在，
// 给 eve 留第二道退出保险。PID 是操作系统给进程的编号，不是认证令牌。
const parentPid = process.ppid
const parentCheck = setInterval(() => {
  try {
    process.kill(parentPid, 0)
  } catch {
    process.exit(0)
  }
}, 500)
parentCheck.unref()

// 机密读完后，stdin 仍保持打开；父进程正常断线时可更早结束。
process.stdin.on('end', () => process.exit(0))
process.stdin.on('error', () => process.exit(1))

try {
  await import(pathToFileURL(process.argv[2]).href)
} catch {
  // 不能打印原错误对象：第三方错误可能夹带提示词或密钥。
  process.stderr.write('E_EVE_BOOT\n')
  process.exit(1)
}
