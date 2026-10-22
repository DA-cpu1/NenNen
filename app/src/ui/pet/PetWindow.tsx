/**
 * 桌宠窗口的第一版内容：整窗只画一张占位角色图。
 * 这是 T02「透明角色小样」的起点——先证明「透明窗口 + 角色图」能显示，
 * 鼠标命中、拖动、缩放在后面的小步骤里逐个加。
 */
import styles from './PetWindow.module.css'
// Vite 会把图片 import 变成「能直接放进 <img src> 的地址字符串」：
// 开发时指向开发服务器上的文件，打包后指向输出目录里的文件
import petSampleUrl from './assets/pet-sample.svg'

/** 桌宠组件：一张占位图铺满整个窗口（窗口尺寸由主进程按同一张图的宽高创建） */
export default function PetWindow() {
  return (
    <main className={styles.stage}>
      {/* alt 写明占位：读屏软件会念出来，也提醒看到的不是正式角色图 */}
      <img className={styles.pet} src={petSampleUrl} alt="占位角色" draggable={false} />
    </main>
  )
}
