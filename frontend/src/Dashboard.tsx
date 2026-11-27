import { t as tr, unit } from './i18n'
import { ArrowRight, Check, ChevronRight, Play, Plus } from 'lucide-react'
import { api, blockTitle, fmtDate, fmtHours, fmtMin, MONTHS, weekday, weekNo, type Dashboard as Dash } from './api'
import type { Ctx } from './App'
import { DayRail, Meter, StartNow, StuckList, taskTimes, useLive } from './DayView'
import { KIND_LABEL, Sec, useLoad } from './ui'
import { busyProps, useBusy } from './interact'

/** Home. Level 1: today (the task you are on, the day as a rail). Level 2: the week, the courses, what is coming up.
    Level 3: the sticking points still open. The day itself is worked on Today. */
export default function Dashboard({ ctx }: { ctx: Ctx }) {
  const d = useLoad(() => api.dashboard(), [ctx.version])
  return (
    <div className="page lv-page">
      <HomeLead ctx={ctx} />
      {d && (
        <div className="lv-tiles">
          <Week d={d} today={ctx.todayDate} />
          <Courses d={d} ctx={ctx} />
          <ComingUp d={d} ctx={ctx} />
        </div>
      )}
      {d && (d.stuck.length
        ? <Sec title={tr('Open sticking points')} meta={String(d.stuck.length)}>
            <StuckList items={d.stuck} canEdit={false} current={null} ctx={ctx} showDate />
          </Sec>
        : <p className="lv-none"><Check size={15} strokeWidth={2} />{tr('No open sticking points')}<span>· {tr('they show up here when a task goes long, a test answer is wrong, or you add one')}</span></p>)}
    </div>
  )
}

function HomeLead({ ctx }: { ctx: Ctx }) {
  const day = ctx.today
  const live = useLive(day, ctx.tick)
  const [busy, run] = useBusy()
  const tasks = (day?.blocks ?? []).flatMap((b) => b.tasks)
  const done = tasks.filter((t) => t.status === 'done').length
  const cur = tasks.find((t) => t.status === 'doing') ?? tasks.find((t) => t.status === 'todo') ?? null
  const open = !!day && day.exists && day.status === 'active'
  const preStart = !!ctx.ov && ctx.ov.today < ctx.ov.start_date
  const spent = tasks.reduce((a, t) => a + live(t), 0)
  const planned = tasks.reduce((a, t) => a + t.est_min, 0)
  const toToday = () => ctx.go({ kind: 'day', date: ctx.todayDate })
  const act = (a: 'start' | 'done') => run(async () => {
    if (cur && (a === 'done' || cur.status === 'todo')) await ctx.run(api.task(cur.id, a))
    ctx.refresh()
    if (a === 'start') toToday()
  })
  const date = day ? `${weekday(day.date)}, ${fmtDate(day.date)}` : ''
  const week = ctx.ov ? ' · ' + tr('Week {n}', { n: weekNo((day?.week ?? 0)) }) : ''

  if (!open || !cur) {
    const title = open ? tr('All {n} tasks done.', { n: tasks.length })
      : preStart ? tr('The plan starts {day} {date}.', { day: weekday(ctx.ov!.start_date), date: fmtDate(ctx.ov!.start_date) })
        : day?.status === 'off' ? tr('A day off.') : tr('No open day for today')
    const sub = open ? tr("Close the day on Today when you're ready")
      : preStart ? tr('Days stay locked until then') : day?.status === 'off' ? tr('No study today, the next day opens in the morning') : null
    return (
      <section className="lead" aria-label={tr('Today')}>
        <div className={'eyebrow' + (open ? ' pos' : '')}>{date}{week}</div>
        <h1 className="lead-title">{open && <Check size={30} strokeWidth={2} className="pos" />} {title}</h1>
        {sub && <p className="lead-sub">{sub}</p>}
        <div className="lead-acts">
          {preStart && <StartNow ctx={ctx} />}
          {(open || day?.status === 'off') && <button className="btn lg" onClick={toToday}>{tr('Today\'s plan')}<ArrowRight size={15} strokeWidth={1.7} /></button>}
        </div>
        {open && day && <DayRail day={day} times={taskTimes(day)} onPick={toToday} />}
      </section>
    )
  }

  const doing = cur.status === 'doing'
  const block = day!.blocks?.find((b) => b.tasks.some((t) => t.id === cur.id))
  const sec = live(cur)
  const leftMin = Math.max(0, cur.est_min - Math.floor(sec / 60))
  const sub = [block ? blockTitle(block.title) : null, KIND_LABEL[cur.kind] ?? cur.kind,
    doing ? (leftMin > 0 ? tr('{a} in, about {b} to go', { a: fmtMin(Math.floor(sec / 60)), b: fmtMin(leftMin) }) : tr('{a} in, past its estimate of {b}', { a: fmtMin(Math.floor(sec / 60)), b: fmtMin(cur.est_min) })) : tr('estimated {t}', { t: fmtMin(cur.est_min) })].filter(Boolean).join(' · ')
  return (
    <section className={'lead' + (doing ? ' on' : '')} aria-label={tr('Today')}>
      <div className="lead-top">
        <div className="lead-l">
          <div className={'eyebrow' + (doing ? ' acc' : '')}>{date} · {doing ? tr('In progress') : tr('Up next')}</div>
          <h1 className="lead-title">{cur.title}</h1>
          <p className="lead-sub">{sub}</p>
        </div>
        <div className="lead-r">
          <div className="lv-fig"><b>{done} / {tasks.length}</b><span>{tr('tasks')}</span></div>
          <div className="lead-note">{tr('{a} of {b} today', { a: fmtMin(Math.floor(spent / 60)), b: fmtMin(planned) })}</div>
          <Meter value={spent / 60 / Math.max(1, planned)} label={tr('Time studied today')} />
        </div>
      </div>
      <div className="lead-acts">
        {doing
          ? <button className="btn primary lg" autoFocus onClick={toToday}>{tr('Continue')}<ArrowRight size={15} strokeWidth={1.8} /></button>
          : <button className="btn primary lg" autoFocus {...busyProps(busy)} onClick={() => act('start')}><Play size={14} strokeWidth={1.7} />{tr('Start')}</button>}
        {doing && <button className="btn lg" {...busyProps(busy)} onClick={() => act('done')}><Check size={15} strokeWidth={1.8} />{tr('Done')}</button>}
        {!doing && <button className="btn ghost lg" onClick={toToday}>{tr('Today\'s plan')}</button>}
      </div>
      <DayRail day={day!} times={taskTimes(day!)} onPick={toToday} />
    </section>
  )
}

/** This week as one track per day: its height the day's plan, filled from the bottom with what was studied. */
function Week({ d, today }: { d: Dash; today: string }) {
  const days = d.week_days ?? []
  const top = Math.max(60, ...days.map((x) => Math.max(x.planned, x.minutes)))
  return (
    <section className="tile" aria-label={tr('This week')}>
      <header className="tile-h"><h2>{tr('This week')}</h2><span>{tr('target {h}', { h: fmtHours(d.week_target_min) })}</span></header>
      <div className="lv-fig"><b>{fmtMin(d.week_minutes)}</b><span>{tr('studied')}</span></div>
      <div className="wk" role="list" aria-label={tr('Study time by day')}>
        {days.map((x) => {
          const h = x.planned ? Math.max(10, (x.planned / top) * 100) : 0
          const tip = `${weekday(x.date)} · ${x.planned ? `${fmtMin(x.minutes)} / ${fmtMin(x.planned)}` : x.minutes ? fmtMin(x.minutes) : tr('no study')}`
          return (
            <div key={x.date} role="listitem" className={'wk-d' + (x.date === today ? ' today' : '')} title={tip} aria-label={tip}>
              <span className="wk-c">
                {x.planned > 0
                  ? <span className="wk-t" style={{ height: `${h}%` }}><i style={{ height: `${Math.min(1, x.minutes / x.planned) * 100}%` }} /></span>
                  : x.minutes > 0 ? <span className="wk-t extra" style={{ height: `${Math.max(10, (x.minutes / top) * 100)}%` }}><i style={{ height: '100%' }} /></span>
                    : <span className="wk-base" />}
              </span>
              <span className="wk-l">{weekday(x.date, true)}</span>
            </div>
          )
        })}
      </div>
      <WeekNote days={days} today={today} />
    </section>
  )
}

/** One line on how the week goes: behind the plan, on it (and what is left), or what it holds before it starts. */
function WeekNote({ days, today }: { days: Dash['week_days']; today: string }) {
  const past = days.filter((x) => x.date < today)
  const owed = past.reduce((a, x) => a + x.planned, 0), did = past.reduce((a, x) => a + x.minutes, 0)
  const left = days.filter((x) => x.date >= today).reduce((a, x) => a + Math.max(0, x.planned - (x.date === today ? x.minutes : 0)), 0)
  const studyDays = days.filter((x) => x.study).length
  const [text, tone] = owed - did > 30 ? [tr('{h} behind the plan this week', { h: fmtMin(owed - did) }), 'warn']
    : did > 0 || days.some((x) => x.minutes > 0) ? [left > 0 ? tr('On plan · {h} still to go this week', { h: fmtMin(left) }) : tr('The week’s plan is done'), 'pos']
      : [tr('{n} study days this week · {h} planned', { n: studyDays, h: fmtHours(days.reduce((a, x) => a + x.planned, 0)) }), '']
  return <p className={'tile-note ' + tone}><i aria-hidden />{text}</p>
}

/** Units of a course: one cell each (passed green, the current one outlined), or one bar with a mark past 20 units. */
function Units({ a, b }: { a: number; b: number }) {
  if (b > 20) {
    return <span className="units bar" aria-hidden><i style={{ width: `${(a / b) * 100}%` }} /><b style={{ left: `${(a / b) * 100}%`, width: `max(6px, ${100 / b}%)` }} /></span>
  }
  return <span className="units" aria-hidden>{Array.from({ length: b }, (_, i) => <i key={i} className={i < a ? 'on' : i === a ? 'cur' : ''} />)}</span>
}

const SHOW = 4

function Courses({ d, ctx }: { d: Dash; ctx: Ctx }) {
  const rows = [
    ...d.tracks.map((x) => ({ key: x.key, label: x.label, a: x.passed, b: x.total, now: x.current })),
    ...(d.khan_total ? [{ key: 'khan', label: 'Khan Algebra 1', a: d.khan_passed, b: d.khan_total, now: d.khan_current?.name ?? null }] : []),
    ...(d.beej_total ? [{ key: 'beej', label: 'Beej C', a: d.beej_done, b: d.beej_total, now: null }] : []),
  ]
  const a = rows.reduce((s, r) => s + r.a, 0), b = rows.reduce((s, r) => s + r.b, 0)
  return (
    <section className="tile" aria-label={tr('Courses')}>
      <header className="tile-h"><h2>{tr('Courses')}</h2><span>{a ? tr('{a} of {b} units', { a, b }) : tr('{n} units', { n: b })}</span></header>
      <ul className="crs">
        {rows.slice(0, SHOW).map((r) => (
          <li key={r.key}>
            <div className="crs-top"><span className="crs-n">{r.label}</span><span className="crs-v">{tr('{a} of {b} passed', { a: r.a, b: r.b })}</span></div>
            <Units a={r.a} b={r.b} />
            {r.now && <span className="crs-now">{tr('now · {unit}', { unit: r.now })}</span>}
          </li>
        ))}
      </ul>
      {rows.length > SHOW && <button type="button" className="tile-more" onClick={() => ctx.go({ kind: 'progress' })}>{tr('All {n} courses', { n: rows.length })}<ChevronRight size={13} strokeWidth={1.7} /></button>}
    </section>
  )
}

function DateChip({ date, tone }: { date: string; tone?: string }) {
  const [, m, dd] = date.split('-').map(Number)
  return <span className={'dchip' + (tone ? ' ' + tone : '')} aria-hidden><small>{MONTHS[m - 1].slice(0, 3)}</small><b>{dd}</b></span>
}

function ComingUp({ d, ctx }: { d: Dash; ctx: Ctx }) {
  const today = ctx.todayDate
  const days = (n: number) => n === 0 ? tr('today') : n === 1 ? tr('tomorrow') : tr('in {n} days', { n })
  type Item = { key: string; date: string; title: string; sub: string; right?: string; tone?: string; go?: () => void }
  const items: Item[] = []
  const nextDay = (d.week_days ?? []).find((x) => x.date > today && x.study)
  if (nextDay) items.push({ key: 'next', date: nextDay.date, title: tr('Next study day'), sub: `${weekday(nextDay.date)} · ${fmtMin(nextDay.planned)}` })
  for (const e of d.exams ?? []) items.push({ key: 'x' + e.key, date: e.date, title: tr('{x} exam', { x: e.label }), sub: days(e.days), right: e.days <= 1 ? undefined : `${e.days} ${unit().d}`, tone: e.days <= 14 ? 'warn' : undefined })
  if (d.last_test) {
    const pct = d.last_test.max ? Math.round((d.last_test.score / d.last_test.max) * 100) : 0
    items.push({ key: 'test', date: d.last_test.date, title: tr('Last end-of-day test'), sub: tr('{n}% right', { n: pct }), right: `${d.last_test.score}/${d.last_test.max}`,
      tone: pct >= 70 ? 'pos' : pct < 50 ? 'warn' : undefined, go: () => ctx.go({ kind: 'test', id: d.last_test!.id }) })
  }
  // the dates first in time order, the last test after them
  const shown = items.slice(0, 3)
  const noExams = !(d.exams ?? []).length && ctx.meta?.plan?.key === 'custom'
  return (
    <section className="tile" aria-label={tr('Coming up')}>
      <header className="tile-h"><h2>{tr('Coming up')}</h2></header>
      {shown.length === 0 && !noExams && <p className="lv-empty">{tr('Nothing scheduled this week.')}</p>}
      <ul className="up">
        {shown.map((it) => {
          const body = <><DateChip date={it.date} tone={it.tone} /><span className="up-t"><b>{it.title}</b><small>{it.sub}</small></span>{it.right && <span className={'up-r ' + (it.tone ?? '')}>{it.right}</span>}</>
          return <li key={it.key}>{it.go ? <button type="button" onClick={it.go}>{body}</button> : <div>{body}</div>}</li>
        })}
      </ul>
      {noExams && <button type="button" className="tile-add" onClick={() => ctx.go({ kind: 'settings', section: 'plan' })}><Plus size={14} strokeWidth={1.8} />{tr('Add exam dates')}</button>}
      {items.length > 3 && <button type="button" className="tile-more" onClick={() => ctx.go({ kind: 'calendar' })}>{tr('Calendar · {n} more', { n: items.length - 3 })}<ChevronRight size={13} strokeWidth={1.7} /></button>}
    </section>
  )
}
