/** 退出协议检查：先通知后台收尾、等待exit，只有超时才强杀；不启动真实进程。 */
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeBackendStop } from '../src/desktop/backend-stop'
import { createQuitBarrier } from '../src/desktop/quit-barrier'

/** 假进程只提供管道与退出事件，固定编号不会交给系统kill。 */
function fakeChild() {
  const stdin = Object.assign(new EventEmitter(), { end: vi.fn() })
  return Object.assign(new EventEmitter(), {
    pid: 12345, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    stdin, kill: vi.fn(() => true),
  })
}

afterEach(() => vi.useRealTimers())

describe('桌面后台退出协议', () => {
  it('先结束stdin，exit之前不放行；重复stop共用结果且正常退出不kill', async () => {
    const child = fakeChild()
    const stop = makeBackendStop(child as unknown as ChildProcess)
    const stopped = stop()
    expect(stop()).toBe(stopped)
    expect(child.stdin.end).toHaveBeenCalledTimes(1)
    expect(child.kill).not.toHaveBeenCalled()
    let completed = false
    void stopped.then(() => { completed = true })
    await Promise.resolve()
    expect(completed).toBe(false)
    child.exitCode = 0
    child.emit('exit', 0, null)
    await stopped
    expect(completed).toBe(true)
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('超过正常收尾期限才kill，强杀仍无exit时明确超时，不永远卡住', async () => {
    vi.useFakeTimers()
    const child = fakeChild()
    const stopped = makeBackendStop(child as unknown as ChildProcess, 100, 20)()
    const result = expect(stopped).rejects.toThrow(/^E_BACKEND_STOP_TIMEOUT$/)
    await vi.advanceTimersByTimeAsync(99)
    expect(child.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(child.kill).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(20)
    await result
    expect(vi.getTimerCount()).toBe(0)
  })

  it('强杀后收到exit就撤掉所有闹钟，已退出进程不再写管道或kill', async () => {
    vi.useFakeTimers()
    const child = fakeChild()
    const stopped = makeBackendStop(child as unknown as ChildProcess, 100, 20)()
    await vi.advanceTimersByTimeAsync(100)
    child.signalCode = 'SIGTERM'
    child.emit('exit', null, 'SIGTERM')
    await stopped
    expect(vi.getTimerCount()).toBe(0)
    const exited = fakeChild()
    exited.exitCode = 0
    await makeBackendStop(exited as unknown as ChildProcess)()
    expect(exited.stdin.end).not.toHaveBeenCalled()
    expect(exited.kill).not.toHaveBeenCalled()
  })

  it('退出屏障等待后台；连续退出不重做，后台失败也有界限地放行', async () => {
    let complete!: () => void
    const stopped = new Promise<void>((resolve) => { complete = resolve })
    const stop = vi.fn(() => stopped), quit = vi.fn(), failed = vi.fn()
    const barrier = createQuitBarrier(stop, quit, failed)
    const first = { preventDefault: vi.fn() }
    barrier(first)
    barrier({ preventDefault: vi.fn() })
    expect(first.preventDefault).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(quit).not.toHaveBeenCalled()
    complete()
    await stopped
    await Promise.resolve()
    await Promise.resolve()
    expect(quit).toHaveBeenCalledTimes(1)
    const final = { preventDefault: vi.fn() }
    barrier(final)
    expect(final.preventDefault).not.toHaveBeenCalled()
    expect(failed).not.toHaveBeenCalled()
    const errorBarrier = createQuitBarrier(async () => { throw new Error('private-error') }, quit, failed)
    errorBarrier({ preventDefault: vi.fn() })
    await Promise.resolve()
    await Promise.resolve()
    expect(failed).toHaveBeenCalledTimes(1)
    expect(quit).toHaveBeenCalledTimes(2)
  })
})
