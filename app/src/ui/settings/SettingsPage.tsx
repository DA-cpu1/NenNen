/**
 * 角色设置页（T05⑨/⑩ 逐步实现）：编辑名字、初始关系、称呼、分区人设、
 * 情境示例，管理图片与版本回退。本文件当前是占位骨架——导航已可切到
 * 这一页，完整表单在下一步提交里填进来。
 */
import type { CharacterProps } from '../App'
import styles from './SettingsPage.module.css'

/** 占位版设置页 */
export default function SettingsPage(_props: CharacterProps) {
  return (
    <div className={styles.placeholder}>
      <p className={styles.title}>角色设置</p>
      <p className={styles.note}>编辑表单在下一步实现（T05⑨）</p>
    </div>
  )
}
