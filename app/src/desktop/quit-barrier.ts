/** 退出屏障：后台完成收尾后才再次请求Electron退出，避免先杀进程丢掉取消状态。 */

/** 只需要这一个动作就能拦住本次退出，不把整个Electron对象交给辅助函数。 */
interface QuitEvent { preventDefault(): void }

/**
 * 生成before-quit处理器，重复退出请求只共用一次后台收尾。
 * @param stop 停止受理并等待后台实际退出
 * @param quit 后台收尾结束后再次请求退出
 * @param onFailure 收尾失败时记录固定错误码，不接触原始错误
 * @returns Electron退出事件的同步处理器
 */
export function createQuitBarrier(stop: () => Promise<void>, quit: () => void, onFailure: () => void): (event: QuitEvent) => void {
  let ready = false
  let stopping = false
  return (event) => {
    if (ready) return
    event.preventDefault()
    if (stopping) return
    stopping = true
    void stop().catch(() => onFailure()).finally(() => {
      ready = true
      quit()
    })
  }
}
