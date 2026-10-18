/**
 * 程序"大管家"进程的入口：开一个窗口、把界面装进去、雇一个后台进程干重活。
 * 规矩：窗口界面不许碰数据库和密钥，重活全在后台进程（03 §3）。
 * 现在是技术贯通骨架：密钥已走后台管道；防双开和托盘留待后续小步骤。
 */
import { app, BrowserWindow } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startBackend, type BackendHandle } from './backend'

/** 开发期的密钥文件位置（app/local.key，git 已挡住不进仓库）。
 * 正式版改由设置页输入 + safeStorage 加密存储（T11），不再读本地明文文件 */
const MODEL_KEY_FILE = join(__dirname, '../../local.key')

/** 读开发期密钥文件；不存在或为空就返回 undefined（= 未配置模型） */
function readModelKey(): string | undefined {
  if (!existsSync(MODEL_KEY_FILE)) return undefined
  const key = readFileSync(MODEL_KEY_FILE, 'utf-8').trim()
  return key || undefined
}

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
 * 雇后台进程并当场自测，共两步：
 * ① 拿暗号打 /health 应接通（200），不拿暗号应被拒（401）；
 * ② 配了密钥就打 /agent/ping——经过 eve 完成一轮，验证两跳密钥管道和模型调用。
 * 日志只记状态码、耗时和用量数字——暗号、密钥、模型回复原文都不进日志（03 §7）
 */
async function startBackendWithSelfCheck(): Promise<void> {
  const modelKey = readModelKey()
  const handle = await startBackend(modelKey)
  backend = handle
  const authHeader = { 'x-session-token': handle.token }
  const withToken = await fetch(`http://127.0.0.1:${handle.port}/health`, {
    headers: authHeader,
  })
  const withoutToken = await fetch(`http://127.0.0.1:${handle.port}/health`)
  console.log(
    `[后台] 端口 ${handle.port}；带令牌 ${withToken.status}（应 200）；未认证 ${withoutToken.status}（应 401）`,
  )

  if (!modelKey) {
    console.log('[模型] app/local.key 不存在，跳过模型自测')
    return
  }
  const started = Date.now()
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/agent/ping`, {
      headers: authHeader,
    })
    const body = (await res.json()) as {
      ok: boolean
      text?: string
      usage?: { inputTokens?: number; outputTokens?: number } | null
      code?: string
      message?: string
    }
    const elapsed = Date.now() - started
    if (res.status === 200 && body.ok) {
      // 只记字符数和用量，不记回复原文（回复将来是聊天内容，不进日志）
      console.log(
        `[eve] 连通成功（${elapsed}ms）；回复 ${body.text?.length ?? 0} 字；用量 in=${body.usage?.inputTokens ?? '?'} out=${body.usage?.outputTokens ?? '?'}`,
      )
    } else {
      console.error(`[模型] 自测失败（${elapsed}ms）：${body.code ?? res.status} ${body.message ?? ''}`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown'
    console.error(`[模型] 自测请求失败：${message}`)
  }
}

app.whenReady().then(() => {
  createWindow()
  // 后台起不来不能连累窗口白屏：先记下来。重试和提示用户是以后的事
  startBackendWithSelfCheck().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unknown'
    console.error(`[后台] 启动失败：${message}`)
  })
})
