/**
 * eve 进程的机密入口：stdin 第 1 行是模型密钥，第 2 行是本地路由令牌。
 * 只在运行期第一次需要时读管道，编译检查不会等密钥；收到后只留在内存。
 */

/** 父进程送来的两样机密；不用于日志、运行文件或会话数据。 */
export interface StdinSecrets {
  modelApiKey: string
  routeToken: string
}

let secretsWaiter: Promise<StdinSecrets> | undefined

/**
 * 等两行机密到齐，重复调用共用同一次接收。
 * @returns 收到的机密；管道提前关闭或超时则用错误码拒绝，不猜测缺失字段。
 */
export function waitSecrets(): Promise<StdinSecrets> {
  if (secretsWaiter) return secretsWaiter
  secretsWaiter = new Promise((resolve, reject) => {
    let buffer = ''
    const timeout = setTimeout(() => finish(new Error('E_SECRETS_TIMEOUT')), 10_000)

    /** 拆掉自己的监听并清空原始缓冲；不移除框架可能安装的其他监听。 */
    function finish(error?: Error, secrets?: StdinSecrets): void {
      clearTimeout(timeout)
      process.stdin.off('data', onData)
      process.stdin.off('end', onEnd)
      process.stdin.off('error', onError)
      process.stdin.pause()
      buffer = ''
      if (error) reject(error)
      else resolve(secrets!)
    }

    /** 收集分批到达的数据，只有两行都结束才交付。 */
    function onData(chunk: Buffer): void {
      buffer += chunk.toString('utf-8')
      if (buffer.length > 16_384) {
        finish(new Error('E_SECRETS_TOO_LARGE'))
        return
      }
      const first = buffer.indexOf('\n')
      const second = first < 0 ? -1 : buffer.indexOf('\n', first + 1)
      if (second < 0) return
      const secrets = {
        modelApiKey: buffer.slice(0, first).trim(),
        routeToken: buffer.slice(first + 1, second).trim(),
      }
      finish(undefined, secrets)
    }

    /** 两行没收齐就断线，不把残缺消息当成合法机密。 */
    function onEnd(): void {
      finish(new Error('E_SECRETS_INCOMPLETE'))
    }

    /** 只报告错误码，避免把流的原始错误内容带进日志。 */
    function onError(): void {
      finish(new Error('E_SECRETS_IO'))
    }

    process.stdin.on('data', onData)
    process.stdin.once('end', onEnd)
    process.stdin.once('error', onError)
  })
  return secretsWaiter
}
