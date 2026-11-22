import { t as tr, tx } from './i18n'
import { stuckSummary } from './stuck'
import { useEffect, useState, type ReactNode } from 'react'
import { AlertCircle, Check, CircleCheck, FileCode2, GitCommitHorizontal, ListChecks, Lock, Target } from 'lucide-react'
import { api, fmtDate, fmtHours, fmtMin, weekday, type Activity, type History, type HistItem } from './api'
import type { Ctx } from './App'
import { Heatmap, SOURCE_LABEL } from './ui'

/** The study year as a contribution graph. */
export function YearGraph({ act, ctx }: { act: Activity | null; ctx: Ctx }) {
  const tot = act?.days.reduce((a, d) => ({ min: a.min + d.minutes, on: a.on + (d.minutes >= 30 ? 1 : 0) }), { min: 0, on: 0 })
  return (
    <section className="year">
      <h2 className="year-h">
        {tot ? <>{tr('{h} studied · {n} active days', { h: fmtHours(tot.min), n: tot.on })}</> : tr('Study year')}
        {act && <span className="meta">{tr('plan year from {date}', { date: fmtDate(act.start) })}</span>}
      </h2>
      <div className="card year-card">
        {act
          ? <Heatmap days={act.days} onPick={(d) => ctx.go({ kind: 'day', date: d.date })} />
          : <div className="heat-skel" />}
      </div>
    </section>
  )
}

/** Commit-log style feed grouped by day. Starts with `initial` days; "Show more" reveals and then loads older ones in place. */
export function ActivityFeed({ ctx, initial = 5 }: { ctx: Ctx; initial?: number }) {
  const [days, setDays] = useState<History['days'] | null>(null)
  const [next, setNext] = useState<string | null>(null)
  const [count, setCount] = useState(initial)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let off = false
    api.history().then((h) => { if (!off) { setDays(h.days); setNext(h.next_before) } }).catch(() => setDays([]))
    return () => { off = true }
  }, [ctx.version])

  const more = async () => {
    if (busy || !days) return
    if (count < days.length || !next) { setCount((c) => c + 10); return }
    setBusy(true)
    const h = await ctx.run(api.history(next))
    setBusy(false)
    if (h) { setDays((d) => [...(d ?? []), ...h.days]); setNext(h.next_before); setCount((c) => c + 10) }
  }

  const shown = days ? days.slice(0, count) : []
  return (
    <div className="feed">
      {days && days.length === 0 && <div className="card empty pad">{tr('Nothing yet. Commits, finished tasks, compiles, scores and tests show up here day by day')}</div>}
      {shown.map((d) => (
        <section key={d.date} className="feed-day">
          <h3 className="feed-h">
            <button className="link" onClick={() => ctx.go({ kind: 'day', date: d.date })}>{weekday(d.date)}, {fmtDate(d.date)}</button>
            <span className="meta">{fmtHours(d.minutes)} · {tr(d.items.length === 1 ? '{n} event' : '{n} events', { n: d.items.length })}</span>
          </h3>
          <div className="feed-list">
            {runs(d.items).map(({ it, n }, i) => <FeedItem key={i} it={it} n={n} ctx={ctx} />)}
          </div>
        </section>
      ))}
      {days && (count < days.length || next) && (
        <button className="btn ghost more" disabled={busy} onClick={more}>{busy ? tr('Loading') : tr('Show more')}</button>
      )}
    </div>
  )
}

/** Back-to-back items that say the same thing (ten wrong answers on one topic from one test) show as one row with a count. */
function runs(items: HistItem[]): { it: HistItem; n: number }[] {
  const out: { it: HistItem; n: number }[] = []
  for (const it of items) {
    const last = out[out.length - 1]
    if (last && it.kind === 'stuck' && last.it.kind === 'stuck' && last.it.title === it.title && last.it.source === it.source
      && !!last.it.resolved === !!it.resolved) last.n++
    else out.push({ it, n: 1 })
  }
  return out
}

function FeedItem({ it, n, ctx }: { it: HistItem; n: number; ctx: Ctx }) {
  const t = it.ts.slice(11, 16)
  let icon = <Check size={14} strokeWidth={1.5} />, body: ReactNode = it.title, meta: ReactNode = null, cls = ''
  switch (it.kind) {
    case 'commit':
      icon = <GitCommitHorizontal size={14} strokeWidth={1.5} />
      meta = <><span className="mono t3">{it.hash}</span>{it.files != null && <span className="mono"><span className="pos">+{it.add}</span> <span className="neg">−{it.del}</span> · {tr(it.files === 1 ? '{n} file' : '{n} files', { n: it.files })}</span>}</>
      cls = 'commit'
      break
    case 'done':
      icon = <CircleCheck size={14} strokeWidth={1.5} />
      meta = it.spent_min != null ? <span className="mono">{fmtMin(it.spent_min)}</span> : null
      break
    case 'compile':
      icon = <FileCode2 size={14} strokeWidth={1.5} />
      body = <span className="mono">{it.title}</span>
      meta = <span className="mono">{it.ok ? <span className="pos">{tr('{n} ok', { n: it.ok })}</span> : null}{it.ok && it.fail ? ' · ' : ''}{it.fail ? <span className="neg">{tr('{n} failed', { n: it.fail })}</span> : null}{it.last_ok === false && ` · ${tr('last compile failed')}`}</span>
      break
    case 'score':
      icon = <Target size={14} strokeWidth={1.5} />
      meta = <span className={'mono' + (it.passed ? ' pos' : ' neg')}>{it.passed ? tr('passed') : tr('below threshold')}</span>
      cls = it.passed ? 'pass' : ''
      break
    case 'test_submitted':
      icon = <ListChecks size={14} strokeWidth={1.5} />
      body = <button className="link" onClick={() => ctx.go({ kind: 'test', id: it.test_id! })}>{tx(it.title)}</button>
      meta = <span className="mono">{it.score}/{it.max}</span>
      break
    case 'day_closed':
      icon = <Lock size={14} strokeWidth={1.5} />
      body = tr('Day closed')
      break
    case 'stuck':
      icon = <AlertCircle size={14} strokeWidth={1.5} />
      body = <>{stuckSummary({ summary: it.title, source: it.source ?? '' })}{n > 1 && <span className="feed-n mono">×{n}</span>}</>
      meta = <span>{SOURCE_LABEL[it.source ?? ''] ?? it.source}{it.resolved ? ` · ${tr('resolved')}` : ''}</span>
      break
  }
  return (
    <div className={`feed-item k-${it.kind} ${cls}`} data-ask={typeof it.title === 'string' ? it.title : undefined}>
      <span className="feed-ic">{icon}</span>
      <span className="feed-body">{body}</span>
      <span className="feed-meta">{meta}</span>
      <span className="feed-t mono">{t}</span>
    </div>
  )
}
