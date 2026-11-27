import { t as tr } from './i18n'
import { ArrowRight, Check, ChevronRight, Play } from 'lucide-react'
import { api, fmtDate, fmtDur, fmtHours, fmtMin, weekday, weekNo } from './api'
import type { Ctx } from './App'
import { StartNow, StuckList } from './DayView'
import { KIND_LABEL, PageHead, useLoad } from './ui'
import { busyProps, useBusy } from './interact'
import { Group, Row } from './settingsui'

/** Home: what to do now, how the week goes, what is open. The day itself lives on Today, the year on Profile. */
export default function Dashboard({ ctx }: { ctx: Ctx }) {
  const d = useLoad(() => api.dashboard(), [ctx.version])
  const day = ctx.today
  const tasks = (day?.blocks ?? []).flatMap((b) => b.tasks)
  const done = tasks.filter((t) => t.status === 'done').length
  const current = tasks.find((t) => t.status === 'doing') ?? tasks.find((t) => t.status === 'todo') ?? null
  const open = day && day.exists && day.status === 'active'
  const preStart = !!ctx.ov && ctx.ov.today < ctx.ov.start_date
  const [busy, run] = useBusy()
  const later = tasks.filter((t) => t.status === 'todo' && t.id !== current?.id).slice(0, 3)
  const spent = tasks.reduce((a, t) => a + t.spent_sec_live, 0)
  const planned = tasks.reduce((a, t) => a + t.est_min, 0)
  const go = () => run(async () => {
    if (current && current.status === 'todo') await ctx.run(api.task(current.id, 'start'))
    ctx.refresh(); ctx.go({ kind: 'day', date: ctx.todayDate })
  })
  const toToday = () => ctx.go({ kind: 'day', date: ctx.todayDate })
  const weekPct = d && d.week_target_min ? Math.min(1, d.week_minutes / d.week_target_min) : 0

  return (
    <div className="page day-page">
      <PageHead
        title={day ? `${weekday(day.date)}, ${fmtDate(day.date)}` : tr('Overview')}
        sub={d ? <>{tr('Week {n}', { n: weekNo(d.week) })}{day && day.status === 'off' ? ` · ${tr('no study today')}` : preStart ? ` · ${tr('starts {date}', { date: fmtDate(ctx.ov!.start_date) })}` : ''}</> : null} />

      <Group title={tr('Today')}
        note={open ? <>{tr('{a} of {b} tasks done', { a: done, b: tasks.length })} · {fmtDur(spent)} / {fmtMin(planned)}</> : undefined}
        action={<button type="button" className="btn ghost sm" onClick={toToday}><span>{tr('Today\'s plan')}</span><ArrowRight size={14} strokeWidth={1.6} /></button>}>
        {open && current ? (
          <>
            <Row label={<span className="home-next">
              <span className="k">{current.status === 'doing' ? tr('In progress') : tr('Up next')} · {KIND_LABEL[current.kind] ?? current.kind} · {fmtMin(current.est_min)}</span>
              <span className="tt">{current.title}</span>
            </span>}>
              <button className="btn primary" autoFocus {...busyProps(busy)} onClick={go}>
                {current.status === 'doing' ? <>{tr('Continue')}<ArrowRight size={15} strokeWidth={1.8} /></> : <><Play size={14} strokeWidth={1.7} />{tr('Start')}</>}</button>
            </Row>
            {later.length > 0 && (
              <ol className="home-later" aria-label={tr('After that')}>
                {later.map((t, i) => <li key={t.id}><span className="mono">{i + 2}</span><span>{t.title}</span><span className="mono">{fmtMin(t.est_min)}</span></li>)}
              </ol>
            )}
          </>
        ) : (
          <Row label={open ? <><Check size={15} strokeWidth={2} className="pos" /> {tr('All {n} tasks done.', { n: tasks.length })}</>
              : preStart ? tr('The plan starts {day} {date}.', { day: weekday(ctx.ov!.start_date), date: fmtDate(ctx.ov!.start_date) })
                : day?.status === 'off' ? tr('A day off.') : tr('No open day for today')}
            hint={open ? tr("Close the day on Today when you're ready") : preStart ? tr('Days stay locked until then') : day?.status === 'off' ? tr('No study today, the next day opens in the morning') : undefined}>
            {preStart ? <StartNow ctx={ctx} /> : undefined}
          </Row>
        )}
      </Group>

      {d && (
        <Group title={tr('This week')}>
          <Row label={tr('Study time')} hint={tr('target {h}', { h: fmtHours(d.week_target_min) })}>
            <span className="home-v">
              <span className="sr-v mono">{fmtHours(d.week_minutes)}</span>
              <span className="thin-bar" aria-hidden><span style={{ display: 'block', height: '100%', width: `${weekPct * 100}%`, background: 'var(--t2)', borderRadius: 2 }} /></span>
            </span>
          </Row>
          {d.tracks.map((x) => (
            <Row key={x.key} label={x.label} hint={x.current ? tr('now: {unit}', { unit: x.current }) : tr('units passed')}>
              <span className="sr-v mono">{x.passed}/{x.total}</span>
            </Row>
          ))}
          {d.khan_total > 0 && <Row label="Khan Algebra 1" hint={d.khan_current ? tr('now: {unit}', { unit: d.khan_current.name }) : tr('unit test passes at 90%')}><span className="sr-v mono">{d.khan_passed}/{d.khan_total}</span></Row>}
          {d.beej_total > 0 && <Row label="Beej C" hint={tr('chapters')}><span className="sr-v mono">{d.beej_done}/{d.beej_total}</span></Row>}
          <Row label={tr('Last end-of-day test')} hint={d.last_test ? fmtDate(d.last_test.date) : tr('none yet')}>
            {d.last_test
              ? <button type="button" className="btn ghost sm" onClick={() => ctx.go({ kind: 'test', id: d.last_test!.id })}><span className="mono">{d.last_test.score}/{d.last_test.max}</span><ChevronRight size={14} strokeWidth={1.6} /></button>
              : <span className="sr-v">–</span>}
          </Row>
        </Group>
      )}

      <Group title={tr('Open sticking points')} note={d && d.stuck.length ? tr('{n} open', { n: d.stuck.length }) : undefined}>
        <StuckList items={d?.stuck ?? []} canEdit={false} current={null} ctx={ctx} showDate />
      </Group>
    </div>
  )
}
