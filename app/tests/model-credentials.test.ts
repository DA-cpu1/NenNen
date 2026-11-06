/** 用隔离临时目录检查凭据文件、内存降级及失败反馈，不接触系统真实密钥。 */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createModelCredentialStore, type CredentialEncryption } from '../src/desktop/model-credentials'

const reference = '550e8400-e29b-41d4-a716-446655440000'
const fakeKey = 'fake-credential-for-fixed-tests'
const directories: string[] = []
// 这是假加密，只检查“先加密再写文件”的调用边界；安全强度由实际 safeStorage 验收。
const encryption: CredentialEncryption = {
  isAvailable: async () => true,
  encrypt: async (value) => Buffer.from(value).reverse(),
  decrypt: async (value) => Buffer.from(value).reverse().toString('utf-8'),
}

/** 每个案例拥有自己的目录，不能读到另一例或真实应用的凭据。 */
async function setup(adapter = encryption) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-credentials-'))
  directories.push(directory)
  return { directory, store: createModelCredentialStore(directory, adapter) }
}

afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })

describe('本机模型凭据', () => {
  it('磁盘不含明文，同一引用重试不新增文件，新实例可读回', async () => {
    const { store, directory } = await setup()
    expect(await store.save(reference, fakeKey)).toBe('encrypted')
    expect(await store.save(reference, fakeKey)).toBe('encrypted')
    expect(await readdir(join(directory, 'model-credentials'))).toEqual([`${reference}.bin`])
    expect((await readFile(join(directory, 'model-credentials', `${reference}.bin`))).includes(Buffer.from(fakeKey))).toBe(false)
    expect(await createModelCredentialStore(directory, encryption).read(reference)).toBe(fakeKey)
    await expect(store.save(reference, 'another-fake-key')).rejects.toThrow('E_CREDENTIAL_CONFLICT')
  })
  it('加密不可用只放内存，重新创建保管箱后没有密钥', async () => {
    const { store, directory } = await setup({ ...encryption, isAvailable: async () => false })
    expect(await store.save(reference, fakeKey)).toBe('memory')
    expect(await store.read(reference)).toBe(fakeKey)
    expect(await readdir(directory)).toEqual([])
    expect(await createModelCredentialStore(directory, encryption).read(reference)).toBeUndefined()
  })
  it('加密或磁盘保存失败，不返回成功也不降级写明文', async () => {
    const broken = { ...encryption, encrypt: vi.fn(async () => { throw new Error('private-error') }) }
    const { store, directory } = await setup(broken)
    await expect(store.save(reference, fakeKey)).rejects.toThrow('E_CREDENTIAL_SAVE')
    expect(await readdir(directory)).toEqual([])
    await writeFile(join(directory, 'model-credentials'), 'occupied')
    await expect(createModelCredentialStore(directory, encryption).save(reference, fakeKey)).rejects.toThrow('E_CREDENTIAL_SAVE')
  })
  it('损坏或无法解密时只报固定码，不把原始错误传出去', async () => {
    const { store, directory } = await setup()
    await store.save(reference, fakeKey)
    const broken = createModelCredentialStore(directory, { ...encryption, decrypt: async () => { throw new Error(fakeKey) } })
    await expect(broken.read(reference)).rejects.toThrow(/^E_CREDENTIAL_DECRYPT$/)
  })
  it('删除可重试，缺少文件明确返回未配置，路径不能越界', async () => {
    const { store } = await setup()
    expect(await store.storage(reference)).toBe('missing')
    await store.save(reference, fakeKey)
    await store.remove(reference)
    await store.remove(reference)
    expect(await store.read(reference)).toBeUndefined()
    await expect(store.remove('../outside')).rejects.toThrow('E_CREDENTIAL_REFERENCE')
  })
})
