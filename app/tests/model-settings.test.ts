/** 检查公开设置不会收下密钥、危险地址或错误容量；所有输入都是虚构资料。 */
import { describe, expect, it } from 'vitest'
import {
  applyModelSettingsSchema, DEFAULT_MODEL_CONNECTION, modelApiKeySchema,
  modelConnectionSchema, readRuntimeModelConnection, saveModelSettingsSchema, storedModelSettingsSchema,
} from '../src/shared/model-settings'

const reference = '550e8400-e29b-41d4-a716-446655440000'
const settings = { connection: DEFAULT_MODEL_CONNECTION, credentialRef: reference, testStatus: 'untested' }

describe('模型设置输入', () => {
  it('运行期优先用完整配置，损坏时不回退到固定供应商', () => {
    const custom = { ...DEFAULT_MODEL_CONNECTION, model: 'custom-model', baseUrl: 'https://example.com/v1' }
    expect(readRuntimeModelConnection(JSON.stringify(custom), 'http://127.0.0.1:1234')).toEqual(custom)
    expect(() => readRuntimeModelConnection('{bad-json')).toThrow('E_MODEL_CONFIGURATION')
  })
  it('保留既有配置起点，并去掉地址末尾斜线', () => {
    expect(modelConnectionSchema.parse({ ...DEFAULT_MODEL_CONNECTION, baseUrl: `${DEFAULT_MODEL_CONNECTION.baseUrl}/` }))
      .toEqual(DEFAULT_MODEL_CONNECTION)
    expect(storedModelSettingsSchema.parse(settings)).toEqual(settings)
  })
  it.each(['file:///private', 'https://user:password@example.com/v1', 'https://example.com/v1?key=fake',
    'https://example.com/v1#fake', 'not-a-url'])('拒绝不合适的服务地址 %s', (baseUrl) => {
    expect(modelConnectionSchema.safeParse({ ...DEFAULT_MODEL_CONNECTION, baseUrl }).success).toBe(false)
  })
  it('允许本机假供应商和明确填写容量的自定义模型', () => {
    expect(modelConnectionSchema.safeParse({ provider: 'openai-compatible', model: 'fixed-model',
      baseUrl: 'http://127.0.0.1:12345/v1', contextWindowTokens: 32768, outputReserveTokens: 4096 }).success).toBe(true)
    expect(modelConnectionSchema.safeParse({ ...DEFAULT_MODEL_CONNECTION, outputReserveTokens: 1_000_000 }).success).toBe(false)
    expect(modelConnectionSchema.safeParse({ ...DEFAULT_MODEL_CONNECTION, contextWindowTokens: 0 }).success).toBe(false)
  })
  it('接受温度、Top P 和思考档位，并拒绝越界值', () => {
    expect(modelConnectionSchema.safeParse({ ...DEFAULT_MODEL_CONNECTION, displayName: '我的配置',
      temperature: 1.2, topP: 0.98, reasoning: { enabled: true, effort: 'max' } }).success).toBe(true)
    expect(modelConnectionSchema.safeParse({ ...DEFAULT_MODEL_CONNECTION, temperature: 3 }).success).toBe(false)
    expect(modelConnectionSchema.safeParse({ ...DEFAULT_MODEL_CONNECTION, topP: 1.5 }).success).toBe(false)
    expect(modelConnectionSchema.safeParse({ ...DEFAULT_MODEL_CONNECTION, displayName: '  ' }).success).toBe(false)
    expect(modelConnectionSchema.safeParse({ ...DEFAULT_MODEL_CONNECTION,
      reasoning: { enabled: true, effort: 'medium' } }).success).toBe(false)
  })
  it('旧配置没有新字段也能读取，不会被当成损坏配置', () => {
    const legacy = { provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com',
      contextWindowTokens: 1_000_000, outputReserveTokens: 8_192 }
    expect(modelConnectionSchema.safeParse(legacy).success).toBe(true)
    expect(storedModelSettingsSchema.safeParse({ ...settings, connection: legacy }).success).toBe(true)
  })
  it('密钥只能出现在单独的保存请求，不能进入公开配置', () => {    expect(storedModelSettingsSchema.safeParse({ ...settings, apiKey: 'fake-test-key' }).success).toBe(false)
    expect(modelConnectionSchema.safeParse({ ...DEFAULT_MODEL_CONNECTION, apiKey: 'fake-test-key' }).success).toBe(false)
    expect(saveModelSettingsSchema.safeParse({ requestId: reference, connection: DEFAULT_MODEL_CONNECTION,
      apiKey: 'fake-test-key' }).success).toBe(true)
  })
  it('凭据引用必须与内部传入的密钥同时存在，禁止路径和管道换行', () => {
    expect(applyModelSettingsSchema.safeParse({ settings, apiKey: 'fake-test-key' }).success).toBe(true)
    expect(applyModelSettingsSchema.safeParse({ settings, apiKey: null }).success).toBe(false)
    expect(storedModelSettingsSchema.safeParse({ ...settings, credentialRef: '../outside' }).success).toBe(false)
    expect(modelApiKeySchema.safeParse('fake\nsecond-line').success).toBe(false)
  })
})
