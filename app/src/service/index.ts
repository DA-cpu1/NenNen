/**
 * 后台进程入口：从主进程管道收令牌和密钥，启动业务 HTTP 服务及 eve 子进程。
 * 机密只通过 stdin 在内存间交付；stdout 只报 READY 端口，stderr 只报固定错误码。
 * 数据库不是机密（只是一个文件位置）：路径经命令行参数 --db 传入，在这里打开。
 */
import { resolve } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { startBackendServer, type BackendOptions, type BackendServer } from './server'
import { startEve, type EveHandle } from '../agent/eve-process'
import { pingEve } from '../agent/eve-client'
import { openCompanionDatabase, type CompanionDb } from '../data/db'
import { runMigrations } from '../data/migrations'
import { appState } from '../data/tables'
import { readSetting, writeSetting } from '../data/settings'
import { PET_WINDOW_KEY, type PetWindowState } from '../shared/window-state'

/** 应用根目录：编译产物在 out/main/，往上两级正好是 app/ */
const APP_DIR = resolve(__dirname, '../..')

/**
 * 从命令行参数里找 `--db 路径`；没传返回 undefined。
 * 命令行参数对本机其他程序是可见的，所以只放「路径」这类非机密信息；
 * 令牌和密钥仍然只走 stdin 那根专门送机密的管子。
 */
function dbPathFromArgs(args: string[]): string | undefined {
  const index = args.indexOf('--db')
  if (index < 0 || index + 1 >= args.length) return undefined
  const value = args[index + 1].trim()
  return value || undefined
}

/**
 * 接收两行启动消息并等待服务就绪；主进程断线时回收 eve 后退出。
 * @returns 无返回值；启动结果用 READY 协议或错误码通知主进程。
 */
function main(): void {
  let buffer = ''
  let started = false
  let closing = false
  /** 当前在岗的 eve；换密钥时整个换人，这个变量永远只指向「现在这个」 */
  let eve: EveHandle | undefined
  let server: BackendServer | undefined
  /** 数据库连接；启动时没传 --db 就保持空（此时 /db/ping 返回明确的 503） */
  let database: CompanionDb | undefined

  /**
   * 后台服务的选项表。特意用「一张可原地更新的表」而不是一次性常量：
   * 换密钥时更新 modelApiKey，服务处理每个请求都现读这张表，
   * 不会拿到换钥前的旧值
   */
  const options: BackendOptions = {
    pingAgent: (signal) => {
      if (!eve) return Promise.reject(new Error('E_EVE_NOT_RUNNING'))
      return pingEve(eve, signal)
    },
    rotateModelKey: (newKey) => rotateModelKey(newKey),
  }

  /**
   * 读共享记忆版本号。迁移正常跑过后 app_state 必有那一行；读不到说明
   * 库被外部动过手脚，抛错让端点报 DB_ERROR，绝不默默当 0 把问题盖住
   */
  function readEpoch(): number {
    if (!database) throw new Error('E_DB_NOT_OPEN')
    const row = database.db.select().from(appState).where(eq(appState.id, 1)).get()
    if (!row) throw new Error('app_state 缺少初始行')
    return row.globalMemoryEpoch
  }

  /**
   * 版本号 +1（一次真实的业务写）。用 SQL 自增而不是「先读出来再加」：
   * 读和加合并成数据库里的一条原子操作，中间不会被别的写入插队改值
   */
  function bumpEpoch(): number {
    if (!database) throw new Error('E_DB_NOT_OPEN')
    database.db
      .update(appState)
      .set({ globalMemoryEpoch: sql`${appState.globalMemoryEpoch} + 1` })
      .where(eq(appState.id, 1))
      .run()
    return readEpoch()
  }

  /** 只执行一次关闭：先停业务请求，再结束 eve，关数据库，最后退出。 */
  async function shutdown(): Promise<void> {
    if (closing) return
    closing = true
    await server?.stop()
    await eve?.stop()
    // 连接不关的话文件会被一直占用；而且 WAL 模式下没正常关闭，
    // 下次打开要多做一段恢复，虽然数据不丢，但没必要冒这个险
    database?.close()
    process.exit(0)
  }

  /** 用指定密钥起一个 eve。失败向外抛，由调用方决定善后。 */
  async function startEveWith(key: string): Promise<void> {
    eve = await startEve({
      appDir: APP_DIR,
      modelApiKey: key,
      // 只传公开测试地址；自动检查让请求落到本机假供应商，避免误花钱
      modelBaseUrl: process.env.COMPANION_MODEL_BASE_URL || undefined,
    })
  }

  /** 开机：先开门（数据库），有密钥再起 eve，最后起业务总机、报到端口。
   *  数据库最先开：它对不上账（迁移失败）时按 05 §7 宁可整个启动失败，
   *  也不能带着结构不确定的库继续跑、把坏数据写进去 */
  async function start(token: string, modelApiKey: string): Promise<void> {
    const dbPath = dbPathFromArgs(process.argv.slice(2))
    if (dbPath) {
      database = openCompanionDatabase(dbPath)
      // 迁移抛错不在这里接：让它顺着 start 的 catch 统一走 E_START 退出
      runMigrations(database.sqlite)
      options.db = {
        readEpoch,
        bumpEpoch,
        // 桌宠窗口位置（T02）：存在 app_settings 的 petWindow 键下（05 §2）。
        // 读出的原始值不在这里验格式——总机的 /window-state 只是搬运，
        // 消费方（主进程）自己过 Zod 关卡，坏数据在那里被拦下。
        // 开头与 readEpoch 同款守卫：闭包捕获的是模块级变量，编译器不知道
        // 「走到这里时一定开过库」，得现查现抛
        readWindowState: () => {
          if (!database) throw new Error('E_DB_NOT_OPEN')
          return readSetting(database.db, PET_WINDOW_KEY)
        },
        writeWindowState: (value: PetWindowState) => {
          if (!database) throw new Error('E_DB_NOT_OPEN')
          writeSetting(database.db, PET_WINDOW_KEY, value)
        },
      }
    }
    if (modelApiKey) await startEveWith(modelApiKey)
    if (closing) {
      await eve?.stop()
      return
    }
    options.modelApiKey = modelApiKey || undefined
    server = await startBackendServer(token, options)
    if (closing) {
      await server.stop()
      await eve?.stop()
      return
    }
    process.stdout.write(`READY ${server.port}\n`)
  }

  /**
   * 运行期换密钥（03 §3「重新配置」通道）：先停旧 eve、再用新密钥起全新的。
   * 为什么整体换进程而不是原地改：密钥在 eve 里只存在于进程内存和管道里，
   * 「换人」是唯一不残留旧密钥的办法。换机期间 modelApiKey 置空——
   * 这段时间自测请求得到明确的 AGENT_ERROR，而不是拿旧密钥硬试；
   * 新进程起失败则保持「无 eve」，绝不回退用旧密钥。
   */
  async function rotateModelKey(newKey: string): Promise<void> {
    const previous = eve
    eve = undefined
    options.modelApiKey = undefined
    await previous?.stop()
    await startEveWith(newKey)
    options.modelApiKey = newKey
  }

  process.stdin.setEncoding('utf-8')
  process.stdin.on('data', (chunk: string) => {
    if (started) return
    buffer += chunk
    const first = buffer.indexOf('\n')
    const second = first < 0 ? -1 : buffer.indexOf('\n', first + 1)
    if (second < 0) return
    started = true
    const token = buffer.slice(0, first).trim()
    const modelApiKey = buffer.slice(first + 1, second).trim()
    buffer = ''
    if (!token) {
      process.stderr.write('E_NO_TOKEN\n')
      process.exit(1)
    }
    void start(token, modelApiKey).catch(async () => {
      await eve?.stop()
      // 启动失败同样不能留着数据库连接占用文件
      database?.close()
      process.stderr.write('E_START\n')
      process.exit(1)
    })
  })
  process.stdin.on('end', () => { void shutdown() })
  process.stdin.on('error', () => { void shutdown() })
}

main()
