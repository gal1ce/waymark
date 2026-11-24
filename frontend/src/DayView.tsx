import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkMath from 'remark-math'
import {
  BookMarked, BookOpen, Check, ChevronDown, ChevronLeft, ChevronRight, CircleDashed, ExternalLink, FileCode2, FolderOpen,
  GraduationCap, Hammer, ListFilter, Lock, NotebookPen, Pause, Play, Plus, RotateCcw, X,
} from 'lucide-react'
import { addDays, api, blockTitle, canPeek, fmtDate, fmtDur, fmtMin, toMin, weekday, weekNo, type Block, type CloseItem, type Day, type OutlineBlock, type Stuck, type Task } from './api'
import type { Ctx } from './App'
import { beejPage } from './BeejPage'
import { t as tr, tx } from './i18n'
import { stuckDetail, stuckSummary } from './stuck'
import { bumpXp } from './prefs'
import { BLOCK_LABEL, KIND_LABEL, PageHead, ScoreBar, Section, SOURCE_LABEL, useFold } from './ui'
import { busyProps, useBusy, useShake } from './interact'
import { KhanTestLauncher, KhanUnitPanel } from './Khan'
import { Fold } from './Fold'
import { CoachMd } from './Coach'
import { fixMathInMd } from './mathtex'

export function useLive(day: Day | null, tick: number) {
  const fetched = useRef(0)
  useEffect(() => { fetched.current = Date.now() }, [day])
  void tick
  return (t: Task) => t.spent_sec_live + (t.status === 'doing' ? Math.max(0, Math.floor((Date.now() - fetched.current) / 1000)) : 0)
}

const peek = (ctx: Ctx, d: string) => canPeek(ctx.meta?.plan?.key, ctx.todayDate, d)
const nowMin = (day: Day) => { const n = day.now ? new Date(day.now) : new Date(); return n.getHours() * 60 + n.getMinutes() }

export function useDay(date: string, ctx: Ctx) {
  const isToday = date === ctx.todayDate
  const [other, setOther] = useState<Day | null>(null)
  useEffect(() => {
    if (isToday) return
    let off = false
    api.day(date).then((d) => { if (!off) setOther(d) }).catch(() => {})
    return () => { off = true }
  }, [date, isToday, ctx.version])
  return isToday ? ctx.today : other && other.date === date ? other : null
}

export default function DayView({ date, ctx }: { date: string; ctx: Ctx }) {
  const day = useDay(date, ctx)
  const live = useLive(day, ctx.tick)
  const [filterRaw, setFilter] = useDayFilter()
  if (!day) return <div className="page" />

  const active = day.status === 'active'
  const preStart = !!ctx.ov && ctx.ov.today < ctx.ov.start_date
  const blocks = day.blocks ?? []
  const tasks = blocks.flatMap((b) => b.tasks)
  const current = tasks.find((t) => t.status === 'doing') ?? null
  const next = tasks.find((t) => t.status === 'todo') ?? null
  const spent = tasks.reduce((a, t) => a + live(t), 0)
  const ver = day.version === 'adapted' ? tr('adapted to your results') : day.version === 'reference' ? tr('planned ahead') : ''
  const verWhy = day.version === 'adapted' ? tr('The coach rewrote this day after looking at your recent tasks, tests and sticking points.')
    : tr('Written in advance from your plan. Until you start it, it can still change: after your results, or when you ask the coach to rewrite it.')
  const st = tx({ active: 'today', past: 'past', closed: 'closed', locked: 'locked', off: 'no study' }[day.status])
  const open = day.exists && day.status !== 'locked' && day.status !== 'off'
  const study = blocks.filter((b) => b.kind !== 'break')
  // a saved filter only uses the choices this day has (a 'Kintsugi' filter on a day without Kintsugi is ignored)
  const opts = { subjects: uniq(study.map((b) => b.kind)), kinds: uniq(study.flatMap((b) => b.tasks.map((t) => t.kind))),
    // a plan of the user's own names its blocks after its tracks: the block's title is the label
    names: Object.fromEntries(study.map((b) => [b.kind, BLOCK_LABEL[b.kind] ?? blockTitle(b.title)])) as Record<string, string> }
  const filter: Filter = {
    subjects: filterRaw.subjects.filter((x) => opts.subjects.includes(x)), status: filterRaw.status,
    kinds: filterRaw.kinds.filter((x) => opts.kinds.includes(x)),
  }
  const filtering = filter.subjects.length > 0 || filter.status !== 'all' || filter.kinds.length > 0
  const rows = study.map((b) => ({ b, tasks: filtering ? b.tasks.filter((t) => matches(filter, b, t)) : b.tasks }))
    .filter((r) => !filtering || r.tasks.length > 0)
  const total = study.reduce((a, b) => a + b.tasks.length, 0)
  const shownN = rows.reduce((a, r) => a + r.tasks.length, 0)

  return (
    <div className="page wide">
      <PageHead
        title={`${weekday(day.date)}, ${fmtDate(day.date)}`}
        sub={<>{tr('Week {n}', { n: weekNo(day.week) })} · {st}{ver && <> · <span className="ver" title={verWhy}>{ver}</span></>}</>}
        right={open && day.progress ? (
          <div className="clock">
            <div className="big">{fmtDur(spent)}</div>
            <div className="small">{tr('plan {t}', { t: fmtMin(day.progress.est_total_min) })} · {day.progress.done}/{day.progress.total} {tr('tasks')}</div>
          </div>
        ) : undefined}>
        {day.adapt_note && <div className="note">{day.adapt_note}</div>}
        {open && <WhyPlan day={day} />}
      </PageHead>
      <WeekStrip date={day.date} ctx={ctx} />

      {!open ? (<>
        <div className="card banner">
          <Lock size={18} strokeWidth={1.5} className="t3" />
          {day.status === 'off' ? <span><b>{tr('No study on {day}.', { day: weekday(day.date) })}</b> {tr('The plan puts nothing on this day')}</span>
            : preStart ? <span><b>{tr('The plan starts {day} {date}.', { day: weekday(ctx.ov!.start_date), date: fmtDate(ctx.ov!.start_date) })}</b> {tr("The day's content opens that morning")}</span>
              : day.outline?.length ? <span><b>{tr('This day is locked.')}</b> {tr('Below is what it will work on. Task details open that morning, and a retake or today\'s results can still change it')}</span>
                : day.exists ? <span><b>{tr('This day is locked.')}</b> {tr("Today's work comes first. It opens in the morning and is reshaped by today's results")}</span>
                  : <span>{tr('No plan for this day')}</span>}
        </div>
        {day.status === 'locked' && day.outline && day.outline.length > 0 && <Outline items={day.outline} />}
      </>) : (
        <>
          {/* what to do now comes first; the day's timeline and its tasks follow */}
          {active && <Current task={current} next={next} live={live} ctx={ctx} />}
          <Ruler day={day} blocks={blocks} />
          <div className="day-grid">
            <div className="timeline">
              <div className="tl-tools">
                {filtering && (
                  <span className="tl-count" role="status">
                    {tr('{a} of {b} tasks', { a: shownN, b: total })}
                    <button type="button" className="link" onClick={() => setFilter(NO_FILTER)}>{tr('Clear')}</button>
                  </span>
                )}
                <FilterMenu opts={opts} filter={filter} setFilter={setFilter} shown={shownN} active={filtering} />
              </div>
              {rows.map(({ b, tasks: ts }) => (
                <BlockRow key={b.id} block={b} tasks={ts} filtered={filtering} day={day} live={live} ctx={ctx} />
              ))}
              {filtering && rows.length === 0 && (
                <div className="card banner">
                  <span>{tr('No tasks on this day match the filters')}</span>
                  <button type="button" className="link" onClick={() => setFilter(NO_FILTER)}>{tr('Clear filters')}</button>
                </div>
              )}
              {/* the day's own end follows its last block: notes and closing, side by side as equals */}
              {(active || day.status === 'closed' || day.status === 'past') && (
                <div className="day-end">
                  <DayNotes day={day} ctx={ctx} />
                  {active && <CloseDay day={day} ctx={ctx} />}
                </div>
              )}
            </div>
            {/* the rail is the day at a glance: shorter than the blocks, and it stays in view while they scroll */}
            <div className="stack rail">
              <DaySummary day={day} spent={spent} />
              <Section title={tr('Sticking points')} meta={tr('{n} open', { n: (day.stuck ?? []).filter((s) => !s.resolved).length })}>
                <StuckList items={day.stuck ?? []} canEdit={active} current={current} ctx={ctx} />
              </Section>
            </div>
          </div>
        </>
      )}
    </div>
  )
}


/** A locked day's outline: each block's time, track and unit, and whether the unit check falls on it. */
function Outline({ items }: { items: OutlineBlock[] }) {
  return (
    <section className="card sec outline">
      <h2 className="sec-h">{tr('Preview')}<span className="meta">{tr('can still change')}</span></h2>
      <ul className="outline-list">
        {items.map((b, i) => (
          <li key={i}>
            <span className="mono t3">{b.start}–{b.end}</span>
            <b>{b.kind === 'test' ? tr('End-of-day test') : b.track}</b>
            <span>
              {b.unit ?? (b.review ? tr('review of earlier units') : '')}
              {b.sessions && b.sessions > 1 && <span className="t3 mono"> · {b.session}/{b.sessions}</span>}
            </span>
            {b.check && <span className="tag">{tr('unit check')}</span>}
          </li>
        ))}
      </ul>
    </section>
  )
}

/** The 7 days of the shown week; off days are visible but not clickable, locked ones only open (as a preview) in a
    plan of the user's own. */
function WeekStrip({ date, ctx }: { date: string; ctx: Ctx }) {
  const weeks = ctx.ov?.weeks ?? []
  const wi = weeks.findIndex((w) => w.days.some((d) => d.date === date))
  const w = weeks[wi]
  if (!w) return null
  return (
    <div className="weekstrip">
      <button className="icon-btn" disabled={wi === 0} onClick={() => ctx.go({ kind: 'day', date: weeks[wi - 1].days[0].date })} aria-label={tr('Previous week')}><ChevronLeft size={16} strokeWidth={1.5} /></button>
      <span className="ws-label">{tr('Week {n}', { n: weekNo(w.week) })}</span>
      <div className="ws-days">
        {Array.from({ length: 7 }, (_, i) => {
          const di = addDays(w.days[0].date, i)
          const d = w.days.find((x) => x.date === di) ?? { date: di, status: 'locked' }
          const blocked = d.status === 'off' || (d.status === 'locked' && !peek(ctx, d.date))
          return (
            <button key={d.date} disabled={blocked} className={`ws-day ${d.status}${d.date === date ? ' sel' : ''}`}
              aria-current={d.date === date ? 'date' : undefined}
              title={d.status === 'locked' ? (peek(ctx, d.date) ? tr('Locked: preview only, opens that morning') : tr('Locked: opens that morning')) : d.status === 'off' ? tr('No study') : fmtDate(d.date)}
              onClick={() => ctx.go({ kind: 'day', date: d.date })}>
              <span>{weekday(d.date, true)}</span>
              {d.status === 'locked' ? <Lock size={12} strokeWidth={1.5} /> : <span className="mono">{Number(d.date.slice(8))}</span>}
            </button>
          )
        })}
      </div>
      <button className="icon-btn" disabled={wi >= weeks.length - 1} onClick={() => ctx.go({ kind: 'day', date: weeks[wi + 1].days[0].date })} aria-label={tr('Next week')}><ChevronRight size={16} strokeWidth={1.5} /></button>
    </div>
  )
}

/** The ruler spans the day's own blocks, whole hours either side (the CTU plan's 10:00–22:00 by default). */
function span(blocks: Block[]): [number, number] {
  if (!blocks.length) return [10 * 60, 22 * 60]
  const lo = Math.floor(Math.min(...blocks.map((b) => toMin(b.start))) / 120) * 120
  const hi = Math.ceil(Math.max(...blocks.map((b) => toMin(b.end))) / 120) * 120
  return [lo, Math.max(hi, lo + 240)]
}

export function Ruler({ day, blocks }: { day: Day; blocks: Block[] }) {
  const [DAY_START, DAY_END] = span(blocks)
  const pos = (m: number) => `${((m - DAY_START) / (DAY_END - DAY_START)) * 100}%`
  const ticks = Array.from({ length: (DAY_END - DAY_START) / 120 + 1 }, (_, i) => DAY_START / 60 + i * 2)
  const n = nowMin(day)
  const showNow = day.status === 'active' && n >= DAY_START && n <= DAY_END
  return (
    <div className="ruler" data-ask={`Day schedule: ${blocks.map((b) => `${b.start}–${b.end} ${blockTitle(b.title)}`).join(', ')}`}>
      <div className="ruler-track">
        {blocks.map((b) => {
          const s = toMin(b.start), e = toMin(b.end)
          const est = b.tasks.reduce((a, t) => a + t.est_min, 0)
          const done = b.tasks.filter((t) => t.status === 'done').reduce((a, t) => a + t.est_min, 0)
          const pct = est ? Math.round((done / est) * 100) : 0
          const cur = day.status === 'active' && n >= s && n < e
          return (
            <div key={b.id} className={`ruler-block${b.kind === 'break' ? ' break' : ''}${cur ? ' cur' : ''}`}
              style={{ left: `calc(${pos(s)} + 2px)`, width: `calc(${pos(e)} - ${pos(s)} - 4px)` }} title={`${b.start}–${b.end} ${blockTitle(b.title)}`}>
              {b.kind !== 'break' && <div className="fill" style={{ '--p': pct / 100 } as CSSProperties} />}
              {b.kind !== 'break' && e - s >= 60 && <span className="lbl">{blockTitle(b.title)}</span>}
              {b.kind !== 'break' && e - s >= 60 && est > 0 && <span className="pct">{pct}%</span>}
            </div>
          )
        })}
        {showNow && <div className="ruler-now" style={{ left: pos(n) }} data-t={`${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`} />}
      </div>
      <div className="ruler-scale">
        {ticks.map((h) => <span key={h} style={{ left: pos(h * 60) }}>{String(h).padStart(2, '0')}:00</span>)}
      </div>
    </div>
  )
}

/** The running task, or the next one to start. */
export function Current({ task, live, ctx, next }: { task: Task | null; live: (t: Task) => number; ctx: Ctx; next?: Task | null }) {
  const [busy, run] = useBusy()
  const [which, setWhich] = useState('')
  const act = (id: number, a: 'start' | 'pause' | 'done') => {
    setWhich(a)
    return run(async () => { const r = await ctx.run(api.task(id, a)); r?.warnings?.forEach((w) => ctx.notify(w, 'warn')); if (r && a === 'done') bumpXp(); ctx.refresh() })
  }
  const bp = (a: string) => busyProps(busy && which === a)
  if (!task) {
    return (
      <div className="card current idle" data-ask={next ? `${next.title}\n${next.detail ?? ''}`.slice(0, 500) : undefined}>
        <div>
          <div className="k">{next ? <>{tr('Up next')} · {KIND_LABEL[next.kind] ?? next.kind} · {tr('est. {t}', { t: fmtMin(next.est_min) })}</> : tr('All done')}</div>
          <div className="tt">{next ? next.title : tr("Today's tasks are done. Close the day when you're ready.")}</div>
          {next && <div className="k">{tr('Time and sticking points are tracked on the task you start')}</div>}
        </div>
        {next && <div className="acts-r"><button className="btn primary lg" {...bp('start')} onClick={() => act(next.id, 'start')}><Play size={15} strokeWidth={1.6} />{tr('Start')}</button></div>}
      </div>
    )
  }
  const sec = live(task)
  const hintIn = Math.max(0, 30 - Math.floor(sec / 60))
  return (
    <div className="card current" data-ask={`${task.title}\n${task.detail ?? ''}`.slice(0, 500)}>
      <div>
        <div className="k">{tr('Now')} · {KIND_LABEL[task.kind] ?? task.kind} · {tr('est. {t}', { t: fmtMin(task.est_min) })}</div>
        <div className="tt">{task.title}</div>
      </div>
      <div className="timer">{fmtDur(sec)}<small>{task.learning ? (hintIn ? tr('coach hint in {n} min', { n: hintIn }) : tr('coach hint available')) : tr('not a learning task')}</small></div>
      <div className="acts">
        <Resources task={task} ctx={ctx} inline />
        <div className="acts-end">
          <button className="btn" {...bp('pause')} onClick={() => act(task.id, 'pause')}><Pause size={14} strokeWidth={1.5} />{tr('Pause')}</button>
          <button className="btn primary" {...bp('done')} onClick={() => act(task.id, 'done')}><Check size={14} strokeWidth={1.5} />{tr('Done')}</button>
        </div>
      </div>
    </div>
  )
}

function BlockRow({ block, tasks, filtered, day, live, ctx }: {
  block: Block; tasks: Task[]; filtered: boolean; day: Day; live: (t: Task) => number; ctx: Ctx
}) {
  const n = nowMin(day)
  const isNow = day.status === 'active' && n >= toMin(block.start) && n < toMin(block.end)
  const past = day.status === 'active' && n >= toMin(block.end)
  const est = block.tasks.reduce((a, t) => a + t.est_min, 0)
  const done = block.tasks.filter((t) => t.status === 'done').length
  const title = blockTitle(block.title)
  const [foldOpen, toggle] = useFold('block.' + title, true)
  // while filtering, blocks open so the matching tasks are in view; the fold you set comes back after
  const open = filtered || foldOpen
  return (
    <div className={'tl-row' + (isNow ? ' now' : '') + (past ? ' past' : '') + (open ? '' : ' folded')}>
      <div className="tl-time"><span>{block.start}</span><span className="t3">{block.end}</span></div>
      <div className="card block" data-ask={`${title} block (${block.start}–${block.end})`}>
        <button type="button" className="block-head fold-btn" aria-expanded={open} aria-disabled={filtered || undefined}
          onClick={() => { if (!filtered) toggle() }}>
          <span className="bt">{title}</span>
          {isNow && <span className="now-tag">{tr('now')}</span>}
          <span className="sum">{filtered && tasks.length < block.tasks.length ? `${tasks.length} / ` : ''}{done}/{block.tasks.length} · {fmtMin(est)}</span>
          {!filtered && (open ? <ChevronDown size={16} strokeWidth={1.5} /> : <ChevronRight size={16} strokeWidth={1.5} />)}
        </button>
        {open && tasks.map((t) => <TaskRow key={t.id} t={t} day={day} live={live} ctx={ctx} />)}
      </div>
    </div>
  )
}

type Filter = { subjects: string[]; status: 'all' | 'open' | 'done'; kinds: string[] }
const NO_FILTER: Filter = { subjects: [], status: 'all', kinds: [] }
const FILTER_KEY = 'ctu.dayFilter'
const uniq = (xs: string[]) => [...new Set(xs)]
const matches = (f: Filter, b: Block, t: Task) =>
  (!f.subjects.length || f.subjects.includes(b.kind)) && (!f.kinds.length || f.kinds.includes(t.kind))
  && (f.status === 'all' || (f.status === 'done') === (t.status === 'done'))

/** Which tasks the timeline shows. Remembered across days and reloads. */
function useDayFilter(): [Filter, (f: Filter) => void] {
  const [f, setF] = useState<Filter>(() => {
    try { return { ...NO_FILTER, ...JSON.parse(localStorage.getItem(FILTER_KEY) || '{}') } } catch { return NO_FILTER }
  })
  const set = (x: Filter) => {
    setF(x)
    try { localStorage.setItem(FILTER_KEY, JSON.stringify(x)) } catch { /* private mode */ }
  }
  return [f, set]
}

const STATUS_OPTS: [Filter['status'], 'All' | 'Not done' | 'Done'][] = [['all', 'All'], ['open', 'Not done'], ['done', 'Done']]

/** The Filter button and its popup: subject (the block), status and task type. */
function FilterMenu({ opts, filter, setFilter, shown, active }: {
  opts: { subjects: string[]; kinds: string[]; names: Record<string, string> }; filter: Filter; setFilter: (f: Filter) => void; shown: number; active: boolean
}) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); btn.current?.focus() } }
    document.addEventListener('pointerdown', down)
    window.addEventListener('keydown', key, true)
    return () => { document.removeEventListener('pointerdown', down); window.removeEventListener('keydown', key, true) }
  }, [open])
  const n = filter.subjects.length + filter.kinds.length + (filter.status !== 'all' ? 1 : 0)
  const flip = (list: string[], x: string) => (list.includes(x) ? list.filter((y) => y !== x) : [...list, x])
  const chips = (list: string[], all: string[], label: Record<string, string>, put: (l: string[]) => void) => (
    <div className="fp-chips">
      {all.map((x) => (
        <button key={x} type="button" className={'chip' + (list.includes(x) ? ' on' : '')} aria-pressed={list.includes(x)}
          onClick={() => put(flip(list, x))}>{label[x] ?? x}</button>
      ))}
    </div>
  )
  return (
    <div className="filter" ref={box}>
      <button ref={btn} type="button" className={'btn sm' + (active ? ' on' : ' ghost')} aria-expanded={open} aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}>
        <ListFilter size={14} strokeWidth={1.5} />{tr('Filter')}{n > 0 && <span className="fp-n">{n}</span>}
      </button>
      {open && (
        <div className="filter-pop" role="dialog" aria-label={tr('Filter tasks')}>
          {opts.subjects.length > 1 && (
            <div className="fp-group">
              <div className="fp-l">{tr('Subject')}</div>
              {chips(filter.subjects, opts.subjects, opts.names, (subjects) => setFilter({ ...filter, subjects }))}
            </div>
          )}
          <div className="fp-group">
            <div className="fp-l">{tr('Status')}</div>
            <div className="seg" role="radiogroup" aria-label={tr('Status')}>
              {STATUS_OPTS.map(([v, l]) => (
                <button key={v} type="button" role="radio" aria-checked={filter.status === v} className={filter.status === v ? 'on' : ''}
                  onClick={() => setFilter({ ...filter, status: v })}>{tr(l)}</button>
              ))}
            </div>
          </div>
          {opts.kinds.length > 1 && (
            <div className="fp-group">
              <div className="fp-l">{tr('Type')}</div>
              {chips(filter.kinds, opts.kinds, KIND_LABEL, (kinds) => setFilter({ ...filter, kinds }))}
            </div>
          )}
          <div className="fp-foot">
            <span className="t3">{tr(shown === 1 ? '{n} task' : '{n} tasks', { n: shown })}</span>
            <button type="button" className="btn ghost sm" disabled={!active} onClick={() => setFilter(NO_FILTER)}>{tr('Reset')}</button>
          </div>
        </div>
      )}
    </div>
  )
}

/** Why the day holds what it holds, read from its tasks: where each track is in its units, retakes, carried-over work
 * and the open sticking points. Only for plans of one's own (their tasks carry a track and a unit). */
function WhyPlan({ day }: { day: Day }) {
  const lines: string[] = []
  const unitName = (t: Task) => t.title.split(' · ')[0]
  for (const b of day.blocks ?? []) {
    const track = blockTitle(b.title)
    const seen = new Set<string>()
    for (const t of b.tasks) {
      const m = t.meta as { track?: string; unit?: number; session?: number; review_unit?: number; track_review?: number; carried_from?: string; moved_from?: string; moved_why?: string; exam?: string }
      if (m.moved_from && !seen.has('m')) {
        seen.add('m')
        lines.push(m.moved_why === 'over'
          ? tr('This block was {from}’s. Its exam is over, so it goes to {track}, the next exam{d}.', { from: m.moved_from, track, d: m.exam ? ` (${fmtDate(m.exam)})` : '' })
          : tr('This block was {from}’s. {track}’s exam is {d} and units are still left, so it takes the block; {from}’s exam is further away.', { from: m.moved_from, track, d: m.exam ? fmtDate(m.exam) : tr('close') }))
      }
      if (m.carried_from) { lines.push(tr('“{t}” was not finished on {d}, so it carried over.', { t: t.title, d: fmtDate(m.carried_from) })); continue }
      if (!m.track) continue
      const u = unitName(t)
      if (m.review_unit != null) { if (!seen.has('r' + u)) lines.push(tr('{track}: {u} again, because its unit check was below the pass mark. The track moves on once you pass the retake.', { track, u })); seen.add('r' + u); continue }
      if (m.track_review != null) { if (!seen.has('v')) lines.push(m.exam ? tr('{track}: no new units left, so it reviews earlier ones until its exam on {d}.', { track, d: fmtDate(m.exam) }) : tr('{track}: no new units left, so it reviews earlier ones.', { track })); seen.add('v'); continue }
      if (t.kind === 'unit_quiz') { if (!t.title.includes('(retake)')) lines.push(tr('{track}: last session of {u}, so its unit check is today. Pass it to move to the next unit.', { track, u })); continue }
      if (m.session != null && !seen.has('u' + u)) {
        const parts = /\((\d+)\/(\d+)\)/.exec(t.title)
        lines.push(parts ? tr('{track}: {u}, session {a} of {b}, next in your plan’s order.', { track, u, a: parts[1], b: parts[2] })
          : tr('{track}: {u}, next in your plan’s order.', { track, u }))
        seen.add('u' + u)
      }
    }
  }
  if (!lines.length) return null
  const open = (day.stuck ?? []).filter((x) => !x.resolved).length
  if (open) lines.push(tr(open === 1 ? '1 sticking point from today is open: the end-of-day test asks about it again, and the coach sees open ones when it plans a new day.' : '{n} sticking points from today are open: the end-of-day test asks about them again, and the coach sees open ones when it plans a new day.', { n: open }))
  return (
    <details className="why-plan">
      <summary>{tr('Why this plan?')}</summary>
      <ul>{lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
      <div className="t3 small">{tr('Each track goes through its units in order: study, problems, then a closed-book unit check. Below the pass mark the unit is studied again and the check retaken before the track moves on. Days are written a few days ahead; one you haven’t started can still change, for example when you ask the coach to rewrite it.')}</div>
    </details>
  )
}

function TaskRow({ t, day, live, ctx }: { t: Task; day: Day; live: (t: Task) => number; ctx: Ctx }) {
  const [open, setOpen] = useState(t.status === 'doing')
  const active = day.status === 'active'
  const sec = live(t)
  const compileFail = t.compile?.type === 'compile_fail'
  const skipped = t.status === 'done' && t.meta.skipped && typeof t.meta.skipped === 'object' ? t.meta.skipped as { percent?: number } : null
  const isTest = t.kind === 'test' || t.kind === 'c_quiz' || t.kind === 'unit_quiz'  // its main action is preparing the test
  const quietStart = isTest || t.kind === 'khan_test' || t.kind === 'khan_study'   // the unit test button / the unit's next step is the main action there
  const [busy, run] = useBusy()
  const [which, setWhich] = useState('')
  const act = (a: 'start' | 'pause' | 'done' | 'reopen') => {
    setWhich(a)
    return run(async () => {
      const r = await ctx.run(api.task(t.id, a))
      r?.warnings?.forEach((w) => ctx.notify(w, 'warn'))
      if (r && (a === 'done' || a === 'reopen')) bumpXp()
      ctx.refresh()
    })
  }
  const bp = (a: string) => busyProps(busy && which === a)
  return (
    <div className={'task ' + t.status} data-ask={`${t.title}\n${t.detail ?? ''}`.slice(0, 500)}>
      <button className="task-row" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={'check ' + t.status}>{t.status === 'done' && <Check size={12} strokeWidth={2.5} />}</span>
        <span className="task-title">{t.title}</span>
        <span className="task-meta">
          {t.compile && <span title={t.compile.data.file} className={'cmp' + (compileFail ? ' fail' : '')}>
            <span className={'dot ' + (compileFail ? 'neg' : 'pos')} />{compileFail ? tr('error') : tr('compiled')}</span>}
          {t.score && <span>{t.score.value}{t.score.max === 100 ? '%' : `/${t.score.max}`}</span>}
          {skipped && <span className="skip-tag">{tr('not needed')}</span>}
          <span className="kind">{KIND_LABEL[t.kind] ?? t.kind}</span>
          <span className="mins">{sec >= 60 ? `${fmtMin(Math.round(sec / 60))} / ` : ''}{fmtMin(t.est_min)}</span>
          {open ? <ChevronDown size={16} strokeWidth={1.5} /> : <ChevronRight size={16} strokeWidth={1.5} />}
        </span>
      </button>
      {open && (
        <div className="task-body">
          {skipped && <div className="skip-note"><Check size={14} strokeWidth={2} />{tr('Not needed today: you passed the unit test ({n}%). The lessons stay here if you want to review.', { n: skipped.percent ?? '' })}</div>}
          {/* a Khan unit is worked in its panel below; the how-to above it is reference once read, so it folds */}
          {t.detail && (t.kind === 'khan_study'
            ? <Fold title={tr('How this task works')} remember="khan-study-how"><div className="md"><Markdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>{fixMathInMd(t.detail)}</Markdown></div></Fold>
            : <div className="md"><Markdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>{fixMathInMd(t.detail)}</Markdown></div>)}
          {typeof t.meta.lesson === 'string' && (
            <details className="lesson" open>
              <summary>{tr('Lesson: {u}', { u: t.title.split(' · ')[0] })}</summary>
              <div className="md"><CoachMd text={t.meta.lesson} ctx={ctx} /></div>
              <p className="t3 small">{tr('Written by the coach for this unit; the worked example is not one of your problems. Check yourself, then read on in the source.')}</p>
            </details>
          )}
          <Resources task={t} ctx={ctx} />
          {typeof t.meta.track === 'string' && <TopicNotes topic={t.title.split(' · ')[0]} ctx={ctx} />}
          {t.files.length > 0 && (
            <div className="files">
              {t.files.map((f) => (
                <span key={f} className="f">
                  {t.files_exist[f] ? <Check size={14} strokeWidth={1.5} /> : <CircleDashed size={14} strokeWidth={1.5} />}{f}
                  {!t.files_exist[f] && <span className="t3">{tr('not yet')}</span>}
                </span>
              ))}
            </div>
          )}
          {compileFail && <div className="errbox">{t.compile!.data.stderr || tr('compile error')}</div>}
          {t.kind === 'khan_study' && <KhanUnitPanel task={t} ctx={ctx} active={active} />}
          {(t.kind === 'khan_test' || t.meta.score_kind === 'khan_unit') && active && (
            <details className="manual-score">
              <summary>{tr('Took the test on khanacademy.org instead? Enter the score')}</summary>
              <ScoreInput t={t} active={active} ctx={ctx} />
            </details>
          )}
          {t.score && t.score.threshold != null && <ScoreBar value={t.score.value} max={t.score.max} threshold={t.score.threshold} label={t.kind === 'unit_quiz' ? tr('Unit check') : tr('Unit test')} />}
          {active && (
            <div className="task-acts">
              {t.status === 'todo' && <button className="btn ghost" {...bp('done')} onClick={() => act('done')}><Check size={14} strokeWidth={1.5} />{tr('Done')}</button>}
              {t.status === 'todo' && <button className={'btn' + (quietStart ? '' : ' primary')} {...bp('start')} onClick={() => act('start')}><Play size={14} strokeWidth={1.5} />{tr('Start')}</button>}
              {t.status === 'doing' && <button className="btn" {...bp('pause')} onClick={() => act('pause')}><Pause size={14} strokeWidth={1.5} />{tr('Pause')}</button>}
              {t.status === 'doing' && <button className={'btn' + (quietStart ? '' : ' primary')} {...bp('done')} onClick={() => act('done')}><Check size={14} strokeWidth={1.5} />{tr('Done')}</button>}
              {t.status === 'done' && <button className="btn ghost" {...bp('reopen')} onClick={() => act('reopen')}><RotateCcw size={14} strokeWidth={1.5} />{tr('Undo')}</button>}
              {isTest && <TestLauncher t={t} day={day} ctx={ctx} />}
              {t.kind === 'read' && typeof t.meta.track === 'string' && typeof t.meta.lesson !== 'string' && <button className="btn" {...bp('lesson')}
                title={tr('A short lesson in the app: the idea, the definitions, a worked example of a different problem, common mistakes and what to read next')}
                onClick={() => { setWhich('lesson'); run(async () => { if (await ctx.run(api.lesson(t.id))) ctx.refresh() }) }}><GraduationCap size={14} strokeWidth={1.5} />{tr('Lesson')}</button>}
              {t.kind === 'practice' && <button className="btn" {...bp('practice')} title={tr('Original problems of the same kind, checked in the app; the ones you miss become sticking points')}
                onClick={() => { setWhich('practice'); run(async () => {
                  const r = await ctx.run(api.practiceSet(t.id))
                  if (r) ctx.go({ kind: 'test', id: r.id })
                }) }}><BookOpen size={14} strokeWidth={1.5} />{tr('Practice set')}</button>}
              {(t.kind === 'khan_test' || t.meta.score_kind === 'khan_unit') && <KhanTestLauncher t={t} ctx={ctx} />}
              {t.files.some((f) => f.endsWith('.c') && t.files_exist[f]) && (
                <button className="btn ghost" {...bp('compile')} title={tr("Compile the task's .c files now with -Wall -Wextra -Werror")}
                  onClick={() => { setWhich('compile'); run(async () => {
                    const r = await ctx.run(api.compile(t.id))
                    if (r) ctx.notify(r.results.every((x) => x.ok) ? tr('Compiled cleanly') : tr('Compile errors, see the task'), r.results.every((x) => x.ok) ? undefined : 'warn')
                    ctx.refresh()
                  }) }}><Hammer size={14} strokeWidth={1.5} />{tr('Compile now')}</button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** The user's notebook pages about this task's unit, and a way to start one. */
function TopicNotes({ topic, ctx }: { topic: string; ctx: Ctx }) {
  const [pages, setPages] = useState<{ id: number; title: string }[] | null>(null)
  useEffect(() => { api.notesAbout(topic).then((r) => setPages(r.pages)).catch(() => setPages([])) }, [topic])
  const [busy, run] = useBusy()
  if (!pages) return null
  return (
    <div className="res topic-notes">
      <span className="t3 small">{tr('Your notes on {t}:', { t: topic })}</span>
      {pages.map((p) => <button key={p.id} onClick={() => ctx.go({ kind: 'notes', id: p.id })}><NotebookPen size={13} strokeWidth={1.5} />{p.title}</button>)}
      <button {...busyProps(busy)} onClick={() => run(async () => {
        const p = await ctx.run(api.notesNew(topic, 'doc'))
        if (p && await ctx.run(api.notesSave(p.id, { topic }))) ctx.go({ kind: 'notes', id: p.id })
      })}><Plus size={13} strokeWidth={1.5} />{pages.length ? tr('New page') : tr('Start a page on it')}</button>
    </div>
  )
}

function Resources({ task, ctx, inline }: { task: Task; ctx: Ctx; inline?: boolean }) {
  if (!task.resources.length) return null
  return (
    <div className={'res' + (inline ? ' inline' : '')}>
      {task.resources.map((r, i) => {
        const bj = r.kind === 'url' ? beejPage(r.href) : null
        if (bj) return <button key={i} onClick={() => ctx.go({ kind: 'beej', ...bj })}><BookOpen size={13} strokeWidth={1.5} />{r.label}</button>
        if (r.kind === 'url') return <a key={i} href={r.href} target="_blank" rel="noreferrer"><ExternalLink size={13} strokeWidth={1.5} />{r.label}</a>
        if (r.kind === 'kintsugi') return <button key={i} onClick={() => ctx.openReader(r.path!)}><FileCode2 size={13} strokeWidth={1.5} />{r.label}</button>
        if (r.kind === 'ref') return <span key={i} className="res-ref"><BookMarked size={13} strokeWidth={1.5} />{r.label}</span>
        return <button key={i} onClick={() => ctx.run(api.open(r.path!)).then((x) => x && !x.exists && ctx.notify(tr("{path} doesn't exist yet, opened the parent folder", { path: r.path! })))}>
          <FolderOpen size={13} strokeWidth={1.5} />{r.label}</button>
      })}
    </div>
  )
}

function ScoreInput({ t, active, ctx }: { t: Task; active: boolean; ctx: Ctx }) {
  const [v, setV] = useState('')
  const [busy, run] = useBusy()
  const [shaking, shake] = useShake()
  const bad = v !== '' && (Number.isNaN(Number(v)) || Number(v) < 0 || Number(v) > 100)
  if (!active) return null
  return (
    <form className="inline-form" onSubmit={(e) => {
      e.preventDefault()
      const n = Number(v)
      if (!v || Number.isNaN(n)) { shake(); return }
      run(async () => {
        const r = await ctx.run(api.score(t.id, n))
        if (r) { ctx.notify(r.message, r.passed ? undefined : 'warn'); setV(''); ctx.refresh() }
      })
    }}>
      <label className="form-l" htmlFor={'score-' + t.id}>{tr('Unit test score')}</label>
      <input id={'score-' + t.id} className={'input w80 mono' + (shaking ? ' shake' : '')} inputMode="decimal" placeholder="%"
        aria-invalid={bad || undefined} value={v} onChange={(e) => setV(e.target.value)} />
      <button className="btn" type="submit" {...busyProps(busy)}><span>{tr('Save')}</span></button>
      <span className="form-n">{tr('threshold {n}%', { n: 90 })}</span>
    </form>
  )
}

function TestLauncher({ t, day, ctx }: { t: Task; day: Day; ctx: Ctx }) {
  const kind = t.kind === 'c_quiz' || t.kind === 'unit_quiz' ? t.kind : 'eod'
  const existing = kind === 'eod' ? day.test : null
  const [busy, run] = useBusy()
  return (
    <>
      {existing?.status === 'submitted' && <span className="form-l mono">{existing.score}/{existing.max}</span>}
      <button className="btn primary" {...busyProps(busy)} onClick={() => run(async () => {
        const r = await ctx.run(api.genTest(kind, t.id))
        if (r) ctx.go({ kind: 'test', id: r.id })
      })}><BookOpen size={14} strokeWidth={1.5} />{existing ? tr('Go to test') : kind === 'c_quiz' ? tr('Prepare quiz') : kind === 'unit_quiz' ? (t.score ? tr('Open check') : tr('Prepare check')) : tr('Prepare test')}</button>
    </>
  )
}

function DaySummary({ day, spent }: { day: Day; spent: number }) {
  const p = day.progress!
  const byBlock = useMemo(() => {
    const m: Record<string, number> = {}
    for (const b of day.blocks ?? []) for (const t of b.tasks) if (b.kind !== 'test' && b.kind !== 'break') {
      const k = blockTitle(b.title).replace(' II', '')
      m[k] = (m[k] ?? 0) + t.spent_sec_live
    }
    return Object.entries(m)
  }, [day])
  const pct = p.est_total_min ? Math.round((p.est_done_min / p.est_total_min) * 100) : 0
  return (
    <Section title={tr('Day')} meta={fmtDur(spent)}>
      <div className="kv"><span>{tr('Tasks done')}</span><b>{p.done}/{p.total}</b></div>
      <div className="kv"><span>{tr('Plan progress')}</span><b>{pct}%</b></div>
      <div className="thin-bar"><div style={{ transform: `scaleX(${pct / 100})` }} /></div>
      <div className="kv-gap" />
      {byBlock.map(([k, s]) => <div className="kv" key={k}><span>{k}</span><b>{fmtMin(Math.round(s / 60))}</b></div>)}
      {day.test?.status === 'submitted' && <div className="kv"><span>{tr('End-of-day test')}</span><b>{day.test.score}/{day.test.max}</b></div>}
    </Section>
  )
}

export function StuckList({ items, canEdit, current, ctx, showDate }: { items: (Stuck & { date?: string })[]; canEdit: boolean; current: Task | null; ctx: Ctx; showDate?: boolean }) {
  const [text, setText] = useState('')
  const [busy, run] = useBusy()
  const [shaking, shake] = useShake()
  return (
    <>
      {canEdit && (
        <form className="inline-form stuck-form" onSubmit={(e) => {
          e.preventDefault(); if (!text.trim()) { shake(); return }
          run(async () => { await ctx.run(api.stuck(text, current?.id)); setText(''); ctx.refresh() })
        }}>
          <input className={'input' + (shaking ? ' shake' : '')} aria-label={tr('Sticking point')} placeholder={current ? tr('Where are you stuck') : tr('Start a task first')} value={text} onChange={(e) => setText(e.target.value)} />
          <button className="btn" type="submit" {...busyProps(busy)}><span>{tr('Add')}</span></button>
        </form>
      )}
      {items.length === 0 && <div className="empty">{tr('None for now. Long idle stretches, repeated compile errors, overtime and wrong test answers land here on their own')}</div>}
      <div className="stuck-list">
        {items.map((s) => (
          <div key={s.id} className={'stuck-item res-' + s.resolved} data-ask={`Sticking point: ${s.summary}${s.detail ? `\n${s.detail}` : ''}`}>
            <div>
              <div>{stuckSummary(s)}</div>
              <div className="src">{SOURCE_LABEL[s.source] ?? s.source} · {showDate && s.date ? `${fmtDate(s.date)} ` : ''}{s.ts.slice(11, 16)}{s.detail && ` · ${stuckDetail(s.detail).slice(0, 120)}`}</div>
            </div>
            {!s.resolved && canEdit && (
              <ResolveBtn onClick={() => ctx.run(api.resolve(s.id)).then(ctx.refresh)}><Check size={14} strokeWidth={1.5} />{tr('Got past it')}</ResolveBtn>
            )}
          </div>
        ))}
      </div>
    </>
  )
}

function CloseDay({ day, ctx }: { day: Day; ctx: Ctx }) {
  const [sure, setSure] = useState(false)
  const [items, setItems] = useState<CloseItem[] | null>(null)
  const [busy, run] = useBusy()
  const ask = () => run(async () => { const r = await ctx.run(api.closeCheck(day.date)); if (r) { setItems(r.checklist); setSure(true) } })
  const missing = (items ?? []).filter((c) => !c.ok && !c.optional)
  return (
    <Section title={tr('Close the day')}>
      <div className="close-note">
        {ctx.meta?.plan?.key === 'ctu'
          ? tr("The day's log is written to PROGRESS.md, unfinished work moves to the next suitable day, and tomorrow is rebuilt from today's results. It also closes on its own at midnight")
          : tr("Unfinished work moves to the next suitable day and tomorrow is rebuilt from today's results. It also closes on its own at midnight")}
      </div>
      {sure && items && (
        <ul className="checklist" aria-label={tr('Before closing')}>
          {items.map((c) => (
            <li key={c.key} className={c.ok ? 'ok' : c.optional ? '' : 'no'}>
              {c.ok ? <Check size={14} strokeWidth={2} /> : <X size={14} strokeWidth={2} />}<span>{tx(c.label)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="inline-form end close-acts">
        {!sure
          ? <button className="btn" {...busyProps(busy)} onClick={ask}><span>{tr('Close the day')}</span></button>
          : <>
              <button className="btn ghost" onClick={() => setSure(false)}>{tr('Cancel')}</button>
              <button className="btn light" {...busyProps(busy)} onClick={() => run(async () => {
                const ok = await ctx.run(api.close(day.date, missing.length > 0))
                setSure(false)
                if (ok) { ctx.notify(tr('Closing the day, rebuilding tomorrow')); ctx.refresh() }
              })}><span>{missing.length ? tr('Close anyway') : tr('Yes, close')}</span></button>
            </>}
      </div>
    </Section>
  )
}

/** What happened today in the user's words; written into the day's PROGRESS.md section (also after closing). */
function DayNotes({ day, ctx }: { day: Day; ctx: Ctx }) {
  const [draft, setDraft] = useState<string | null>(null)   // null: not editing, show what is saved
  const [busy, run] = useBusy()
  return (
    <Section title={tr('Day notes')} meta={ctx.meta?.plan?.key !== 'ctu' ? tr('saved with the day') : day.status === 'active' ? tr('go into PROGRESS.md') : tr('PROGRESS.md is updated on save')}>
      <textarea className="input notes-box" value={draft ?? day.summary ?? ''} placeholder={tr("What went well, what didn't, what to look at tomorrow")}
        aria-label={tr('Day notes')} onChange={(e) => setDraft(e.target.value)} />
      {draft !== null && (
        <div className="inline-form end">
          <button className="btn ghost" onClick={() => setDraft(null)}>{tr('Cancel')}</button>
          <button className="btn primary" {...busyProps(busy)} onClick={() => run(async () => {
            const r = await ctx.run(api.notes(day.date, draft))
            if (r) { setDraft(null); ctx.notify(tr('Notes saved')); ctx.refresh() }
          })}><span>{tr('Save')}</span></button>
        </div>
      )}
    </Section>
  )
}

function ResolveBtn({ onClick, children }: { onClick: () => Promise<unknown>; children: ReactNode }) {
  const [busy, run] = useBusy()
  return <button className="btn ghost sm" {...busyProps(busy)} onClick={() => run(onClick)}>{children}</button>
}
