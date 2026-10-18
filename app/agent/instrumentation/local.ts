/**
 * 关闭框架默认的本地调用追踪，避免提示词或回复另存一份诊断记录。
 * 工作流的执行进度仍可写在专用运行目录里；它不是用户聊天和记忆的权威记录。
 */
import { disableInstrumentation } from 'eve/instrumentation'

export default disableInstrumentation()
