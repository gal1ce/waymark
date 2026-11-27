import { useEffect, useRef, useState, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkMath from 'remark-math'
import {
  BookMarked, BookOpen, Check, ChevronDown, ChevronLeft, ChevronRight, CircleDashed, ExternalLink, FileCode2, FolderOpen,
  GraduationCap, Hammer, ListFilter, Lock, NotebookPen, Pause, Play, Plus, RotateCcw, X,
} from 'lucide-react'
import { addDays, api, blockTitle, fmtDate, fmtDur, fmtMin, toMin, weekday, weekNo, type Block, type CloseItem, type Day, type OutlineBlock, type Stuck, type Task } from './api'
import type { Ctx } from './App'
import { beejPage } from './BeejPage'
import { dayName, getLang, t as tr, tx } from './i18n'
import { Select } from './controls'
import { stuckDetail, stuckSummary } from './stuck'
import { bumpXp } from './prefs'
import { BLOCK_LABEL, KIND_LABEL, ScoreBar, Sec, SOURCE_LABEL } from './ui'
import { busyProps, useBusy, useShake } from './interact'
import { KhanTestLauncher, KhanUnitPanel } from './Khan'
import { Fold } from './Fold'
import { CoachMd } from './Coach'
import { fixMathInMd } from './mathtex'
import { useSaved } from './settingsui'

export function useLive(day: Day | null, tick: number) {
  const fetched = useRef(0)
  useEffect(() => { fetched.current = Date.now() }, [day])
  void tick
  return (t: Task) => t.spent_sec_live + (t.status === 'doing' ? Math.max(0, Math.floor((Date.now() - fetched.current) / 1000)) : 0)
}

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
  const [pick, setPick] = useState({ id: 0, n: 0 })
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
  const times = taskTimes(day)
  // one list in the order of the day; what is done goes to the end, so the top of the list is what comes next
  const all = study.flatMap((b) => b.tasks.map((t) => ({ b, t })))
  const shown = all.filter(({ b, t }) => !filtering || matches(filter, b, t))
  const list = [...shown.filter(({ t }) => t.status !== 'done'), ...shown.filter(({ t }) => t.status === 'done')]
  const left = all.filter(({ t }) => t.status !== 'done')
  const planMin = day.progress?.est_total_min ?? all.reduce((a, { t }) => a + t.est_min, 0)
  const details = (id: number) => setPick((p) => ({ id, n: p.n + 1 }))

  return (
    <div className="page lv-page">
      <DayHead day={day} ctx={ctx} st={st} ver={ver} verWhy={verWhy}
        brief={open ? dayBrief(day, spent) : null} spent={open ? spent : null} planMin={planMin} />
      {day.extra && <ExtraDayNote day={day} ctx={ctx} />}

      {day.status === 'off' && day.can_add?.length ? <AddStudy day={day} ctx={ctx} /> : !open ? (<>
        <div className="card banner">
          <Lock size={18} strokeWidth={1.5} className="t3" />
          {day.status === 'off' && !preStart ? <span><b>{tr('No study on {day}.', { day: weekday(day.date) })}</b> {tr('The plan puts nothing on this day')}</span>
            : preStart ? <span><b>{tr('The plan starts {day} {date}.', { day: weekday(ctx.ov!.start_date), date: fmtDate(ctx.ov!.start_date) })}</b> {tr("The day's content opens that morning")}</span>
              : day.outline?.length ? <span><b>{tr('This day is locked.')}</b> {tr('Below is what it will work on. Task details open that morning, and a retake or today\'s results can still change it')}</span>
                : day.exists ? <span><b>{tr('This day is locked.')}</b> {tr("Today's work comes first. It opens in the morning and is reshaped by today's results")}</span>
                  : <span>{tr('No plan for this day')}</span>}
          {preStart && day.date === ctx.ov?.today && <StartNow ctx={ctx} />}
        </div>
        {day.status === 'locked' && day.outline && day.outline.length > 0 && <Outline items={day.outline} />}
      </>) : (
        <>
          {/* level 1: the task you are on (or the next one); the only card on the page */}
          {active && <Focus task={current} next={next} live={live} ctx={ctx} day={day} times={times} onDetails={details} />}
          {/* level 2: the day as a rail, then its tasks beside the sticking points and the notes */}
          {all.length > 0 && (
            <Sec title={tr('The day')} meta={railMeta(times, left.length)}>
              <DayRail day={day} times={times} onPick={(t) => details(t.id)} />
            </Sec>
          )}
          <div className="lv-split">
            <Sec title={tr('Tasks')}
              meta={filtering ? <>{tr('{a} of {b} tasks', { a: shown.length, b: all.length })} · <button type="button" className="linkish" onClick={() => setFilter(NO_FILTER)}>{tr('Clear')}</button></>
                : left.length ? tr('{n} left · {t}', { n: left.length, t: fmtMin(left.reduce((a, { t }) => a + t.est_min, 0)) }) : tr('all done')}
              action={<FilterMenu opts={opts} filter={filter} setFilter={setFilter} shown={shown.length} active={filtering} />}>
              <div className="lv-tasks">
                {list.map(({ t }) => (
                  <TaskRow key={t.id} t={t} day={day} live={live} ctx={ctx} at={times.get(t.id)?.s} pick={pick.id === t.id ? pick.n : 0} />
                ))}
                {filtering && list.length === 0 && <p className="lv-empty">{tr('No tasks on this day match the filters')}</p>}
              </div>
            </Sec>
            <div className="lv-side">
              <Sec title={tr('Sticking points')} meta={tr('{n} open', { n: (day.stuck ?? []).filter((s) => !s.resolved).length })}>
                <StuckList items={day.stuck ?? []} canEdit={active} current={current} ctx={ctx} />
              </Sec>
              {(active || day.status === 'closed' || day.status === 'past') && <DayNotes day={day} ctx={ctx} />}
            </div>
          </div>
          {/* level 3: why the day holds what it holds, and closing it */}
          <DayFoot day={day} ctx={ctx} />
        </>
      )}
    </div>
  )
}

/** Where each task falls in the day: its block's start plus the estimates before it, squeezed to fit the block. */
export function taskTimes(day: Day) {
  const m = new Map<number, { s: number; e: number }>()
  for (const b of day.blocks ?? []) {
    if (b.kind === 'break') continue
    const s0 = toMin(b.start), len = Math.max(0, toMin(b.end) - s0)
    const sum = b.tasks.reduce((a, t) => a + t.est_min, 0)
    const k = sum > len && len > 0 ? len / sum : 1
    let at = s0
    for (const t of b.tasks) { const d = t.est_min * k; m.set(t.id, { s: at, e: at + d }); at += d }
  }
  return m
}

export const hm = (min: number) => { const r = Math.round(min); return `${String(Math.floor(r / 60)).padStart(2, '0')}:${String(r % 60).padStart(2, '0')}` }

const railMeta = (times: Map<number, { s: number; e: number }>, left: number) => {
  const v = [...times.values()]
  if (!v.length) return undefined
  const range = `${hm(Math.min(...v.map((x) => x.s)))}–${hm(Math.max(...v.map((x) => x.e)))}`
  return left ? `${range} · ${tr('{n} left', { n: left })}` : range
}

/** The day in a sentence: its courses, its size, how far it is. */
export function dayBrief(day: Day, spentSec: number) {
  const study = (day.blocks ?? []).filter((b) => b.kind !== 'break' && b.tasks.some((t) => t.kind !== 'test'))
  const names = uniq(study.map((b) => blockTitle(b.title)))
  if (!names.length) return null
  const courses = new Intl.ListFormat(getLang() === 'tr' ? 'tr' : 'en', { type: 'conjunction' }).format(names.slice(0, 4))
  const ts = (day.blocks ?? []).flatMap((b) => b.tasks)
  const n = ts.length, d = ts.filter((t) => t.status === 'done').length
  const plan = fmtMin(day.progress?.est_total_min ?? ts.reduce((a, t) => a + t.est_min, 0))
  const spent = fmtMin(Math.floor(spentSec / 60))
  if (day.status !== 'active') return tr('{courses}: {d} of {n} tasks done, {h} studied.', { courses, d, n, h: spent })
  if (n && d === n) return tr('{courses}: all {n} tasks done, {h} studied.', { courses, n, h: spent })
  return tr('{courses}: {h} over {n} tasks.', { courses, h: plan, n }) + (d ? ' ' + tr(d === 1 ? '1 is done.' : '{d} are done.', { d }) : '')
}

/** A thin bar for how much of something is used. */
export function Meter({ value, label }: { value: number; label?: string }) {
  const v = Math.max(0, Math.min(1, value || 0))
  return <span className="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)} aria-label={label}><i style={{ width: `${v * 100}%` }} /></span>
}

function DayHead({ day, ctx, st, ver, verWhy, brief, spent, planMin }: {
  day: Day; ctx: Ctx; st: string; ver: string; verWhy: string; brief: string | null; spent: number | null; planMin: number
}) {
  const go = (d: string) => ctx.go({ kind: 'day', date: d })
  return (
    <header className="lv-head">
      <div className="lv-head-l">
        <div className="lv-nav">
          <button type="button" className="icon-btn sm" onClick={() => go(addDays(day.date, -1))} aria-label={tr('Previous day')}><ChevronLeft size={16} strokeWidth={1.6} /></button>
          <h1 className="eyebrow">{weekday(day.date)}, {fmtDate(day.date)} · {tr('Week {n}', { n: weekNo(day.week) })} · {st}{ver && <> · <span className="ver" title={verWhy}>{ver}</span></>}</h1>
          <button type="button" className="icon-btn sm" onClick={() => go(addDays(day.date, 1))} aria-label={tr('Next day')}><ChevronRight size={16} strokeWidth={1.6} /></button>
          {day.date !== ctx.todayDate && <button type="button" className="btn ghost sm" onClick={() => go(ctx.todayDate)}>{tr('Back to today')}</button>}
        </div>
        {brief && <p className="lv-brief">{brief}</p>}
      </div>
      {spent != null && planMin > 0 && (
        <div className="lv-head-r">
          <div className="lv-fig"><b>{fmtMin(Math.floor(spent / 60))}</b><span>{tr('of {t}', { t: fmtMin(planMin) })}</span></div>
          <Meter value={spent / 60 / planMin} label={tr('Time studied today')} />
        </div>
      )}
    </header>
  )
}

/** The day as one line of time: each task where it falls, the done ones green, the running one in the accent, and a
    mark at the current time. A task opens its row below. */
export function DayRail({ day, times, onPick }: { day: Day; times: Map<number, { s: number; e: number }>; onPick?: (t: Task) => void }) {
  const items = (day.blocks ?? []).filter((b) => b.kind !== 'break').flatMap((b) => b.tasks.map((t) => ({ t, b })))
  const v = items.map(({ t }) => times.get(t.id)).filter((x): x is { s: number; e: number } => !!x)
  if (!v.length) return null
  const a = Math.floor(Math.min(...v.map((x) => x.s)) / 60) * 60
  const z = Math.max(a + 60, Math.ceil(Math.max(...v.map((x) => x.e)) / 60) * 60)
  const len = z - a
  const pos = (m: number) => `${((m - a) / len) * 100}%`
  const step = len > 600 ? 120 : 60
  const hours: number[] = []
  for (let h = a; h <= z; h += step) hours.push(h)
  const n = nowMin(day)
  const showNow = day.status === 'active' && n >= a && n <= z
  return (
    <div className="drail">
      <div className="drail-track" role="list" aria-label={tr('The day')}>
        {items.map(({ t, b }) => {
          const x = times.get(t.id)!
          const label = `${hm(x.s)}–${hm(x.e)} · ${blockTitle(b.title)} · ${t.title}`
          return (
            <button key={t.id} type="button" role="listitem" className={'drail-seg ' + t.status} title={label} aria-label={label}
              style={{ left: pos(x.s), width: `calc(${((x.e - x.s) / len) * 100}% - 3px)` }} onClick={() => onPick?.(t)}>
              <span>{t.title}</span>
            </button>
          )
        })}
        {showNow && <span className="drail-now" style={{ left: pos(n) }} aria-hidden />}
      </div>
      <div className="drail-hours" aria-hidden>{hours.map((h) => <span key={h} style={{ left: pos(h) }}>{String(h / 60).padStart(2, '0')}</span>)}</div>
    </div>
  )
}

/** The first paragraph of a task's text, without the markdown. */
const gist = (md: string | null | undefined) => {
  const p = (md ?? '').trim().split(/\n\s*\n/)[0] ?? ''
  return p.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^#+\s*/gm, '').replace(/[*_`>]/g, '').replace(/\s+/g, ' ').trim()
}

/** Level 1 of Today: the running task, or the next one to start. */
function Focus({ task, next, live, ctx, day, times, onDetails }: {
  task: Task | null; next: Task | null; live: (t: Task) => number; ctx: Ctx; day: Day; times: Map<number, { s: number; e: number }>; onDetails: (id: number) => void
}) {
  const [busy, run] = useBusy()
  const [which, setWhich] = useState('')
  const act = (id: number, a: 'start' | 'pause' | 'done') => {
    setWhich(a)
    return run(async () => { const r = await ctx.run(api.task(id, a)); r?.warnings?.forEach((w) => ctx.notify(w, 'warn')); if (r && a === 'done') bumpXp(); ctx.refresh() })
  }
  const bp = (a: string) => busyProps(busy && which === a)
  const t = task ?? next
  if (!t) {
    return (
      <section className="lead" aria-label={tr('All done')}>
        <div className="eyebrow pos">{tr('All done')}</div>
        <h2 className="lead-title">{tr("Today's tasks are done.")}</h2>
        <p className="lead-sub">{tr('Write a line in the day notes, then close the day at the end of the page.')}</p>
      </section>
    )
  }
  const doing = t.status === 'doing'
  const block = (day.blocks ?? []).find((b) => b.tasks.some((x) => x.id === t.id))
  const sec = live(t)
  const hintIn = Math.max(0, 30 - Math.floor(sec / 60))
  const at = times.get(t.id)
  const text = gist(t.detail)
  return (
    <section className={'lead' + (doing ? ' on' : '')} aria-label={doing ? tr('In progress') : tr('Up next')} data-ask={`${t.title}\n${t.detail ?? ''}`.slice(0, 500)}>
      <div className="lead-top">
        <div className="lead-l">
          <div className={'eyebrow' + (doing ? ' acc' : '')}>
            {doing ? tr('In progress') : tr('Up next')} · {KIND_LABEL[t.kind] ?? t.kind}{block && ` · ${blockTitle(block.title)}`}{!doing && at ? ` · ${hm(at.s)}` : ''}
          </div>
          <h2 className="lead-title">{t.title}</h2>
          {text && <p className="lead-sub">{text}</p>}
        </div>
        <div className="lead-r">
          {doing ? <>
            <div className="lead-timer">{fmtDur(sec)}</div>
            <div className="lead-note">{tr('of {t}', { t: fmtMin(t.est_min) })} · {t.learning ? (hintIn ? tr('coach hint in {n} min', { n: hintIn }) : tr('coach hint available')) : tr('not a learning task')}</div>
            <Meter value={sec / 60 / Math.max(1, t.est_min)} label={tr('Time on this task')} />
          </> : <>
            <div className="lead-timer dim">{fmtMin(t.est_min)}</div>
            <div className="lead-note">{tr('estimated')}</div>
          </>}
        </div>
      </div>
      <div className="lead-acts">
        {doing ? <>
          <button className="btn primary lg" {...bp('done')} onClick={() => act(t.id, 'done')}><Check size={15} strokeWidth={1.8} />{tr('Done')}</button>
          <button className="btn lg" {...bp('pause')} onClick={() => act(t.id, 'pause')}><Pause size={15} strokeWidth={1.6} />{tr('Pause')}</button>
        </> : (
          <button className="btn primary lg" autoFocus {...bp('start')} onClick={() => act(t.id, 'start')}><Play size={15} strokeWidth={1.6} />{tr('Start')}</button>
        )}
        <button type="button" className="btn ghost lg" onClick={() => onDetails(t.id)}>{tr('Details')}</button>
        <span className="lead-res"><Resources task={t} ctx={ctx} inline /></span>
      </div>
    </section>
  )
}

/** A plan of the user's own that starts on a later day: start it today instead. The first work comes today and the
    days after move up; a today the plan has off becomes a one-off study day. */
export function StartNow({ ctx }: { ctx: Ctx }) {
  const [busy, run] = useBusy()
  if (ctx.meta?.plan?.key !== 'custom' || !ctx.ov || ctx.ov.today >= ctx.ov.start_date) return null
  const go = async () => {
    const ok = await ctx.confirm({
      title: tr('Start the plan today?'), action: tr('Start today'),
      body: tr('The plan starts today instead of {date}. Its first work comes today and every planned day after it moves up. Your weekly study days stay the same.', { date: fmtDate(ctx.ov!.start_date) }),
    })
    if (ok) run(async () => { const r = await ctx.run(api.startNow()); if (r) { ctx.notify(tr('The plan starts today'), 'ok'); ctx.refresh() } })
  }
  return <button type="button" className="btn primary sm start-now" {...busyProps(busy)} onClick={go}><Play size={14} strokeWidth={1.8} /><span>{tr('Start the plan today')}</span></button>
}

/** A day off of a plan of the user's own: study on it anyway, for this date only. It copies the blocks of one of the
    plan's study days and takes the next work of each course, so the planned days after it move up. */
function AddStudy({ day, ctx }: { day: Day; ctx: Ctx }) {
  const opts = day.can_add ?? []
  const [like, setLike] = useState(opts[0])
  const [busy, run] = useBusy()
  const add = () => run(async () => {
    const r = await ctx.run(api.addExtraDay(day.date, like))
    if (r) {
      ctx.notify(tr('Study added on {day}', { day: weekday(day.date) }), 'ok',
        r.replanned.length ? tr('The days planned after it were planned again: their work moved up.') : undefined)
      ctx.refresh()
    }
  })
  return (
    <section className="card sec extra-add">
      <h2 className="sec-h">{tr('No study on {day}.', { day: weekday(day.date) })}<span className="meta">{tr('a day off')}</span></h2>
      <p className="sec-sub">{tr('Want to study anyway? Add study for this date only. It uses the blocks of one of your study days and goes on with the next work in your plan, so the days after it move up. Your weekly study days stay the same.')}</p>
      <div className="inline-form">
        <Select size="sm" value={like} onChange={setLike} label={tr('Which day\'s blocks to use')}
          options={opts.map((w) => ({ value: w, label: tr('The blocks of {day}', { day: dayName((w + 1) % 7) }) }))} />
        <button type="button" className="btn primary sm" {...busyProps(busy)} onClick={add}><Plus size={14} strokeWidth={1.8} /><span>{tr('Study on this day')}</span></button>
      </div>
    </section>
  )
}

/** A study day the user added on a day off: says so, and takes it back while nobody has worked on it. */
function ExtraDayNote({ day, ctx }: { day: Day; ctx: Ctx }) {
  const [busy, run] = useBusy()
  const x = day.extra!
  const remove = async () => {
    const ok = await ctx.confirm({
      title: tr('Take this study day back?'), action: tr('Take it back'),
      body: tr('{day} goes back to being a day off. Its work returns to the days after it.', { day: weekday(day.date) }),
    })
    if (ok) run(async () => { const r = await ctx.run(api.removeExtraDay(day.date)); if (r) { ctx.notify(tr('Study day taken back'), 'ok'); ctx.refresh() } })
  }
  return (
    <div className="card banner split extra-note">
      <span><b>{tr('A study day you added.')}</b> {tr('{day} is normally a day off; this date uses the blocks of {like}.', { day: weekday(day.date), like: dayName((x.like + 1) % 7) })}</span>
      {x.removable && <button type="button" className="btn ghost sm" {...busyProps(busy)} onClick={remove}><X size={14} strokeWidth={1.6} /><span>{tr('Take it back')}</span></button>}
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
function whyLines(day: Day): { note?: string | null; lines: string[] } | null {
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
  if (!lines.length && !day.adapt_note) return null
  const open = (day.stuck ?? []).filter((x) => !x.resolved).length
  if (open) lines.push(tr(open === 1 ? '1 sticking point from today is open: the end-of-day test asks about it again, and the coach sees open ones when it plans a new day.' : '{n} sticking points from today are open: the end-of-day test asks about them again, and the coach sees open ones when it plans a new day.', { n: open }))
  return { note: day.adapt_note, lines }
}

/** Level 3 of Today: why the day holds what it holds (one line, opens to the reasons), and closing the day. */
function DayFoot({ day, ctx }: { day: Day; ctx: Ctx }) {
  const why = whyLines(day)
  const [open, setOpen] = useState(false)
  const active = day.status === 'active'
  if (!why && !active) return null
  return (
    <footer className="lv-foot">
      <div className="lv-foot-row">
        {why && <button type="button" className="lv-why" aria-expanded={open} onClick={() => setOpen(!open)}>
          {tr('Why this plan?')}{open ? <ChevronDown size={14} strokeWidth={1.6} /> : <ChevronRight size={14} strokeWidth={1.6} />}</button>}
        {why && !open && <span className="lv-why-gist">{why.note || why.lines[0]}</span>}
        {active && <CloseDay day={day} ctx={ctx} />}
      </div>
      {open && why && (
        <div className="why-b">
          {why.note && <p>{why.note}</p>}
          {why.lines.length > 0 && <ul>{why.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>}
          <p className="t3 small">{tr('Each track goes through its units in order: study, problems, then a closed-book unit check. Below the pass mark the unit is studied again and the check retaken before the track moves on. Days are written a few days ahead; one you haven’t started can still change, for example when you ask the coach to rewrite it.')}</p>
        </div>
      )}
    </footer>
  )
}

function TaskRow({ t, day, live, ctx, at, pick }: { t: Task; day: Day; live: (t: Task) => number; ctx: Ctx; at?: number; pick?: number }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  // "Details" on the focus card and a task on the rail open its row here
  useEffect(() => {
    if (!pick) return
    setOpen(true)
    requestAnimationFrame(() => box.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }))
  }, [pick])
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
    <div ref={box} className={'task ' + t.status} data-ask={`${t.title}\n${t.detail ?? ''}`.slice(0, 500)}>
      <button className={'task-row' + (at != null ? ' timed' : '')} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={'check ' + t.status}>{t.status === 'done' && <Check size={12} strokeWidth={2.5} />}</span>
        {at != null && <span className="task-at">{hm(at)}</span>}
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


export function StuckList({ items, canEdit, current, ctx, showDate }: { items: (Stuck & { date?: string })[]; canEdit: boolean; current: Task | null; ctx: Ctx; showDate?: boolean }) {
  const [text, setText] = useState('')
  const [busy, run] = useBusy()
  const [shaking, shake] = useShake()
  return (
    <>
      {canEdit && current && (
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
  const what = ctx.meta?.plan?.key === 'ctu'
    ? tr("The day's log is written to PROGRESS.md, unfinished work moves to the next suitable day, and tomorrow is rebuilt from today's results. It also closes on its own at midnight")
    : tr("Unfinished work moves to the next suitable day and tomorrow is rebuilt from today's results. It also closes on its own at midnight")
  return (
    <>
      <span className="lv-close">
        {!sure
          ? <button className="btn sm" title={what} {...busyProps(busy)} onClick={ask}><span>{tr('Close the day')}</span></button>
          : <>
              <button className="btn ghost sm" onClick={() => setSure(false)}>{tr('Cancel')}</button>
              <button className="btn primary sm" {...busyProps(busy)} onClick={() => run(async () => {
                const ok = await ctx.run(api.close(day.date, missing.length > 0))
                setSure(false)
                if (ok) { ctx.notify(tr('Closing the day, rebuilding tomorrow')); ctx.refresh() }
              })}><span>{missing.length ? tr('Close anyway') : tr('Yes, close')}</span></button>
            </>}
      </span>
      {sure && items && (
        <div className="lv-close-b">
          <p>{what}</p>
          <ul className="checklist" aria-label={tr('Before closing')}>
            {items.map((c) => (
              <li key={c.key} className={c.ok ? 'ok' : c.optional ? '' : 'no'}>
                {c.ok ? <Check size={14} strokeWidth={2} /> : <X size={14} strokeWidth={2} />}<span>{tx(c.label)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  )
}

/** What happened today in the user's words; written into the day's PROGRESS.md section (also after closing). */
function DayNotes({ day, ctx }: { day: Day; ctx: Ctx }) {
  const [draft, setDraft] = useState<string | null>(null)   // null: not edited, show what is saved
  const [saved, markSaved] = useSaved()
  const save = async () => {
    if (draft === null || draft === (day.summary ?? '')) { setDraft(null); return }
    const r = await ctx.run(api.notes(day.date, draft))
    if (r) { setDraft(null); markSaved(); ctx.refresh() }
  }
  return (
    <Sec title={tr('Day notes')} meta={saved ? <span className="sg-saved" role="status"><Check size={13} strokeWidth={2.2} />{tr('Saved')}</span> : tr('saved when you leave the box')}>
      <textarea className="input notes-box" value={draft ?? day.summary ?? ''} placeholder={tr("What went well, what didn't, what to look at tomorrow")}
        aria-label={tr('Day notes')} title={ctx.meta?.plan?.key !== 'ctu' ? tr('Saved with the day when you leave the box.') : tr('Saved into PROGRESS.md when you leave the box.')}
        onChange={(e) => setDraft(e.target.value)} onBlur={save} />
    </Sec>
  )
}

function ResolveBtn({ onClick, children }: { onClick: () => Promise<unknown>; children: ReactNode }) {
  const [busy, run] = useBusy()
  return <button className="btn ghost sm" {...busyProps(busy)} onClick={() => run(onClick)}>{children}</button>
}
