import { Fragment, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import {
  ArrowLeft, ArrowRight, BookMarked, Check, ChevronDown, ChevronRight, ClipboardPaste, ExternalLink, FileText,
  Pencil, RotateCcw, Sparkles, Upload, X,
} from 'lucide-react'
import { AiProviders } from './AiProviders'
import { api, type Answers, type DraftPlan, type Onboarding, type PlanTrack, type PlanView } from './api'
import type { Ctx } from './App'
import { Checkbox, DateInput, Slider, TimeField } from './controls'
import { addDays, daysBetween, longDate, monthLabel, weekdayMon } from './dates'
import { dayName, dayShort, getLang, t, type Key } from './i18n'
import { busyProps, useBusy, useShake } from './interact'

/* Setting up a plan of your own, one question at a time, on the same paper as a test: the question in the middle,
   the answer under it, Enter to go on. At the end the answers are laid out once more, each one a click away from
   being changed, and the model drafts the plan from them. You read the draft, ask for changes until it is right,
   and only then approve it. The same flow changes an approved plan; it then opens on the summary. */

const FIELDS: { v: Key; hint: Key }[] = [
  { v: 'Mathematics + computer science', hint: 'Proofs and programs side by side' },
  { v: 'Mathematics', hint: 'Analysis, algebra, topology, probability…' },
  { v: 'Computer science', hint: 'Algorithms, systems, theory, machine learning…' },
  { v: 'Physics', hint: 'Mechanics, electromagnetism, quantum, statistical…' },
]
const LEVELS: { v: Key; hint: Key }[] = [
  { v: 'Undergraduate', hint: 'Bachelor courses and their exams' },
  { v: "Master's student", hint: 'Graduate courses, qualifying exams, a thesis' },
  { v: 'PhD student', hint: 'Quals, research reading, the thesis' },
  { v: 'Self-study at that level', hint: 'No school around it, the same material' },
]
const GOAL_IDEAS: Key[] = [
  'Pass the qualifying exam', 'Finish a thesis chapter', 'Master one course from start to end',
  'Prepare for technical interviews', 'Get ready for a graduate programme',
]
const DRAFT_KEY = 'ctu.setup.answers'
const STEP_KEY = 'ctu.setup.step'
const PLAN_FILE_MAX = 100_000

type StepId = 'hello' | 'key' | 'path' | 'field' | 'level' | 'goal' | 'when' | 'background' | 'topics' | 'days' | 'hours' | 'code' | 'file' | 'time' | 'summary'
const ORDER: StepId[] = ['field', 'level', 'goal', 'when', 'background', 'topics', 'days', 'hours', 'code', 'file', 'summary']
/** the quick start: what you study, the goal (and its date), your time; the model fills in the rest */
const QUICK: StepId[] = ['field', 'goal', 'time', 'summary']
const QUICK_KEY = 'ctu.setup.quick'
/** steps that can be left empty: they show "Skip" */
const OPTIONAL = new Set<StepId>(['key', 'level', 'background', 'topics', 'file'])

const blank = (today: string): Answers => ({
  field: '', level: '', goal: '', deadline: '', background: '', focus: '', sources: '',
  weekdays: [0, 1, 2, 3, 4], day_start: '09:00', day_end: '17:00', hours: 6, start_date: today,
  language: 'auto', code: false, plan_text: '', plan_file: '',
})

const store = {
  get<T>(k: string): T | null { try { const s = localStorage.getItem(k); return s ? JSON.parse(s) as T : null } catch { return null } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private mode */ } },
  drop(...ks: string[]) { try { ks.forEach((k) => localStorage.removeItem(k)) } catch { /* private mode */ } },
}
const forget = () => store.drop(DRAFT_KEY, STEP_KEY)

/** Monday-first weekday names (the plan counts 0 = Monday). */
const wds = (i: number) => dayShort((i + 1) % 7)
const wdl = (i: number) => dayName((i + 1) % 7)
const mins = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m }
const fmtH = (m: number) => (m % 60 ? t('{h} h {m} min', { h: Math.floor(m / 60), m: m % 60 }) : t('{h} h', { h: m / 60 }))

export default function Setup({ ctx }: { ctx: Ctx }) {
  const [ob, setOb] = useState<Onboarding | null>(null)
  const [plan, setPlan] = useState<PlanView | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let off = false
    Promise.all([api.onboarding(), api.plan()]).then(([o, p]) => { if (!off) { setOb(o); setPlan(p); setErr(null) } })
      .catch((e: Error) => { if (!off) setErr(e.message) })
    return () => { off = true }
  }, [ctx.version])
  useEffect(() => { document.title = t('Plan setup · Waymark'); return () => { document.title = 'Waymark' } }, [])

  if (err) return <div className="page focus"><div className="callout err" role="alert">{err}</div></div>
  if (!ob || !ctx.meta) return <div className="page focus"><div className="setup-wait" aria-busy><span className="busy-road wide" aria-hidden /><span>{t('Loading…')}</span></div></div>
  if (ob.status === 'drafting') return <Drafting ob={ob} ctx={ctx} changing={!!plan?.ready} />
  if (ob.status === 'ready' && ob.draft) return <Review ob={ob} ctx={ctx} replacing={plan?.key ?? null} />
  return <Wizard ctx={ctx} ob={ob} plan={plan} />
}

// ------------------------------------------------------------- the AI providers
/** Where the model requests go: providers, their keys (in .env) and models. See AiProviders.tsx. */
export function KeyCard({ ctx, onSaved }: { ctx: Ctx; compact?: boolean; onSaved?: () => void }) {
  return <AiProviders ctx={ctx} onSaved={onSaved} />
}

// ------------------------------------------------------------- the frame: a sheet of paper over the app
function Sheet({ where, step, progress, back, side, children }: {
  where: string; step?: string; progress: number; back?: () => void; side?: ReactNode; children: ReactNode
}) {
  return (
    <div className="sheet wz" role="dialog" aria-modal="true" aria-label={where}>
      <div className="sheet-top">
        {back ? <button type="button" className="icon-btn" onClick={back} aria-label={t('Back')} title={t('Back')}><ArrowLeft size={18} strokeWidth={1.6} /></button> : <span />}
        <div className="sheet-where"><span className="sheet-t">{where}</span>{step && <span className="sheet-step mono">{step}</span>}</div>
        <div className="sheet-r">{side}</div>
        <div className="sheet-prog" aria-hidden><span style={{ width: `${Math.round(progress * 100)}%` }} /></div>
      </div>
      <div className="sheet-body">{children}</div>
    </div>
  )
}

// ------------------------------------------------------------- hello
/* The first thing a new install shows. The mark draws itself; the greeting in the interface's language rises in,
   then the greetings of other languages run through one window like the drum of a slot machine: slow to start,
   a blur at full speed, slowing down until the first greeting comes round again. Then the one thing worth asking
   before anything else: what to call you (empty: the name this computer knows you by). Any key or click during
   the run jumps to the end; with reduced motion the end shows at once. */
const HELLOS = ['Bonjour', 'Hallo', 'Ciao', 'Hola', 'Olá', 'Hej', 'Привет', 'Γεια σου', 'مرحبا', 'नमस्ते', 'こんにちは', '你好', '안녕하세요', 'Ahoj', 'Hello', 'Merhaba']
const SPLIT = /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\s,.'’-]+$/u
const letters = (w: string) => (SPLIT.test(w)
  ? [...w].map((ch, i) => <span key={i} className="hl-ch" style={{ '--i': i } as CSSProperties}>{ch === ' ' ? '\u00a0' : ch}</span>)
  : <span className="hl-ch">{w}</span>)

function Hello({ ctx, onDone, leaving }: { ctx: Ctx; onDone: () => void; leaving: boolean }) {
  const [still] = useState(() => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [first] = useState(() => t('Hello'))
  const [drum] = useState(() => [first, ...HELLOS.filter((w) => w !== first), first])
  // intro: the mark and the first greeting · run: the drum turns · ready: the name · greet: hello, <name>
  const [phase, setPhase] = useState<'intro' | 'run' | 'ready' | 'greet'>(still ? 'ready' : 'intro')
  const [me, setMe] = useState<{ name: string; system: string } | null>(null)
  const [name, setName] = useState('')
  const [greet, setGreet] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    let off = false
    api.me().then((m) => { if (!off) { setMe({ name: m.name, system: m.system_name ?? '' }); setName(m.name) } }).catch(() => {})
    return () => { off = true }
  }, [])
  useEffect(() => {
    box.current?.focus({ preventScroll: true })
    if (still) return
    const a = window.setTimeout(() => setPhase((p) => (p === 'intro' ? 'run' : p)), 1900)
    const b = window.setTimeout(() => setPhase((p) => (p === 'run' ? 'ready' : p)), 1900 + 1750 + 150)
    return () => { window.clearTimeout(a); window.clearTimeout(b) }
  }, [still])
  useEffect(() => { if (phase === 'ready') input.current?.focus({ preventScroll: true }) }, [phase])
  const begin = () => {
    const n = name.trim() || me?.system || ''
    if (n && n !== me?.name) ctx.run(api.meName(n))
    if (still || !n) { onDone(); return }
    setGreet(`${first}, ${n.split(' ')[0]}`)
    setPhase('greet')
    window.setTimeout(onDone, 1250)
  }
  const ready = phase === 'ready' || phase === 'greet'
  return (
    <div ref={box} className={'sheet wz hello ' + phase + (still ? ' still' : '') + (leaving ? ' out' : '')} role="dialog" aria-label="Waymark" tabIndex={-1}
      onKeyDown={(e) => { if (phase === 'intro' || phase === 'run') { e.preventDefault(); setPhase('ready') } }}
      onPointerDown={(e) => { if ((phase === 'intro' || phase === 'run') && !(e.target as HTMLElement).closest('button,input')) setPhase('ready') }}>
      <div className="hello-stage">
        <svg className="hello-mark" viewBox="-20 40 800 680" aria-hidden>
          <polygon className="hm hm-1" pathLength={1} points="380,63 543,169 543,294 380,193 217,294 217,169" />
          <polygon className="hm hm-2" pathLength={1} points="6,307 140,219 140,493 219,539 219,373 334,311 334,626 216,698 6,575" />
          <polygon className="hm hm-3" pathLength={1} points="754,307 620,219 620,493 541,539 541,373 426,311 426,626 544,698 754,575" />
        </svg>
        <div className="hello-word" aria-hidden>
          <div className="hello-drum" style={{ '--n': drum.length - 1 } as CSSProperties}>
            {drum.map((w, i) => <span key={i} className="hello-line" dir="auto">{i === 0 ? letters(w) : w}</span>)}
          </div>
          {phase === 'greet' && <span className={'hello-greet' + (greet.length > 14 ? ' long' : '')}>{letters(greet)}</span>}
        </div>
        <span className="sr-only" aria-live="polite">{phase === 'greet' ? greet : first}</span>
        <form className="hello-name" onSubmit={(e) => { e.preventDefault(); begin() }} aria-hidden={!ready}>
          <p className="hello-sub">{t('Welcome to Waymark. First things first:')}</p>
          <label className="hello-q" htmlFor="hello-name">{t('What should I call you?')}</label>
          <input ref={input} id="hello-name" className="wz-line hello-in" value={name} onChange={(e) => setName(e.target.value)} maxLength={60}
            autoComplete="given-name" spellCheck={false} placeholder={me?.system || t('Your name')} tabIndex={ready ? 0 : -1} />
          <p className="wz-note">{me?.system ? t('Leave it empty and I use the name this computer knows you by: {n}.', { n: me.system }) : t('You can change it later in your profile.')}</p>
          <div className="hello-acts">
            <button type="submit" className="btn primary lg" tabIndex={ready ? 0 : -1} disabled={phase === 'greet' || undefined}><span>{t("Let's begin")}</span><ArrowRight size={16} strokeWidth={1.8} /></button>
            <span className="wz-hint t3"><kbd>↵</kbd></span>
          </div>
        </form>
      </div>
    </div>
  )
}

// ------------------------------------------------------------- the questions
function Wizard({ ctx, ob, plan }: { ctx: Ctx; ob: Onboarding; plan: PlanView | null }) {
  // the server's date (its clock may be the demo clock)
  const today = ctx.meta!.today
  const hasKey = !!ctx.meta?.has_api_key
  const changing = !!plan?.ready
  const [head] = useState<StepId[]>(() => [
    ...(!changing && !store.get<StepId>(STEP_KEY) ? ['hello' as StepId] : []),
    ...(hasKey ? [] : ['key' as StepId]), ...(changing ? [] : ['path' as StepId])])
  const [quick, setQuick] = useState(() => !changing && store.get<boolean>(QUICK_KEY) === true)
  const stepsFor = (q: boolean) => [...head, ...(q ? QUICK : ORDER)]
  const steps = stepsFor(quick)
  const [a, setA] = useState<Answers>(() => {
    const merged = { ...blank(today), ...(plan?.answers ?? {}), ...(ob.answers ?? {}), ...(store.get<Partial<Answers>>(DRAFT_KEY) ?? {}), plan_text: '', plan_file: '' }
    if (merged.start_date < today) merged.start_date = today
    // older answers kept the deadline as a month: its last day
    if (/^\d{4}-\d{2}$/.test(merged.deadline)) merged.deadline = addDays(addDays(`${merged.deadline}-01`, 32).slice(0, 8) + '01', -1)
    return merged
  })
  const [i, setI] = useState(() => {
    const s = store.get<StepId>(STEP_KEY)
    const at = s ? steps.indexOf(s) : -1
    return at >= 0 ? at : changing ? steps.indexOf('summary') : 0
  })
  const [anim, setAnim] = useState<{ dir: 1 | -1; out: boolean }>({ dir: 1, out: false })
  const moving = useRef(false)
  const [still] = useState(() => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [returnTo, setReturnTo] = useState<number | null>(null)
  const [other, setOther] = useState(() => a.field !== '' && !FIELDS.some((f) => f.v === a.field))
  const [busy, run] = useBusy()
  const [shaking, shake] = useShake()
  const col = useRef<HTMLDivElement>(null)
  const id = steps[i]
  const off = steps[0] === 'hello' ? 1 : 0

  useEffect(() => { store.set(DRAFT_KEY, { ...a, plan_text: '', plan_file: '' }) }, [a])
  useEffect(() => { store.set(QUICK_KEY, quick) }, [quick])
  useEffect(() => { if (id !== 'hello') store.set(STEP_KEY, id) }, [id])
  useEffect(() => {
    // the step's first field takes the keyboard; otherwise the step itself, so Enter and the number keys work
    const el = col.current?.querySelector<HTMLElement>('[data-autofocus]') ?? col.current
    el?.focus({ preventScroll: true })
  }, [id])

  const set = <K extends keyof Answers>(k: K, v: Answers[K]) => setA((x) => ({ ...x, [k]: v }))
  const dayMin = mins(a.day_end) - mins(a.day_start)

  const problem = (s: StepId): string => {
    if (s === 'field' && !a.field.trim() && !a.plan_text) return t('Pick one, or write your field.')
    if (s === 'goal' && !a.goal.trim() && !a.plan_text) return t('Write the goal: the whole plan is built around it.')
    if ((s === 'when' || (s === 'goal' && quick)) && a.deadline && a.deadline <= a.start_date) return t('The deadline has to come after the start.')
    if (s === 'time' && !a.weekdays.length) return t('Choose at least one study day.')
    if (s === 'days' && !a.weekdays.length) return t('Choose at least one study day.')
    if (s === 'days' && !(dayMin >= 60)) return t('The study day has to be at least an hour long.')
    return ''
  }
  /** to step n: the current step leaves the way you are going, then the next one comes in from the other side */
  const go = (to: number) => {
    const n = Math.max(0, Math.min(steps.length - 1, to))
    if (n === i || moving.current) return
    const dir = n > i ? 1 : -1
    if (still) { setAnim({ dir, out: false }); setI(n); return }
    moving.current = true
    setAnim({ dir, out: true })
    window.setTimeout(() => { setI(n); setAnim({ dir, out: false }); moving.current = false }, id === 'hello' ? 420 : 190)
  }
  const next = () => {
    const p = problem(id)
    if (p) { shake(); ctx.notify(p, 'warn'); return }
    if (returnTo != null) { setReturnTo(null); go(returnTo); return }
    go(i + 1)
  }
  const skip = () => { if (returnTo != null) { setReturnTo(null); go(returnTo) } else go(i + 1) }
  const edit = (s: StepId) => {
    if (!steps.includes(s)) {   // a detail the quick start skipped: switch to the full questions, at that one
      const full = stepsFor(false)
      setQuick(false); setReturnTo(full.indexOf('summary')); setI(full.indexOf(s)); return
    }
    setReturnTo(steps.indexOf('summary')); go(steps.indexOf(s))
  }
  const choosePath = (q: boolean) => {
    setQuick(q)
    if (q && !a.code && /comput|software|program|data sci/i.test(a.field)) set('code', true)
    const n = stepsFor(q).indexOf('path') + 1
    if (still) { setI(n); return }
    moving.current = true
    setAnim({ dir: 1, out: true })
    window.setTimeout(() => { setI(n); setAnim({ dir: 1, out: false }); moving.current = false }, 190)
  }

  const draft = () => {
    const missing = steps.find((s) => s !== 'summary' && problem(s))
    if (missing) { ctx.notify(problem(missing), 'warn'); go(steps.indexOf(missing)); return }
    run(async () => { const r = await ctx.run(api.draftPlan(a)); if (r) { store.drop(STEP_KEY); ctx.refresh() } })
  }

  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.altKey) return
    const el = e.target as HTMLElement
    const typing = el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && (el as HTMLInputElement).type !== 'file')
    if (e.key === 'Enter' && id !== 'summary' && id !== 'key') {
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); next(); return }
      if (el.tagName === 'TEXTAREA') return
      if (!typing && el !== col.current) return
      e.preventDefault(); next(); return
    }
    // 1–9 pick an option; going on stays with Enter or Continue
    if (!typing && !e.ctrlKey && !e.metaKey && /^[1-9]$/.test(e.key)) {
      const opt = col.current?.querySelectorAll<HTMLElement>('.wz-opts [role=radio]')[Number(e.key) - 1]
      if (opt) { e.preventDefault(); opt.click(); col.current?.focus({ preventScroll: true }) }
    }
  }

  if (id === 'hello') return <Hello ctx={ctx} onDone={() => go(i + 1)} leaving={anim.out} />

  const side = changing
    ? <button type="button" className="btn ghost sm" onClick={() => { forget(); ctx.go({ kind: 'settings' }) }}><X size={14} strokeWidth={1.6} /><span>{t('Cancel')}</span></button>
    : <button type="button" className="btn ghost sm" onClick={() => ctx.go({ kind: 'settings' })} title={t('Restore a backup file in Settings → Data')}>{t('I have a backup')}</button>

  let body: ReactNode = null
  switch (id) {
    case 'key':
      body = (
        <Q h={t('First, your API key')} sub={t('The model that drafts your plan, writes your tests and runs the coach is called with your own key. You can also add it later, before the draft.')}>
          <div className="wz-panel"><KeyCard ctx={ctx} /></div>
        </Q>
      )
      break
    case 'path':
      body = (
        <Q h={t('How do you want to start?')} sub={t('Both end with a draft you read and change before anything is planned.')}>
          <Options items={[
            { v: 'quick', label: t('Quick start · 3 questions'), hint: t('What you study, your goal and your time. The model assumes the rest; add details later in Settings → Plan.') },
            { v: 'full', label: t('Detailed setup · 10 questions'), hint: t('Your level, what you already know, topics and sources, the hours of your day, programming, a plan file of your own.') },
          ]} value={quick ? 'quick' : 'full'} onPick={(v) => choosePath(v === 'quick')} />
        </Q>
      )
      break
    case 'time': {
      body = (
        <Q h={t('How much time do you have?')} sub={t('Your study days and the net hours on each. The plan fits the blocks into your day.')}>
          <div className="wz-days" role="group" aria-label={t('Study days')}>
            {[0, 1, 2, 3, 4, 5, 6].map((d) => {
              const on = a.weekdays.includes(d)
              return (
                <button key={d} type="button" aria-pressed={on} aria-label={wdl(d)} className={'wz-day' + (on ? ' on' : '')}
                  onClick={() => set('weekdays', on ? a.weekdays.filter((x) => x !== d) : [...a.weekdays, d].sort())}>
                  <span>{wds(d)}</span><span className="wz-day-m" aria-hidden><Check size={12} strokeWidth={2.6} /></span>
                </button>
              )
            })}
          </div>
          <div className="wz-big" aria-hidden><span className="mono">{a.hours}</span><span>{t('hours')}</span></div>
          <Slider className="wz-slider" label={t('Net study a day')} min={1} max={12} value={a.hours}
            onChange={(v) => setA((x) => {
              // the day window grows with the hours, so the blocks always fit
              const end = mins(x.day_start) + v * 60 + 60
              return { ...x, hours: v, day_end: end > mins(x.day_end) ? `${String(Math.min(23, Math.floor(end / 60))).padStart(2, '0')}:${String(end >= 1440 ? 59 : end % 60).padStart(2, '0')}` : x.day_end }
            })}
            valueText={t('{h} hours', { h: a.hours })} ticks={[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((x) => ({ at: x, label: String(x) }))} />
          <p className="wz-note" aria-live="polite">{t('{w} a week over {d} days, between {a} and {b}.', { w: fmtH(a.hours * 60 * a.weekdays.length), d: a.weekdays.length, a: a.day_start, b: a.day_end })}</p>
        </Q>
      )
      break
    }
    case 'field':
      body = (
        <Q h={t('What do you study?')} sub={t('The plan, its sources and its tests are written for this field.')}>
          <Options items={FIELDS.map((f) => ({ v: f.v as string, label: t(f.v), hint: t(f.hint) }))} value={other ? '' : a.field}
            onPick={(v) => { setOther(false); set('field', v) }}
            extra={{ label: t('Something else'), on: other, pick: () => { setOther(true); if (FIELDS.some((f) => f.v === a.field)) set('field', '') } }} />
          {other && <input className="wz-line" data-autofocus aria-label={t('Your field')} placeholder={t('e.g. Statistics, Electrical engineering')}
            value={a.field} onChange={(e) => set('field', e.target.value)} />}
        </Q>
      )
      break
    case 'level':
      body = (
        <Q h={t('At what level?')} sub={t('It sets how fast the plan moves and how hard the checks are.')}>
          <Options items={LEVELS.map((l) => ({ v: l.v as string, label: t(l.v), hint: t(l.hint) }))} value={a.level} onPick={(v) => set('level', v)} />
        </Q>
      )
      break
    case 'goal':
      body = (
        <Q h={t('What is your goal?')} sub={t('What the whole plan works towards. Concrete is better: an exam and its date, a thesis chapter, a course you want to master.')}>
          <textarea className="wz-ruled" data-autofocus rows={2} value={a.goal} onChange={(e) => set('goal', e.target.value)} aria-label={t('Goal')}
            placeholder={t('e.g. Pass the analysis qualifying exam in September; be fluent in measure theory')} />
          <div className="wz-ideas" aria-label={t('Ideas')}>
            {GOAL_IDEAS.map((g) => (
              <button key={g} type="button" className="chip" onClick={(e) => {
                set('goal', a.goal.trim() ? `${a.goal.trim()}; ${t(g).toLocaleLowerCase()}` : t(g))
                e.currentTarget.closest('.wz-col')?.querySelector<HTMLTextAreaElement>('.wz-ruled')?.focus()
              }}>{t(g)}</button>
            ))}
          </div>
          {quick && (
            <div className="wz-date wz-date-q">
              <span className="wz-date-l">{t('Goal date')} <span className="t3">· {t('optional')}</span></span>
              <DateInput label={t('Goal date')} value={a.deadline} min={addDays(a.start_date, 1)} today={today} invalid={!!a.deadline && a.deadline <= a.start_date}
                onChange={(d) => set('deadline', d)} />
              <div className="wz-mini">
                <button type="button" className={'chip' + (!a.deadline ? ' on' : '')} onClick={() => set('deadline', '')}>{t('No date')}</button>
              </div>
            </div>
          )}
        </Q>
      )
      break
    case 'when': {
      const tomorrow = addDays(today, 1)
      const monday = addDays(today, 7 - weekdayMon(today))
      const later = (m: number) => { const [y, mo, d] = a.start_date.split('-').map(Number); const t0 = new Date(Date.UTC(y, mo - 1 + m, 1)); const lim = new Date(Date.UTC(t0.getUTCFullYear(), t0.getUTCMonth() + 1, 0)).getUTCDate(); return `${t0.getUTCFullYear()}-${String(t0.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(d, lim)).padStart(2, '0')}` }
      body = (
        <Q h={t('From when, until when?')} sub={t('The first day of the plan and the day the goal is due. The plan splits the road between them into units, with room for review at the end.')}>
          <div className="wz-dates">
            <div className="wz-date">
              <span className="wz-date-l">{t('Start date')}</span>
              <DateInput label={t('Start date')} value={a.start_date} min={today} today={today} onChange={(d) => set('start_date', d < today ? today : d)} />
              <div className="wz-mini">
                <button type="button" className={'chip' + (a.start_date === today ? ' on' : '')} onClick={() => set('start_date', today)}>{t('Today')}</button>
                <button type="button" className={'chip' + (a.start_date === tomorrow ? ' on' : '')} onClick={() => set('start_date', tomorrow)}>{t('Tomorrow')}</button>
                <button type="button" className={'chip' + (a.start_date === monday ? ' on' : '')} onClick={() => set('start_date', monday)}>{t('Next Monday')}</button>
              </div>
            </div>
            <div className="wz-date">
              <span className="wz-date-l">{t('Goal date')} <span className="t3">· {t('optional')}</span></span>
              <DateInput label={t('Goal date')} value={a.deadline} min={addDays(a.start_date, 1)} today={today} invalid={!!a.deadline && a.deadline <= a.start_date}
                onChange={(d) => set('deadline', d)} />
              <div className="wz-mini">
                {[3, 6, 12].map((m) => {
                  const d = later(m)
                  return <button key={m} type="button" className={'chip' + (a.deadline === d ? ' on' : '')} onClick={() => set('deadline', d)}>{m === 12 ? t('In a year') : t('In {n} months', { n: m })}</button>
                })}
                <button type="button" className={'chip' + (!a.deadline ? ' on' : '')} onClick={() => set('deadline', '')}>{t('No date')}</button>
              </div>
            </div>
          </div>
          <Journey start={a.start_date} end={a.deadline} weekdays={a.weekdays} />
          <p className="wz-note">{t('Several exams on different days? Write each in your goal (e.g. "Calculus midterm Dec 10, Linear algebra Dec 17"): every course gets its own date, and you can change them on the draft.')}</p>
        </Q>
      )
      break
    }
    case 'background':
      body = (
        <Q h={t('Where are you now?')} sub={t('Courses you finished, books you worked through, where you feel shaky. The plan starts from here instead of from zero.')}>
          <textarea className="wz-ruled" data-autofocus rows={3} value={a.background} onChange={(e) => set('background', e.target.value)} aria-label={t('What you already know')}
            placeholder={t('e.g. Calculus I–III and linear algebra done; proofs feel slow; no measure theory yet')} />
        </Q>
      )
      break
    case 'topics':
      body = (
        <Q h={t('What should be in it?')} sub={t('Both are optional. Leave them empty and the model picks the topics your goal needs and the standard sources for them.')}>
          <label className="wz-pair">
            <span>{t('Topics')}</span>
            <textarea className="wz-ruled sm" data-autofocus rows={1} value={a.focus} onChange={(e) => set('focus', e.target.value)} placeholder={t('e.g. real analysis, probability, algorithms')} />
          </label>
          <label className="wz-pair">
            <span>{t('Sources')}</span>
            <textarea className="wz-ruled sm" rows={1} value={a.sources} onChange={(e) => set('sources', e.target.value)} placeholder={t('e.g. Abbott, Understanding Analysis; MIT OCW 18.100A')} />
          </label>
        </Q>
      )
      break
    case 'days':
      body = (
        <Q h={t('When do you study?')} sub={t('Your study days, and the hours of the day the plan may use.')}>
          <div className="wz-days" role="group" aria-label={t('Study days')}>
            {[0, 1, 2, 3, 4, 5, 6].map((d) => {
              const on = a.weekdays.includes(d)
              return (
                <button key={d} type="button" aria-pressed={on} aria-label={wdl(d)} className={'wz-day' + (on ? ' on' : '')}
                  onClick={() => set('weekdays', on ? a.weekdays.filter((x) => x !== d) : [...a.weekdays, d].sort())}>
                  <span>{wds(d)}</span><span className="wz-day-m" aria-hidden><Check size={12} strokeWidth={2.6} /></span>
                </button>
              )
            })}
          </div>
          <div className="wz-ideas">
            <button type="button" className={'chip' + (a.weekdays.join() === '0,1,2,3,4' ? ' on' : '')} onClick={() => set('weekdays', [0, 1, 2, 3, 4])}>{t('Weekdays')}</button>
            <button type="button" className={'chip' + (a.weekdays.join() === '0,1,2,3,4,5' ? ' on' : '')} onClick={() => set('weekdays', [0, 1, 2, 3, 4, 5])}>{t('Six days')}</button>
            <button type="button" className={'chip' + (a.weekdays.length === 7 ? ' on' : '')} onClick={() => set('weekdays', [0, 1, 2, 3, 4, 5, 6])}>{t('Every day')}</button>
          </div>
          <p className="wz-sentence">
            {t('Each day from {a} to {b}').split(/(\{a\}|\{b\})/).map((x, n) => x === '{a}'
              ? <TimeField key={n} label={t('Day starts')} value={a.day_start} onChange={(v) => set('day_start', v)} />
              : x === '{b}' ? <TimeField key={n} label={t('Day ends')} value={a.day_end} onChange={(v) => set('day_end', v)} />
                : <span key={n}>{x}</span>)}
          </p>
          <p className={'wz-note' + (dayMin < 60 ? ' bad' : '')}>{dayMin >= 60 ? t('A window of {h} a day.', { h: fmtH(dayMin) }) : t('The day has to be at least an hour long.')}</p>
        </Q>
      )
      break
    case 'hours': {
      const fits = a.hours * 60 <= dayMin
      body = (
        <Q h={t('How many hours of real study a day?')} sub={t('Net, breaks not counted. Be honest: a plan you keep beats a plan that looks good.')}>
          <div className="wz-big" aria-hidden><span className="mono">{a.hours}</span><span>{t('hours')}</span></div>
          <Slider className="wz-slider" label={t('Net study a day')} min={1} max={12} value={a.hours} onChange={(v) => set('hours', v)}
            valueText={t('{h} hours', { h: a.hours })} ticks={[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((x) => ({ at: x, label: String(x) }))} />
          <p className={'wz-note' + (fits ? '' : ' warn')} aria-live="polite">
            {fits ? t('{w} a week over {d} days, in a {win} window each day.', { w: fmtH(a.hours * 60 * a.weekdays.length), d: a.weekdays.length, win: fmtH(dayMin) })
              : t('More than your day ({win}). That is fine; the plan puts in as much as fits, or widen the day.', { win: fmtH(dayMin) })}
          </p>
        </Q>
      )
      break
    }
    case 'code':
      body = (
        <Q h={t('Does the plan include programming?')} sub={t('With it, tests get code questions and the plan gets code tasks.')}>
          <Options items={[{ v: 'yes', label: t('Yes, I write code'), hint: t('Implementations, exercises in a language, code-reading questions') },
            { v: 'no', label: t('No, no code'), hint: t('Proofs, problems and reading only') }]}
            value={a.code ? 'yes' : 'no'} onPick={(v) => set('code', v === 'yes')} />
        </Q>
      )
      break
    case 'file':
      body = (
        <Q h={t('Do you already have a plan?')} sub={t("A Markdown or text file with your own plan, for example a COACH.md. The model turns it into this app's shape; the file itself is only read, never changed.")}>
          <PlanFile a={a} setA={setA} ctx={ctx} />
        </Q>
      )
      break
    case 'summary':
      body = <Summary a={a} ctx={ctx} edit={edit} draft={draft} busy={busy} hasKey={hasKey} failed={ob.status === 'failed' ? ob.error ?? null : null} quick={quick} />
      break
  }

  const last = id === 'summary'
  const total = steps.length - off
  const cls = anim.out ? (anim.dir > 0 ? ' out-f' : ' out-b') : (anim.dir > 0 ? ' in-f' : ' in-b')
  return (
    <Sheet where={changing ? t('Change your plan') : t('Set up your plan')} step={`${i - off + 1} / ${total}`} progress={(i - off) / Math.max(1, total - 1)}
      back={i > off ? () => go(returnTo ?? i - 1) : undefined} side={side}>
      <div key={id} ref={col} className={'sheet-col wz-col' + cls} tabIndex={-1} onKeyDown={key}>
        {body}
        {!last && (
          <div className="wz-acts">
            <span className="wz-hint t3">{id === 'goal' || id === 'background' || id === 'topics'
              ? <><kbd>Ctrl</kbd><kbd>↵</kbd><span>{t('to go on')}</span></> : <><kbd>↵</kbd><span>{t('to go on')}</span></>}</span>
            {OPTIONAL.has(id) && <button type="button" className="btn ghost lg" onClick={skip}>{t('Skip')}</button>}
            <button type="button" className={'btn primary lg' + (shaking ? ' shake' : '')} onClick={next}>
              <span>{returnTo != null ? t('Back to the summary') : t('Continue')}</span><ArrowRight size={16} strokeWidth={1.8} />
            </button>
          </div>
        )}
      </div>
    </Sheet>
  )
}

/** The road from the start to the goal date, months marked along it. One road whatever the dates: changing them
    moves its marks and fill instead of building it again. */
function Journey({ start, end, weekdays }: { start: string; end: string; weekdays: number[] }) {
  const ok = !!end && end > start
  const total = ok ? daysBetween(start, end) : 0
  let study = 0
  for (let k = 0, d = start; k < Math.min(total, 1500); k++, d = addDays(d, 1)) if (weekdays.includes(weekdayMon(d))) study++
  const months: { d: string; at: number; label: string; year: boolean }[] = []
  if (ok) {
    for (let d = addDays(start.slice(0, 8) + '01', 32).slice(0, 8) + '01'; d < end; d = addDays(d, 32).slice(0, 8) + '01') {
      months.push({ d, at: daysBetween(start, d) / total, label: monthLabel(d.slice(0, 7)).split(' ')[0].slice(0, 3), year: d.slice(5, 7) === '01' })
    }
  }
  const every = Math.max(1, Math.ceil(months.length / 8))
  return (
    <div className={'jr' + (ok ? '' : ' open')} aria-live="polite">
      <div className="jr-road">
        <span className="jr-fill" />
        {months.map((m, k) => (
          <span key={m.d} className={'jr-tick' + (m.year ? ' y' : '')} style={{ left: `${m.at * 100}%` }}>
            {k % every === 0 && <span className="jr-tl">{m.label}</span>}
          </span>
        ))}
        <span className="jr-pin a" /><span className="jr-pin b" />
      </div>
      <div className="jr-ends"><span>{longDate(start)}</span><span className="jr-end">{ok ? longDate(end) : '…'}</span></div>
      <p className="wz-note">{ok ? t('{w} weeks, about {s} study days.', { w: Math.round(total / 7), s: study })
        : end ? t('The deadline has to come after the start.') : t('No date: the plan simply goes through the material.')}</p>
    </div>
  )
}

/** One question: the question itself (its words rise in one after another), a line on why it is asked, the answer. */
function Q({ h, sub, children }: { h: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <>
      <h1 className="sheet-h wz-h" aria-label={h}>
        {h.split(' ').map((w, i) => <Fragment key={i}>{i > 0 && ' '}<span className="wz-w" aria-hidden style={{ '--i': i } as CSSProperties}><span>{w}</span></span></Fragment>)}
      </h1>
      {sub && <p className="wz-sub">{sub}</p>}
      {children}
    </>
  )
}

function Options({ items, value, onPick, extra }: {
  items: { v: string; label: string; hint?: string }[]; value: string; onPick: (v: string) => void
  extra?: { label: string; on: boolean; pick: () => void }
}) {
  const all = [...items.map((x) => ({ ...x, on: x.v === value, pick: () => onPick(x.v) })), ...(extra ? [{ v: '_', label: extra.label, hint: undefined, on: extra.on, pick: extra.pick }] : [])]
  return (
    <div className="wz-opts" role="radiogroup">
      {all.map((x, n) => (
        <button key={x.v} type="button" role="radio" aria-checked={x.on} className={'choice wz-opt' + (x.on ? ' on' : '')} onClick={x.pick}>
          <span className="wz-k mono" aria-hidden>{n + 1}</span>
          <span className="wz-ol"><span className="wz-ot">{x.label}</span>{x.hint && <span className="wz-oh">{x.hint}</span>}</span>
          <span className="wz-tick" aria-hidden><Check size={16} strokeWidth={2.2} /></span>
        </button>
      ))}
    </div>
  )
}

/** A plan file dropped or picked, or the text pasted. The system's file window is the one part only the
    operating system can draw; dropping the file here or pasting its text avoids it. */
function PlanFile({ a, setA, ctx }: { a: Answers; setA: (f: (x: Answers) => Answers) => void; ctx: Ctx }) {
  const pick = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const [pasting, setPasting] = useState(false)
  const take = (f: File | undefined) => {
    if (!f) return
    if (f.size > PLAN_FILE_MAX * 2) { ctx.notify(t('That file is too large for a plan (over 100 KB of text).'), 'warn'); return }
    f.text().then((txt) => {
      setA((x) => ({ ...x, plan_text: txt.slice(0, PLAN_FILE_MAX), plan_file: f.name }))
      if (txt.length > PLAN_FILE_MAX) ctx.notify(t('Only the first 100 KB of the file is used.'), 'warn')
    }).catch(() => ctx.notify(t('The file could not be read.'), 'err'))
  }
  if (a.plan_text) {
    return (
      <div className="wz-file">
        <FileText size={20} strokeWidth={1.5} />
        <div className="wz-file-t"><b>{a.plan_file || t('Pasted text')}</b><span className="t3 mono">{Math.ceil(a.plan_text.length / 1000)} KB</span></div>
        <button type="button" className="btn ghost sm" onClick={() => setA((x) => ({ ...x, plan_text: '', plan_file: '' }))}><X size={14} strokeWidth={1.6} /><span>{t('Remove')}</span></button>
      </div>
    )
  }
  return (
    <>
      <input ref={pick} type="file" accept=".md,.markdown,.txt,text/plain,text/markdown" hidden onChange={(e) => { take(e.target.files?.[0]); e.target.value = '' }} />
      {pasting ? (
        <PasteBox onDone={(txt) => { setPasting(false); if (txt.trim()) setA((x) => ({ ...x, plan_text: txt.slice(0, PLAN_FILE_MAX), plan_file: '' })) }} />
      ) : (
        <>
          <div className={'wz-drop' + (over ? ' over' : '')} role="button" tabIndex={0} data-autofocus
            onClick={() => pick.current?.click()} onKeyDown={(e) => { if (e.key === ' ') { e.preventDefault(); pick.current?.click() } }}
            onDragOver={(e) => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files?.[0]) }}>
            <Upload size={22} strokeWidth={1.5} />
            <span className="wz-drop-t">{t('Drop the file here, or click to choose it')}</span>
            <span className="t3">{t('Markdown or plain text, up to 100 KB')}</span>
          </div>
          <button type="button" className="btn ghost" onClick={() => setPasting(true)}><ClipboardPaste size={15} strokeWidth={1.6} /><span>{t('Paste the text instead')}</span></button>
        </>
      )}
    </>
  )
}

function PasteBox({ onDone }: { onDone: (txt: string) => void }) {
  const [v, setV] = useState('')
  return (
    <div className="wz-paste">
      <textarea className="input mono" data-autofocus rows={10} value={v} onChange={(e) => setV(e.target.value)} aria-label={t('Your plan as text')} placeholder={t('Paste your plan here')} />
      <div className="inline-form end">
        <button type="button" className="btn ghost sm" onClick={() => onDone('')}>{t('Cancel')}</button>
        <button type="button" className="btn sm" disabled={!v.trim()} onClick={() => onDone(v)}><Check size={14} strokeWidth={1.8} /><span>{t('Use this text')}</span></button>
      </div>
    </div>
  )
}

/** One exam date per course. `onSave` gets only the dates that changed ('' removes one). */
export function ExamDates({ tracks, start, today, onSave, busy, action, note, ends }: {
  tracks: PlanTrack[]; start: string; today: string; onSave: (dates: Record<string, string>) => void; busy: boolean; action: string; note: string
  ends?: Record<string, string>
}) {
  const [v, setV] = useState<Record<string, string>>(() => Object.fromEntries(tracks.map((x) => [x.key, x.deadline ?? ''])))
  const changed = Object.fromEntries(tracks.filter((x) => (x.deadline ?? '') !== (v[x.key] ?? '')).map((x) => [x.key, v[x.key] ?? '']))
  const min = addDays(start > today ? start : today, 1)
  const bad = Object.values(v).some((d) => d && d < min)
  return (
    <div className="exam-dates">
      <p className="set-note">{note}</p>
      {tracks.map((x, i) => (
        <div key={x.key} className="exam-row">
          <span className={'trk-dot trk-' + (i % 6)} aria-hidden /><span className="exam-l">{x.label}</span>
          <DateInput label={t('Exam date for {c}', { c: x.label })} value={v[x.key] ?? ''} min={min} today={today} invalid={!!v[x.key] && v[x.key] < min}
            onChange={(d) => setV((o) => ({ ...o, [x.key]: d }))} />
          {v[x.key] ? <button type="button" className="mini" aria-label={t('No exam date')} title={t('No exam date')} onClick={() => setV((o) => ({ ...o, [x.key]: '' }))}><X size={13} strokeWidth={1.6} /></button>
            : <span className="t3 small">{t('no exam')}</span>}
          {ends?.[x.key] && <Buffer end={ends[x.key]} exam={x.deadline ?? ''} />}
        </div>
      ))}
      {Object.keys(changed).length > 0 && (
        <div className="inline-form">
          <button type="button" className="btn sm primary" {...busyProps(busy)} disabled={busy || bad || undefined} onClick={() => onSave(changed)}>{action}</button>
          {bad && <span className="t3 small">{t('An exam date has to be in the future.')}</span>}
        </div>
      )}
    </div>
  )
}

/** A course's last unit next to its exam: the days between are its review, said in so many words. */
function Buffer({ end, exam }: { end: string; exam: string }) {
  if (!exam) return <span className="exam-buf t3 small">{t('units end {d}', { d: longDate(end) })}</span>
  const days = daysBetween(end, exam)
  if (days <= 0) return <span className="exam-buf warn small">{t('units end {d}, after the exam', { d: longDate(end) })}</span>
  return <span className="exam-buf t3 small" title={t('After its last unit, the course’s blocks review its earlier units and open sticking points until the exam; once the exam is over they go to the next exam.')}>
    {t('units end {d} · {n} days of review before the exam', { d: longDate(end), n: days })}</span>
}

/** an answer picked from the lists is stored in English (the model reads it); show it in the interface language */
const known = (v: string) => ([...FIELDS, ...LEVELS].some((x) => x.v === v) ? t(v as Key) : v)

function Summary({ a, ctx, edit, draft, busy, hasKey, failed, quick }: {
  a: Answers; ctx: Ctx; edit: (s: StepId) => void; draft: () => void; busy: boolean; hasKey: boolean; failed: string | null; quick?: boolean
}) {
  const days = [...a.weekdays].sort().map(wds).join(' · ')
  const rows: { s: StepId; l: string; v: ReactNode; empty?: boolean }[] = [
    { s: 'field', l: t('Field'), v: [a.field, a.level].filter(Boolean).map(known).join(' · ') },
    { s: 'goal', l: t('Goal'), v: a.goal, empty: !a.goal },
    { s: 'when', l: t('Dates'), v: <>{longDate(a.start_date)} <span className="t3">→</span> {a.deadline ? longDate(a.deadline) : <span className="t3">{t('no goal date')}</span>}</> },
    { s: 'background', l: t('Where you are'), v: a.background || t('Not said'), empty: !a.background },
    { s: 'topics', l: t('Topics and sources'), v: [a.focus, a.sources].filter(Boolean).join(' · ') || t("The model's choice"), empty: !a.focus && !a.sources },
    { s: 'days', l: t('Week'), v: <>{days} <span className="mono t3 nowrap">{a.day_start}–{a.day_end}</span></> },
    { s: 'hours', l: t('A day'), v: t('{h} hours of real study', { h: a.hours }) },
    { s: 'code', l: t('Programming'), v: a.code ? t('Yes') : t('No') },
    { s: 'file', l: t('Your own plan'), v: a.plan_text ? (a.plan_file || t('Pasted text')) : t('None'), empty: !a.plan_text },
  ]
  if (quick) {
    rows.splice(0, rows.length,
      { s: 'field', l: t('Field'), v: known(a.field) },
      { s: 'goal', l: t('Goal'), v: <>{a.goal} <span className="t3">· {a.deadline ? longDate(a.deadline) : t('no goal date')}</span></>, empty: !a.goal },
      { s: 'time', l: t('Week'), v: <>{days} <span className="mono t3 nowrap">· {t('{h} hours of real study', { h: a.hours })}</span></> })
  }
  return (
    <>
      <Q h={t('Here is what you told me')} sub={t('Change anything by clicking it. The model drafts the plan from these answers; nothing is set until you approve the draft.')} />
      {failed && <div className="callout err" role="alert">{failed}</div>}
      <dl className="wz-sum">
        {rows.map((r) => (
          <button key={r.s} type="button" className="wz-row" onClick={() => edit(r.s)}>
            <dt>{r.l}</dt>
            <dd className={r.empty ? 't3' : ''}>{r.v}</dd>
            <Pencil size={14} strokeWidth={1.6} className="wz-row-e" aria-hidden />
          </button>
        ))}
      </dl>
      {quick && <p className="wz-note">{t('Quick start: the model assumes your level and background and picks topics and free sources for your goal; it says what it assumed in the draft. Add any of it now or later in Settings → Plan.')}{' '}
        <button type="button" className="link" onClick={() => edit('background')}>{t('Add details now')}</button></p>}
      {!hasKey && <div className="wz-panel"><h2 className="wz-panel-h">{t('Your API key')}</h2><KeyCard ctx={ctx} /></div>}
      <div className="wz-acts mid">
        <button type="button" className="btn primary lg wz-go" {...busyProps(busy)} disabled={busy || !hasKey || undefined} onClick={draft}>
          <Sparkles size={16} strokeWidth={1.6} /><span>{t('Draft my plan')}</span>
        </button>
      </div>
      <p className="wz-note">{hasKey ? t('Writing the draft takes a minute or two. You can leave the page meanwhile.') : t('Add your API key above first.')}</p>
    </>
  )
}

// ------------------------------------------------------------- while the model writes
/* What the server says the model is doing, asked every second: thinking (nothing written yet), writing (the
   tracks it named and the units it finished, read off its stream), checking (the app repairs the draft and opens
   every link). The clock is the server's own, so it keeps time even on the demo clock. */
const PHASES: { k: 'thinking' | 'writing' | 'checking'; l: Key }[] = [
  { k: 'thinking', l: 'The model reads your answers and thinks the plan through' },
  { k: 'writing', l: 'It writes the tracks, units and the week' },
  { k: 'checking', l: 'The app checks every block and opens the sources' },
]

function Drafting({ ob, ctx, changing }: { ob: Onboarding; ctx: Ctx; changing: boolean }) {
  const [st, setSt] = useState(ob)
  const [base, setBase] = useState(() => ({ at: Date.now(), elapsed: ob.progress?.elapsed ?? 0 }))
  const [now, setNow] = useState(() => Date.now())
  // the app context changes every second; the poll keeps running and reads the latest refresh from a ref
  const refresh = useRef(ctx.refresh)
  useEffect(() => { refresh.current = ctx.refresh })
  useEffect(() => {
    let off = false
    const tick = window.setInterval(() => {
      setNow(Date.now())
      api.onboarding().then((o) => {
        if (off) return
        setSt(o)
        if (o.progress) setBase({ at: Date.now(), elapsed: o.progress.elapsed })
        if (o.status !== 'drafting') refresh.current()
      }).catch(() => {})
    }, 1000)
    return () => { off = true; window.clearInterval(tick) }
  }, [])
  const p = st.progress
  const phase = p?.phase ?? 'thinking'
  const at = PHASES.findIndex((x) => x.k === phase)
  const sec = Math.max(0, Math.round(base.elapsed + (now - base.at) / 1000))
  // how far along the road: an estimate from what has been written (a full draft is roughly 16k characters)
  const far = phase === 'checking' ? 0.94 : phase === 'writing' ? 0.14 + Math.min(0.76, (p?.chars ?? 0) / 16000 * 0.76) : Math.min(0.12, 0.02 + sec / 600)
  return (
    <Sheet where={changing ? t('Change your plan') : t('Set up your plan')} progress={1}
      side={<button type="button" className="btn ghost sm" onClick={() => ctx.go({ kind: 'settings' })}>{t('Settings')}</button>}>
      <div className="sheet-col wz-col wz-wait in-f" aria-live="polite">
        <div className={'dr ' + phase} style={{ '--far': far } as CSSProperties} aria-hidden>
          <div className="dr-road"><span className="dr-fill" /><span className="dr-car"><BrandGlyph /></span></div>
        </div>
        <Q h={ob.change ? t('Changing the draft') : t('Writing your plan')} sub={t('It takes a minute or two. You can leave this page: it keeps going, and the draft waits for you here.')} />
        <ol className="wz-phases">
          {PHASES.map((x, n) => (
            <li key={x.k} className={n < at ? 'done' : n === at ? 'cur' : ''}>
              <span className="wz-ph-m" aria-hidden>{n < at ? <Check size={12} strokeWidth={2.6} /> : n === at ? <span className="wz-ph-road" /> : null}</span>
              <span className="wz-ph-t">{t(x.l)}
                {x.k === 'writing' && n === at && (p?.units ?? 0) > 0 && <span className="wz-ph-d">{t('{n} units so far', { n: p!.units })}</span>}
              </span>
            </li>
          ))}
        </ol>
        {(p?.tracks.length ?? 0) > 0 && (
          <div className="wz-found" aria-label={t('Tracks')}>{p!.tracks.map((x) => <span key={x} className="wz-found-t">{x}</span>)}</div>
        )}
        <p className="wz-note mono">{Math.floor(sec / 60)}:{String(sec % 60).padStart(2, '0')}</p>
        {ob.change && <p className="wz-note"><b>{t('Your change:')}</b> {ob.change}</p>}
      </div>
    </Sheet>
  )
}

/** the mark, small: it rides the road while the plan is written */
function BrandGlyph() {
  return (
    <svg viewBox="0 0 760 760" aria-hidden>
      <polygon points="380,63 543,169 543,294 380,193 217,294 217,169" />
      <polygon points="6,307 140,219 140,493 219,539 219,373 334,311 334,626 216,698 6,575" />
      <polygon points="754,307 620,219 620,493 541,539 541,373 426,311 426,626 544,698 754,575" />
    </svg>
  )
}

// ------------------------------------------------------------- reading the draft
// changes people often ask for, one click each; they go into the box, where they can be edited before asking
const ASKS = ['Lighter Fridays', 'No study on weekends', 'Shorter days', 'More practice problems', 'More time for review before the deadline'] as const

function Review({ ob, ctx, replacing }: { ob: Onboarding; ctx: Ctx; replacing: string | null }) {
  const d = ob.draft!
  const p = d.plan
  const [change, setChange] = useState('')
  const [busy, run] = useBusy()
  const [which, setWhich] = useState('')
  const [open, setOpen] = useState<Record<string, boolean>>(() => ({ [p.tracks[0]?.key ?? '']: true }))
  const act = (w: string, fn: () => Promise<unknown>) => { setWhich(w); return run(fn) }
  const approve = async () => {
    const ok = await ctx.confirm({
      title: t('Approve this plan?'),
      body: replacing
        ? t('It replaces the plan you follow now. Days you already worked on stay as they are; days ahead are planned again from this plan. A copy of the database is kept first.')
        : t('The app starts planning your days from it. You can change the plan later in Settings → Plan.'),
      action: t('Approve'), danger: !!replacing,
    })
    if (!ok) return
    act('approve', async () => {
      const r = await ctx.run(api.approvePlan())
      if (r) { forget(); ctx.notify(t('Plan approved. The first days are being planned.'), 'ok'); ctx.refresh(); ctx.go({ kind: 'day', date: ctx.meta?.today ?? '' }) }
    })
  }
  const askRef = useRef<HTMLTextAreaElement>(null)
  // the box grows with what is written, up to a limit; then it scrolls
  const grow = (el: HTMLTextAreaElement) => { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 260)}px` }
  const add = (line: string) => {
    const next = change.trim() ? `${change.trim().replace(/[.;]?$/, ';')} ${line.charAt(0).toLocaleLowerCase(getLang())}${line.slice(1)}` : line
    setChange(next)
    const el = askRef.current
    if (el) { el.value = next; grow(el); el.focus(); el.setSelectionRange(next.length, next.length) }
  }
  const ask = () => {
    if (!change.trim()) return
    act('change', async () => { const r = await ctx.run(api.changeDraft(change.trim())); if (r) { setChange(''); ctx.refresh() } })
  }
  const setUnit = (track: string, unit: number, on: boolean) =>
    act('unit', async () => { const r = await ctx.run(api.setDraftUnit(track, unit, on)); if (r) ctx.refresh() })
  const discard = async () => {
    const ok = await ctx.confirm({ title: t('Discard this draft?'), body: t('Your answers stay filled in; the draft is thrown away.'), action: t('Discard'), danger: true })
    if (ok) act('discard', async () => { const r = await ctx.run(api.discardDraft()); if (r) ctx.refresh() })
  }
  const goal = ob.answers?.goal
  const deadline = p.deadline || ob.answers?.deadline
  const weeksTo = (end: string) => Math.floor((Date.parse(end) - Date.parse(p.start_date)) / (7 * 864e5)) + 1
  const late = !!(p.end_date && deadline && deadline.length === 10 && p.end_date > deadline)
  return (
    <div className="page focus setup-page">
      <div className="head">
        <div className="head-l">
          <h1 className="title">{t('Your draft is ready')}</h1>
          <div className="sub">{t('Read it through. Ask for changes until it fits, then approve it; nothing is planned before that.')}</div>
        </div>
      </div>
      <section className="card sec draft-head">
        <h2 className="draft-title">{p.label}</h2>
        {p.summary && <p className="draft-sum">{p.summary}</p>}
        {goal && (
          <div className="draft-goal">
            <span className="draft-goal-l">{t('Goal')}</span>
            <span className="draft-goal-v">{goal}</span>
            {deadline && <span className="draft-goal-d mono">{deadline.length === 10 ? longDate(deadline) : monthLabel(deadline)}</span>}
          </div>
        )}
        <dl className="draft-facts">
          <div><dt>{t('Starts')}</dt><dd>{longDate(p.start_date)}</dd></div>
          {p.end_date && <div title={t('If every unit check passes the first time; a retake moves it later.')}>
            <dt>{t('Last unit')}</dt>
            <dd className={late ? 'warn' : undefined}>{longDate(p.end_date)} <span className="t3 mono">· {t('{n} weeks', { n: weeksTo(p.end_date) })}</span></dd>
          </div>}
          {deadline && deadline.length === 10 ? <div><dt>{t('Deadline')}</dt><dd>{longDate(deadline)}</dd></div>
            : <div title={t('Add a goal date in the questions and the units are sized to finish before it.')}><dt>{t('Deadline')}</dt><dd className="t3">{t('None: the plan goes at your pace')}</dd></div>}
          <div><dt>{t('Study days')}</dt><dd>{p.study_weekdays.map((x) => wds(x)).join(' · ')}</dd></div>
          <div><dt>{t('A week')}</dt><dd className="mono">{fmtH(weekMinutes(p))}</dd></div>
          <div><dt>{t('Unit check')}</dt><dd className="mono">≥{p.thresholds.unit_quiz?.threshold ?? 4}/{p.thresholds.unit_quiz?.max ?? 5}</dd></div>
        </dl>
      </section>
      <section className="card sec">
        <h2 className="sec-h">{t('Exam dates')}<span className="meta">{t('optional')}</span></h2>
        <ExamDates tracks={p.tracks} start={p.start_date} today={ctx.meta!.today} busy={busy && which === 'change'} ends={p.track_ends}
          note={t('Separate exams? Give each course its date: the draft is written again so each course ends a few days before its own exam, and the nearest exam gets priority.')}
          action={t('Redraft with these dates')}
          onSave={(dates) => act('change', async () => {
            const text = 'Exam dates per course: ' + p.tracks.map((x) => `${x.label}: ${(x.key in dates ? dates[x.key] : x.deadline) || 'no exam'}`).join('; ')
              + '. Set each track\'s deadline to its date and size it to end a few days before it.'
            const r = await ctx.run(api.changeDraft(text)); if (r) ctx.refresh()
          })} />
      </section>
      {d.notes.length > 0 && (
        <section className="card sec">
          <h2 className="sec-h">{t('Check these')}<span className="meta">{d.notes.length}</span></h2>
          <ul className="draft-notes">{d.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
        </section>
      )}
      {(p.goals.length > 0 || p.roadmap.length > 0) && (
        <section className="card sec">
          <h2 className="sec-h">{t('Goals and milestones')}</h2>
          {p.goals.length > 0 && <ul className="draft-goals">{p.goals.map((g, i) => <li key={i}><b>{g.label}</b><span className="mono">{g.target}</span>{g.note && <span className="t3">{g.note}</span>}</li>)}</ul>}
          {p.roadmap.length > 0 && <ol className="draft-road">{p.roadmap.map((m, i) => <li key={i}><span className="mono t3">{m.start === m.end ? monthLabel(m.start) : `${monthLabel(m.start)} – ${monthLabel(m.end)}`}</span><span>{m.items.join('; ')}</span></li>)}</ol>}
        </section>
      )}
      <WeekGrid p={p} />
      <section className="card sec">
        <h2 className="sec-h">{t('Tracks')}<span className="meta">{t('{n} units', { n: p.tracks.reduce((s, x) => s + x.units.filter((u) => !u.skip).length, 0) })}</span></h2>
        <p className="sec-sub">{t('Untick a unit to take it out of the plan. It stays in the list, so you can tick it again; the end date follows.')}</p>
        <div className="draft-tracks">
          {p.tracks.map((tr, ti) => {
            const on = !!open[tr.key]
            return (
              <div key={tr.key} className={'draft-track' + (on ? ' open' : '')}>
                <button type="button" className="draft-track-h" aria-expanded={on} onClick={() => setOpen((o) => ({ ...o, [tr.key]: !on }))}>
                  {on ? <ChevronDown size={16} strokeWidth={1.6} /> : <ChevronRight size={16} strokeWidth={1.6} />}
                  <span className={'trk-dot trk-' + (ti % 6)} aria-hidden />{tr.label}<span className="t3 mono">{tr.units.filter((u) => !u.skip).length}</span>
                </button>
                {on && (
                  <div className="draft-track-b">
                    {tr.goal && <p className="set-note">{tr.goal}</p>}
                    <ol className="draft-units">
                      {tr.units.map((u, i) => (
                        <li key={i} className={u.skip ? 'du-out' : undefined}>
                          <div className="du-h">
                            <span className="du-t">{u.title}</span>
                            <span className="t3 mono">{u.skip ? t('taken out') : u.sessions > 1 ? t('{n} sessions', { n: u.sessions }) : t('1 session')}</span>
                            <Checkbox className="du-cb" checked={!u.skip} disabled={busy || (!u.skip && tr.units.filter((x) => !x.skip).length <= 1)}
                              label={u.skip ? t('Put {unit} back into the plan', { unit: u.title }) : t('Take {unit} out of the plan', { unit: u.title })}
                              title={!u.skip && tr.units.filter((x) => !x.skip).length <= 1 ? t('A course keeps at least one unit') : undefined}
                              onChange={(on) => setUnit(tr.key, i, on)} />
                          </div>
                          {u.objective && <div className="du-o">{u.objective}</div>}
                          {u.resources.length > 0 && <div className="du-r">{u.resources.map((r, j) => r.href
                            ? <a key={j} href={r.href} target="_blank" rel="noreferrer"><ExternalLink size={12} strokeWidth={1.6} />{r.label}</a>
                            : <span key={j}><BookMarked size={12} strokeWidth={1.6} />{r.label}</span>)}</div>}
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </section>
      <section className="card sec">
        <h2 className="sec-h">{t('Something to change?')}</h2>
        <p className="sec-sub">{t('Say it in your own words. The model rewrites the draft and you read it again; nothing is saved until you approve.')}</p>
        <div className={'ask-box' + (busy && which === 'change' ? ' working' : '')}>
          <textarea ref={askRef} className="ask-in" rows={2} value={change} maxLength={2000} aria-label={t('What should change')}
            onChange={(e) => { setChange(e.target.value); grow(e.currentTarget) }}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ask() } }}
            placeholder={t('e.g. No study on Saturdays; start analysis with Abbott, not Rudin; more time for algorithms')} />
          <div className="ask-foot">
            <div className="ask-chips" role="group" aria-label={t('Common changes')}>
              {ASKS.map((a) => (
                <button key={a} type="button" className="ask-chip" disabled={busy || undefined} onClick={() => add(t(a))}>{t(a)}</button>
              ))}
            </div>
            <button type="button" className="btn sm" {...busyProps(busy && which === 'change')} disabled={busy || !change.trim() || undefined} onClick={ask}>
              <Sparkles size={14} strokeWidth={1.6} /><span>{t('Ask for these changes')}</span><kbd className="ask-kbd">Ctrl ↵</kbd>
            </button>
          </div>
        </div>
        <div className="draft-acts">
          <button type="button" className="btn ghost" {...busyProps(busy && which === 'discard')} disabled={busy || undefined} onClick={discard}><RotateCcw size={14} strokeWidth={1.6} /><span>{t('Start over')}</span></button>
          <button type="button" className="btn primary lg" {...busyProps(busy && which === 'approve')} disabled={busy || undefined} onClick={approve}><Check size={15} strokeWidth={1.8} /><span>{t('Approve this plan')}</span></button>
        </div>
      </section>
    </div>
  )
}

const weekMinutes = (p: DraftPlan) => p.week.reduce((s, day) => s + day.filter((b) => b.kind !== 'break').reduce((x, b) => x + mins(b.end) - mins(b.start), 0), 0)

/** The weekly template: one column per study day, blocks to scale. */
export function WeekGrid({ p }: { p: DraftPlan }) {
  const days = p.study_weekdays
  const all = days.flatMap((d) => p.week[d] ?? [])
  if (!all.length) return null
  const lo = Math.min(...all.map((b) => mins(b.start))), hi = Math.max(...all.map((b) => mins(b.end)))
  const span = Math.max(60, hi - lo)
  const idx: Record<string, number> = Object.fromEntries(p.tracks.map((tr, i) => [tr.key, i]))
  return (
    <section className="card sec">
      <h2 className="sec-h">{t('Weekly schedule')}<span className="meta">{`${String(Math.floor(lo / 60)).padStart(2, '0')}:${String(lo % 60).padStart(2, '0')} – ${String(Math.floor(hi / 60)).padStart(2, '0')}:${String(hi % 60).padStart(2, '0')}`}</span></h2>
      <div className="week-grid" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
        {days.map((d) => (
          <div key={d} className="wg-col">
            <div className="wg-h">{wds(d)}</div>
            <div className="wg-body" style={{ height: Math.round(span * 0.9) }}>
              {(p.week[d] ?? []).map((b, i) => {
                const k = b.kind === 'break' ? 'brk' : b.kind === 'test' ? 'tst' : 'trk-' + ((idx[b.kind] ?? 0) % 6)
                return (
                  <div key={i} className={'wg-b ' + k} style={{ top: `${((mins(b.start) - lo) / span) * 100}%`, height: `${((mins(b.end) - mins(b.start)) / span) * 100}%` }}
                    title={`${b.start}–${b.end} ${b.title}`}>
                    {b.kind !== 'break' && <><span className="wg-t">{b.title}</span><span className="wg-m mono">{b.start}</span></>}
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
