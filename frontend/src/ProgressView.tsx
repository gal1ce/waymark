import { useState, type ReactNode } from 'react'
import { api, fmtDate, weekNo, type Progress, type TopicRow, type TrackStatus } from './api'
import { t as tr, tx } from './i18n'
import type { Ctx } from './App'
import { PageHead, Section, SOURCE_LABEL, useLoad } from './ui'

type Pt = { date: string; label: string; v: number; max: number }

// shown through tx(), in the interface language
const TRACK: Record<TrackStatus, string> = {
  passed: 'passed', done: 'done', current: 'now', doing: 'in progress', tried: 'tried, below threshold', planned: 'planned', todo: 'up next',
}

export default function ProgressView({ ctx }: { ctx: Ctx }) {
  const p = useLoad(() => api.progress(), [ctx.version])
  const [sel, setSel] = useState<string | null>(null)
  if (!p) return <div className="page" />

  const series: { key: string; label: string; pts: Pt[]; threshold: number; max: number; unit: string }[] = [
    ...p.thresholds.filter((t) => t.key !== 'ielts_essay').map((t) => ({
      key: t.key, label: t.label, threshold: t.threshold, max: t.max, unit: t.unit,
      pts: p.scores.filter((s) => s.kind === t.key).map((s) => ({ date: s.date, label: s.item, v: s.value, max: s.max })),
    })),
    {
      key: 'eod', label: tr('End-of-day test'), threshold: 0, max: 10, unit: '',
      pts: p.tests.filter((t) => t.kind === 'eod').map((t) => ({ date: t.date, label: tr('Test #{n}', { n: t.id }), v: t.score, max: t.max })),
    },
  ]
  const key = sel ?? series.find((s) => s.pts.length)?.key ?? 'khan_unit'
  const cur = series.find((s) => s.key === key) ?? series[0]
  const khanPassed = p.khan.filter((k) => k.status === 'passed').length
  const beejDone = p.beej.filter((b) => b.status === 'done').length

  return (
    <div className="page wide">
      <PageHead title={tr('Progress')} sub={tr('Scores against thresholds. Nothing below its threshold counts as learned')} />

      <Section title={tr('Scores')} className="chart-card" meta={cur.pts.length ? tr(cur.pts.length === 1 ? '{n} result' : '{n} results', { n: cur.pts.length }) : undefined}>
        <div className="tabs" role="tablist" aria-label={tr('Measure')}>
          {series.map((s) => (
            <button key={s.key} role="tab" aria-selected={s.key === key} className={'tab' + (s.key === key ? ' on' : '')} onClick={() => setSel(s.key)}>
              {tx(s.label)}<span className="n">{s.pts.length}</span>
            </button>
          ))}
        </div>
        <ScoreChart key={key} pts={cur.pts} threshold={cur.threshold} unit={cur.unit} />
      </Section>

      <section className="card tracks" aria-label={tr('Tracks')}>
        {p.tracks.map((trk) => {
          const c = trk.units.find((u) => u.status === 'current' || u.status === 'tried')
          return (
            <TrackRow key={trk.key} title={trk.label} meta={tr('{a}/{b} passed', { a: trk.units.filter((u) => u.status === 'passed').length, b: trk.units.length })}>
              <Track items={trk.units.map((u) => ({ key: u.idx, status: u.status, tip: `${u.idx + 1}. ${u.name} · ${tx(TRACK[u.status])}${u.best != null ? ` · ${tr('best {v}', { v: `${u.best}/${u.max}` })}` : ''}` }))} />
              {c && <div className="track-now">{tr('Now:')} <b>{c.name}</b>{c.best != null && <span className="t3"> · {tr('best {v}', { v: `${c.best}/${c.max}` })}</span>}</div>}
            </TrackRow>
          )
        })}
        {p.khan.length > 0 && <TrackRow title="Khan Algebra 1" meta={tr('{a}/{b} passed', { a: khanPassed, b: p.khan.length })}>
          <Track items={p.khan.map((k) => ({ key: k.idx, status: k.status, tip: `${k.idx + 1}. ${k.name} · ${tx(TRACK[k.status])}${k.best != null ? ` · ${tr('best {v}', { v: `${k.best}%` })}` : ''}` }))} />
          {(() => { const c = p.khan.find((k) => k.status === 'current' || k.status === 'tried'); return c && <div className="track-now">{tr('Now:')} <b>{c.name}</b>{c.best != null && <span className="t3"> · {tr('best {v}', { v: `${c.best}%` })}, {tr('threshold {n}%', { n: 90 })}</span>}</div> })()}
        </TrackRow>}
        {p.beej.length > 0 && <TrackRow title="Beej C" meta={tr('{a}/{b} chapters', { a: beejDone, b: p.beej.length })}>
          <Track items={p.beej.map((b) => ({ key: b.n, status: b.status, tip: `${b.n}. ${b.title} · ${tx(TRACK[b.status])}${b.tasks ? ` · ${b.done}/${b.tasks} ${tr('tasks')}` : ''}` }))} />
          {(() => { const c = p.beej.find((b) => b.status === 'doing') ?? p.beej.find((b) => b.status === 'planned'); return c && <div className="track-now">{tx(TRACK[c.status])}: <b>{c.n}. {c.title}</b></div> })()}
        </TrackRow>}
        {p.kintsugi.length > 0 && <TrackRow title={tr('Kintsugi reading')} meta={tr('{a}/{b} done', { a: p.kintsugi.filter((k) => k.status === 'done').length, b: p.kintsugi.length })}>
          <Track items={p.kintsugi.map((k) => ({ key: k.idx, status: k.status, tip: `${k.name} · ${tx(TRACK[k.status])}` }))} />
          {(() => { const c = p.kintsugi.find((k) => k.status === 'doing') ?? p.kintsugi.find((k) => k.status === 'planned'); return c && <div className="track-now">{tx(TRACK[c.status])}: <b>{c.name}</b> <span className="t3 mono">{c.files.join(', ')}</span></div> })()}
        </TrackRow>}
      </section>

      <Section title={tr('By topic')} meta={tr('every finished test, weakest first')}>
        <Topics rows={p.topics} ctx={ctx} />
      </Section>

      <div className="two-col">
        <Section title={tr('Thresholds')} meta={tr('from the roadmap')}>
          <table className="tbl">
            <thead><tr><th>{tr('Measure')}</th><th className="r">{tr('Threshold')}</th><th className="r">{tr('Last')}</th><th className="r">{tr('Passed')}</th><th className="r">{tr('Failed')}</th></tr></thead>
            <tbody>
              {p.thresholds.map((t) => (
                <tr key={t.key} data-ask={`${t.label} threshold: ${t.threshold}${t.unit}${t.note ? ` (${t.note})` : ''}`}>
                  <td>{tx(t.label)}{t.note && <div className="t3 small">{t.note}</div>}</td>
                  <td className="r mono">{fmtV(t.threshold, t.max, t.unit)}</td>
                  <td className={'r mono' + (t.last != null && t.last < t.threshold ? ' neg' : '')}>{t.last != null ? fmtV(t.last, t.max, t.unit) : '–'}</td>
                  <td className="r mono">{t.passed}</td>
                  <td className="r mono">{t.failed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
        <Section title={tr('Sticking points')} meta={tr('{n} open', { n: p.stuck_open })}>
          <StuckWeeks weeks={p.stuck_weeks} />
        </Section>
      </div>
    </div>
  )
}

const fmtV = (v: number, max: number, unit: string) => unit === '%' ? `${v}%` : max ? `${v}/${max}` : `${v}`

function TrackRow({ title, meta, children }: { title: string; meta: string; children: ReactNode }) {
  return (
    <div className="track-row" data-ask={`${title}: ${meta}`}>
      <h2 className="track-h">{title}<span className="meta">{meta}</span></h2>
      {children}
    </div>
  )
}

function Track({ items }: { items: { key: number; status: TrackStatus; tip: string }[] }) {
  return (
    <div className="track" style={{ gridTemplateColumns: `repeat(${items.length}, 1fr)` }}>
      {items.map((i) => <span key={i.key} className={'seg-cell is-' + i.status} title={i.tip} aria-label={i.tip} />)}
    </div>
  )
}

/** Values as % of max over time; the teal line is the pass threshold. */
function ScoreChart({ pts, threshold, unit }: { pts: Pt[]; threshold: number; unit: string }) {
  const W = 880, H = 240, L = 40, R = 16, T = 16, B = 28
  if (!pts.length) return <div className="chart-empty">{tr('No scores for this measure yet. The first one is drawn here against its threshold')}</div>
  const pct = (p: Pt) => (p.v / p.max) * 100
  const thr = unit === '%' ? threshold : pts[0].max ? (threshold / pts[0].max) * 100 : 0
  const x = (i: number) => L + (pts.length === 1 ? (W - L - R) / 2 : (i / (pts.length - 1)) * (W - L - R))
  const y = (v: number) => T + (1 - v / 100) * (H - T - B)
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(pct(p)).toFixed(1)}`).join(' ')
  const area = `${line} L${x(pts.length - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`
  const fmt = (p: Pt) => unit === '%' ? `${p.v}%` : `${p.v}/${p.max}`
  const above = thr ? pts.filter((p) => pct(p) >= thr).length : null
  const summary = tr('Score chart: {n} results, latest {v} on {d}', { n: pts.length, v: fmt(pts[pts.length - 1]), d: fmtDate(pts[pts.length - 1].date) })
    + (above != null ? '. ' + tr('{a} of {n} at or above the threshold', { a: above, n: pts.length }) : '')
  return (
    <>
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary}>
      <defs>
        <linearGradient id="area-fade" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" className="area-stop" stopOpacity="0.09" /><stop offset="1" className="area-stop" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0, 25, 50, 75, 100].map((g) => (
        <g key={g}><line x1={L} x2={W - R} y1={y(g)} y2={y(g)} className={'grid' + (g === 0 ? ' base' : '')} /><text x={L - 8} y={y(g) + 4} className="ax" textAnchor="end">{g}</text></g>
      ))}
      {thr > 0 && <g><line x1={L} x2={W - R} y1={y(thr)} y2={y(thr)} className="thr" /><text x={W - R} y={y(thr) - 6} className="thr-t" textAnchor="end">{tr('threshold {v}', { v: unit === '%' ? `${threshold}%` : `${threshold}/${pts[0].max}` })}</text></g>}
      {pts.length > 1 && <path d={area} className="area" />}
      {pts.length > 1 && <path d={line} className="ln" pathLength={1} />}
      {pts.map((p, i) => (
        <g key={i}>
          <circle cx={x(i)} cy={y(pct(p))} r={4} className={'pt' + (thr && pct(p) >= thr ? ' pass' : '')}><title>{`${fmtDate(p.date)} · ${p.label} · ${unit === '%' ? `${p.v}%` : `${p.v}/${p.max}`}`}</title></circle>
          {(pts.length <= 12 || i % Math.ceil(pts.length / 12) === 0) && <text x={x(i)} y={H - 8} className="ax" textAnchor="middle">{fmtDate(p.date)}</text>}
        </g>
      ))}
    </svg>
    <details className="chart-table">
      <summary>{tr('Show as a table')}</summary>
      <table className="tbl">
        <caption className="sr-only">{summary}</caption>
        <thead><tr><th>{tr('Date')}</th><th>{tr('Measure')}</th><th className="r">{tr('Score')}</th>{thr > 0 && <th className="r">{tr('Threshold')}</th>}</tr></thead>
        <tbody>{pts.map((p, i) => (
          <tr key={i}><td>{fmtDate(p.date)}</td><td>{p.label}</td><td className="r mono">{fmt(p)}</td>
            {thr > 0 && <td className={'r' + (pct(p) >= thr ? '' : ' neg')}>{pct(p) >= thr ? tr('passed') : tr('below')}</td>}</tr>
        ))}</tbody>
      </table>
    </details>
    </>
  )
}

const TREND = { up: '↑', down: '↓', flat: '→' } as const

function Topics({ rows, ctx }: { rows: TopicRow[]; ctx: Ctx }) {
  if (!rows.length) return <div className="empty">{tr('No finished tests yet. After your first one, each topic shows here with how often you get it right')}</div>
  return (
    <div className="topic-list">
      {rows.map((r) => {
        const pct = Math.round((r.right / r.total) * 100)
        const weak = pct < 70
        return (
          <div key={r.topic} className={'topic-row' + (weak ? ' weak' : '')}>
            <div className="topic-head">
              <b>{r.topic}</b>
              <span className="mono t2">{r.right}/{r.total} · {pct}%</span>
              {r.trend && <span className={'trend ' + r.trend} title={tr('Last test compared with the first one shown')}>{TREND[r.trend]} {tr(r.trend === 'up' ? 'improving' : r.trend === 'down' ? 'slipping' : 'no change')}</span>}
              {r.stuck_open > 0 && <span className="t3 small">{tr(r.stuck_open === 1 ? '1 open sticking point' : '{n} open sticking points', { n: r.stuck_open })}</span>}
            </div>
            <span className="topic-bar" role="img" aria-label={tr('{a} of {b} right', { a: r.right, b: r.total })}><span style={{ width: `${pct}%` }} /></span>
            <div className="t3 small">{tr('Recent tests:')} {r.attempts.map((a) => `${fmtDate(a.date)} ${a.right}/${a.total}`).join(' · ')}</div>
            {r.miss && weak && (
              <div className="topic-miss small">
                <span className="t2">{tr('Last miss')} ({fmtDate(r.miss.date)}):</span> {r.miss.prompt || tr('(question)')}{' '}
                <span className="t3">{tr('you wrote {g}, correct: {a}', { g: r.miss.given || '–', a: r.miss.answer })}</span>
              </div>
            )}
            {weak && (
              <div className="topic-acts">
                <button className="btn ghost sm" onClick={() => ctx.ask(`Topic: ${r.topic}. I got ${r.right}/${r.total} right on tests.` + (r.miss ? ` Last miss: ${r.miss.prompt} (I wrote ${r.miss.given || 'nothing'}, correct: ${r.miss.answer}).` : '') + ' Help me find where my reasoning goes wrong, then give me a short practice test on it.')}>{tr('Work on it with the coach')}</button>
                {r.miss && <button className="btn ghost sm" onClick={() => ctx.go({ kind: 'test', id: r.miss!.test_id })}>{tr('Open that test')}</button>}
                {r.notes.map((n) => <button key={n.id} className="btn ghost sm" onClick={() => ctx.go({ kind: 'notes', id: n.id })}>{tr('Your notes: {t}', { t: n.title })}</button>)}
              </div>
            )}
          </div>
        )
      })}
      <div className="t3 small">{tr('Every finished test counts here, practice sets included; pass marks come only from unit checks. Below 70% a topic counts as weak. Wrong answers on end-of-day tests, unit checks and practice sets from a task also become sticking points: the end-of-day test asks about them again, and the coach sees open ones when it plans a new day.')}</div>
    </div>
  )
}

function StuckWeeks({ weeks }: { weeks: Progress['stuck_weeks'] }) {
  if (!weeks.length) return <div className="empty">{tr('No sticking points logged yet')}</div>
  const max = Math.max(1, ...weeks.map((w) => w.opened))
  return (
    <div className="sw-list">
      {weeks.map((w) => {
        const top = Object.entries(w.sources).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, n]) => `${SOURCE_LABEL[k] ?? k} ${n}`).join(' · ')
        return (
          <div key={w.week} className="sw-row" title={top}>
            <span className="t2">{tr('Week {n}', { n: weekNo(w.week) })}</span>
            <span className="sw-bar"><span className="o" style={{ width: `${(w.opened / max) * 100}%` }} /><span className="r" style={{ width: `${(w.resolved / max) * 100}%` }} /></span>
            <span className="mono t2">{w.resolved}/{w.opened}</span>
          </div>
        )
      })}
      <div className="t3 small">{tr('outline: opened · filled: resolved')}</div>
    </div>
  )
}
