/** 检查新的凭据通道拒绝桌宠、子页面和导航后的外站；不接收真实凭据。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerModelSettingsBridge } from '../src/bridge/model-settings'
import type { DesktopModelSettings } from '../src/desktop/model-settings-controller'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler) } }))

beforeEach(() => handlers.clear())

describe('模型设置窗口权限', () => {
  it('仅指定窗口的受信主页面可以调用，回包不携带明文', async () => {
    const controller = { read: vi.fn(async () => ({ ok: true, data: { ready: false } })),
      save: vi.fn(), remove: vi.fn(), restore: vi.fn() } as unknown as DesktopModelSettings
    registerModelSettingsBridge(controller, () => ({ id: 7, url: 'file:///trusted/index.html' }))
    const frame = { url: 'file:///trusted/index.html' }
    const event = { sender: { id: 7, mainFrame: frame }, senderFrame: frame }
    expect(await handlers.get('model:settings')!(event)).toMatchObject({ ok: true })
    for (const name of ['model:settings', 'model:save', 'model:delete', 'model:test', 'model:test-cancel']) {
      for (const bad of [{ ...event, sender: { id: 8, mainFrame: frame } },
        { ...event, senderFrame: { url: frame.url } },
        { sender: { id: 7, mainFrame: { url: 'https://external.example.com' } }, senderFrame: { url: 'https://external.example.com' } }]) {
        expect(await handlers.get(name)!(bad)).toEqual({ ok: false, code: 'UNAUTHORIZED' })
      }
    }
    expect(controller.save).not.toHaveBeenCalled()
    expect(controller.remove).not.toHaveBeenCalled()
  })
})
