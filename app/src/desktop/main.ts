/**
 * 桌面主进程入口（03 §3）：创建首个窗口并加载界面，启动后台服务子进程。
 * 当前是 T01 最小贯通：单实例锁、托盘、密钥交付在后续小步加入。
 */
import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { startBackend, type BackendHandle } from './backend'

/** 创建主窗口；开发环境连 electron-vite 开发服务器，生产加载打包产物 */
function createWindow(): void {
  const win = new BrowserWindow({
    width: 420,
    height: 640,
    title: '二次元女友',
    autoHideMenuBar: true,
    webPreferences: {
      // 03 §7：界面沙箱与隔离，禁用 Node 直接访问
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, '../preload/index.js'),
    },
  })

  // electron-vite 约定：开发模式注入界面开发服务器地址，生产环境加载文件
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// 所有窗口关闭即退出（Windows 惯例；后续加入托盘常驻时再调整）
app.on('window-all-closed', () => {
  app.quit()
})

// 退出前回收后台子进程，保证无残留（T01 验收项）；kill 是同步派发，无需等待
app.on('will-quit', () => {
  backend?.stop()
})

/** 当前后台子进程句柄；每次启动重建 */
let backend: BackendHandle | undefined

/**
 * 启动后台服务并做启动自检：
 * 用令牌访问 /health 应得 200，不带令牌应得 401。
 * 日志只记端口与状态码，不记令牌（03 §7）。
 */
async function startBackendWithSelfCheck(): Promise<void> {
  const handle = await startBackend()
  backend = handle
  const withToken = await fetch(`http://127.0.0.1:${handle.port}/health`, {
    headers: { 'x-session-token': handle.token },
  })
  const withoutToken = await fetch(`http://127.0.0.1:${handle.port}/health`)
  console.log(
    `[后台] 端口 ${handle.port}；带令牌 ${withToken.status}（应 200）；未认证 ${withoutToken.status}（应 401）`,
  )
}

app.whenReady().then(() => {
  createWindow()
  // 后台启动失败不让界面跟着挂：先记录，后续步骤再做重试与用户提示
  startBackendWithSelfCheck().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unknown'
    console.error(`[后台] 启动失败：${message}`)
  })
})
