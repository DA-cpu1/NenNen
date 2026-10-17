/**
 * 窗口里显示的第一页。现在只是"开机自检页"——
 * 能看到这两行字，就说明界面进程活着。
 */
import styles from './App.module.css'

/** 自检页内容：应用名 + 当前阶段说明 */
export default function App() {
  return (
    <main className={styles.shell}>
      <h1 className={styles.title}>二次元女友</h1>
      <p className={styles.note}>T01 最小窗口空壳——界面进程已运行</p>
    </main>
  )
}
