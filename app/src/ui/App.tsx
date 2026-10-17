/**
 * 根组件（T01 空壳）：仅证明界面进程正常运行，尚无实际功能。
 */
import styles from './App.module.css'

/** 空壳页：显示应用名与当前阶段说明 */
export default function App() {
  return (
    <main className={styles.shell}>
      <h1 className={styles.title}>二次元女友</h1>
      <p className={styles.note}>T01 最小窗口空壳——界面进程已运行</p>
    </main>
  )
}
