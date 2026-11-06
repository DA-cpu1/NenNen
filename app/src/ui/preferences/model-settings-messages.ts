/** 设置页与首次使用共用的中文反馈，只解释固定错误码，不展示后台错误原文。 */
const messages: Record<string, string> = {
  INVALID_INPUT: '请检查模型名称、服务地址、密钥和容量设置。',
  E_MODEL_BUSY: '正在回复或更新配置，请先停止回复，再重试。',
  E_CREDENTIAL_MISSING: '尚未配置可用凭据，请重新填写 API 密钥。',
  E_CREDENTIAL_REQUIRED_FOR_ADDRESS: '服务地址或供应商已更改，请重新填写对应的 API 密钥。',
  E_CREDENTIAL_DECRYPT: '无法读取已保存的凭据，请重新填写。',
  E_CREDENTIAL_READ: '凭据读取失败，请重新配置。',
  E_CREDENTIAL_SAVE: '凭据未保存，请重试；填写内容仍保留。',
  E_CREDENTIAL_CONFLICT: '本次保存编号已用于另一份凭据，请修改后重新保存。',
  E_CREDENTIAL_DELETE: '凭据删除尚未完成，请重试删除。',
  E_MODEL_SETTINGS_SAVE: '配置保存失败，尚未保存本次修改；填写内容仍保留。',
  E_MODEL_SETTINGS_READ: '模型配置读取失败，请重试读取。',
  E_MODEL_UPDATE: '更换未完成，请重新配置；当前暂不可发送消息。',
  E_MODEL_CONNECTION: '连接失败，请检查密钥、模型和服务地址后重试。',
  E_MODEL_TEST_CANCELLED: '连接测试已取消，尚未通过本次检查。',
  E_MODEL_TEST_TIMEOUT: '连接测试超时，请检查网络后重新测试。',
  E_MODEL_TEST_FAILED: '测试未完成或结果未保存，请重新读取状态。',
  E_MODEL_TEST_UNCERTAIN: '本次测试结果未知，为避免重复用量没有重新请求；可再次点击“测试连接”开始新测试。',
  E_MODEL_TEST_CONFLICT: '配置已更改，请对当前配置开始新的测试。',
  BACKEND_NOT_READY: '本机服务正在准备，请稍后重新读取。',
  BACKEND_UNREACHABLE: '本机服务暂时无法连接，请重试。',
}

/**
 * 将固定码换成面向用户的说明，未知错误也不回显潜在机密。
 * @param code 本机操作的固定错误码
 * @returns 可直接展示的中文反馈
 */
export function modelSettingsMessage(code?: string): string {
  return code ? messages[code] ?? '操作尚未完成，请重试。' : '操作尚未完成，请重试。'
}
