/**
 * 后台进程入口：从主进程管道收令牌和密钥，启动业务 HTTP 服务及 eve 子进程。
 * 机密只通过 stdin 在内存间交付；stdout 只报 READY 端口，stderr 只报固定错误码。
 * 数据库不是机密（只是一个文件位置）：路径经命令行参数 --db 传入，在这里打开。
 */
import { resolve } from 'node:path'
import { startBackendServer, type BackendOptions, type BackendServer } from './server'
import { startEve, type EveHandle } from '../agent/eve-process'
import { pingEve } from '../agent/eve-client'
import { openCompanionDatabase, type CompanionDb } from '../data/db'
import { runMigrations } from '../data/migrations'
import { bumpGlobalMemoryEpoch, readGlobalMemoryEpoch } from '../data/epochs'
import { getFirstCharacter, initializeFirstCharacter } from '../data/character-init'
import { getFormalConversation } from '../data/conversations'
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

  /** 读共享记忆版本号。实现统一收在 data/epochs.ts（app_state 缺初始行
   *  时它抛错，绝不默默当 0 把问题盖住）；这里只保留「库还没打开」的守卫 */
  function readEpoch(): number {
    if (!database) throw new Error('E_DB_NOT_OPEN')
    return readGlobalMemoryEpoch(database.db)
  }

  /** 版本号 +1（一次真实的业务写），同样复用 data 层的原子自增：
   *  读和加在数据库里一步完成，不会被并发的其他写入插队改值 */
  function bumpEpoch(): number {
    if (!database) throw new Error('E_DB_NOT_OPEN')
    return bumpGlobalMemoryEpoch(database.db)
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
      // 首个角色初始化（05 §8）：库是空的就一个事务建齐四件套，已有则
      // 复用。人设先用占位文本——T03 写好的角色卡到 T06 才接入；
      // 时区按用户系统取（如 Asia/Shanghai），取不到退 UTC 不卡启动。
      // 初始化失败同样顺着 catch 走 E_START：没有正式会话的库不值得启动
      initializeFirstCharacter(database.db, {
        name: '六花',
        personaText: '（占位人设：T03 正式角色卡在 T06 接入）',
        initialRelationship: '恋人',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      })
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
        // 正式会话解析（04 §1）：每次现查库，不信启动时缓存的旧值——
        // 中途重建上下文换了框架会话 ID 后，这里能拿到新的
        readFormalConversation: () => {
          if (!database) throw new Error('E_DB_NOT_OPEN')
          const character = getFirstCharacter(database.db)
          if (!character) return null
          // 初始化保证正式会话存在；万一被外力删掉，返回明确的 null
          // 让调用方知道「没有」，而不是让意外错误顺着 HTTP 冒出去
          const conversation = getFormalConversation(database.db, character.id)
          if (!conversation) return null
          return {
            characterId: character.id,
            conversationId: conversation.id,
            runtimeSessionId: conversation.runtimeSessionId,
            contextEpoch: conversation.contextEpoch,
          }
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
