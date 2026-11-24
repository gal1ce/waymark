import { dayShort, t as tr, tx } from './i18n'
import { useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { fmtDate, fmtHours, MONTHS, type ActivityDay } from './api'

/** A label map read in the interface language: KIND_LABEL[k] gives the translated label at the time it is read. */
const live = (m: Record<string, string>): Record<string, string> =>
  new Proxy(m, { get: (o, k) => (typeof k === 'string' && Object.hasOwn(o, k) ? tx(o[k]) : undefined) })
export const KIND_LABEL: Record<string, string> = live({
  read: 'reading', exercise: 'exercise', khan_test: 'unit test', khan_study: 'Khan study', write: 'writing',
  kintsugi_read: 'code reading', review: 'review', rewrite: 'rewrite', c_quiz: 'quiz', test: 'test', other: 'wrap-up',
  practice: 'problems', unit_quiz: 'unit check',
})
export const SOURCE_LABEL: Record<string, string> = live({
  idle: 'idle', compile: 'compile', overtime: 'overtime', wrong_answer: 'wrong answer', low_score: 'low score',
  wrong_check: 'false check', boredom: 'focus', manual: 'your note', agent: 'coach',
})
export const BLOCK_LABEL: Record<string, string> = live({ math: 'Math', eng: 'English', c: 'C', kintsugi: 'Kintsugi', test: 'Test' })

export function PageHead({ title, sub, right, children }: { title: ReactNode; sub?: ReactNode; right?: ReactNode; children?: ReactNode }) {
  return (
    <header className="head">
      <div className="head-l">
        <h1 className="title">{title}</h1>
        {sub && <div className="sub">{sub}</div>}
        {children}
      </div>
      {right && <div className="head-r">{right}</div>}
    </header>
  )
}

/** Open/closed state remembered per key in localStorage (falls back to `init`). */
export function useFold(key: string | undefined, init = true): [boolean, (v?: boolean) => void] {
  const read = () => { if (!key) return init; try { const v = localStorage.getItem('ctu.fold.' + key); return v == null ? init : v === '1' } catch { return init } }
  const [open, setOpen] = useState(read)
  useEffect(() => { setOpen(read()) }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  const set = (v?: boolean) => setOpen((o) => {
    const n = v ?? !o
    if (key) try { localStorage.setItem('ctu.fold.' + key, n ? '1' : '0') } catch { /* private mode */ }
    return n
  })
  return [open, set]
}

/** Card section. With `fold`, the title toggles the body and the state is remembered under that key. */
export function Section({ title, meta, children, className = '', ask, fold, foldInit = true }: {
  title: ReactNode; meta?: ReactNode; children: ReactNode; className?: string; ask?: string; fold?: string; foldInit?: boolean
}) {
  const [open, toggle] = useFold(fold, foldInit)
  if (!fold) {
    return (
      <section className={'card sec ' + className} data-ask={ask}>
        <h2 className="sec-h">{title}{meta != null && <span className="meta">{meta}</span>}</h2>
        {children}
      </section>
    )
  }
  return (
    <section className={'card sec foldable ' + className + (open ? '' : ' folded')} data-ask={ask}>
      <h2 className="sec-h">
        <button type="button" className="fold-btn" onClick={() => toggle()} aria-expanded={open}>
          {open ? <ChevronDown size={16} strokeWidth={1.5} /> : <ChevronRight size={16} strokeWidth={1.5} />}{title}
        </button>
        {meta != null && <span className="meta">{meta}</span>}
      </h2>
      {open && children}
    </section>
  )
}

/** Bare (non-card) section with a big title that folds; state remembered under `fold`. */
export function Fold({ title, meta, fold, init = true, children }: { title: ReactNode; meta?: ReactNode; fold: string; init?: boolean; children: ReactNode }) {
  const [open, toggle] = useFold(fold, init)
  return (
    <section className={'fold' + (open ? '' : ' folded')}>
      <h2 className="year-h">
        <button type="button" className="fold-btn" onClick={() => toggle()} aria-expanded={open}>
          {open ? <ChevronDown size={16} strokeWidth={1.5} /> : <ChevronRight size={16} strokeWidth={1.5} />}{title}
        </button>
        {meta != null && <span className="meta">{meta}</span>}
      </h2>
      {open && children}
    </section>
  )
}

export function Stat({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="card stat-card">
      <div className="stat-l">{label}</div>
      <div className="stat-v">{value}</div>
      {note && <div className="stat-n">{note}</div>}
    </div>
  )
}

/** One figure in a hairline-divided strip (`.figures`): label, number, what it compares to. */
export function Fig({ label, value, note, onClick }: { label: string; value: ReactNode; note?: ReactNode; onClick?: () => void }) {
  const body = <>
    <div className="stat-l">{label}</div>
    <div className="fig-v">{value}</div>
    {note && <div className="stat-n">{note}</div>}
  </>
  return onClick ? <button type="button" className="fig fig-link" onClick={onClick}>{body}</button> : <div className="fig">{body}</div>
}

/** Value against its pass line. The notch marks the threshold. */
export function ScoreBar({ value, max, threshold, label }: { value: number; max: number; threshold: number; label: string }) {
  const pass = value >= threshold
  const f = (x: number) => (max === 100 ? `${x}%` : `${x}/${max}`)
  return (
    <div className="score">
      <div className="score-top"><span>{label}</span><b>{f(value)} <span className="thr-l">threshold {f(threshold)}</span></b></div>
      <div className="score-bar">
        <div className={'v' + (pass ? ' pass' : '')} style={{ width: `${Math.min(100, (value / max) * 100)}%` }} />
        <div className="notch" style={{ left: `calc(${(threshold / max) * 100}% - 1px)` }} />
      </div>
    </div>
  )
}

const ROWS = [1, 0, 3, 0, 5, 0, 0]   // weekday numbers (Sunday 0) labelled down the side; 0 leaves a row blank

/** Contribution graph: one column per week, Monday on top, fills its container.
 *  Teal intensity = tracked minutes. `foot` sits left of the legend. */
export function Heatmap({ days, onPick, foot }: { days: ActivityDay[]; onPick?: (d: ActivityDay) => void; foot?: ReactNode }) {
  const cols = Array.from({ length: Math.ceil(days.length / 7) }, (_, i) => days.slice(i * 7, i * 7 + 7))
  const months = cols.map((w, i) => {
    const first = w.find((d) => d.date.endsWith('-01')) ?? (i === 0 && !cols.slice(1, 3).some((c) => c.some((d) => d.date.endsWith('-01'))) ? w[0] : undefined)
    return first ? MONTHS[Number(first.date.slice(5, 7)) - 1].slice(0, 3) : ''
  })
  return (
    <div className="heat">
      <div className="heat-grid" style={{ gridTemplateColumns: `auto repeat(${cols.length}, minmax(0, 1fr))` }}>
        {months.map((m, i) => m && <span key={'m' + i} className="heat-m" style={{ gridColumn: i + 2, gridRow: 1 }}>{m}</span>)}
        {ROWS.map((r, i) => r > 0 && <span key={'r' + i} className="heat-r" style={{ gridColumn: 1, gridRow: i + 2 }}>{dayShort(r)}</span>)}
        {cols.map((w, i) => w.map((d, j) => {
          const tip = d.status === 'off' ? `${fmtDate(d.date)} · ${tr('no study')}`
            : d.status === 'future' ? `${fmtDate(d.date)} · ${tr('locked')}`
              : `${fmtDate(d.date)} · ${fmtHours(d.minutes)} · ${tr(d.done === 1 ? '{n} task' : '{n} tasks', { n: d.done })}`
          const click = onPick && d.status !== 'future' && d.status !== 'off'
          return (
            <button key={d.date} type="button" className={`cell l${d.level} s-${d.status}`} title={tip} aria-label={tip}
              style={{ gridColumn: i + 2, gridRow: j + 2 }} disabled={!click} onClick={click ? () => onPick(d) : undefined} />
          )
        }))}
      </div>
      <div className="heat-foot">
        {foot && <span className="heat-note">{foot}</span>}
        <HeatLegend />
      </div>
    </div>
  )
}

export function HeatLegend() {
  return (
    <div className="heat-legend">
      <span>{tr('Less')}</span>
      {[0, 1, 2, 3, 4].map((l) => <span key={l} className={`cell l${l} s-past`} />)}
      <span>{tr('More')}</span>
    </div>
  )
}

/** Fetch on mount and whenever the shared version bumps. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): T | null {
  const [v, setV] = useState<T | null>(null)
  useEffect(() => {
    let off = false
    fn().then((x) => { if (!off) setV(x) }).catch(() => {})
    return () => { off = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return v
}
