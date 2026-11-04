/** eve 工具从本机业务服务读取结果，自己不打开 SQLite 或选择角色。 */
import { memoryToolPath, type MemoryToolRequest, type MemoryToolResult } from '../../src/shared/memory-tool'
import { waitSecrets } from './stdin-secrets'

/**
 * 把工具参数与 eve 提供的会话编号交给本机业务后台。
 * @param request 当前 eve 会话号和工具参数
 * @param signal eve 工具的取消信号
 * @returns 后台实际返回的结果，连接失败时回固定错误
 */
export async function callMemoryTool(request: MemoryToolRequest, signal: AbortSignal): Promise<MemoryToolResult> {
  const unavailable = { ok: false, code: 'STORAGE_UNAVAILABLE', message: '暂时无法连接本机记忆服务。', retryable: true } as const
  try {
    const port = Number(process.env.COMPANION_MEMORY_TOOL_PORT)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return unavailable
    const { routeToken } = await waitSecrets()
    const response = await fetch(`http://127.0.0.1:${port}${memoryToolPath}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
      headers: { 'x-session-token': routeToken, 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    if (!response.ok) return unavailable
    return await response.json() as MemoryToolResult
  } catch {
    if (signal.aborted) return { ok: false, code: 'CANCELLED', message: '这轮聊天已停止。', retryable: false }
    return unavailable
  }
}
