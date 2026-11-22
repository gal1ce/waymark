import { t as tr } from './i18n'
import { ArrowRight, Check, Play } from 'lucide-react'
import { api, fmtDate, fmtHours, fmtMin, weekday, weekNo } from './api'
import type { Ctx } from './App'
import { StuckList } from './DayView'
import { Fig, KIND_LABEL, PageHead, Section, useLoad } from './ui'
import { busyProps, useBusy } from './interact'

/** Short summary. The full day lives on Today, the year graph on Profile. */
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
  const go = () => run(async () => {
    if (current && current.status === 'todo') await ctx.run(api.task(current.id, 'start'))
    ctx.refresh(); ctx.go({ kind: 'day', date: ctx.todayDate })
  })

  return (
    <div className="page">
      <PageHead
        title={day ? `${weekday(day.date)}, ${fmtDate(day.date)}` : tr('Overview')}
        sub={d ? <>{tr('Week {n}', { n: weekNo(d.week) })}{day && day.status === 'off' ? ` · ${tr('no study today')}` : preStart ? ` · ${tr('starts {date}', { date: fmtDate(ctx.ov!.start_date) })}` : ''}</> : null}
        right={<button className="btn ghost" onClick={() => ctx.go({ kind: 'day', date: ctx.todayDate })}>{tr('Today\'s plan')}<ArrowRight size={14} strokeWidth={1.5} /></button>} />

      {open && current ? (
        <section className="upnext-hero card">
          <div className="uh-prog" aria-label={tr('{a} of {b} tasks done', { a: done, b: tasks.length })}>
            <div className="uh-bar"><span style={{ width: `${tasks.length ? (done / tasks.length) * 100 : 0}%` }} /></div>
            <span className="mono">{done}/{tasks.length}</span>
          </div>
          <div className="uh-main">
            <div className="uh-b">
              <div className="uh-k">{current.status === 'doing' ? tr('In progress') : tr('Up next')} · {KIND_LABEL[current.kind] ?? current.kind} · {fmtMin(current.est_min)}</div>
              <h2 className="uh-t">{current.title}</h2>
            </div>
            <button className="btn primary lg" autoFocus {...busyProps(busy)} onClick={go}>
              {current.status === 'doing' ? <>{tr('Continue')}<ArrowRight size={16} strokeWidth={1.8} /></> : <><Play size={15} strokeWidth={1.7} />{tr('Start')}</>}<kbd>↵</kbd></button>
          </div>
          {later.length > 0 && (
            <ol className="uh-later">
              {later.map((t, i) => (
                <li key={t.id}><span className="uh-n">{i + 2}</span><span className="uh-lt">{t.title}</span><span className="t3 mono">{fmtMin(t.est_min)}</span></li>
              ))}
            </ol>
          )}
        </section>
      ) : (
        <p className="lede">
          {open ? <><Check size={16} strokeWidth={2} className="pos" /> <b>{tr('All {n} tasks done.', { n: tasks.length })}</b> {tr("Close the day on Today when you're ready")}</>
            : preStart ? <><b>{tr('The plan starts {day} {date}.', { day: weekday(ctx.ov!.start_date), date: fmtDate(ctx.ov!.start_date) })}</b> {tr('Days stay locked until then')}</>
              : day?.status === 'off' ? <><b>{tr('A day off.')}</b> {tr('No study today, the next day opens in the morning')}</>
                : <>{tr('No open day for today')}</>}
        </p>
      )}

      {d && (
        <div className="figures">
          <Fig label={tr('This week')} value={fmtHours(d.week_minutes)} note={tr('target {h}', { h: fmtHours(d.week_target_min) })} />
          {d.khan_total > 0 && <Fig label="Khan Algebra 1" value={<>{d.khan_passed}<small>/{d.khan_total}</small></>}
            note={d.khan_current ? tr('now: {unit}', { unit: d.khan_current.name }) : tr('unit test passes at 90%')} />}
          {d.beej_total > 0 && <Fig label="Beej C" value={<>{d.beej_done}<small>/{d.beej_total}</small></>} note={tr('chapters')} />}
          {d.tracks.slice(0, 3).map((x) => (
            <Fig key={x.key} label={x.label} value={<>{x.passed}<small>/{x.total}</small></>}
              note={x.current ? tr('now: {unit}', { unit: x.current }) : tr('units passed')} />
          ))}
        </div>
      )}

      <div className="two-col">
        <Section title={tr('Open sticking points')} meta={d ? d.stuck.length : undefined}>
          <StuckList items={d?.stuck ?? []} canEdit={false} current={null} ctx={ctx} showDate />
        </Section>
        <Section title={tr('Last end-of-day test')}>
          {d?.last_test
            ? <button className="row-link" onClick={() => ctx.go({ kind: 'test', id: d.last_test!.id })}>
                <span>{fmtDate(d.last_test.date)}</span><b className="mono">{d.last_test.score}/{d.last_test.max}</b><ArrowRight size={14} strokeWidth={1.5} />
              </button>
            : <div className="empty">{tr('No tests yet. Each day ends with a closed-book test')}</div>}
        </Section>
      </div>
    </div>
  )
}
