import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Download, ExternalLink, RefreshCw } from 'lucide-react'
import { api, type UpdateInfo, type UpdateJob } from './api'
import { t, tx } from './i18n'
import { Switch } from './controls'
import { busyProps, useBusy } from './interact'

/* A newer version, told the way the app greets a new user: a whole screen on the same paper as the hello, shown when
   the app is opened (never in the middle of work). Update now (the program swaps itself and the tab reloads into the
   new one), download it yourself, or go on as you were. The server side is backend/app/updates.py. */

const MB = (n: number) => (n / 1e6).toFixed(n > 1e8 ? 0 : 1)

/** Release notes as GitHub keeps them (Markdown): headings, list items and paragraphs, as plain text. */
function Notes({ text }: { text: string }) {
  const out: ReactNode[] = []
  let list: string[] = []
  const flush = () => { if (list.length) { out.push(<ul key={out.length}>{list.map((x, i) => <li key={i}>{x}</li>)}</ul>); list = [] } }
  const clean = (s: string) => s.replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) { flush(); continue }
    const li = /^[-*+]\s+(.*)$/.exec(line)
    if (li) { list.push(clean(li[1])); continue }
    flush()
    const h = /^#{1,6}\s+(.*)$/.exec(line)
    out.push(h ? <h3 key={out.length}>{clean(h[1])}</h3> : <p key={out.length}>{clean(line)}</p>)
  }
  flush()
  return <div className="upd-notes">{out}</div>
}

function Mark() {
  return (
    <svg className="upd-mark" viewBox="-20 40 800 680" aria-hidden>
      <polygon points="380,63 543,169 543,294 380,193 217,294 217,169" />
      <polygon points="6,307 140,219 140,493 219,539 219,373 334,311 334,626 216,698 6,575" />
      <polygon points="754,307 620,219 620,493 541,539 541,373 426,311 426,626 544,698 754,575" />
    </svg>
  )
}

/** Following an update until the new program answers, then reloading into it. */
function useUpdateJob(target: string | undefined) {
  const [job, setJob] = useState<UpdateJob | null>(null)
  const [lost, setLost] = useState(false)
  const since = useRef(0)
  useEffect(() => {
    if (!job || job.phase === 'failed' || job.phase === 'idle') return
    if (job.phase === 'restarting' && !since.current) since.current = Date.now()
    const id = window.setTimeout(() => {
      api.update().then((u) => {
        if (target && u.current === target) { location.reload(); return }
        setJob({ ...u.job, phase: since.current && u.job.phase === 'idle' ? 'restarting' : u.job.phase })
      }).catch(() => setJob((j) => (j ? { ...j } : j)))   // the old program has stopped; the new one is starting
      if (since.current && Date.now() - since.current > 90_000) setLost(true)
    }, job.phase === 'restarting' ? 1000 : 400)
    return () => window.clearTimeout(id)
  }, [job, target])
  return { job, setJob, lost }
}

export function UpdateScreen({ info, onClose }: { info: UpdateInfo; onClose: () => void }) {
  const latest = info.latest!
  const { job, setJob, lost } = useUpdateJob(latest.version)
  const [err, setErr] = useState<string | null>(null)
  const [leaving, setLeaving] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const working = !!job && job.phase !== 'failed' && job.phase !== 'idle'
  const failed = err ?? (job?.phase === 'failed' ? job.error || t('The update failed.') : null)

  useEffect(() => { box.current?.focus({ preventScroll: true }) }, [])
  const close = (how: 'later' | 'skip') => {
    if (working) return
    ;(how === 'skip' ? api.updateSkip(latest.version) : api.updateLater(latest.version)).catch(() => {})
    setLeaving(true)
    window.setTimeout(onClose, 320)
  }
  const start = () => {
    setErr(null)
    setJob({ phase: 'downloading', done: 0, total: info.asset?.size ?? 0 })
    api.updateApply().then(setJob).catch((e: Error) => { setJob(null); setErr(e.message) })
  }

  const pct = job?.total ? Math.min(100, Math.round(((job.done ?? 0) / job.total) * 100)) : 0
  const status = !job ? '' : job.phase === 'downloading'
    ? t('Downloading… {a} of {b} MB', { a: MB(job.done ?? 0), b: MB(job.total ?? 0) })
    : job.phase === 'installing' ? t('Putting the new version in place…') : t('Starting the new version…')


  return (
    <div ref={box} className={'sheet upd' + (leaving ? ' out' : '')} role="dialog" aria-modal="true" aria-labelledby="upd-title" tabIndex={-1}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); close('later') } }}>
      <div className="upd-stage">
        <Mark />
        <p className="upd-kicker">{t('Version {v} · you have {c}', { v: latest.version, c: info.current })}</p>
        <h1 id="upd-title" className="upd-title">{t('A new Waymark is ready')}</h1>
        {latest.notes.trim() && !working && <Notes text={latest.notes} />}

        {working ? (
          <div className="upd-work" role="status" aria-live="polite">
            <div className="upd-bar"><span style={{ width: `${job!.phase === 'downloading' ? pct : 100}%` }} /></div>
            <p className="upd-status">{lost ? t("The new version hasn't answered yet. If nothing happens, start Waymark again.") : status}</p>
          </div>
        ) : (
          <>
            {failed && <div className="callout err upd-err" role="alert">{failed}</div>}
            {!info.self_update && info.reason && <p className="upd-note">{tx(info.reason)}</p>}
            {/* the decision, side by side: update or not now */}
            <div className="upd-acts">
              {info.self_update
                ? <button type="button" className="btn primary lg" onClick={start}><RefreshCw size={16} strokeWidth={1.8} /><span>{failed ? t('Try again') : t('Update now')}</span></button>
                : <a className="btn primary lg" href={latest.page} target="_blank" rel="noreferrer"><Download size={16} strokeWidth={1.8} /><span>{t('Download the new version')}</span></a>}
              <button type="button" className="btn lg" onClick={() => close('later')} title={t('Asks again the next time you open Waymark')}>{t('Not now')}</button>
            </div>
            {/* the rarer ways out, quiet and alike */}
            <div className="upd-more">
              {info.self_update && <>
                <a className="upd-link" href={latest.page} target="_blank" rel="noreferrer">{t('Download it myself')}<ExternalLink size={12} strokeWidth={1.8} aria-hidden /></a>
                <span className="upd-dot" aria-hidden>·</span>
              </>}
              <button type="button" className="upd-link" onClick={() => close('skip')} title={t("Doesn't ask about this version again")}>{t('Skip this version')}</button>
            </div>
            <p className="upd-note">{t('Your plan, notes and everything you recorded stay as they are.')}</p>
          </>
        )}
      </div>
    </div>
  )
}

/** Settings → Updates: this version, checking now, and whether to check when the app opens. */
export function UpdateSection({ onShow }: { onShow: (u: UpdateInfo) => void }) {
  const [u, setU] = useState<UpdateInfo | null>(null)
  const [busy, run] = useBusy()
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => { api.update().then(setU).catch(() => {}) }, [])
  if (!u) return null
  if (!u.current) return <p className="set-note">{t('This copy runs from source; it is updated with git or a new package, not from here.')}</p>
  const checkNow = () => run(async () => {
    setMsg(null)
    try {
      const n = await api.update(true)
      setU(n)
      if (n.available) onShow({ ...n, show: true })
      else setMsg(n.error ? tx(n.error) : t('You have the latest version.'))
    } catch (e) { setMsg((e as Error).message) }
  })
  return (
    <>
      <p className="set-note">{t('This is Waymark {v}.', { v: u.current })}{u.checked ? ' ' + t('Last checked {d}.', { d: u.checked.replace('T', ' ').slice(0, 16) }) : ''}</p>
      <div className="inline-form">
        <button type="button" className="btn sm" {...busyProps(busy)} onClick={checkNow}><RefreshCw size={14} strokeWidth={1.6} /><span>{t('Check for updates')}</span></button>
        {u.available && u.latest && <button type="button" className="btn ghost sm" onClick={() => onShow({ ...u, show: true })}><span>{t('Version {v} is ready', { v: u.latest.version })}</span></button>}
      </div>
      {msg && <p className="set-note">{msg}</p>}
      <h3 className="set-sub">{t('When Waymark opens')}</h3>
      <Switch checked={u.enabled} onChange={(on) => { api.updateSettings(on).then(setU).catch(() => {}) }}>
        {t('Check for a new version')}
      </Switch>
      <p className="set-note">{t('Asks GitHub, where Waymark is published, for the latest version: at most every few hours, and nothing about you is sent.')}</p>
    </>
  )
}
