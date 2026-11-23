import { useEffect, useRef, useState } from 'react'
import { CalcTool } from './Calc'
import { Ban, Check, ChevronLeft, ChevronRight, ClipboardCheck, Flag, RefreshCw, Send, Timer, X } from 'lucide-react'
import { api, fmtDate, fmtDur, fmtMin, type Test } from './api'
import type { Ctx } from './App'
import { PageHead } from './ui'
import { busyProps, useBusy, useQuestionFocus } from './interact'
import { highlightC } from './codefmt'
import { MathText, TexBlock } from './mathtex'
import { GenLog } from './genlog'
import { bumpXp } from './prefs'
import { Scratch, ScratchIcon, ScoreRing, SheetFrame, SheetTool } from './Sheet'
import { t as tr, type Key } from './i18n'

const KIND: Record<string, Key> = { eod: 'End-of-day test', c_quiz: 'C quiz', unit_quiz: 'Unit check', practice: 'Practice test' }
const kindName = (k: string) => (KIND[k] ? tr(KIND[k]) : k)
const STATUS: Record<string, Key> = { generating: 'preparing', ready: 'ready', in_progress: 'in progress', failed: 'error' }

export function TestsList({ ctx, version }: { ctx: Ctx; version: number }) {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof api.tests>>>([])
  useEffect(() => { api.tests().then(setRows).catch(() => {}) }, [version])
  return (
    <div className="page">
      <PageHead title={tr('Tests')} sub={tr("End-of-day tests and closed-book quizzes. Wrong answers become sticking points and go into the next day's plan")} />
      <div className="card">
        {rows.length === 0 && <div className="panel empty">{tr("No tests yet. The end-of-day test is prepared from the test task at the end of the day")}</div>}
        {rows.map((r) => (
          <button key={r.id} className="task-row list-row"
            onClick={() => ctx.go({ kind: 'test', id: r.id })}>
            <span className="id">#{r.id}</span>
            <span>{kindName(r.kind)} · {fmtDate(r.date)}</span>
            <span className="task-meta">
              {r.status === 'submitted' ? <span>{r.cancelled ? `${tr('cancelled')} · ` : ''}{r.score}/{r.max}</span> : <span>{r.status === 'ready' && r.used_sec ? tr('paused') : STATUS[r.status] ? tr(STATUS[r.status]) : r.status}</span>}
              <ChevronRight size={16} strokeWidth={1.5} />
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

/** Right answers and questions per topic, the weakest first. */
const byTopic = (qs: { id: string; topic: string }[], results: Record<string, { correct: boolean; void?: boolean }>) => {
  const m = new Map<string, [number, number]>()
  for (const q of qs) { if (results[q.id]?.void) continue; const [ok, all] = m.get(q.topic) ?? [0, 0]; m.set(q.topic, [ok + (results[q.id]?.correct ? 1 : 0), all + 1]) }
  return [...m].map(([k, [ok, all]]) => [k, ok, all] as const).sort((a, b) => a[1] / a[2] - b[1] / b[2])
}

export default function TestPage({ id, ctx, version }: { id: number; ctx: Ctx; version: number }) {
  const [t, setT] = useState<Test | null>(null)
  const [ans, setAns] = useState<Record<string, string>>({})
  const [left, setLeft] = useState<number | null>(null)
  const [cur, setCur] = useState(0)
  const [all, setAll] = useState(false)
  const [scratch, setScratch] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [voiding, setVoiding] = useState<string | null>(null) // the question being marked broken
  const [why, setWhy] = useState('')
  const loaded = useRef(false)
  const [busy, run] = useBusy()
  const [graded, setGraded] = useState(false) // true for a moment after submitting: wrong verdicts shake once

  useEffect(() => {
    api.test(id).then((x) => {
      setT(x)
      if (!loaded.current && x.answers) { setAns(x.answers); loaded.current = true }
      if (x.remaining_sec != null) setLeft(x.remaining_sec)
    }).catch(() => {})
  }, [id, version])

  const exam = t?.status === 'in_progress'
  useEffect(() => { ctx.setExam(exam); return () => ctx.setExam(false) }, [exam]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (t?.status !== 'in_progress') return
    const i = setInterval(() => setLeft((l) => (l == null ? l : Math.max(0, l - 1))), 1000)
    return () => clearInterval(i)
  }, [t?.status])

  useEffect(() => {
    if (t?.status !== 'in_progress') return
    const h = setTimeout(() => api.saveAnswers(id, ans).catch(() => {}), 600)
    return () => clearTimeout(h)
  }, [ans, id, t?.status])

  // time's up: hand in what is there (the server does the same if the tab is closed)
  const autoSent = useRef(false)
  useEffect(() => {
    if (t?.status !== 'in_progress' || left !== 0 || autoSent.current) return
    autoSent.current = true
    api.submit(id, ans).then((x) => { setT(x); ctx.notify(tr("Time's up: the test was submitted with your answers"), 'warn'); ctx.refresh() })
      .catch((e) => ctx.notify(e instanceof Error ? e.message : String(e), 'err'))
  }, [left, t?.status, id]) // eslint-disable-line react-hooks/exhaustive-deps

  const n = t?.questions.length ?? 0
  const live = t?.status === 'in_progress' || t?.status === 'submitted'
  useEffect(() => {
    if (!live || all) return
    const k = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector('.scratch-sheet')) return
      if (e.key === 'ArrowRight') { e.preventDefault(); setCur((c) => Math.min(n - 1, c + 1)) }
      if (e.key === 'ArrowLeft') { e.preventDefault(); setCur((c) => Math.max(0, c - 1)) }
      if (e.key.toLowerCase() === 'd' && t?.status === 'in_progress' && !document.querySelector('.scratch-sheet')) { e.preventDefault(); setScratch(true) }
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [live, all, n])
  const root = useRef<HTMLDivElement>(null)
  useQuestionFocus(root, Math.min(cur, Math.max(n - 1, 0)), t?.status === 'in_progress' && !all)

  if (!t) return <div className="page" />
  const set = (q: string, v: string) => setAns((a) => ({ ...a, [q]: v }))
  const results = Object.fromEntries((t.results ?? []).map((r) => [r.id, r]))
  const submitted = t.status === 'submitted'
  const markBroken = (qid: string) => run(async () => {
    const x = await ctx.run(api.voidQuestion(t.id, qid, why))
    if (x) { setT(x); setVoiding(null); ctx.notify(tr('Taken out of the score')); ctx.refresh() }
  })
  // leaving pauses the test: answers and the time used stay, nothing is graded
  const exitTest = () => run(async () => {
    const x = await ctx.run(api.exitTest(t.id, ans))
    if (x) { setT(x); setConfirm(false); setLeft(x.remaining_sec ?? null); ctx.notify(tr('Test paused. Your answers and the time left are kept')); ctx.refresh() }
  })
  const paused = t.status === 'ready' && (t.used_sec ?? 0) > 0
  const answeredN = Object.values(ans).filter((v) => v.trim()).length
  const startTest = () => run(async () => { const x = await ctx.run(api.startTest(t.id)); if (x) { setT(x); setLeft(x.remaining_sec ?? null) } })

  const close = () => ctx.go({ kind: 'day', date: t.date })
  const title = `${kindName(t.kind)} · ${fmtDate(t.date)}`

  if (t.status === 'in_progress' || submitted) {
    const answered = (q: { id: string }) => !!(ans[q.id] ?? '').trim()
    const done = t.questions.filter(answered).length
    const ci = Math.min(cur, n - 1)
    const submit = async () => {
      if (done < n && !confirm) { setConfirm(true); return }
      setConfirm(false)
      await run(async () => {
        const x = await ctx.run(api.submit(t.id, ans))
        if (x) { setT(x); setAll(false); setGraded(true); window.setTimeout(() => setGraded(false), 600); ctx.refresh(); bumpXp() }
      })
    }
    const question = (q: Test['questions'][number], i: number) => {
      const r = results[q.id]
      const last = i === n - 1
      return (
        <div key={q.id} className={'q sheet-qa' + (all ? '' : ' solo')}>
          {all && <div className="qa-n">{tr('Question {n}', { n: i + 1 })}<span className="t3"> · {q.topic}</span></div>}
          <div className="sheet-q">
            <div className="perseus"><MathText text={q.prompt} /></div>
            {q.math && <TexBlock src={q.math} className="q-math" />}
            {q.code && <pre className="code"><code>{highlightC(q.code)}</code></pre>}
            {q.type === 'mcq' ? (
              <div className="pw-radio">
                {q.choices?.map((c) => (
                  <button key={c} disabled={submitted} className={'choice' + (ans[q.id] === c ? ' on' : '') + (r && ans[q.id] === c ? (r.correct ? ' right' : ' wrong') : '')}
                    onClick={() => { set(q.id, c); setConfirm(false) }}>
                    <span className="o" /><span className="pw-choice-t"><MathText text={c} big /></span>
                  </button>
                ))}
              </div>
            ) : (
              <div className={'pw-field pw-expr' + (r ? (r.correct ? ' ok' : ' bad') : '')}>
                <input className="input mono" disabled={submitted} value={ans[q.id] ?? ''} autoComplete="off" spellCheck={false}
                  onChange={(e) => { set(q.id, e.target.value); setConfirm(false) }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (!last) setCur(i + 1); else submit() } }}
                  placeholder={q.answer_format || (q.type === 'output' ? tr('The exact output') : tr('Your answer'))} />
              </div>
            )}
          </div>
          {r && (r.void ? (
            <div className="verdict void">
              <Ban size={14} strokeWidth={2} />
              <span>{tr('Marked broken: not counted in the score')}{r.void_why && <span className="t2"> · {r.void_why}</span>}
                <span className="t2"> · {tr('Correct answer:')} <MathText text={r.answer} /></span>{r.explanation && <span className="t2"> · <MathText text={r.explanation} /></span>}</span>
            </div>
          ) : (
            <div className={'verdict ' + (r.correct ? 'ok' : 'no') + (graded && !r.correct ? ' shake' : '')}>
              {r.correct ? <Check size={14} strokeWidth={2} /> : <X size={14} strokeWidth={2} />}
              <span>{r.correct ? tr('Correct') : <>{tr('Correct answer:')} <MathText text={r.answer} /></>}{r.explanation && <span className="t2"> · <MathText text={r.explanation} /></span>}</span>
            </div>
          ))}
          {r && !r.void && !r.correct && submitted && !t.cancelled && (voiding === q.id ? (
            <form className="void-form" onSubmit={(e) => { e.preventDefault(); markBroken(q.id) }}>
              <span className="t2 small">{tr("Couldn't be answered from what was shown (information missing, wrong answer key)? It leaves the score and its sticking point is closed.")}</span>
              <input className="input" autoFocus value={why} maxLength={300} placeholder={tr('What was wrong? (optional)')} onChange={(e) => setWhy(e.target.value)} />
              <div className="row">
                <button className="btn sm" type="submit" disabled={busy}>{tr('Not counted')}</button>
                <button className="btn sm ghost" type="button" onClick={() => setVoiding(null)}>{tr('Cancel')}</button>
              </div>
            </form>
          ) : (
            <button className="btn ghost sm void-btn" onClick={() => { setVoiding(q.id); setWhy('') }}><Flag size={13} strokeWidth={1.8} />{tr('This question is broken')}</button>
          ))}
        </div>
      )
    }

    if (submitted && !all) {
      const max = t.max ?? n, sc = t.score ?? 0
      const pct = max ? (sc / max) * 100 : 0
      const thr = t.kind === 'c_quiz' || t.kind === 'unit_quiz' ? 80 : undefined
      const wrong = t.questions.filter((q) => results[q.id] && !results[q.id].correct && !results[q.id].void)
      const head = tr(t.cancelled ? 'Cancelled' : thr != null ? (pct >= thr ? 'Quiz passed' : 'Not yet') : pct >= 80 ? 'Strong day' : pct >= 50 ? 'Day closed' : 'A hard one')
      return (
        <SheetFrame title={title} step={tr('Result')} progress={1} onClose={close} closeLabel={tr('Back to the day')}>
          <div className="sheet-col result">
            <ScoreRing value={pct} threshold={thr} label={`${sc} / ${max}`} />
            <h1 className="sheet-h big">{head}</h1>
            <p className="result-n">
              {t.cancelled ? (t.kind === 'practice' ? tr('Every question counts as unanswered.') : tr('Every question counts as unanswered and went into sticking points.'))
                : wrong.length ? (t.kind === 'practice'
                  ? (t.practice?.from_task
                    ? tr(wrong.length === 1 ? '1 wrong answer becomes a sticking point.' : '{n} wrong answers become sticking points.', { n: wrong.length })
                    : tr('Practice only: wrong answers here are not saved as sticking points.'))
                  : tr(wrong.length === 1 ? "1 wrong answer becomes a sticking point for tomorrow's plan." : "{n} wrong answers become sticking points for tomorrow's plan.", { n: wrong.length }))
                : tr('Every answer right. Nothing carries over to tomorrow.')}
            </p>
            {wrong.length > 0 && (
              <div className="result-miss">
                <span className="t3 small">{tr('By topic')}</span>
                <div className="result-chips">{byTopic(t.questions, results).map(([topic, ok, all]) => (
                  <span key={topic} className={'chip' + (ok < all ? ' miss' : '')}>{topic} <b className="mono">{ok}/{all}</b></span>
                ))}</div>
                {!t.cancelled && <span className="t3 small">{tr('A sticking point stays open until you mark it understood on the day page or work it through with the coach; open ones come back in the next end-of-day tests.')}</span>}
              </div>
            )}
            <div className="sheet-acts mid">
              <button className="btn lg" onClick={() => setAll(true)}>{tr('Review answers')}</button>
              <button className="btn primary lg" autoFocus onClick={close}>{tr('Back to the day')}<kbd>↵</kbd></button>
            </div>
          </div>
        </SheetFrame>
      )
    }
    if (submitted) {
      return (
        <SheetFrame title={title} step={`${t.score}/${t.max} · ${tr('review')}`} progress={1} onClose={() => setAll(false)} closeLabel={tr('Back to the result')}>
          <div className="sheet-col review" ref={root}>{t.questions.map(question)}</div>
        </SheetFrame>
      )
    }
    const q = t.questions[ci]
    const last = ci === n - 1
    return (
      <SheetFrame title={title} step={tr('Question {a} of {b}', { a: ci + 1, b: n })} progress={done / n} onClose={exitTest} closeLabel={tr('Pause and leave (answers and time are kept)')}
        right={<>
          <SheetTool onClick={() => setScratch(true)} label={tr('Scratch paper')} kbd="D"><ScratchIcon /></SheetTool>
          <CalcTool as={(p) => <SheetTool {...p} />} />
          {left != null && <span className={'sheet-timer mono' + (left < 300 ? ' urgent' : '')} role="timer"><Timer size={14} strokeWidth={1.8} />{fmtDur(left)}</span>}
        </>}>
        <div className="sheet-col" ref={root}>
          <div className="q-chips mid" role="tablist" aria-label={tr('Questions')}>
            {t.questions.map((x, i) => (
              <button key={x.id} role="tab" aria-selected={i === ci} className={'q-chip' + (i === ci ? ' cur' : '') + (answered(x) ? ' done' : '')}
                title={answered(x) ? tr('Answered') : tr('Not answered')} onClick={() => setCur(i)}>{i + 1}</button>
            ))}
          </div>
          <div className="statline"><span>{q.topic}</span><span>{tr('Closed book')}</span><span>{tr('Saved as you go')}</span></div>
          {question(q, ci)}
          <div className="sheet-acts">
            <button className="btn ghost" disabled={ci === 0} onClick={() => setCur(ci - 1)}><ChevronLeft size={15} strokeWidth={1.6} />{tr('Previous')}</button>
            {confirm
              ? <><span className="q-count warn" role="status">{tr('{n} unanswered: they count as wrong.', { n: n - done })}</span>
                  <button className="btn ghost" onClick={() => setConfirm(false)}>{tr('Keep going')}</button>
                  <button className="btn primary lg" {...busyProps(busy)} onClick={submit}>{tr('Submit anyway')}</button></>
              : last
                ? <button className="btn primary lg" {...busyProps(busy)} onClick={submit}><Send size={15} strokeWidth={1.6} />{tr('Submit test')}</button>
                : <button className="btn primary lg" onClick={() => setCur(ci + 1)}>{answered(q) ? tr('Next') : tr('Skip')}<kbd>↵</kbd></button>}
          </div>
          {!last && !confirm && <button className="link sheet-submit-early" onClick={submit}>{tr('Submit now ({a}/{b} answered)', { a: done, b: n })}</button>}
        </div>
        {scratch && <Scratch id={`eod-${t.id}-${q.id}`} onClose={() => setScratch(false)} question={<div className="perseus"><MathText text={q.prompt} /></div>} />}
      </SheetFrame>
    )
  }

  return (
    <div className="page narrow" ref={root}>
      <div className="head">
        <div>
          <h1 className="title">{title}</h1>
          <div className="sub">{tr('{n} questions', { n: t.questions.length })} · {fmtMin(t.time_limit_min)}{t.practice?.level ? ` · ${tr('{l} level', { l: t.practice.level })}` : ''} · {tr('closed book')}{t.source === 'fallback' ? ` · ${tr('stock question set (agent off)')}` : ''}</div>
          <div className="note">{t.threshold}</div>
        </div>
      </div>

      {t.status === 'generating' && (t.live
        ? <GenLog key={t.status} id={t.id} init={t.live} />
        : <div className="card banner"><span className="busy-road" aria-hidden />{tr('The coach is writing the questions. This can take 30–60 seconds')}</div>)}
      {t.status === 'failed' && (
        <div className="card banner split" role="alert">
          <span>{tr("Couldn't prepare the test: {e}", { e: t.error ?? '' })}</span>
          <button className="btn" {...busyProps(busy)} onClick={() => run(() => ctx.run(api.retryTest(t.id)).then(ctx.refresh))}><RefreshCw size={14} strokeWidth={1.5} />{tr('Try again')}</button>
        </div>
      )}
      {t.status === 'failed' && t.live && <GenLog key={t.status} id={t.id} init={t.live} />}
      {t.status === 'ready' && (
        <div className="ready-card card">
          <div className="ready-ic"><ClipboardCheck size={26} strokeWidth={1.5} /></div>
          <div className="ready-b">
            <div className="ready-t">{paused ? tr('Paused') : tr('Ready when you are')}</div>
            <div className="ready-n">{paused
              ? tr('{t} left · {a}/{b} answered. Nothing is graded until you submit; the clock runs again when you resume.', { t: fmtDur(t.remaining_sec ?? 0), a: answeredN, b: t.questions.length })
              : tr('{n} questions, {m} minutes. The clock runs once you start. No books, notes or AI.', { n: t.questions.length, m: t.time_limit_min })}</div>
          </div>
          <button className="btn primary lg" autoFocus {...busyProps(busy)} onClick={startTest}>{paused ? tr('Resume') : tr('Start')}<kbd>↵</kbd></button>
        </div>
      )}
      {t.status === 'ready' && t.live && (
        <details className="gen-how">
          <summary>{tr('How this test was made')}</summary>
          <GenLog key={t.status} id={t.id} init={t.live} />
        </details>
      )}
    </div>
  )
}
