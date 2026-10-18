/**
 * T01 的 eve 调用入口：发固定短消息，读到完整轮次结果后才报告成功。
 * 202 只表示请求已受理；只有事件流里的最终回复才证明模型运行成功。
 */
import { Client } from 'eve/client'
import type { EveHandle } from './eve-process'
import type { ModelCallResult } from './model'

/**
 * 经 eve 跑一次固定的模型连通性检查。
 * @param handle 已启动的 eve 服务凭证，令牌不离开后台内存
 * @param signal 调用方设定的取消或超时信号
 * @returns 最终文字和本轮用量；失败只抛固定错误码，不转发框架原始错误对象
 */
export async function pingEve(handle: EveHandle, signal: AbortSignal): Promise<ModelCallResult> {
  const client = new Client({
    host: `http://127.0.0.1:${handle.port}`,
    auth: { bearer: handle.token },
    redirect: 'error',
  })
  try {
    const { response } = await client.sessions.create({
      message: '请只回复两个字：收到',
      signal,
    })
    const result = await response.result()
    // 会话可以回到 waiting 等下一句话；但当前轮失败或被取消时不能误报成功。
    if (result.status === 'failed' || !result.message || result.events.some((event) =>
      event.type === 'turn.failed' || event.type === 'turn.cancelled')) {
      throw new Error('E_EVE_TURN_FAILED')
    }
    let usage: ModelCallResult['usage']
    for (const event of result.events) {
      if (event.type === 'session.waiting' || event.type === 'session.completed') {
        const reported = event.data?.usage
        //统计token数
        if (reported) {
          usage = { inputTokens: reported.inputTokens, outputTokens: reported.outputTokens }
        }
      }
    }
    return { text: result.message, usage }
  } catch {
    throw new Error(signal.aborted ? 'E_EVE_CANCELLED' : 'E_EVE_TURN_FAILED')
  }
}
