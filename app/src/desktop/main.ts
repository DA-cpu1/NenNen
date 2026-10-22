/**
 * 程序"大管家"进程的入口：开窗口、把界面装进去、雇一个后台进程干重活。
 * 规矩：窗口界面不许碰数据库和密钥，重活全在后台进程（03 §3）。
 * 现在开两个窗口：T01 的状态窗 + T02 的透明桌宠窗（角色小样）；
 * 托盘留待后续小步骤。
 */
import { app, BrowserWindow, ipcMain, Menu, screen } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startBackend, type BackendHandle } from './backend'
import { petWindowStateSchema } from '../shared/window-state'
import { clampPetBounds, defaultPetBounds, type WorkArea } from './pet-bounds'

/** 开发期的密钥文件位置（app/local.key，git 已挡住不进仓库）。
 * 打包后主程序住在 resources/app.asar/out/main 里，「往上两级」会指到
 * asar 档案内部——所以打包版改从 resources 目录读（测试时由验收脚本
 * 放置）。正式版改由设置页输入 + safeStorage 加密存储（T11），不再读明文文件 */
const MODEL_KEY_FILE = app.isPackaged
  ? join(process.resourcesPath, 'local.key')
  : join(__dirname, '../../local.key')

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

/** 桌宠窗口的引用；关闭时置空。拖动、缩放、右键菜单都通过它操作窗口 */
let petWindow: BrowserWindow | undefined

/** 拖动状态：定时器和「抓手点」偏移。二者存在 = 正在拖动 */
let petDragTimer: NodeJS.Timeout | undefined
let petDragOffset: { x: number; y: number } | undefined

/**
 * 手动拖动·开始：记下光标在窗口里的「抓手点」，然后开一个约每帧一次的
 * 定时器，让窗口跟着光标走。
 * 为什么不用 CSS 的 -webkit-app-region: drag：它把区域交给系统当「标题栏」，
 * 右键和点击事件都会被吞——桌宠以后要靠点击开聊天、右键弹菜单（01 §5）。
 * 为什么坐标不走界面进程：主进程直接向屏幕查询光标位置（系统统一的逻辑
 * 像素单位），不在进程之间传坐标，也就不必做多屏缩放换算。
 */
function startPetDrag(): void {
  if (petDragTimer) return
  const pet = petWindow
  if (!pet || pet.isDestroyed()) return
  const bounds = pet.getBounds()
  const cursor = screen.getCursorScreenPoint()
  petDragOffset = { x: cursor.x - bounds.x, y: cursor.y - bounds.y }
  petDragTimer = setInterval(() => {
    const win = petWindow
    if (!win || win.isDestroyed()) {
      stopPetDrag()
      return
    }
    const point = screen.getCursorScreenPoint()
    // 抓手点相对光标保持不动：拖动时角色不会「跳」到光标中心
    win.setPosition(
      Math.round(point.x - (petDragOffset?.x ?? 0)),
      Math.round(point.y - (petDragOffset?.y ?? 0)),
    )
  }, 16)
}

/** 手动拖动·结束：关定时器、清状态；重复调用无害 */
function stopPetDrag(): void {
  if (petDragTimer) {
    clearInterval(petDragTimer)
    petDragTimer = undefined
  }
  petDragOffset = undefined
  // 拖完顺手保存位置：重启后角色停在用户放的地方（T02 位置恢复）
  void savePetBounds()
}

/** 桌宠当前缩放比例：1 = 默认大小。限幅防止缩到看不见或盖满整屏 */
let petScale = 1
const PET_SCALE_MIN = 0.25
const PET_SCALE_MAX = 3
/** 每档缩放的倍数：向上滚一格放大 10%，向下滚缩小回 ~91% */
const PET_SCALE_STEP = 1.1

/**
 * 把桌宠窗口改成指定比例。「钉住脚底」：底部中点不动，角色向上长大、
 * 向下缩小——桌宠站在桌面上的感觉，而不是以窗口中心缩放。
 * 为什么比例由主进程记：界面只是一张填满窗口的图，不需要知道比例；
 * 状态少一份，两边对不上账的机会就少一个。
 */
function resizePetWindow(scale: number): void {
  const pet = petWindow
  if (!pet || pet.isDestroyed()) return
  const width = Math.round(PET_WINDOW_SIZE.width * scale)
  const height = Math.round(PET_WINDOW_SIZE.height * scale)
  const bounds = pet.getBounds()
  // 一次 setBounds 改位置和尺寸：分两次调会出现「先缩再挪」的中间帧，肉眼可见地抖
  pet.setBounds({
    x: Math.round(bounds.x + (bounds.width - width) / 2),
    y: Math.round(bounds.y + bounds.height - height),
    width,
    height,
  })
}

/** 右键菜单（01 §5 桌宠页）。目前只有一项：恢复默认位置和大小（R01） */
function showPetMenu(): void {
  const pet = petWindow
  if (!pet || pet.isDestroyed()) return
  Menu.buildFromTemplate([
    {
      label: '恢复默认位置和大小',
      click: () => {
        petScale = 1
        pet.setBounds(
          defaultPetBounds(
            PET_WINDOW_SIZE.width,
            PET_WINDOW_SIZE.height,
            screen.getPrimaryDisplay().workArea,
          ),
        )
        // 恢复完也保存：下次重启直接落在默认位，不再跳回旧位置
        void savePetBounds()
      },
    },
  ]).popup({ window: pet })
}

/**
 * 显示器配置变化（拔屏、改缩放）时，把角色当场拉回还存在的可见区（03 §3）。
 * 改缩放后各屏工作区的 DIP 矩形会变，原来合法的位置可能悬到屏外；
 * clamp 只做最小平移——位置本来合法时窗口纹丝不动，不会借机「归位」。
 * 完全不可见（屏被拔）就放回主屏默认位。
 */
function keepPetVisible(): void {
  const pet = petWindow
  if (!pet || pet.isDestroyed()) return
  const check = petWindowStateSchema.safeParse(pet.getBounds())
  if (!check.success) return
  const areas: WorkArea[] = screen.getAllDisplays().map((display) => display.workArea)
  const clamped = clampPetBounds(check.data, areas)
  if (clamped) {
    pet.setBounds(clamped)
  } else {
    pet.setBounds(
      defaultPetBounds(
        PET_WINDOW_SIZE.width,
        PET_WINDOW_SIZE.height,
        screen.getPrimaryDisplay().workArea,
      ),
    )
  }
}

/**
 * 把桌宠当前位置保存进数据库（经后台服务，界面进程不经手）。
 * 三个「没有就不保存」的前置：窗口没了、后台还没起来、读到的矩形过不了
 * 格式关卡——任何一条不满足都安静跳过。保存失败只记状态码
 * （01 R17：失败不假装成功，也不拿错误原文刷屏）。
 */
async function savePetBounds(): Promise<void> {
  const pet = petWindow
  const handle = backend
  if (!pet || pet.isDestroyed() || !handle) return
  const check = petWindowStateSchema.safeParse(pet.getBounds())
  if (!check.success) return
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/window-state`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-session-token': handle.token },
      body: JSON.stringify(check.data),
    })
    if (res.status !== 200) {
      console.error(`[窗口状态] 保存失败：${res.status}`)
    }
  } catch {
    // 网络层失败（比如后台正好在关闭）：不重试，下次拖动/缩放会再存
  }
}

/**
 * 开机恢复桌宠位置：向后台要上次保存的位置，能用就先「拉回可见区」再落位。
 * 四道防线，任何一道不过都停在默认位置，绝不拿脏数据设窗口：
 * ① 请求失败；② 没存过（state 为 null）；③ 存的值过不了格式关卡；
 * ④ 位置在当前桌面布局里完全不可见（显示器被拔，clamp 返回 null）。
 * 已知取舍：窗口先按默认位显示、恢复数据到位后跳过去——后台就绪要几秒，
 * 与其让角色迟到，不如让它先出现再挪窝（T05 再优化启动顺序）。
 */
async function restorePetBounds(handle: BackendHandle): Promise<void> {
  const pet = petWindow
  if (!pet || pet.isDestroyed()) return
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/window-state`, {
      headers: { 'x-session-token': handle.token },
    })
    if (res.status !== 200) {
      console.error(`[窗口状态] 读取失败：${res.status}`)
      return
    }
    const body = (await res.json()) as { ok: boolean; state: unknown }
    if (!body.ok || body.state === null) return
    const check = petWindowStateSchema.safeParse(body.state)
    if (!check.success) return
    // 工作区矩形（Rectangle）与 WorkArea 字段相同，结构上直接兼容
    const areas: WorkArea[] = screen.getAllDisplays().map((display) => display.workArea)
    const clamped = clampPetBounds(check.data, areas)
    if (!clamped) return
    pet.setBounds(clamped)
  } catch {
    // 后台未就绪等瞬时原因：保持默认位置，本次不恢复
  }
}


/** 桌宠窗口的初始尺寸，与占位图 pet-sample.svg 的 viewBox（200×260）一致：
 *  窗口多大、角色就多大，透明区只存在于角色图的镂空处（R01：尺寸与实际
 *  挡鼠标的区域一致——窗口不留角色外面的大片空白） */
const PET_WINDOW_SIZE = { width: 200, height: 260 }

/**
 * 创建桌宠窗口：无边框 + 全透明（03 §3）。和状态窗的关键差别：
 * - frame: false 去掉标题栏和边框——桌宠不是「带标题栏的软件窗口」；
 * - transparent: true 允许整窗透明：没画内容的像素直接露出桌面；
 * - hasShadow: false 关掉系统投影——投影按矩形窗口算，会给透明的四角
 *   投出「不存在的东西」，看起来像一圈脏边；
 * - resizable: false 不给系统拖边框缩放——无边框窗没有边可拖，
 *   缩放按规格走 Ctrl 滚轮（后续小步骤实现，03 §3）；
 * - skipTaskbar: true 不占任务栏——任务栏位置归状态窗，桌宠常驻不抢位。
 */
function createPetWindow(): void {
  const pet = new BrowserWindow({
    ...PET_WINDOW_SIZE,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    // 透明窗常用「先藏后亮」：等页面真正画完再显示，避免先白屏一闪
    show: false,
    webPreferences: {
      // 和状态窗相同的三道安全开关：桌宠同样是纯网页，拿不到 Node 能力（03 §7）
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, '../preload/index.js'),
    },
  })
  // 存到模块级变量：拖动、后续的缩放/右键菜单都要靠它找到这个窗口
  petWindow = pet
  // 窗口关闭时清空引用，并兜底停掉拖动——防止界面没来得及发「结束」信号，
  // 窗口就一直黏在光标上
  pet.on('closed', () => {
    petWindow = undefined
    stopPetDrag()
  })
  pet.once('ready-to-show', () => {
    pet.show()
  })
  // electron-vite 的约定：开发模式连本地开发服务器，正式版加载打包好的文件
  if (process.env.ELECTRON_RENDERER_URL) {
    // 多入口页面对应开发服务器上的「/pet.html」（见 electron.vite.config.ts 的 input）
    void pet.loadURL(`${process.env.ELECTRON_RENDERER_URL}/pet.html`)
  } else {
    void pet.loadFile(join(__dirname, '../renderer/pet.html'))
  }
}

/** 当前的后台进程句柄；每次启动重新雇一个 */
let backend: BackendHandle | undefined

/**
 * 抢「全程序唯一」的锁（03 §3：双开不允许）。
 * requestSingleInstanceLock 由操作系统层面仲裁：第一个实例拿到 true，
 * 之后再双击图标，新拿到的实例只会拿到 false。
 * 抢不到的实例唯一的任务就是安静退出——不开窗口、不雇后台、不发任何模型请求。
 * 所以下面的窗口、事件注册、开机流程全部包在「抢到了」的分支里。
 */
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // 有人再次双击图标时，操作系统把这次启动「转交」给拿到锁的我们。
  // 反应保持最小：把已有窗口弹回最前，仅此而已——不起第二套后台、
  // 不触发任何模型调用（03 §3）
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      // 窗口可能被最小化在任务栏：先还原再聚焦，用户才看得见
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  // 所有窗口都关掉就退出程序（Windows 的惯例；以后加托盘常驻时再改）
  app.on('window-all-closed', () => {
    app.quit()
  })

  // 程序退出前叫后台进程下班，不许留孤儿进程占着内存和端口
  app.on('will-quit', () => {
    stopPetDrag()
    backend?.stop()
  })

/**
 * 雇后台进程并当场自测，共三步：
 * ① 拿暗号打 /health 应接通（200），不拿暗号应被拒（401）；
 * ② 打 /db/ping——先读共享记忆版本号、+1 写回、再读一次，两行数字进 stdout。
 *    打包版没有外部检查口，重启后「读回上一轮写入的值」只能从这里观察
 *    （持久化验收的观察窗）。版本号每次启动 +1 是贯通自测的已知行为，
 *    T04 定正式接口时收编或重置；
 * ③ 配了密钥就打 /agent/ping——经过 eve 完成一轮，验证两跳密钥管道和模型调用。
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

  // 数据库自测：读 → 写（+1）→ 再读。第二次读到的新值若与写回的一致，
  // 说明读写都真实落了库。失败只记状态码，库报错原文不进日志
  try {
    const readStart = await fetch(`http://127.0.0.1:${handle.port}/db/ping`, { headers: authHeader })
    const readStartBody = (await readStart.json()) as { ok: boolean; globalMemoryEpoch?: number; code?: string }
    if (readStart.status !== 200 || !readStartBody.ok) {
      console.error(`[数据库] 自测读失败：${readStartBody.code ?? readStart.status}`)
    } else {
      const startEpoch = readStartBody.globalMemoryEpoch ?? -1
      const writeRes = await fetch(`http://127.0.0.1:${handle.port}/db/ping`, {
        method: 'POST',
        headers: authHeader,
      })
      const writeBody = (await writeRes.json()) as { ok: boolean; globalMemoryEpoch?: number; code?: string }
      if (writeRes.status !== 200 || !writeBody.ok) {
        console.error(`[数据库] 自测写失败：${writeBody.code ?? writeRes.status}`)
      } else {
        console.log(`[数据库] 自测 200；globalMemoryEpoch ${startEpoch} → ${writeBody.globalMemoryEpoch}`)
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown'
    console.error(`[数据库] 自测请求失败：${message}`)
  }

  // 桌宠位置恢复（T02）：只依赖后台服务本身，不依赖模型密钥，
  // 所以放在「无密钥提前返回」之前
  await restorePetBounds(handle)

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

  // 桌宠界面发来的拖动信号（preload 放行的固定操作，只带信号不带数据）
  ipcMain.on('pet:drag-start', () => startPetDrag())
  ipcMain.on('pet:drag-end', () => stopPetDrag())

  // 缩放：方向只认 ±1，其余当垃圾丢弃——这是内部信号通道，不是给随意数值的门
  ipcMain.on('pet:zoom', (_event, direction: unknown) => {
    if (direction !== 1 && direction !== -1) return
    const next = Math.min(
      PET_SCALE_MAX,
      Math.max(PET_SCALE_MIN, petScale * (direction === 1 ? PET_SCALE_STEP : 1 / PET_SCALE_STEP)),
    )
    petScale = next
    resizePetWindow(next)
    // 每档缩放动作后顺手保存：重启后保持用户调的大小
    void savePetBounds()
  })
  ipcMain.on('pet:menu', () => showPetMenu())

  app.whenReady().then(() => {
    createWindow()
    // 桌宠窗口紧随其后；它不依赖后台服务，后台起不来也不影响角色显示
    createPetWindow()
    // screen 模块要等应用就绪后才能用（Electron 规矩），所以这两个
    // 监听在这里注册而不是文件顶层
    screen.on('display-metrics-changed', () => keepPetVisible())
    screen.on('display-removed', () => keepPetVisible())
    // 后台起不来不能连累窗口白屏：先记下来。重试和提示用户是以后的事
    startBackendWithSelfCheck().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'unknown'
      console.error(`[后台] 启动失败：${message}`)
    })
  })
}
