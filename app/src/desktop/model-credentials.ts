/**
 * 主进程独占的模型凭据保管箱：磁盘只写系统加密后的字节。
 * 每次新凭据用独立编号，后台尚未保存新地址时也不会把旧编号指向新密钥。
 */
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { credentialReferenceSchema, modelApiKeySchema } from '../shared/model-settings'

/** 把 Electron 加密能力作为参数传入，固定检查便可模拟不可用或损坏的情况。 */
export interface CredentialEncryption {
  isAvailable(): Promise<boolean>
  encrypt(value: string): Promise<Buffer>
  decrypt(value: Buffer): Promise<string>
}

/** 保管状态可以交给界面，明文读取能力只能留在主进程。 */
export type CredentialStorage = 'encrypted' | 'memory' | 'missing'

/**
 * 在应用自己的用户目录中保管凭据；不读取任何开发期明文文件。
 * @param dataDir Electron 的 userData 目录
 * @param encryption 当前系统的加解密能力
 * @returns 按随机引用保存、读取、查看状态和删除的固定操作
 */
export function createModelCredentialStore(dataDir: string, encryption: CredentialEncryption) {
  const directory = join(dataDir, 'model-credentials')
  const memory = new Map<string, string>()

  /** 引用只认 UUID，拦住 ../ 等路径，避免误读或误删目录外的文件。 */
  function filePath(reference: string): string {
    if (!credentialReferenceSchema.safeParse(reference).success) throw new Error('E_CREDENTIAL_REFERENCE')
    return join(directory, `${reference}.bin`)
  }

  /** 没有文件是正常的“未配置”；其他磁盘故障不能伪装成文件不存在。 */
  async function exists(reference: string): Promise<boolean> {
    try {
      const info = await stat(filePath(reference))
      if (!info.isFile() || info.size > 65_536) throw new Error('E_CREDENTIAL_READ')
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw new Error('E_CREDENTIAL_READ')
    }
  }

  /** 只返回保管方式，不解密，也不把明文带给窗口。 */
  async function storage(reference: string): Promise<CredentialStorage> {
    filePath(reference)
    if (memory.has(reference)) return 'memory'
    return await exists(reference) ? 'encrypted' : 'missing'
  }

  /** 只给后台交付时读取；解密失败报固定码，绝不把加密文件当明文读。 */
  async function read(reference: string): Promise<string | undefined> {
    filePath(reference)
    if (memory.has(reference)) return memory.get(reference)
    if (!await exists(reference)) return undefined
    try {
      if (!await encryption.isAvailable()) throw new Error('unavailable')
      const value = await encryption.decrypt(await readFile(filePath(reference)))
      const checked = modelApiKeySchema.safeParse(value)
      if (!checked.success) throw new Error('invalid')
      return checked.data
    } catch { throw new Error('E_CREDENTIAL_DECRYPT') }
  }

  /**
   * 先写好独立凭据，调用方才可把编号交给 SQLite。
   * 同一编号重试只接受同一密钥；新内容必须使用新编号，不能覆盖旧配置的凭据。
   */
  async function save(reference: string, value: string): Promise<CredentialStorage> {
    const path = filePath(reference)
    const checked = modelApiKeySchema.safeParse(value)
    if (!checked.success) throw new Error('E_CREDENTIAL_INPUT')
    const previous = await read(reference)
    if (previous !== undefined) {
      if (previous !== checked.data) throw new Error('E_CREDENTIAL_CONFLICT')
      return storage(reference)
    }
    try {
      if (!await encryption.isAvailable()) {
        memory.set(reference, checked.data)
        return 'memory'
      }
      const encrypted = await encryption.encrypt(checked.data)
      await mkdir(directory, { recursive: true })
      // wx 只创建新文件：重试和意外重用编号都不能覆盖仍被旧设置引用的文件。
      await writeFile(path, encrypted, { flag: 'wx' })
      return 'encrypted'
    } catch { throw new Error('E_CREDENTIAL_SAVE') }
  }

  /** 删除已不存在的文件也算完成，方便同一个删除请求安全重试。 */
  async function remove(reference: string): Promise<void> {
    const path = filePath(reference)
    try { await unlink(path) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('E_CREDENTIAL_DELETE')
    }
    memory.delete(reference)
  }

  return { save, read, storage, remove }
}

export type ModelCredentialStore = ReturnType<typeof createModelCredentialStore>
