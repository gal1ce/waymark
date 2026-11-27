import { t as tr } from './i18n'
import { ArrowRight, Check, ChevronRight, Play } from 'lucide-react'
import { api, blockTitle, fmtDate, fmtHours, fmtMin, weekday, weekNo, type Dashboard as Dash } from './api'
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
        <div className="lv-cols">
          <Week d={d} today={ctx.todayDate} />
          <Courses d={d} />
          <ComingUp d={d} ctx={ctx} />
        </div>
      )}
      <Sec title={tr('Open sticking points')} meta={d ? String(d.stuck.length) : undefined}>
        <StuckList items={d?.stuck ?? []} canEdit={false} current={null} ctx={ctx} showDate />
      </Sec>
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

function Week({ d, today }: { d: Dash; today: string }) {
  const top = Math.max(60, ...(d.week_days ?? []).map((x) => Math.max(x.planned, x.minutes)))
  return (
    <Sec title={tr('This week')} meta={tr('target {h}', { h: fmtHours(d.week_target_min) })}>
      <div className="lv-fig"><b>{fmtHours(d.week_minutes)}</b><span>{tr('studied')}</span></div>
      <div className="wk-bars" role="list" aria-label={tr('Study time by day')}>
        {(d.week_days ?? []).map((x) => (
          <div key={x.date} role="listitem" className={'wk-day' + (x.date === today ? ' today' : '') + (x.study ? '' : ' off')}
            title={`${weekday(x.date)} · ${fmtMin(x.minutes)}${x.planned ? ' / ' + fmtMin(x.planned) : ''}`}>
            <span className="wk-col">
              <i className="wk-plan" style={{ height: `${(x.planned / top) * 100}%` }} />
              <i className="wk-done" style={{ height: `${(Math.min(x.minutes, top) / top) * 100}%` }} />
            </span>
            <span className="wk-l">{weekday(x.date, true)}</span>
          </div>
        ))}
      </div>
    </Sec>
  )
}

function Courses({ d }: { d: Dash }) {
  const rows = [
    ...d.tracks.map((x) => ({ key: x.key, label: x.label, a: x.passed, b: x.total, now: x.current })),
    ...(d.khan_total ? [{ key: 'khan', label: 'Khan Algebra 1', a: d.khan_passed, b: d.khan_total, now: d.khan_current?.name ?? null }] : []),
    ...(d.beej_total ? [{ key: 'beej', label: 'Beej C', a: d.beej_done, b: d.beej_total, now: null }] : []),
  ]
  const a = rows.reduce((s, r) => s + r.a, 0), b = rows.reduce((s, r) => s + r.b, 0)
  return (
    <Sec title={tr('Courses')} meta={tr('units passed')}>
      <div className="lv-fig"><b>{a} / {b}</b><span>{tr('units')}</span></div>
      <ul className="crs">
        {rows.map((r) => (
          <li key={r.key} title={r.now ? tr('now: {unit}', { unit: r.now }) : undefined}>
            <span className="crs-n">{r.label}</span>
            <Meter value={r.b ? r.a / r.b : 0} label={r.label} />
            <span className="crs-v">{r.a}/{r.b}</span>
          </li>
        ))}
      </ul>
    </Sec>
  )
}

function ComingUp({ d, ctx }: { d: Dash; ctx: Ctx }) {
  const [first, ...rest] = d.exams ?? []
  const days = (n: number) => n === 0 ? tr('today') : n === 1 ? tr('tomorrow') : tr('{n} days', { n })
  return (
    <Sec title={tr('Coming up')}>
      {first
        ? <div className="lv-fig"><b>{days(first.days)}</b><span>{tr('to the {x} exam', { x: first.label })} · {fmtDate(first.date)}</span></div>
        : d.last_test
          ? <div className="lv-fig"><b>{d.last_test.score}/{d.last_test.max}</b><span>{tr('last end-of-day test')}</span></div>
          : <p className="lv-empty">{tr('No exam dates yet. Add them in Settings → Plan.')}</p>}
      <ul className="lv-rows">
        {rest.map((e) => <li key={e.key}><span>{tr('{x} exam', { x: e.label })} · {fmtDate(e.date)}</span><span className="lv-rv">{days(e.days)}</span></li>)}
        {first && d.last_test && (
          <li><button type="button" className="linkish" onClick={() => ctx.go({ kind: 'test', id: d.last_test!.id })}>{tr('Last end-of-day test')} · {fmtDate(d.last_test.date)}</button>
            <span className="lv-rv">{d.last_test.score}/{d.last_test.max}<ChevronRight size={13} strokeWidth={1.6} /></span></li>
        )}
      </ul>
    </Sec>
  )
}
