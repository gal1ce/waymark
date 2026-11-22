import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, Clock } from 'lucide-react'
import { addDays, fromMin, fromUtc, iso, longDate, monthLabel, pad, parts, toMin, weekdayMon } from './dates'
import { dayShort, MONTHS, t } from './i18n'

/* The app's own controls. Nothing here is the browser's: no <input type=date|time|month|range|checkbox|color>, no
   <select>. (Tooltips are Tip.tsx.) Each one is drawn from the app's tokens, works with the keyboard and says what it is
   to a screen reader (role, aria-checked / aria-valuenow / aria-selected). Popovers render into <body> so a card
   that clips or animates never cuts them off. */

// ------------------------------------------------------------------ popover
/** A panel under (or, without room, above) its anchor. Closes on Escape, outside press; follows scroll and resize. */
export function Popover({ anchor, open, onClose, label, className = '', children }: {
  anchor: RefObject<HTMLElement | null>; open: boolean; onClose: () => void; label: string; className?: string; children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  useEffect(() => { close.current = onClose })
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const a = anchor.current, p = ref.current
      if (!a || !p) return
      const r = a.getBoundingClientRect(), w = p.offsetWidth, h = p.offsetHeight
      const vw = window.innerWidth, vh = window.innerHeight
      const below = vh - r.bottom - 8, above = r.top - 8
      const up = h + 6 > below && above > below
      p.style.top = `${up ? Math.max(8, r.top - 6 - h) : Math.max(8, Math.min(vh - 8 - h, r.bottom + 6))}px`
      p.style.left = `${Math.min(Math.max(8, r.left), vw - 8 - w)}px`
      p.style.transformOrigin = up ? 'bottom left' : 'top left'
      p.style.setProperty('--anchor-w', `${r.width}px`)
    }
    place()
    const down = (e: PointerEvent) => {
      const tg = e.target as Node
      if (!ref.current?.contains(tg) && !anchor.current?.contains(tg)) close.current()
    }
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close.current(); anchor.current?.focus() }
    }
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    document.addEventListener('pointerdown', down, true)
    document.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      document.removeEventListener('pointerdown', down, true)
      document.removeEventListener('keydown', key, true)
    }
  }, [open, anchor])
  if (!open) return null
  return createPortal(<div ref={ref} className={'ctl-pop ' + className} role="dialog" aria-label={label}>{children}</div>, document.body)
}

// ------------------------------------------------------------------ checkbox and switch
export function Checkbox({ checked, onChange, children, disabled, className = '' }: {
  checked: boolean; onChange: (v: boolean) => void; children?: ReactNode; disabled?: boolean; className?: string
}) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} disabled={disabled} className={'cbx' + (checked ? ' on' : '') + (className ? ' ' + className : '')}
      onClick={() => onChange(!checked)}>
      <span className="cbx-box" aria-hidden><Check size={12} strokeWidth={2.8} /></span>
      {children != null && <span className="cbx-l">{children}</span>}
    </button>
  )
}

export function Switch({ checked, onChange, children, disabled }: { checked: boolean; onChange: (v: boolean) => void; children?: ReactNode; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} disabled={disabled} className={'swt' + (checked ? ' on' : '')} onClick={() => onChange(!checked)}>
      <span className="swt-track" aria-hidden><span className="swt-knob" /></span>
      {children != null && <span className="swt-l">{children}</span>}
    </button>
  )
}

// ------------------------------------------------------------------ slider
/** A stretch of road: the travelled part in ink, the centre line dashed, the thumb a road marker. */
export function Slider({ value, min, max, step = 1, onChange, label, valueText, ticks, className = '', style }: {
  value: number; min: number; max: number; step?: number; onChange: (v: number) => void; label: string
  valueText?: string; ticks?: { at: number; label: string }[]; className?: string; style?: CSSProperties
}) {
  const ref = useRef<HTMLDivElement>(null)
  const span = max - min || 1
  const snap = (v: number) => {
    const n = Math.round((v - min) / step) * step + min
    return Math.min(max, Math.max(min, +n.toFixed(6)))
  }
  const fromX = (x: number) => {
    const r = ref.current!.getBoundingClientRect()
    return snap(min + ((x - r.left) / Math.max(1, r.width)) * span)
  }
  const pct = Math.min(100, Math.max(0, ((value - min) / span) * 100))
  const key = (e: KeyboardEvent) => {
    const big = Math.max(step, (max - min) / 10)
    const n = { ArrowRight: value + step, ArrowUp: value + step, ArrowLeft: value - step, ArrowDown: value - step,
      PageUp: value + big, PageDown: value - big, Home: min, End: max }[e.key]
    if (n === undefined) return
    e.preventDefault()
    const v = snap(n)
    if (v !== value) onChange(v)
  }
  return (
    <div className={'sld-wrap' + (className ? ' ' + className : '')} style={style}>
      <div ref={ref} className="sld" role="slider" tabIndex={0} aria-label={label} aria-valuemin={min} aria-valuemax={max} aria-valuenow={value}
        aria-valuetext={valueText} style={{ '--p': `${pct}%` } as CSSProperties} onKeyDown={key}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.preventDefault()
          e.currentTarget.focus()
          e.currentTarget.setPointerCapture(e.pointerId)
          const v = fromX(e.clientX)
          if (v !== value) onChange(v)
        }}
        onPointerMove={(e) => {
          if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
          const v = fromX(e.clientX)
          if (v !== value) onChange(v)
        }}>
        <span className="sld-track" aria-hidden><span className="sld-fill" /></span>
        <span className="sld-thumb" aria-hidden />
      </div>
      {ticks && (
        <div className="sld-ticks" aria-hidden>
          {ticks.map((k) => <span key={k.at} className={k.at === value ? 'on' : ''} style={{ left: `${((k.at - min) / span) * 100}%` }}>{k.label}</span>)}
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ select
export type Opt<V> = { value: V; label: ReactNode; text?: string; hint?: ReactNode }

/** A button that opens a list. Arrow keys move, Enter picks, typing a letter jumps to the option it starts. */
export function Select<V extends string | number>({ value, options, onChange, label, placeholder, className = '', disabled, size }: {
  value: V | null | undefined; options: Opt<V>[]; onChange: (v: V) => void; label: string; placeholder?: string
  className?: string; disabled?: boolean; size?: 'sm' | 'lg'
}) {
  const btn = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [act, setAct] = useState(0)
  const cur = options.findIndex((o) => o.value === value)
  const show = () => { setAct(Math.max(0, cur)); setOpen(true) }
  useEffect(() => { if (open) list.current?.focus() }, [open])
  useEffect(() => { if (open) list.current?.querySelector(`[data-i="${act}"]`)?.scrollIntoView({ block: 'nearest' }) }, [open, act])
  const pick = (i: number) => { const o = options[i]; if (o) onChange(o.value); setOpen(false); btn.current?.focus() }
  const key = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setAct((a) => Math.min(options.length - 1, a + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAct((a) => Math.max(0, a - 1)) }
    else if (e.key === 'Home') { e.preventDefault(); setAct(0) }
    else if (e.key === 'End') { e.preventDefault(); setAct(options.length - 1) }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(act) }
    else if (e.key === 'Tab') setOpen(false)
    else if (e.key.length === 1) {
      const ch = e.key.toLocaleLowerCase()
      const n = options.length
      for (let k = 1; k <= n; k++) {
        const i = (act + k) % n
        const txt = (options[i].text ?? String(options[i].label ?? '')).toLocaleLowerCase()
        if (txt.startsWith(ch)) { setAct(i); break }
      }
    }
  }
  const o = options[cur]
  return (
    <>
      <button ref={btn} type="button" className={'input ctl-field ctl-select' + (size ? ' ' + size : '') + (className ? ' ' + className : '')} disabled={disabled}
        aria-haspopup="listbox" aria-expanded={open} aria-label={label}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); show() } }}>
        <span className={'ctl-v' + (o ? '' : ' ph')}>{o ? o.label : placeholder ?? t('Choose')}</span>
        <ChevronDown size={15} strokeWidth={1.6} className="ctl-chev" />
      </button>
      <Popover anchor={btn} open={open} onClose={() => setOpen(false)} label={label} className="ctl-list-pop">
        <div ref={list} className="ctl-list" role="listbox" tabIndex={-1} aria-label={label} aria-activedescendant={open ? `opt-${act}` : undefined}
          onKeyDown={key}>
          {options.map((x, i) => (
            <div key={String(x.value)} id={`opt-${i}`} data-i={i} role="option" aria-selected={i === cur}
              className={'ctl-opt' + (i === act ? ' act' : '') + (i === cur ? ' sel' : '')}
              onPointerMove={() => { if (i !== act) setAct(i) }} onClick={() => pick(i)}>
              <span className="ctl-opt-l">{x.label}{x.hint && <span className="ctl-opt-h">{x.hint}</span>}</span>
              {i === cur && <Check size={14} strokeWidth={2} />}
            </div>
          ))}
        </div>
      </Popover>
    </>
  )
}

// ------------------------------------------------------------------ dates
/** A month of days, Monday first. Arrow keys walk the days, PageUp/PageDown the months. */
export function Calendar({ value, onChange, min, max, today }: { value: string; onChange: (d: string) => void; min?: string; max?: string; today?: string }) {
  const [focus, setFocus] = useState(() => value || today || min || fromUtc(new Date()))
  const [y, m] = parts(focus)
  const grid = useRef<HTMLDivElement>(null)
  const moved = useRef(false)
  useEffect(() => {
    if (!moved.current) return
    moved.current = false
    grid.current?.querySelector<HTMLButtonElement>(`[data-d="${focus}"]`)?.focus()
  }, [focus])
  const first = iso(y, m, 1)
  const start = addDays(first, -weekdayMon(first))
  const cells = Array.from({ length: 42 }, (_, i) => addDays(start, i))
  const rows = cells[35].slice(0, 7) === `${y}-${pad(m)}` ? 6 : 5
  const off = (d: string) => (!!min && d < min) || (!!max && d > max)
  const shiftMonth = (n: number) => {
    const d = new Date(Date.UTC(y, m - 1 + n, 1))
    const days = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
    setFocus(iso(d.getUTCFullYear(), d.getUTCMonth() + 1, Math.min(parts(focus)[2], days)))
  }
  const key = (e: KeyboardEvent) => {
    const n = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key]
    if (n !== undefined) { e.preventDefault(); moved.current = true; setFocus(addDays(focus, n)); return }
    if (e.key === 'PageUp' || e.key === 'PageDown') { e.preventDefault(); moved.current = true; shiftMonth(e.key === 'PageUp' ? -1 : 1); return }
    if (e.key === 'Home') { e.preventDefault(); moved.current = true; setFocus(addDays(focus, -weekdayMon(focus))); return }
    if (e.key === 'End') { e.preventDefault(); moved.current = true; setFocus(addDays(focus, 6 - weekdayMon(focus))) }
  }
  const prevOff = !!min && iso(y, m, 1) <= min
  const nextOff = !!max && addDays(iso(y, m, 1), 31).slice(0, 7) > max.slice(0, 7)
  return (
    <div className="dp">
      <div className="dp-h">
        <button type="button" className="icon-btn" disabled={prevOff} onClick={() => shiftMonth(-1)} aria-label={t('Previous month')}><ChevronLeft size={16} strokeWidth={1.6} /></button>
        <span className="dp-t" aria-live="polite">{MONTHS[m - 1]} <span className="mono">{y}</span></span>
        <button type="button" className="icon-btn" disabled={nextOff} onClick={() => shiftMonth(1)} aria-label={t('Next month')}><ChevronRight size={16} strokeWidth={1.6} /></button>
      </div>
      <div className="dp-g" role="grid" ref={grid} onKeyDown={key} aria-label={`${MONTHS[m - 1]} ${y}`}>
        <div className="dp-w" role="row">{[0, 1, 2, 3, 4, 5, 6].map((i) => <span key={i} role="columnheader">{dayShort((i + 1) % 7)}</span>)}</div>
        {Array.from({ length: rows }, (_, r) => (
          <div key={r} className="dp-r" role="row">
            {cells.slice(r * 7, r * 7 + 7).map((d) => {
              const out = d.slice(0, 7) !== `${y}-${pad(m)}`
              return (
                <button key={d} type="button" role="gridcell" data-d={d} tabIndex={d === focus ? 0 : -1} disabled={off(d)} aria-selected={d === value}
                  aria-label={longDate(d, true)}
                  className={'dp-d' + (out ? ' out' : '') + (d === value ? ' on' : '') + (d === today ? ' now' : '')}
                  onClick={() => { setFocus(d); onChange(d) }}>{parts(d)[2]}</button>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

type Seg = 'd' | 'm' | 'y'
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate()

/** A date typed or picked: day | month | year as three parts (the order of the interface language), each one
    written with the keyboard (digits, or the month's first letters) or stepped with the arrow keys; the calendar
    opens from the button at the end. A date before `min` is shown but marked, and not passed on. */
export function DateInput({ value, onChange, min, max, today, label, invalid }: {
  value: string; onChange: (d: string) => void; min?: string; max?: string; today?: string; label: string; invalid?: boolean
}) {
  const [draft, setDraft] = useState<{ d: number | null; m: number | null; y: number | null } | null>(null)
  const [open, setOpen] = useState(false)
  const typed = useRef('')
  const wrap = useRef<HTMLDivElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const [vy, vm, vd] = value ? parts(value) : [null, null, null]
  const cur = draft ?? { d: vd, m: vm, y: vy }
  const order: Seg[] = document.documentElement.lang === 'en' ? ['m', 'd', 'y'] : ['d', 'm', 'y']
  const base = today || min || fromUtc(new Date(0))
  const commit = (n: { d: number | null; m: number | null; y: number | null }) => {
    if (n.d && n.m && n.y && n.y >= 1000) {
      const d = iso(n.y, n.m, Math.min(n.d, daysIn(n.y, n.m)))
      setDraft(null)
      onChange(d)
    } else setDraft(n)
  }
  const focusSeg = (k: Seg) => wrap.current?.querySelector<HTMLElement>(`[data-seg="${k}"]`)?.focus()
  const step = (k: Seg, by: number) => {
    const [by0, bm0, bd0] = parts(base)
    const n = { ...cur }
    if (k === 'y') n.y = (n.y ?? by0) + by
    if (k === 'm') n.m = (((n.m ?? bm0) - 1 + by + 12) % 12) + 1
    if (k === 'd') { const lim = daysIn(n.y ?? by0, n.m ?? bm0); n.d = (((n.d ?? bd0) - 1 + by + lim) % lim) + 1 }
    commit({ d: n.d ?? bd0, m: n.m ?? bm0, y: n.y ?? by0 })
  }
  const key = (k: Seg, e: KeyboardEvent) => {
    const i = order.indexOf(k)
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); typed.current = ''; step(k, e.key === 'ArrowUp' ? 1 : -1); return }
    if (e.key === 'ArrowRight' && i < 2) { e.preventDefault(); typed.current = ''; focusSeg(order[i + 1]); return }
    if (e.key === 'ArrowLeft' && i > 0) { e.preventDefault(); typed.current = ''; focusSeg(order[i - 1]); return }
    if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); typed.current = ''; setDraft({ ...cur, [k]: null }); return }
    if (/^\d$/.test(e.key)) {
      e.preventDefault()
      const t2 = (typed.current + e.key).slice(k === 'y' ? -4 : -2)
      typed.current = t2
      const n = Number(t2)
      const lim = k === 'd' ? 31 : k === 'm' ? 12 : 9999
      const v = Math.min(lim, n)
      const next = { ...cur, [k]: v || null }
      const done = k === 'y' ? t2.length === 4 : t2.length === 2 || n * 10 > lim
      if (done) { typed.current = ''; commit(next); if (i < 2) focusSeg(order[i + 1]) } else setDraft(next)
      return
    }
    if (k === 'm' && /^\p{L}$/u.test(e.key)) {
      e.preventDefault()
      const t2 = (typed.current + e.key).toLocaleLowerCase()
      const hit = MONTHS.findIndex((x) => x.toLocaleLowerCase().startsWith(t2))
      if (hit >= 0) { typed.current = t2; commit({ ...cur, m: hit + 1 }) } else typed.current = ''
    }
  }
  const out = !!value && ((!!min && value < min) || (!!max && value > max))
  const seg = (k: Seg) => {
    const v = cur[k]
    const text = v == null ? { d: t('dd'), m: t('month'), y: t('yyyy') }[k] : k === 'm' ? MONTHS[v - 1] : k === 'd' ? pad(v) : String(v)
    return (
      <span key={k} data-seg={k} role="spinbutton" tabIndex={0} className={'di-s di-' + k + (v == null ? ' ph' : '')}
        aria-label={{ d: t('Day'), m: t('Month'), y: t('Year') }[k]} aria-valuenow={v ?? undefined} aria-valuetext={v == null ? t('empty') : text}
        onKeyDown={(e) => key(k, e)} onBlur={() => { typed.current = '' }}>{text}</span>
    )
  }
  return (
    <div ref={wrap} className={'di' + (out || invalid ? ' bad' : '') + (open ? ' open' : '')} role="group" aria-label={label}>
      {order.map((k, i) => <span key={k} className="di-p">{i > 0 && <span className="di-sep" aria-hidden>{document.documentElement.lang === 'en' ? '/' : '.'}</span>}{seg(k)}</span>)}
      <button ref={btn} type="button" className="di-cal" aria-haspopup="dialog" aria-expanded={open} aria-label={t('Open the calendar')} onClick={() => setOpen(!open)}>
        <CalendarDays size={16} strokeWidth={1.6} />
      </button>
      <Popover anchor={wrap} open={open} onClose={() => setOpen(false)} label={label}>
        <Calendar value={value} min={min} max={max} today={today} onChange={(d) => { setDraft(null); onChange(d); setOpen(false); btn.current?.focus() }} />
      </Popover>
    </div>
  )
}

/** Twelve months of a year; for a deadline. */
export function MonthGrid({ value, onChange, min }: { value: string; onChange: (ym: string) => void; min?: string }) {
  const [year, setYear] = useState(() => Number((value || min || fromUtc(new Date())).slice(0, 4)))
  const minY = min ? Number(min.slice(0, 4)) : -Infinity
  return (
    <div className="dp dp-mon">
      <div className="dp-h">
        <button type="button" className="icon-btn" disabled={year <= minY} onClick={() => setYear(year - 1)} aria-label={t('Previous year')}><ChevronLeft size={16} strokeWidth={1.6} /></button>
        <span className="dp-t mono" aria-live="polite">{year}</span>
        <button type="button" className="icon-btn" onClick={() => setYear(year + 1)} aria-label={t('Next year')}><ChevronRight size={16} strokeWidth={1.6} /></button>
      </div>
      <div className="dp-mg" role="radiogroup" aria-label={String(year)}>
        {MONTHS.map((name, i) => {
          const ym = `${year}-${pad(i + 1)}`
          return (
            <button key={ym} type="button" role="radio" aria-checked={ym === value} disabled={!!min && ym < min}
              className={'dp-mc' + (ym === value ? ' on' : '')} onClick={() => onChange(ym)}>{name}</button>
          )
        })}
      </div>
    </div>
  )
}

/** A date as a field: the button shows it written out, the calendar opens under it. */
export function DateField({ value, onChange, min, max, today, label, className = '' }: {
  value: string; onChange: (d: string) => void; min?: string; max?: string; today?: string; label: string; className?: string
}) {
  const btn = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  return (
    <>
      <button ref={btn} type="button" className={'input ctl-field' + (className ? ' ' + className : '')} aria-haspopup="dialog" aria-expanded={open}
        aria-label={`${label}: ${longDate(value)}`} onClick={() => setOpen(!open)}>
        <CalendarDays size={15} strokeWidth={1.6} className="ctl-ic" /><span className="ctl-v">{value ? longDate(value) : t('Choose')}</span>
      </button>
      <Popover anchor={btn} open={open} onClose={() => setOpen(false)} label={label}>
        <Calendar value={value} min={min} max={max} today={today} onChange={(d) => { onChange(d); setOpen(false); btn.current?.focus() }} />
      </Popover>
    </>
  )
}

export function MonthField({ value, onChange, min, label, clearable }: { value: string; onChange: (ym: string) => void; min?: string; label: string; clearable?: boolean }) {
  const btn = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  return (
    <>
      <button ref={btn} type="button" className="input ctl-field" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)} aria-label={label}>
        <CalendarDays size={15} strokeWidth={1.6} className="ctl-ic" /><span className={'ctl-v' + (value ? '' : ' ph')}>{value ? monthLabel(value) : t('No date')}</span>
      </button>
      <Popover anchor={btn} open={open} onClose={() => setOpen(false)} label={label}>
        <MonthGrid value={value} min={min} onChange={(v) => { onChange(v); setOpen(false); btn.current?.focus() }} />
        {clearable && value && <button type="button" className="btn ghost sm ctl-clear" onClick={() => { onChange(''); setOpen(false) }}>{t('No date')}</button>}
      </Popover>
    </>
  )
}

// ------------------------------------------------------------------ time

/** A time of day, 24-hour. Arrow keys on the field move it by the step; the panel has an hour and a minute column. */
export function TimeField({ value, onChange, label, step = 15, className = '' }: { value: string; onChange: (v: string) => void; label: string; step?: number; className?: string }) {
  const btn = useRef<HTMLButtonElement>(null)
  const cols = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [h, m] = value.split(':').map(Number)
  useEffect(() => {
    if (!open) return
    cols.current?.querySelectorAll<HTMLElement>('.on').forEach((el) => el.scrollIntoView({ block: 'center' }))
  }, [open])
  const mins = Array.from({ length: 60 / step }, (_, i) => i * step)
  return (
    <>
      <button ref={btn} type="button" className={'input ctl-field ctl-time' + (className ? ' ' + className : '')} aria-haspopup="dialog" aria-expanded={open}
        aria-label={`${label}: ${value}`} onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); onChange(fromMin(toMin(value) + (e.key === 'ArrowUp' ? step : -step))) }
        }}>
        <Clock size={15} strokeWidth={1.6} className="ctl-ic" /><span className="ctl-v mono">{value}</span>
      </button>
      <Popover anchor={btn} open={open} onClose={() => setOpen(false)} label={label}>
        <div className="tpk" ref={cols}>
          <div className="tpk-col" role="listbox" aria-label={t('Hour')}>
            {Array.from({ length: 24 }, (_, i) => (
              <button key={i} type="button" role="option" aria-selected={i === h} className={'tpk-c mono' + (i === h ? ' on' : '')}
                onClick={() => onChange(`${pad(i)}:${pad(m)}`)}>{pad(i)}</button>
            ))}
          </div>
          <span className="tpk-sep mono" aria-hidden>:</span>
          <div className="tpk-col" role="listbox" aria-label={t('Minute')}>
            {mins.map((i) => (
              <button key={i} type="button" role="option" aria-selected={i === m} className={'tpk-c mono' + (i === m ? ' on' : '')}
                onClick={() => { onChange(`${pad(h)}:${pad(i)}`); setOpen(false); btn.current?.focus() }}>{pad(i)}</button>
            ))}
          </div>
        </div>
      </Popover>
    </>
  )
}

// ------------------------------------------------------------------ colour
const hexToHsl = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16)
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn
  if (!d) return [0, 0, Math.round(l * 100)]
  const s = d / (1 - Math.abs(2 * l - 1))
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [Math.round((h * 60 + 360) % 360), Math.round(s * 100), Math.round(l * 100)]
}
const hslToHex = (h: number, s: number, l: number) => {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100)
  const f = (k: number) => { const x = (k + h / 30) % 12; const c = l / 100 - a * Math.max(-1, Math.min(x - 3, 9 - x, 1)); return Math.round(c * 255).toString(16).padStart(2, '0') }
  return `#${f(0)}${f(8)}${f(4)}`
}

/** Any colour: hue, strength and lightness on three roads, or a hex code typed in. */
export function ColorField({ value, onChange, label, children }: { value: string; onChange: (hex: string) => void; label: string; children?: ReactNode }) {
  const btn = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [hsl, setHsl] = useState(() => hexToHsl(value))
  const [hex, setHex] = useState(value)
  const set = (n: [number, number, number]) => { setHsl(n); const x = hslToHex(...n); setHex(x); onChange(x) }
  return (
    <>
      <button ref={btn} type="button" className={'clr-btn' + (open ? ' open' : '')} aria-haspopup="dialog" aria-expanded={open} aria-label={label}
        onClick={() => { if (!open) { setHsl(hexToHsl(value)); setHex(value) } setOpen(!open) }}>
        <span className="clr-sw" style={{ background: value }} aria-hidden />{children}
      </button>
      <Popover anchor={btn} open={open} onClose={() => setOpen(false)} label={label} className="clr-pop">
        <div className="clr-prev" style={{ background: hslToHex(...hsl) }} aria-hidden />
        <Slider className="hue" label={t('Hue')} min={0} max={359} value={hsl[0]} onChange={(v) => set([v, hsl[1], hsl[2]])} valueText={`${hsl[0]}°`} />
        <Slider className="sat" label={t('Strength')} min={0} max={100} value={hsl[1]} onChange={(v) => set([hsl[0], v, hsl[2]])} valueText={`${hsl[1]}%`}
          style={{ '--h': hsl[0], '--l': `${hsl[2]}%` } as CSSProperties} />
        <Slider className="lit" label={t('Lightness')} min={5} max={95} value={hsl[2]} onChange={(v) => set([hsl[0], hsl[1], v])} valueText={`${hsl[2]}%`}
          style={{ '--h': hsl[0], '--s': `${hsl[1]}%` } as CSSProperties} />
        <label className="clr-hex">
          <span className="t3">Hex</span>
          <input className="input sm mono" value={hex} spellCheck={false} maxLength={7} aria-label={t('Hex code')}
            onChange={(e) => {
              const v = e.target.value.startsWith('#') ? e.target.value : '#' + e.target.value
              setHex(v)
              if (/^#[0-9a-fA-F]{6}$/.test(v)) { setHsl(hexToHsl(v)); onChange(v.toLowerCase()) }
            }} />
        </label>
      </Popover>
    </>
  )
}
