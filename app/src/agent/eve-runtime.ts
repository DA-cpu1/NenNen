/**
 * 只回收本次 eve 进程的私有执行目录，避免删到其他实例或用户资料。
 * 删除前同时核对文字路径与真实路径；符号链接像路径快捷方式，不能借它越界。
 */
import { lstat, readdir, realpath, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

const runtimeName = /^run-[A-Za-z0-9_-]+$/

/** 两个绝对路径是否指向同一位置；Windows 的盘符与大小写由系统路径规则处理。 */
function samePath(left: string, right: string): boolean {
  return relative(left, right) === '' && relative(right, left) === ''
}

/** 只把「不存在」视为已经清理，其他文件错误不能冒充成功。 */
function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/**
 * 删除本次由 mkdtemp 建立的 run-目录；调用方必须先确认该 eve 进程已经退出。
 * @param runtimeRoot 本次创建目录时使用的完整运行根目录
 * @param dataDir 本次 mkdtemp 返回的完整目录，不从磁盘扫描或重新猜测
 * @returns 清理完成；目标已不存在时同样完成，便于重复停止
 * @throws E_EVE_RUNTIME_PATH 路径越界或遇到链接；E_EVE_RUNTIME_CLEANUP_FAILED 无法检查或删除
 */
export async function cleanupEveRuntimeDirectory(runtimeRoot: string, dataDir: string): Promise<void> {
  const root = resolve(runtimeRoot)
  const target = resolve(dataDir)
  if (!isAbsolute(runtimeRoot) || !isAbsolute(dataDir) || !samePath(dirname(target), root)
    || runtimeRoot.split(/[\\/]/).includes('..') || dataDir.split(/[\\/]/).includes('..')
    || !runtimeName.test(basename(target))) throw new Error('E_EVE_RUNTIME_PATH')

  try {
    const rootInfo = await lstat(root)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('E_EVE_RUNTIME_PATH')
    // realpath 会沿所有父目录找到实际位置；上层目录被换成链接时也不能继续删除。
    const realRoot = await realpath(root)
    if (!samePath(realRoot, root)) throw new Error('E_EVE_RUNTIME_PATH')
    const targetInfo = await lstat(target)
    if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()) throw new Error('E_EVE_RUNTIME_PATH')
    const realTarget = await realpath(target)
    if (!samePath(realTarget, target) || !samePath(dirname(realTarget), realRoot)) {
      throw new Error('E_EVE_RUNTIME_PATH')
    }
    // 到这里已实查绝对路径、真实路径及直接父目录，只删创建时捕获的这一项。
    await rm(target, { recursive: true, maxRetries: 3, retryDelay: 50 })
  } catch (error) {
    if (isMissing(error)) return
    if (error instanceof Error && error.message === 'E_EVE_RUNTIME_PATH') throw error
    throw new Error('E_EVE_RUNTIME_CLEANUP_FAILED')
  }
}

/**
 * 清理异常退出留下的运行文件。只在持有该数据目录的应用启动锁、还没启动新 eve 时调用。
 * @param runtimeRoot 当前数据库专属的绝对运行根目录
 * @returns 所有可识别的旧运行目录已经清理，其他文件保持原样
 */
export async function cleanupEveRuntimeRoot(runtimeRoot: string): Promise<void> {
  if (!isAbsolute(runtimeRoot) || runtimeRoot.split(/[\\/]/).includes('..')) throw new Error('E_EVE_RUNTIME_PATH')
  try {
    const info = await lstat(runtimeRoot)
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(runtimeRoot), runtimeRoot)) {
      throw new Error('E_EVE_RUNTIME_PATH')
    }
    for (const entry of await readdir(runtimeRoot)) {
      if (runtimeName.test(entry)) await cleanupEveRuntimeDirectory(runtimeRoot, join(runtimeRoot, entry))
    }
  } catch (error) {
    if (isMissing(error)) return
    if (error instanceof Error && error.message === 'E_EVE_RUNTIME_PATH') throw error
    throw new Error('E_EVE_RUNTIME_CLEANUP_FAILED')
  }
}
