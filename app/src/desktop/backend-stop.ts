/**
 * 桌面退出时先合上给后台的输入管道，让后台保存取消状态并回收eve。
 * 后台不回应时才强制结束，并设置最后期限，不能让退出永远卡住。
 */
import type { ChildProcess } from 'node:child_process'

/**
 * 为本次后台进程建立可重复调用的停止动作。
 * @param child 本次创建的后台进程，不能传别的进程编号
 * @param graceMs 等后台正常收尾的最长毫秒数
 * @param forcedExitMs 强制结束后再等退出事件的最长毫秒数
 * @returns 同一次停止的Promise；超时只给固定错误码
 */
export function makeBackendStop(child: ChildProcess, graceMs = 10_000, forcedExitMs = 2_000): () => Promise<void> {
  let stopping: Promise<void> | undefined
  return () => {
    stopping ??= new Promise<void>((resolve, reject) => {
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) { resolve(); return }
      let forceTimer: ReturnType<typeof setTimeout> | undefined
      let exitTimer: ReturnType<typeof setTimeout> | undefined
      let finished = false
      let forceRequested = false
      /** 只收尾一次；进程已退出就撤掉闹钟，不能晚些时候误杀复用的进程号。 */
      function finish(error?: Error): void {
        if (finished) return
        finished = true
        clearTimeout(forceTimer)
        clearTimeout(exitTimer)
        child.removeListener('exit', onExit)
        child.stdin?.removeListener('error', onPipeError)
        if (error) reject(error)
        else resolve()
      }
      const onExit = () => finish()
      /** 管道已经坏了就走强制结束；仍然只处理这次捕获的child。 */
      const force = () => {
        clearTimeout(forceTimer)
        if (finished || forceRequested) return
        forceRequested = true
        try { child.kill() } catch { /* 最后期限仍会报告固定失败码。 */ }
        exitTimer = setTimeout(() => finish(new Error('E_BACKEND_STOP_TIMEOUT')), forcedExitMs)
      }
      const onPipeError = () => force()
      child.once('exit', onExit)
      child.stdin?.once('error', onPipeError)
      forceTimer = setTimeout(force, graceMs)
      try {
        if (child.stdin) child.stdin.end()
        else force()
      } catch { force() }
    })
    return stopping
  }
}
