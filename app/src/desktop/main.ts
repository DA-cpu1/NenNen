/**
 * 程序"大管家"进程的入口：开一个窗口、把界面装进去、雇一个后台进程干重活。
 * 规矩：窗口界面不许碰数据库和密钥，重活全在后台进程（03 §3）。
 * 现在还是最小骨架——防双开的锁、托盘图标、密钥交付都还没做。
 */
import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { startBackend, type BackendHandle } from './backend'

/** 创建主窗口；开发时连本地开发服务器（改代码立即生效），正式版加载打包好的文件 */
function createWindow(): void {
  const win = new BrowserWindow({
    width: 420,
    height: 640,
    title: '二次元女友',
    autoHideMenuBar: true,
    webPreferences: {
      // 三道安全开关：把界面当纯网页对待，拿不到 Node 能力、碰不了文件和数据库（03 §7）
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, '../preload/index.js'),
    },
  })

  // electron-vite 的约定：开发模式会把这个变量塞给我们，指向上面的开发服务器
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// 所有窗口都关掉就退出程序（Windows 的惯例；以后加托盘常驻时再改）
app.on('window-all-closed', () => {
  app.quit()
})

// 程序退出前叫后台进程下班，不许留孤儿进程占着内存和端口
app.on('will-quit', () => {
  backend?.stop()
})

/** 当前的后台进程句柄；每次启动重新雇一个 */
let backend: BackendHandle | undefined

/**
 * 雇后台进程并当场自测：拿暗号打 /health 应该接通（200），
 * 不拿暗号应该被拒（401），两个都符合才算通道正常。
 * 日志只记端口号和结果数字——暗号绝不能进日志（03 §7）
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
  // 后台起不来不能连累窗口白屏：先记下来。重试和提示用户是以后的事
  startBackendWithSelfCheck().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unknown'
    console.error(`[后台] 启动失败：${message}`)
  })
})
