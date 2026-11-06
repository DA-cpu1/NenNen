/**
 * 首次使用的四步引导：确认角色、配置模型、隔离试聊、开始相处。
 * 复用正式设置和试聊组件；明确跳过可以浏览本地资料，不产生模型调用。
 */
import { useEffect, useState } from 'react'
import type { CharacterProps } from '../App'
import type { ModelSettingsOverview } from '../../shared/model-settings'
import { assetUrl } from '../../shared/asset-url'
import ModelSettingsPage from '../preferences/ModelSettingsPage'
import { modelSettingsMessage } from '../preferences/model-settings-messages'
import PreviewChat from '../settings/PreviewChat'
import { draftFromCharacter } from '../settings/character-draft'
import styles from './OnboardingPage.module.css'

const steps = ['确认角色', '模型连接', '试聊预览', '开始相处']

/**
 * 引导操作遵守同一份草稿保护和模型可用状态，不另建正式会话。
 * @param props 角色、公开模型状态、读取操作及导航动作
 * @returns 四步引导，或必要的读取失败反馈
 */
export default function OnboardingPage(props: CharacterProps & {
  overview: ModelSettingsOverview; modelError: string | null; reloadModel: () => Promise<void>
  leaving: boolean; onLeave: () => void; onStay: () => void; onComplete: () => void; onOpenCharacter: () => void
}) {
  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState(false)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [error, setError] = useState('')
  const [modelExit, setModelExit] = useState<'previous' | 'skip' | null>(null)
  const character = props.character
  const portrait = assetUrl(character?.portraitImagePath)

  useEffect(() => {
    if (!props.leaving || step === 1) return
    if (busy || previewBusy) { setError('正在处理，请先停止或等待完成。'); props.onStay() }
    else props.onLeave()
  }, [props.leaving, step, busy, previewBusy, props.onLeave, props.onStay])

  /** 用户明确结束引导后才记库；先回桌面只收起窗口，桌宠继续常驻。 */
  async function finish(desktop = false): Promise<void> {
    if (busy || previewBusy || !window.appApi) return
    setBusy(true); setError('')
    try {
      const result = await window.appApi.completeOnboarding()
      if (!result.ok) { setError(modelSettingsMessage(result.code)); return }
      await props.reloadModel()
      props.onComplete()
      if (desktop) window.close()
    } catch { setError('首次使用状态尚未保存，请重试。') }
    finally { setBusy(false) }
  }

  /** 图片仍经现有主进程选图及复制流程保存，取消选图不覆盖旧图片。 */
  async function pick(slot: 'desktop' | 'portrait'): Promise<void> {
    if (busy || !window.appApi) return
    setBusy(true); setError('')
    try {
      const result = await window.appApi.pickImage(slot)
      if (result.ok) await props.reload()
      else if (result.code !== 'CANCELLED') setError('图片尚未更新，请重新选择。')
    } catch { setError('图片尚未更新，请重试。') }
    finally { setBusy(false) }
  }

  /** 模型页确认没有未保存内容后，才切回上一步、跳过或离开整个引导。 */
  function leaveModel(): void {
    const target = modelExit
    setModelExit(null)
    if (target === 'previous') setStep(0)
    else if (target === 'skip') void finish()
    else props.onLeave()
  }

  return <section className={styles.page} aria-label="首次使用引导">
    <aside className={styles.art}>{portrait ? <img src={portrait} alt={`${character?.name}立绘`} /> : <div className={styles.avatar}>{character?.name.slice(0, 1) ?? '伴'}</div>}
      <strong>{character?.name ?? '桌面陪伴'}</strong><p>从这一刻起，<br />慢慢积累共同的日常。</p></aside>
    <div className={styles.main}>
      <ol className={styles.progress} aria-label="首次使用步骤">{steps.map((label, index) => <li key={label} aria-current={step === index ? 'step' : undefined}
        className={index <= step ? styles.current : undefined}><span>{index + 1}</span>{label}</li>)}</ol>
      <div className={step === 1 ? styles.modelBody : styles.body}>
        {step === 0 ? <><h1>确认角色</h1><p className={styles.intro}>这是你将要陪伴的角色。图片和设定随时可以再修改。</p>
          {character ? <><dl className={styles.summary}><div><dt>角色名字</dt><dd>{character.name}</dd></div>
            <div><dt>初始关系</dt><dd>{character.activeVersion?.initialRelationship || '尚未填写'}</dd></div></dl>
            <div className={styles.pictures}>{(['desktop', 'portrait'] as const).map((slot) => {
              const image = assetUrl(slot === 'desktop' ? character.desktopImagePath : character.portraitImagePath)
              return <button key={slot} type="button" disabled={busy} onClick={() => void pick(slot)}>
                {image ? <img src={image} alt="" /> : <span className={styles.picturePlaceholder}>＋</span>}
                <span><strong>{slot === 'desktop' ? '选择桌面形象' : '选择聊天立绘'}</strong><small>{slot === 'desktop' ? '桌面上的 Q 版形象' : '聊天时显示的全身立绘'}</small></span></button>
            })}</div><button type="button" className={styles.link} onClick={props.onOpenCharacter}>修改角色设定</button></>
            : <p>角色资料尚未读到。<button type="button" onClick={() => void props.reload()}>重新读取</button></p>}</> : null}
        {step === 1 ? <ModelSettingsPage overview={props.overview} loadError={props.modelError} reload={props.reloadModel} character={character}
          compact leaving={props.leaving || modelExit !== null} onLeave={leaveModel} onStay={() => { setModelExit(null); props.onStay() }} onContinue={() => setStep(2)} /> : null}
        {step === 2 && character ? <><h1>试聊预览</h1><p className={styles.intro}>先聊几句，感受当前设定的回复风格。试聊不会写入正式记忆。</p>
          <PreviewChat draft={draftFromCharacter(character)} enabled={props.overview.ready} busy={previewBusy} onBusyChange={setPreviewBusy} onClose={() => setStep(3)} /></> : null}
        {step === 3 ? <><h1>准备好开始相处了</h1><p className={styles.intro}>以后打开这个角色，会接着同一段正式会话。</p>
          <dl className={styles.summary}><div><dt>角色名字</dt><dd>{character?.name}</dd></div><div><dt>模型连接</dt><dd>{props.overview.ready ? '连接测试通过' : '尚未配置可用模型'}</dd></div>
            <div><dt>主动陪伴</dt><dd>默认关闭</dd></div></dl><p className={styles.hint}>聊天与记忆保存在本机；回复和整理所需的文字会发送给你选择的模型服务。</p></> : null}
      </div>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <footer className={styles.footer}>
        {step > 0 ? <button type="button" disabled={busy || previewBusy} onClick={() => step === 1 ? setModelExit('previous') : setStep(step - 1)}>上一步</button> : null}
        {step === 0 ? <button type="button" className={styles.primary} disabled={!character || busy} onClick={() => setStep(1)}>下一步：模型连接</button> : null}
        {step === 2 ? <button type="button" className={styles.primary} disabled={previewBusy} onClick={() => setStep(3)}>下一步：开始相处</button> : null}
        {step === 3 ? <><button type="button" className={styles.primary} disabled={busy || !props.overview.ready} onClick={() => void finish()}>开始聊天</button>
          <button type="button" disabled={busy} onClick={() => void finish(true)}>先回到桌面</button></> : null}
        {step < 2 ? <button type="button" className={styles.link} disabled={busy} onClick={() => step === 1 ? setModelExit('skip') : void finish()}>暂不配置，先看看</button> : null}
      </footer>
    </div>
  </section>
}
