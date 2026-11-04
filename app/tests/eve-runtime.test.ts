/**
 * 只用本仓库忽略目录内新建的临时资料，检查 eve 退出后只删自己的 run-目录。
 * 不启动 eve、不扫描旧目录；链接测试的外部目标也只在同一测试资料夹里。
 */
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanupEveRuntimeDirectory, cleanupEveRuntimeRoot } from '../src/agent/eve-runtime'
import { makeEveStop } from '../src/agent/eve-process'

const failure = vi.hoisted(() => ({ remove: false }))
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (failure.remove) throw new Error('private-path-and-prompt-must-not-escape')
      return actual.rm(...args)
    },
  }
})

const fixtureBase = resolve(process.cwd(), '.eve')
let fixture: string
let runtimeRoot: string
let dataDir: string

beforeEach(async () => {
  failure.remove = false
  await mkdir(fixtureBase, { recursive: true })
  fixture = await mkdtemp(join(fixtureBase, 'runtime-cleanup-test-'))
  runtimeRoot = join(fixture, 'smoke')
  await mkdir(runtimeRoot)
  dataDir = await mkdtemp(join(runtimeRoot, 'run-'))
  await writeFile(join(dataDir, 'execution.txt'), 'fixed-test-data')
})

afterEach(async () => {
  failure.remove = false
  // 测试收尾也先检查实际绝对位置；只删本测试刚创建的资料夹，不扫 .eve。
  const target = resolve(fixture)
  if (dirname(target) !== fixtureBase || !basename(target).startsWith('runtime-cleanup-test-')
    || (await lstat(target)).isSymbolicLink() || await realpath(target) !== target) {
    throw new Error('E_TEST_FIXTURE_PATH')
  }
  await rm(target, { recursive: true })
})

/** 假进程只提供退出事件和停止动作，不创建系统进程。 */
function fakeChild() {
  return Object.assign(new EventEmitter(), {
    pid: 12345, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    stdin: { destroy: vi.fn() }, kill: vi.fn(() => true),
  })
}

describe('eve 私有运行目录回收', () => {
  it('重启只清理当前数据库自己的旧运行目录', async () => {
    const siblingRoot = join(fixture, 'other-database')
    await mkdir(siblingRoot)
    const otherRun = await mkdtemp(join(siblingRoot, 'run-'))
    const userFile = join(runtimeRoot, 'keep.txt')
    await writeFile(userFile, 'fixed-user-file')
    await cleanupEveRuntimeRoot(runtimeRoot)
    expect(existsSync(dataDir)).toBe(false)
    expect(existsSync(userFile)).toBe(true)
    expect(existsSync(otherRun)).toBe(true)
  })

  it('成功只删除指定run目录，保留根目录、其他实例和外部资料；重复清理可复用', async () => {
    const sibling = await mkdtemp(join(runtimeRoot, 'run-'))
    const outside = join(fixture, 'user-data.txt')
    await writeFile(outside, 'fixed-user-data')
    await cleanupEveRuntimeDirectory(runtimeRoot, dataDir)
    expect(existsSync(dataDir)).toBe(false)
    expect(existsSync(runtimeRoot)).toBe(true)
    expect(existsSync(sibling)).toBe(true)
    expect(existsSync(outside)).toBe(true)
    await expect(cleanupEveRuntimeDirectory(runtimeRoot, dataDir)).resolves.toBeUndefined()
  })

  it('拒绝根目录、父级跳转、同级目录及不属于run的目录，资料保持存在', async () => {
    const siblingRoot = join(fixture, 'other-smoke')
    await mkdir(siblingRoot)
    const siblingRun = await mkdtemp(join(siblingRoot, 'run-'))
    const ordinary = join(runtimeRoot, 'user-data')
    await mkdir(ordinary)
    for (const invalid of [runtimeRoot, join(dataDir, '..'), `${dataDir}/..//${basename(dataDir)}`, siblingRun, ordinary]) {
      await expect(cleanupEveRuntimeDirectory(runtimeRoot, invalid)).rejects.toThrow(/^E_EVE_RUNTIME_PATH$/)
    }
    await expect(cleanupEveRuntimeDirectory(runtimeRoot, 'run-relative')).rejects.toThrow(/^E_EVE_RUNTIME_PATH$/)
    expect(existsSync(dataDir)).toBe(true)
    expect(existsSync(siblingRun)).toBe(true)
    expect(existsSync(ordinary)).toBe(true)
  })

  it('拒绝目标或运行根目录的链接逃逸', async ({ skip }) => {
    const outside = join(fixture, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'keep.txt'), 'fixed-data')
    const linkedRun = join(runtimeRoot, 'run-linked')
    const linkedRoot = join(fixture, 'linked-smoke')
    try {
      await symlink(outside, linkedRun, 'junction')
      await symlink(runtimeRoot, linkedRoot, 'junction')
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error
        && ['EPERM', 'EACCES', 'ENOTSUP'].includes(String(error.code))) { skip(); return }
      throw error
    }
    await expect(cleanupEveRuntimeDirectory(runtimeRoot, linkedRun)).rejects.toThrow(/^E_EVE_RUNTIME_PATH$/)
    await expect(cleanupEveRuntimeDirectory(linkedRoot, join(linkedRoot, basename(dataDir)))).rejects.toThrow(/^E_EVE_RUNTIME_PATH$/)
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true)
    expect(existsSync(dataDir)).toBe(true)
  })

  it('run目录里的链接只删链接本身，不追到链接指向的资料', async ({ skip }) => {
    const outside = join(fixture, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'keep.txt'), 'fixed-data')
    try { await symlink(outside, join(dataDir, 'linked-files'), 'junction') }
    catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error
        && ['EPERM', 'EACCES', 'ENOTSUP'].includes(String(error.code))) { skip(); return }
      throw error
    }
    await cleanupEveRuntimeDirectory(runtimeRoot, dataDir)
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true)
    expect(existsSync(dataDir)).toBe(false)
  })

  it('停止等待真实exit事件才清目录；重复stop共用同一结果且只kill一次', async () => {
    const child = fakeChild()
    const stop = makeEveStop(child as unknown as ChildProcess, runtimeRoot, dataDir)
    const first = stop()
    expect(stop()).toBe(first)
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(existsSync(dataDir)).toBe(true)
    child.exitCode = 0
    child.emit('exit', 0, null)
    await first
    expect(existsSync(dataDir)).toBe(false)
    expect(stop()).toBe(first)
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('进程自行退出也回收本次目录，不额外kill', async () => {
    const child = fakeChild()
    const stop = makeEveStop(child as unknown as ChildProcess, runtimeRoot, dataDir)
    child.exitCode = 1
    child.emit('exit', 1, null)
    await stop()
    expect(existsSync(dataDir)).toBe(false)
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('清理失败只返回固定码，不暴露原始路径或报错正文', async () => {
    failure.remove = true
    await expect(cleanupEveRuntimeDirectory(runtimeRoot, dataDir)).rejects.toThrow(/^E_EVE_RUNTIME_CLEANUP_FAILED$/)
    const child = fakeChild()
    const stop = makeEveStop(child as unknown as ChildProcess, runtimeRoot, dataDir)
    const stopped = stop()
    child.exitCode = 0
    child.emit('exit', 0, null)
    await expect(stopped).rejects.toThrow(/^E_EVE_RUNTIME_CLEANUP_FAILED$/)
    expect(existsSync(dataDir)).toBe(true)
    failure.remove = false
    await expect(stop()).resolves.toBeUndefined()
    expect(existsSync(dataDir)).toBe(false)
    expect(child.kill).toHaveBeenCalledTimes(1)
  })
})
