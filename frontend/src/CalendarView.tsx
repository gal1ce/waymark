import { dayShort, t as tr, tx } from './i18n'
import { ChevronLeft, ChevronRight, Flag, GraduationCap, Lock } from 'lucide-react'
import { api, canPeek, fmtHours, MONTHS, weekNo, type CalDay } from './api'
import type { Ctx } from './App'
import { PageHead, useLoad } from './ui'

const HEAD = [1, 2, 3, 4, 5, 6, 0]   // Monday first; weekday numbers with Sunday 0
const shift = (m: string, n: number) => {
  const [y, mo] = m.split('-').map(Number)
  const d = new Date(y, mo - 1 + n, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
// read through tx() when shown, so they follow the interface language
const STATUS: Record<CalDay['status'], string> = {
  active: 'today', closed: 'closed', past: 'past, not closed', locked: 'locked', off: 'no study', before: 'before the plan',
}

export default function CalendarView({ month, ctx }: { month?: string; ctx: Ctx }) {
  const m = month ?? (ctx.todayDate || new Date().toISOString()).slice(0, 7)
  const cal = useLoad(() => api.calendar(m), [m, ctx.version])
  const [y, mo] = m.split('-').map(Number)
  const lead = cal ? (new Date(cal.days[0].date + 'T12:00:00').getDay() + 6) % 7 : 0
  const startMonth = ctx.ov?.start_date.slice(0, 7)

  // the plan's days off, from the month itself (whatever weekdays this plan rests on)
  const offDays = [...new Set((cal?.days ?? []).filter((d) => d.status === 'off').map((d) => new Date(d.date + 'T12:00:00').getDay()))]
    .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
  const s = cal?.days.reduce((a, d) => ({ min: a.min + d.minutes, closed: a.closed + (d.status === 'closed' ? 1 : 0), study: a.study + (d.exists ? 1 : 0) }), { min: 0, closed: 0, study: 0 })

  return (
    <div className="page wide">
      <PageHead title={`${MONTHS[mo - 1]} ${y}`}
        sub={s ? <>{tr('{n} study days', { n: s.study })} · {tr('{n} closed', { n: s.closed })} · {fmtHours(s.min)}</> : null}
        right={
          <div className="seg">
            <button className="icon-btn" disabled={!!startMonth && m <= startMonth} onClick={() => ctx.go({ kind: 'calendar', month: shift(m, -1) })} aria-label={tr('Previous month')}><ChevronLeft size={16} strokeWidth={1.5} /></button>
            <button className="btn ghost sm" onClick={() => ctx.go({ kind: 'calendar' })}>{tr('This month')}</button>
            <button className="icon-btn" onClick={() => ctx.go({ kind: 'calendar', month: shift(m, 1) })} aria-label={tr('Next month')}><ChevronRight size={16} strokeWidth={1.5} /></button>
          </div>
        } />

      <div className="cal-legend">
        <span><i className="sw active" />{tr('today')}</span><span><i className="sw closed" />{tr('closed')}</span>
        <span><i className="sw past" />{tr('past, not closed')}</span><span><i className="sw locked" />{tr('locked')}</span>
        {cal?.end && <span><Flag size={11} strokeWidth={1.6} className="t3" />{tr('last unit (projected)')}</span>}
        {cal?.deadline && <span><Flag size={11} strokeWidth={1.8} className="cal-dl" />{tr('deadline')}</span>}
        {Object.keys(cal?.exams ?? {}).length > 0 && <span><GraduationCap size={11} strokeWidth={1.8} className="cal-dl" />{tr('exam')}</span>}
        {offDays.length > 0 && <span><i className="sw off" />{tr('days off: {days}', { days: offDays.map(dayShort).join(', ') })}</span>}
      </div>

      <div className="cal card">
        {HEAD.map((h) => <div key={h} className={'cal-h' + (offDays.includes(h) ? ' off' : '')}>{dayShort(h)}</div>)}
        {Array.from({ length: lead }, (_, i) => <div key={'x' + i} className="cal-cell blank" />)}
        {cal?.days.map((d) => {
          // a day off from today on opens too (a plan of the user's own): study can be added on it there
          const addable = d.status === 'off' && ctx.meta?.plan?.key === 'custom' && d.date >= ctx.todayDate && (!ctx.ov || d.date >= ctx.ov.start_date)
          const can = addable || d.status === 'active' || d.status === 'closed' || d.status === 'past' || (d.status === 'locked' && canPeek(ctx.meta?.plan?.key, ctx.todayDate, d.date))
          const tip = `${d.date} · ${tx(STATUS[d.status])}` + (addable ? ` · ${tr('open it to add study on this day')}` : '') + (cal?.exams?.[d.date] ? ` · ${tr('{c} exam', { c: cal.exams[d.date] })}` : '') + (cal?.deadline === d.date ? ` · ${tr('deadline')}` : '') + (cal?.end === d.date ? ` · ${tr('last unit (projected)')}` : '')
          const body = (
            <>
              <div className="cal-top">
                <span className="cal-n mono">{Number(d.date.slice(8))}</span>
                {d.status === 'active' && <span className="now-tag">{tr('today')}</span>}
                {d.status === 'locked' && <Lock size={12} strokeWidth={1.5} className="t3" />}
                {d.week != null && new Date(d.date + 'T12:00:00').getDay() === 1 && <span className="cal-w">{tr('W{n}', { n: weekNo(d.week) })}</span>}
              </div>
              {cal?.exams?.[d.date] && <span className="cal-meta cal-dl"><GraduationCap size={11} strokeWidth={1.8} /> {tr('{c} exam', { c: cal.exams[d.date] })}</span>}
              {cal?.deadline === d.date && !cal?.exams?.[d.date] && <span className="cal-meta cal-dl"><Flag size={11} strokeWidth={1.8} /> {tr('deadline')}</span>}
              {cal?.end === d.date && <span className="cal-meta"><Flag size={11} strokeWidth={1.6} /> {tr('last unit')}</span>}
              {d.exists && d.status !== 'off' && (
                <div className="cal-body">
                  {d.total > 0 && (
                    <>
                      <div className="cal-bar"><div style={{ width: `${(d.done / d.total) * 100}%` }} /></div>
                      <span className="cal-meta"><b>{d.done}/{d.total}</b> {tr('tasks')}{d.minutes > 0 && <> · {fmtHours(d.minutes)}</>}</span>
                    </>
                  )}
                  {d.test && <span className="cal-meta">{tr('test')} <b>{d.test.score}/{d.test.max}</b></span>}
                  {d.stuck > 0 && <span className="cal-meta">{tr('{n} stuck', { n: d.stuck })}</span>}
                </div>
              )}
            </>
          )
          return can
            ? <button key={d.date} className={`cal-cell ${d.status}`} title={tip} onClick={() => ctx.go({ kind: 'day', date: d.date })}>{body}</button>
            : <div key={d.date} className={`cal-cell ${d.status}`} title={tip} aria-disabled>{body}</div>
        })}
        {cal && Array.from({ length: (7 - ((lead + cal.days.length) % 7)) % 7 }, (_, i) => <div key={'y' + i} className="cal-cell blank" />)}
      </div>
    </div>
  )
}
