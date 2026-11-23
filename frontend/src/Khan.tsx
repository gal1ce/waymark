import { useCallback, useEffect, useRef, useState } from 'react'
import { CalcTool } from './Calc'
import { Check, ChevronLeft, CircleDashed, Download, ExternalLink, Eye, PlayCircle, Send, SquarePen, X } from 'lucide-react'
import { api, ApiError, type KhanCheck, type KhanItem, type KhanOutline, type KhanProgress, type KhanQuestion, type KhanTest, type KhanVideo,
  type PAnswers, type PContent, type Task, fmtMin } from './api'
import type { Ctx } from './App'
import { busyProps, useBusy, useQuestionFocus } from './interact'
import { PerseusStatic, PerseusView, Solution } from './Perseus'
import { bumpXp } from './prefs'
import { HintPills, Keypad, KeypadIcon, NextArrow, Scratch, ScratchIcon, ScoreRing, SheetFrame, SheetTool, VerdictBar } from './Sheet'
import { t as tr } from './i18n'

/* Khan Academy inside the app: the unit's videos and exercises (Kolibri's copy of the Khan channel),
   practice with Khan's own questions and hints, and the unit test graded here. */

const mmss = (s?: number | null) => (s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '')

function Dots({ p }: { p: Partial<KhanProgress> }) {
  const n = p.n ?? 7
  const last = p.last ?? []
  return (
    <span className="kdots" title={p.mastered ? tr('Mastered') : tr('{a} right of the last {b}; {m} of {n} masters it', { a: last.filter(Boolean).length, b: last.length, m: p.m ?? 5, n })}>
      {Array.from({ length: n }, (_, i) => {
        const v = last[i]
        return <span key={i} className={'kdot' + (v === 1 ? ' ok' : v === 0 ? ' bad' : '')} />
      })}
      {p.mastered && <span className="kbadge">mastered</span>}
    </span>
  )
}

type Open = { kind: 'video' | 'exercise'; id: string; kolibri?: string | null; partial?: boolean } | null

/* videos have no record on the server; which ones were watched is remembered on this computer */
const WATCHED = 'ctu.khan.watched'
const watched = (): Set<string> => { try { return new Set(JSON.parse(localStorage.getItem(WATCHED) ?? '[]')) } catch { return new Set() } }
const markWatched = (id: string) => { try { const s = watched(); s.add(id); localStorage.setItem(WATCHED, JSON.stringify([...s])) } catch { /* private mode */ } }

/** Lives inside a Khan study task: the unit as a path of steps (videos and exercises), the next one ready to start. */
export function KhanUnitPanel({ task, ctx, active }: { task: Task; ctx: Ctx; active: boolean }) {
  const idx = Number(task.meta.unit_idx ?? 0)
  const [o, setO] = useState<KhanOutline | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState<Open>(null)
  const [seen, setSeen] = useState(watched)
  const load = useCallback(() => api.khanUnit(idx).then((x) => { setO(x); setErr(null) }).catch((e: Error) => setErr(e.message)), [idx])
  useEffect(() => { load() }, [load])
  useEffect(() => {      // while Kolibri is downloading, watch the files arrive
    if (!o?.downloading) return
    const h = setInterval(load, 5000)
    return () => clearInterval(h)
  }, [o?.downloading, load])

  const begin = (x: Open) => {
    setOpen(x)
    if (active && task.status === 'todo') api.task(task.id, 'start').then(() => ctx.refresh()).catch(() => {})
  }
  const back = () => { setOpen(null); setSeen(watched()); load() }

  if (err) return <div className="kpanel kpanel-empty"><CircleDashed size={14} strokeWidth={1.5} /><span>{err}</span></div>
  if (!o) return <div className="kpanel kpanel-empty t3"><span className="busy-road" aria-hidden />{tr('Loading the unit…')}</div>

  const c = o.counts
  const missing = c.videos + c.exercises - c.videos_ready - c.exercises_ready
  const done = (it: KhanItem) => (it.kind === 'video' ? seen.has(it.id) : !!it.mastered)
  const flat = o.lessons.flatMap((l) => l.items)
  const next = flat.find((it) => it.ready && !done(it)) ?? null
  const openItem = (it: KhanItem) => begin({ kind: it.kind, id: it.id, kolibri: it.kolibri, partial: (it.supported ?? 0) < (it.total ?? 0) })
  const nDone = flat.filter(done).length
  let n = 0
  return (
    <div className="kpanel">
      {open?.kind === 'video' && <KhanVideoView id={open.id} onBack={back} title={flat.find((i) => i.id === open.id)?.title ?? tr('Video')}
        nextUp={(() => { const i = flat.findIndex((x) => x.id === open.id); const nx = flat.slice(i + 1).find((x) => x.ready); return nx ? { title: nx.title, go: () => { setSeen(watched()); openItem(nx) } } : null })()} />}
      {open?.kind === 'exercise' && <KhanPractice id={open.id} onBack={back} ctx={ctx} kolibri={o.status.server ? open.kolibri ?? null : null} partial={!!open.partial} />}
      <div className="unit-top">
        {next ? (
          <div className="upnext">
            <button className="btn primary lg" onClick={() => openItem(next)}>{nDone ? tr('Continue') : tr('Start')}<NextArrow /></button>
            <div className="upnext-t"><span>{tr('Up next')}</span><b>{next.title}</b></div>
          </div>
        ) : <div className="upnext-t"><b>{tr('Every step of this unit is done.')}</b><span>{tr("Take the unit test when it's on the plan.")}</span></div>}
        <div className="unit-stats">
          <span><b>{c.mastered}</b>/{c.exercises} {tr('mastered')}</span>
          <span>{tr('{n} videos', { n: c.videos })} · {fmtMin(c.video_min)}</span>
          {missing > 0 && (o.downloading
            ? <span><Download size={13} strokeWidth={1.5} />{tr('downloading {a}/{b}', { a: c.videos_ready + c.exercises_ready, b: c.videos + c.exercises })}</span>
            : <button className="btn ghost sm" onClick={() => api.khanDownload(idx).then(load).catch((e: Error) => ctx.notify(e.message, 'warn'))}>
                <Download size={13} strokeWidth={1.5} />{tr('Download {n} missing', { n: missing })}</button>)}
        </div>
      </div>
      {o.error && <div className="errbox">{tr('Download problem: {e}', { e: o.error })}</div>}
      <div className="path">
        {o.lessons.map((les) => (
          <section key={les.id} className="path-lesson">
            <h4 className="path-h">{les.title}</h4>
            <ol className="steps">
              {les.items.map((it) => {
                n += 1
                const st = !it.ready ? 'pending' : done(it) ? 'done' : next?.id === it.id ? 'cur' : 'todo'
                return (
                  <li key={it.id} className={'step ' + st}>
                    <span className="step-n" aria-hidden>{st === 'done' ? <Check size={14} strokeWidth={2.6} /> : n}</span>
                    <button className="step-card" disabled={!it.ready} onClick={() => openItem(it)}>
                      <span className="step-ic">{it.kind === 'video' ? <PlayCircle size={16} strokeWidth={1.6} /> : <SquarePen size={16} strokeWidth={1.6} />}</span>
                      <span className="step-t">{it.title}</span>
                      <span className="step-m">
                        {!it.ready && <span className="t3">{tr('downloading')}</span>}
                        {it.ready && it.kind === 'video' && <span className="mono t3">{mmss(it.duration)}</span>}
                        {it.ready && it.kind === 'exercise' && <>{it.supported === 0 && <span className="t3">{tr('Kolibri only')}</span>}<Dots p={it} /></>}
                      </span>
                      {st === 'cur' && <span className="btn primary sm step-go">{tr('Start')}</span>}
                    </button>
                  </li>
                )
              })}
            </ol>
          </section>
        ))}
      </div>
      <div className="kfoot t3">
        {o.status.server ? tr("Khan Academy content (CC BY-NC-SA) through Kolibri. Questions the app can't show, such as drawing graphs, open in Kolibri.")
          : tr("Khan Academy content (CC BY-NC-SA) through Kolibri. Questions the app can't show, such as drawing graphs, open in Kolibri (start it with ./run.sh).")}
      </div>
    </div>
  )
}

function KhanVideoView({ id, title, onBack, nextUp }: { id: string; title: string; onBack: () => void; nextUp: { title: string; go: () => void } | null }) {
  const [v, setV] = useState<KhanVideo | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [pct, setPct] = useState(0)
  const [ended, setEnded] = useState(false)
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => { api.khanVideo(id).then(setV).catch((e: Error) => setErr(e.message)) }, [id])
  useEffect(() => { if (ref.current) ref.current.playbackRate = 0.75 }, [v])   // the plan: English subtitles at 0.75x
  return (
    <SheetFrame title={title} step={tr('Video')} progress={pct} onClose={onBack} closeLabel={tr('Back to the unit')}
      bar={ended ? (
        <VerdictBar tone="info" title={tr('Video watched')} action={nextUp ? tr('Next step') : tr('Back to the unit')} onAction={nextUp ? nextUp.go : onBack}>
          {nextUp ? <>{tr('Up next')}: {nextUp.title}</> : tr('That was the last step in this unit.')}
        </VerdictBar>
      ) : null}>
      <div className="sheet-col wide">
        <h1 className="sheet-h">{title}</h1>
        {err && <div className="errbox">{err}</div>}
        {v && (
          <video ref={ref} className="sheet-video" controls autoPlay preload="metadata" poster={v.poster ?? undefined} src={v.src}
            onLoadedMetadata={(e) => { e.currentTarget.playbackRate = 0.75 }}
            onTimeUpdate={(e) => { const d = e.currentTarget.duration; if (d) { setPct(e.currentTarget.currentTime / d); if (e.currentTarget.currentTime / d > 0.9) markWatched(id) } }}
            onEnded={() => { markWatched(id); setEnded(true) }}>
            {v.subtitles.map((s) => <track key={s.lang} kind="subtitles" srcLang={s.lang} label={s.label} src={s.src} default={s.lang === 'en'} />)}
          </video>
        )}
        {v?.description && <p className="sheet-desc">{v.description}</p>}
        <p className="sheet-note">{tr('Starts at 0.75× with English subtitles; Turkish is in the CC menu. New terms go to')} <code>eng/math-terms.md</code>.</p>
      </div>
    </SheetFrame>
  )
}

function KhanPractice({ id, onBack, ctx, kolibri, partial }: { id: string; onBack: () => void; ctx: Ctx; kolibri: string | null; partial: boolean }) {
  const [q, setQ] = useState<KhanQuestion | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [ans, setAns] = useState<PAnswers>({})
  const [res, setRes] = useState<KhanCheck | null>(null)
  const [hints, setHints] = useState<PContent[]>([])
  const [revealed, setRevealed] = useState<Record<string, string> | null>(null)
  const [progress, setProgress] = useState<KhanProgress | null>(null)
  const [gain, setGain] = useState<{ xp: number; mastered: boolean } | null>(null)
  const [scratch, setScratch] = useState(false)
  const [pad, setPad] = useState(() => { try { return localStorage.getItem('ctu.keypad') === '1' } catch { return false } })
  const [busy, run] = useBusy()
  const [which, setWhich] = useState('')
  const col = useRef<HTMLDivElement>(null)
  const counted = useRef(false)
  useEffect(() => { try { localStorage.setItem('ctu.keypad', pad ? '1' : '0') } catch { /* private mode */ } }, [pad])

  const next = useCallback(() => api.khanExercise(id).then((x) => {
    setQ(x); setAns({}); setRes(null); setHints(x.hints); setRevealed(null); setProgress(x.progress); setErr(null); setGain(null)
    counted.current = x.counted
    requestAnimationFrame(() => { if (window.matchMedia('(pointer: fine)').matches) col.current?.querySelector<HTMLElement>('.sheet-q input:not(:disabled)')?.focus({ preventScroll: true }) })
  }).catch((e: Error) => setErr(e.message)), [id])
  useEffect(() => { next() }, [next])

  const done = !!res?.correct || !!revealed
  const act = (w: string, fn: () => Promise<void>) => { setWhich(w); return run(fn) }
  const check = () => act('check', async () => {
    if (!q || done) return
    const first = !counted.current
    const r = await ctx.run(api.khanCheck(id, q.item_id, ans))
    if (!r) return
    counted.current = true
    setRes(r); setProgress(r.progress)
    const mastered = r.progress.mastered && !progress?.mastered
    const xp = (first ? (r.correct && hints.length === 0 ? 5 : 1) : 0) + (mastered ? 25 : 0)
    setGain({ xp, mastered })
    if (xp) bumpXp()
  })
  const hint = () => act('hint', async () => {
    if (!q) return
    const r = await ctx.run(api.khanHint(id, q.item_id))
    if (r) { setHints(r.hints); if (!counted.current) { counted.current = true; bumpXp() } }
  })
  const reveal = () => act('reveal', async () => {
    if (!q) return
    const r = await ctx.run(api.khanReveal(id, q.item_id))
    if (r) { setHints(r.hints); setRevealed(r.solution); setProgress(r.progress); setRes(null); bumpXp() }
  })
  const retry = () => { setRes(null); requestAnimationFrame(() => col.current?.querySelector<HTMLElement>('.sheet-q input:not(:disabled), .sheet-q .choice')?.focus()) }
  const showHint = (i: number) => col.current?.querySelectorAll('.hint-card')[i]?.scrollIntoView({ block: 'center' })

  const p = progress
  const right = p?.last.filter(Boolean).length ?? 0
  const bar = res?.correct ? (
    <VerdictBar tone="ok" title={gain?.mastered ? tr('Mastered') : hints.length ? tr('Correct, with a hint') : tr('Correct')} xp={gain?.xp} action={tr('Next question')} onAction={next}>
      {gain?.mastered ? <>{q?.title}: {tr('{m} of the last {n} right. On to the next step whenever you like.', { m: p?.m ?? 5, n: p?.n ?? 7 })}</>
        : hints.length ? tr('Right answer; a hint before it makes this one count as a miss for mastery.') : null}
    </VerdictBar>
  ) : res ? (
    <VerdictBar tone="bad" title={tr('Not quite')} action={tr('Try again')} onAction={retry}
      secondary={<button className="btn ghost" {...busyProps(busy && which === 'reveal')} onClick={reveal}><Eye size={15} strokeWidth={1.6} />{tr('Show solution')}</button>}>
      {tr('This one counts as a miss. Change your answer and check again, or open a hint.')}
    </VerdictBar>
  ) : revealed ? (
    <VerdictBar tone="info" title={tr('Worked solution')} action={tr('Next question')} onAction={next}>{tr('The steps are under the question. Counted as a miss.')}</VerdictBar>
  ) : null

  return (
    <SheetFrame title={q?.title ?? tr('Practice')} step={p ? tr('{a} of the last {b} right · {m} of {n} masters it', { a: right, b: p.last.length, m: p.m, n: p.n }) : undefined}
      progress={p ? Math.min(1, right / p.m) : 0} onClose={onBack} closeLabel={tr('Back to the unit')}
      right={<>
        {kolibri && partial && <a className="btn ghost sm" href={kolibri} target="_blank" rel="noreferrer"
          title={tr("Some of this exercise's questions (graphs, drag and drop) only work in Kolibri's player")}><ExternalLink size={13} strokeWidth={1.5} />Kolibri</a>}
        <SheetTool onClick={() => setScratch(true)} label={tr('Scratch paper')} kbd="D"><ScratchIcon /></SheetTool>
        <CalcTool as={(p) => <SheetTool {...p} />} />
        <SheetTool on={pad} onClick={() => setPad((x) => !x)} label={tr('Keypad')}><KeypadIcon /></SheetTool>
      </>}
      bar={bar}>
      <div className="sheet-col" ref={col} onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey && !busy && q && !res && !revealed && (e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); check() }
        if (e.key.toLowerCase() === 'h' && !(e.target as HTMLElement).closest('input, textarea') && q && hints.length < q.hints_total && !done) { e.preventDefault(); hint() }
        if (e.key.toLowerCase() === 'd' && !(e.target as HTMLElement).closest('input, textarea')) { e.preventDefault(); setScratch(true) }
      }}>
        <h1 className="sheet-h"><em>{tr('Practice')}</em> {q?.title}</h1>
        {p && <Dots p={p} />}
        {q && <div className="statline"><span>{tr('Right')} <b>{right}/{p?.last.length ?? 0}</b></span><span>{tr('Mastery at')} <b className="ink">{p?.m ?? 5}/{p?.n ?? 7}</b></span><span>{tr('Hints')} <b className="ink">{hints.length}/{q.hints_total}</b></span></div>}
        {err && <div className="errbox">{err}{' '}{kolibri && <a href={kolibri} target="_blank" rel="noreferrer">{tr('Open in Kolibri')}</a>}</div>}
        {q && (
          <>
            <div key={q.item_id} className="sheet-q">
              <PerseusView part={q.question} answers={ans} disabled={done}
                set={(k, v) => { setAns((a) => ({ ...a, [k]: v })); if (res && !res.correct) setRes(null) }}
                feedback={res} />
            </div>
            <HintPills taken={hints.length} total={q.hints_total} onTake={hint} onShow={showHint} busy={busy && which === 'hint'} disabled={done && !revealed} />
            {pad && !done && <Keypad scope={col} onCheck={check} />}
            {!done && !res && (
              <div className="sheet-acts">
                <button className="btn ghost" {...busyProps(busy && which === 'reveal')} onClick={reveal}><Eye size={15} strokeWidth={1.6} />{tr('Show solution')}</button>
                <button className="btn primary lg" {...busyProps(busy && which === 'check')} onClick={check}>{tr('Check')}<kbd>↵</kbd></button>
              </div>
            )}
            {revealed && <div className="sheet-sol"><Solution sol={revealed} /></div>}
            {hints.length > 0 && (
              <div className="hint-cards">
                {hints.map((h, i) => (
                  <div key={i} className="hint-card">
                    <div className="hint-h"><span className="hint-n">{i + 1}</span><span>{tr('Hint {n}', { n: i + 1 })}{i === hints.length - 1 && i === q.hints_total - 1 ? ` · ${tr('the answer')}` : ''}</span></div>
                    <PerseusStatic part={h} />
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      {scratch && q && <Scratch id={q.item_id} onClose={() => setScratch(false)} question={<PerseusStatic part={q.question} />} />}
    </SheetFrame>
  )
}

/** In a unit-test task: start or resume the test; typing a score from khanacademy.org stays possible. */
export function KhanTestLauncher({ t, ctx }: { t: Task; ctx: Ctx }) {
  const [busy, run] = useBusy()
  return (
    <button className="btn primary" {...busyProps(busy)} onClick={() => run(async () => {
      try {
        const r = await api.khanStartTest(t.id)
        ctx.go({ kind: 'khanTest', id: r.id })
      } catch (e) {
        ctx.notify(e instanceof ApiError ? e.message : String(e), 'warn')
      }
    })}><SquarePen size={14} strokeWidth={1.5} />{t.score ? tr('Retake unit test') : tr('Start unit test')}</button>
  )
}

export function KhanTestPage({ id, ctx }: { id: number; ctx: Ctx }) {
  const [t, setT] = useState<KhanTest | null>(null)
  const [ans, setAns] = useState<Record<string, PAnswers>>({})
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ text: string; passed: boolean } | null>(null)
  const [cur, setCur] = useState(0)
  const [review, setReview] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [scratch, setScratch] = useState(false)
  const [busy, run] = useBusy()
  const loaded = useRef(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    api.khanTest(id).then((x) => { setT(x); if (!loaded.current) { setAns(x.answers ?? {}); loaded.current = true } })
      .catch((e: Error) => setErr(e.message))
  }, [id])
  const exam = t?.status === 'in_progress'
  useEffect(() => { ctx.setExam(exam); return () => ctx.setExam(false) }, [exam]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!exam) return
    const h = setTimeout(() => api.khanSaveTest(id, ans).catch(() => {}), 600)
    return () => clearTimeout(h)
  }, [ans, id, exam])

  const n = t?.questions.length ?? 0
  useEffect(() => {        // ← → between questions
    if (!t || review || t.status !== 'in_progress') return
    const k = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return
      if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector('.scratch-sheet')) return
      if (e.key === 'ArrowRight') { e.preventDefault(); setCur((c) => Math.min(n - 1, c + 1)) }
      if (e.key === 'ArrowLeft') { e.preventDefault(); setCur((c) => Math.max(0, c - 1)) }
      if (e.key.toLowerCase() === 'd') { e.preventDefault(); setScratch(true) }
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [t, review, n])
  useQuestionFocus(root, Math.min(cur, Math.max(n - 1, 0)), !!t && !review)

  const close = () => ctx.go({ kind: 'day', date: t?.date ?? ctx.todayDate })
  if (err) return <SheetFrame title={tr('Unit test')} onClose={close}><div className="sheet-col"><div className="errbox">{err}</div></div></SheetFrame>
  if (!t) return <SheetFrame title={tr('Unit test')} onClose={close}><div className="sheet-col" /></SheetFrame>
  const done = t.status === 'submitted'
  const answered = (key: string) => Object.values(ans[key] ?? {}).some((v) => (Array.isArray(v) ? v.length > 0 : String(v).trim() !== ''))
  const count = t.questions.filter((q) => answered(q.key)).length
  const ci = Math.min(cur, n - 1)
  const submit = () => {
    if (count < n && !confirm) { setConfirm(true); return }
    setConfirm(false)
    return run(async () => {
      const r = await ctx.run(api.khanSubmitTest(id, ans))
      if (r) { setT(r.test); setMsg({ text: r.message, passed: r.passed }); setCur(0); setReview(false); ctx.refresh(); bumpXp() }
    })
  }

  const question = (q: KhanTest['questions'][number], i: number) => {
    const r = t.results?.[q.key]
    return (
      <div key={q.key} className={'q sheet-qa' + (review ? '' : ' solo')}
        onKeyDown={(e) => {   // Enter in an answer box moves on
          if (e.key === 'Enter' && !review && !done && (e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); if (i < n - 1) setCur(i + 1); else submit() }
        }}>
        {review && <div className="qa-n">{tr('Question {n}', { n: i + 1 })}<span className="t3"> · {q.exercise}</span></div>}
        <div className="sheet-q">
          {q.missing ? <span className="t3">{tr("This question's file is missing.")}</span> : q.question && (
            <PerseusView part={q.question} answers={ans[q.key] ?? {}} disabled={done} feedback={r ?? null}
              set={(k, v) => { setConfirm(false); setAns((a) => ({ ...a, [q.key]: { ...(a[q.key] ?? {}), [k]: v } })) }} />
          )}
        </div>
        {r && (
          <div className={'verdict ' + (r.correct ? 'ok' : 'no')}>
            {r.correct ? <Check size={14} strokeWidth={2} /> : <X size={14} strokeWidth={2} />}
            <span>{r.correct ? tr('Correct') : <>{tr('Answer')}: <Solution sol={r.solution} inline /></>}</span>
          </div>
        )}
        {r && !r.correct && q.hints && q.hints.length > 0 && (
          <details className="khints"><summary>{tr('Worked solution')}</summary>
            {q.hints.map((h, k) => <div key={k} className="khint"><PerseusStatic part={h} /></div>)}
          </details>
        )}
      </div>
    )
  }

  const title = `${tr('Unit test')} · ${t.unit.name}`
  // submitted: the score first, then the answers on request
  if (done && !review) {
    const sc = t.score ?? 0, pass = sc >= t.threshold
    const wrong = t.questions.filter((q) => t.results?.[q.key] && !t.results[q.key].correct)
    return (
      <SheetFrame title={title} step={tr('Result')} progress={1} onClose={close} closeLabel={tr('Back to the day')}>
        <div className="sheet-col result">
          <ScoreRing value={sc} threshold={t.threshold} label={tr('Score')} />
          <h1 className="sheet-h big">{pass ? tr('Unit passed') : tr('Not yet')}</h1>
          <p className="result-n">{msg?.text ?? (pass ? tr('{s}% is over the {t}% mark: Math II moves on.', { s: sc, t: t.threshold }) : tr("{t}% passes. Study the unit's weak spots and retake the test.", { t: t.threshold }))}</p>
          {wrong.length > 0 && (
            <div className="result-miss">
              <span className="t3 small">{tr('Missed, by exercise')}</span>
              <div className="result-chips">{[...new Set(wrong.map((q) => q.exercise))].map((e) => <span key={e} className="chip">{e}</span>)}</div>
            </div>
          )}
          <div className="sheet-acts mid">
            <button className="btn lg" onClick={() => setReview(true)}>{tr('Review answers')}</button>
            <button className="btn primary lg" autoFocus onClick={close}>{tr('Back to the day')}<kbd>↵</kbd></button>
          </div>
        </div>
      </SheetFrame>
    )
  }
  if (review) {
    return (
      <SheetFrame title={title} step={`${t.score}% · ${tr('review')}`} progress={1} onClose={() => setReview(false)} closeLabel={tr('Back to the result')}>
        <div className="sheet-col review" ref={root}>{t.questions.map(question)}</div>
      </SheetFrame>
    )
  }
  const q = t.questions[ci]
  const last = ci === n - 1
  return (
    <SheetFrame title={title} step={tr('Question {a} of {b}', { a: ci + 1, b: n })} progress={count / n} onClose={close} closeLabel={tr('Leave the test (answers are kept)')}
      right={<>
        <SheetTool onClick={() => setScratch(true)} label={tr('Scratch paper')} kbd="D"><ScratchIcon /></SheetTool>
        <CalcTool as={(p) => <SheetTool {...p} />} />
        <span className="sheet-count mono" title={tr('Answered')}>{count}/{n}</span>
      </>}>
      <div className="sheet-col" ref={root}>
        <div className="q-chips mid" role="tablist" aria-label={tr('Questions')}>
          {t.questions.map((x, i) => (
            <button key={x.key} role="tab" aria-selected={i === ci} className={'q-chip' + (i === ci ? ' cur' : '') + (answered(x.key) ? ' done' : '')}
              title={answered(x.key) ? tr('Answered') : tr('Not answered')} onClick={() => setCur(i)}>{i + 1}</button>
          ))}
        </div>
        <div className="statline"><span>{tr('Untimed')}</span><span>{tr('Pass at')} <b>{t.threshold}%</b></span><span>{tr('Saved as you go')}</span></div>
        {question(q, ci)}
        <div className="sheet-acts">
          <button className="btn ghost" disabled={ci === 0} onClick={() => setCur(ci - 1)}><ChevronLeft size={15} strokeWidth={1.6} />{tr('Previous')}</button>
          {confirm
            ? <><span className="q-count warn" role="status">{tr('{n} unanswered: they count as wrong.', { n: n - count })}</span>
                <button className="btn ghost" onClick={() => setConfirm(false)}>{tr('Keep going')}</button>
                <button className="btn primary lg" {...busyProps(busy)} onClick={submit}>{tr('Submit anyway')}</button></>
            : last
              ? <button className="btn primary lg" {...busyProps(busy)} onClick={submit}><Send size={15} strokeWidth={1.6} />{tr('Submit test')}</button>
              : <button className="btn primary lg" onClick={() => setCur(ci + 1)}>{answered(q.key) ? tr('Next') : tr('Skip')}<kbd>↵</kbd></button>}
        </div>
        {!last && !confirm && <button className="link sheet-submit-early" onClick={submit}>{tr('Submit now ({a}/{b} answered)', { a: count, b: n })}</button>}
      </div>
      {scratch && <Scratch id={'test-' + q.key} onClose={() => setScratch(false)} question={q.question ? <PerseusStatic part={q.question} /> : null} />}
    </SheetFrame>
  )
}
