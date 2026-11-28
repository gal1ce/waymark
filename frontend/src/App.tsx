import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  ChevronRight, CircleAlert, Copy, Flame, House,
  MessageSquareText, Monitor, Moon, Settings as SettingsIcon, Sun, UserRound, Zap,
} from 'lucide-react'
import {
  CalendarBlank as PhCalendar, CalendarCheck as PhToday, ClipboardText as PhTests, House as PhHome, Notebook as PhNotes,
  NotePencil as PhNewChat, SidebarSimple as PhSidebar, TrendUp as PhProgress,
} from '@phosphor-icons/react'
import { api, ApiError, fmtDate, fmtDur, setWeekBase, type Day, type Meta, type Notice, type Overview, type UpdateInfo, type Xp } from './api'
import Dashboard from './Dashboard'
import DayView from './DayView'
import CalendarView from './CalendarView'
import ProgressView from './ProgressView'
import ProfileView from './ProfileView'
import TestPage, { TestsList } from './TestPage'
import { KhanTestPage } from './Khan'
import Reader from './Reader'
import BeejPage from './BeejPage'
import { AskPopup, CoachAvatar, CoachPanel, CoachWindow, Recents, startNewChat, type Grab } from './Coach'
import NixPage from './Nix'
import Tip from './Tip'
import Notes from './Notes'
import SettingsView from './SettingsView'
import Setup from './Setup'
import { UpdateScreen } from './Update'
import { Scrollbar } from './Scrollbar'
import { useLayout, useTheme, type Layout, type ThemePref } from './prefs'
import { t, t as tApp, tx, useLang, type Lang } from './i18n'
import { ConfirmDialog, NoticeBell, Toasts, type ConfirmOpts, type Toast } from './Notices'

export type View =
  | { kind: 'nix'; id?: number } | { kind: 'dash' } | { kind: 'day'; date: string } | { kind: 'calendar'; month?: string } | { kind: 'progress' }
  | { kind: 'tests' } | { kind: 'test'; id: number } | { kind: 'profile' } | { kind: 'khanTest'; id: number }
  | { kind: 'notes'; id?: number } | { kind: 'settings'; section?: string; sub?: string } | { kind: 'setup' } | { kind: 'beej'; page: string; sec?: string }

export type Ctx = {
  /** a toast; warnings and errors are also kept in the notification history */
  notify: (text: string, tone?: Toast['tone'], body?: string) => void
  /** the app's own confirm dialog */
  confirm: (o: ConfirmOpts) => Promise<boolean>
  run: <T>(p: Promise<T>) => Promise<T | undefined>
  go: (v: View) => void
  openReader: (path: string) => void
  refresh: () => void
  ask: (context: string, at?: { x: number; y: number }) => void
  setExam: (on: boolean) => void
  tick: number
  version: number
  meta: Meta | null
  ov: Overview | null
  today: Day | null
  todayDate: string
  theme: ThemePref
  setTheme: (p: ThemePref) => void
  layout: Layout
  setLayout: (p: Partial<Layout>) => void
  lang: Lang
  setLang: (l: Lang) => void
  /** a page names what's open on it, for the top bar's trail */
  setCrumb: (c: string | null) => void
  /** opens the update screen (Settings → Updates) */
  showUpdate: (u: UpdateInfo) => void
}

// ------------------------------------------------------------- hash routing
const toHash = (v: View): string => {
  switch (v.kind) {
    case 'nix': return v.id ? `#/nix/${v.id}` : '#/nix'
    case 'dash': return '#/overview'
    case 'day': return `#/day/${v.date}`
    case 'calendar': return v.month ? `#/calendar/${v.month}` : '#/calendar'
    case 'progress': return '#/progress'
    case 'tests': return '#/tests'
    case 'test': return `#/test/${v.id}`
    case 'khanTest': return `#/khan-test/${v.id}`
    case 'profile': return '#/profile'
    case 'notes': return v.id ? `#/notes/${v.id}` : '#/notes'
    case 'settings': return v.section ? `#/settings/${v.section}` + (v.sub ? `/${v.sub}` : '') : '#/settings'
    case 'setup': return '#/setup'
    case 'beej': return `#/beej/${v.page}` + (v.sec ? `/${v.sec}` : '')
  }
}
export const fromHash = (h: string): View => {
  const [, a, b, c] = h.replace(/^#/, '').split('/')
  // old Turkish routes still resolve
  if ((a === 'day' || a === 'gun') && b) return { kind: 'day', date: b }
  if (a === 'calendar' || a === 'takvim') return { kind: 'calendar', month: b }
  if (a === 'progress' || a === 'ilerleme') return { kind: 'progress' }
  if (a === 'tests' || a === 'testler') return { kind: 'tests' }
  if (a === 'test' && b) return { kind: 'test', id: Number(b) }
  if (a === 'khan-test' && b) return { kind: 'khanTest', id: Number(b) }
  if (a === 'profile' || a === 'profil' || a === 'gecmis') return { kind: 'profile' }
  if (a === 'today' || a === 'bugun') return { kind: 'day', date: '' }
  if (a === 'notes') return { kind: 'notes', id: b ? Number(b) : undefined }
  if (a === 'settings') return { kind: 'settings', section: b, sub: c }
  if (a === 'setup') return { kind: 'setup' }
  if (a === 'beej' && b) return { kind: 'beej', page: b, sec: c }
  // the app opens on the coach; #/overview is Home
  if (!a || a === 'nix') return { kind: 'nix', id: b ? Number(b) || undefined : undefined }
  return { kind: 'dash' }
}

const store = {
  get: (k: string, d: boolean) => { try { const v = localStorage.getItem(k); return v == null ? d : v === '1' } catch { return d } },
  set: (k: string, v: boolean) => { try { localStorage.setItem(k, v ? '1' : '0') } catch { /* private mode */ } },
}

const num = {
  get: (k: string, d: number) => { try { const v = Number(localStorage.getItem(k)); return Number.isFinite(v) && v > 0 ? v : d } catch { return d } },
  set: (k: string, v: number) => { try { localStorage.setItem(k, String(Math.round(v))) } catch { /* private mode */ } },
}
const COACH_W = 400
const clampCoach = (w: number) => Math.min(Math.max(320, Math.min(820, window.innerWidth * 0.6)), Math.max(300, w))

function Resizer({ edge, onDrag, onReset, onStep, label }: { edge: 'left' | 'right'; onDrag: (dx: number, phase: 'start' | 'move' | 'end') => void; onReset: () => void; onStep: (d: number) => void; label: string }) {
  return (
    <div className={'resizer ' + edge} role="separator" aria-orientation="vertical" aria-label={label} tabIndex={0}
      title={label + ' · drag, double-click to reset'}
      onDoubleClick={onReset}
      onKeyDown={(e) => { if (e.key === 'ArrowLeft') { e.preventDefault(); onStep(-16) } if (e.key === 'ArrowRight') { e.preventDefault(); onStep(16) } }}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        const el = e.currentTarget, x0 = e.clientX
        el.setPointerCapture(e.pointerId)
        onDrag(0, 'start')
        const move = (ev: PointerEvent) => onDrag(ev.clientX - x0, 'move')
        const up = (ev: PointerEvent) => { onDrag(ev.clientX - x0, 'end'); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up) }
        el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up)
      }} />
  )
}

const typing = (el: EventTarget | null) => el instanceof HTMLElement && (el.closest('input, textarea, select, [contenteditable="true"]') != null)

type Menu = { x: number; y: number; context: string; selection: string }
type Ask = { x: number; y: number; context: string }

export default function App() {
  const [meta, setMeta] = useState<Meta | null>(null)
  const [ov, setOv] = useState<Overview | null>(null)
  const [today, setToday] = useState<Day | null>(null)
  const [view, setView] = useState<View>(() => fromHash(location.hash))
  // where "Back to the app" in Settings returns to: the last page that wasn't a settings one
  useEffect(() => { if (view.kind !== 'settings') try { sessionStorage.setItem('ctu.lastPage', location.hash || '#/') } catch { /* private window */ } }, [view])
  const [toasts, setToasts] = useState<Toast[]>([])
  const [reader, setReader] = useState<string | null>(null)
  const [coachOpen, setCoachOpen] = useState(() => store.get('ctu.coach', false))
  // the coach as a floating window instead of a column beside the page
  const [coachFloat, setCoachFloat] = useState(() => store.get('ctu.coachFloat', false))
  const [grab, setGrab] = useState<Grab | null>(null)   // the panel was just dragged off the side: the window follows on
  // the side: a wide sidebar (new chat, the pages, recent conversations) or the slim rail of icons
  const [navWide, setNavWide] = useState(() => store.get('ctu.navWide', true))
  const wide = useWide()
  // below this width a docked coach panel and the full sidebar leave the page a strip: the sidebar shows its icons
  // only while the panel is open (the saved choice stays; the toggle still opens it for now)
  const roomy = useWide('(min-width: 1180px)')
  const [navPeek, setNavPeek] = useState(false)
  useEffect(() => store.set('ctu.navWide', navWide), [navWide])
  const [coachW, setCoachW] = useState(() => num.get('ctu.coachW', COACH_W))
  const [resizing, setResizing] = useState(false)
  const drag0 = useRef(0)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [askAt, setAskAt] = useState<Ask | null>(null)
  const [exam, setExam] = useState(false)
  const [tick, setTick] = useState(0)
  const [version, setVersion] = useState(0)
  const [theme, setTheme] = useTheme()
  const [layout, setLayout] = useLayout()
  const [lang, setLang] = useLang()
  const [crumb, setCrumb] = useState<string | null>(null)
  // a newer version of the packaged program: asked once when the app opens (backend/app/updates.py)
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  useEffect(() => {
    let off = false
    api.update().then((u) => { if (!off && u.show && u.latest) setUpdate(u) }).catch(() => {})
    return () => { off = true }
  }, [])
  const mainRef = useRef<HTMLElement>(null)
  const fetchedAt = useRef(0)
  useEffect(() => { fetchedAt.current = Date.now() }, [today])

  const todayDate = ov ? (ov.today < ov.start_date ? ov.start_date : ov.today) : ''

  const closeToast = useCallback((id: number) => {
    setToasts((t) => t.map((x) => (x.id === id ? { ...x, out: true } : x)))
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 200)
  }, [])
  const toast = useCallback((t: Omit<Toast, 'id'>) => {
    let id = Date.now() + Math.random()
    setToasts((all) => {
      // the same message again bumps a counter on the one already showing
      const same = all.find((x) => !x.out && x.title === t.title && x.body === t.body)
      if (same) { id = same.id; return all.map((x) => (x === same ? { ...x, n: (x.n ?? 1) + 1 } : x)) }
      return [...all, { ...t, id }]
    })
    const life = t.tone === 'err' ? 8000 : t.tone === 'warn' ? 6000 : 4200
    setTimeout(() => closeToast(id), life)
  }, [closeToast])
  const notify = useCallback((text: string, tone: Toast['tone'] = 'info', body?: string) => {
    toast({ title: text, body, tone })
    if (tone === 'warn' || tone === 'err') api.noticeAdd({ title: text, body, tone }).catch(() => {})
  }, [toast])
  const [asking, setAsking] = useState<{ opts: ConfirmOpts; resolve: (ok: boolean) => void } | null>(null)
  const confirm = useCallback((opts: ConfirmOpts) => new Promise<boolean>((resolve) => setAsking({ opts, resolve })), [])
  useEffect(() => {
    const on = (e: Event) => { const d = (e as CustomEvent<{ text: string; tone?: Toast['tone'] }>).detail; if (d?.text) notify(d.text, d.tone) }
    window.addEventListener('ctu:notify', on)
    return () => window.removeEventListener('ctu:notify', on)
  }, [notify])
  const run = useCallback(async <T,>(p: Promise<T>) => {
    try { return await p } catch (e) { notify(e instanceof ApiError ? tx(e.message) : String(e), 'err'); return undefined }
  }, [notify])
  const refresh = useCallback(() => setVersion((v) => v + 1), [])
  const go = useCallback((v: View) => {
    const h = toHash(v)
    if (location.hash !== h) location.hash = h
    setView(v)
    setCrumb(null)
    mainRef.current?.scrollTo({ top: 0 })
  }, [])

  useEffect(() => {
    const on = () => { setView(fromHash(location.hash)); setCrumb(null) }
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  useEffect(() => store.set('ctu.coach', coachOpen), [coachOpen])
  useEffect(() => store.set('ctu.coachFloat', coachFloat), [coachFloat])
  // full-screen sheets (unit test, practice, video) are portalled to <body>: tell them where the coach panel is,
  // so "Open in panel" from a test shows the panel beside the sheet instead of behind it
  useEffect(() => {
    const b = document.body
    b.classList.toggle('coach-on', coachOpen && !coachFloat && view.kind !== 'nix')
    b.dataset.coach = layout.coach
    b.style.setProperty('--sheet-coach', `min(${clampCoach(coachW)}px, 50vw)`)
  }, [coachOpen, coachFloat, coachW, layout.coach, view.kind])
  useEffect(() => num.set('ctu.coachW', coachW), [coachW])

  // shared data: meta, overview, today's day (used by the top bar, dashboard and coach)
  useEffect(() => {
    let off = false
    Promise.all([api.meta(), api.overview(), api.today()]).then(([m, o, d]) => { if (!off) { setWeekBase(m.plan?.key); setMeta(m); setOv(o); setToday(d) } }).catch(() => {})
    return () => { off = true }
  }, [version])

  useEffect(() => {
    const es = new EventSource('/api/stream')
    let t: number | undefined
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        // generation progress is frequent and only the test page cares: hand it over, don't refetch everything
        if (msg.kind === 'test_progress') { window.dispatchEvent(new CustomEvent('ctu:test-progress', { detail: msg.data })); return }
        // the server's notices: a toast for the ones it raised (the page's own were already shown), and the bell refreshes
        if (msg.kind === 'notice') {
          const n = msg.data as Notice
          if (n.source === 'app') toast({ title: n.title, body: n.items.length > 1 ? n.items.slice(-3).join(' · ') : n.body, tone: n.tone, link: n.link })
          window.dispatchEvent(new CustomEvent('ctu:notices', { detail: 'new' }))
          return
        }
        if (msg.kind === 'notices') { window.dispatchEvent(new CustomEvent('ctu:notices')); return }
        if (msg.kind === 'paused_away') notify(tApp('The running task was paused: no activity for 30 minutes (laptop asleep or the app closed)'), 'warn')
      } catch { /* ignore */ }
      clearTimeout(t); t = window.setTimeout(refresh, 250)
    }
    return () => es.close()
  }, [notify, toast, refresh])

  useEffect(() => { const i = setInterval(() => setTick((x) => x + 1), 1000); return () => clearInterval(i) }, [])

  // activity heartbeat: tells the monitor the user is here
  useEffect(() => {
    let active = false
    const mark = () => { active = true }
    const evs = ['keydown', 'mousemove', 'scroll', 'click']
    evs.forEach((e) => window.addEventListener(e, mark, { passive: true, capture: true }))
    // every 30 s: 'input' when the user did something; otherwise a plain ping that the app is still open, so a
    // running timer keeps counting while it is (and stops counting when the laptop sleeps)
    const i = setInterval(() => { api.heartbeat(active && document.visibilityState === 'visible').catch(() => {}); active = false }, 30000)
    return () => { evs.forEach((e) => window.removeEventListener(e, mark, { capture: true })); clearInterval(i) }
  }, [])

  // keyboard: ] coach, Esc closes floating things
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setMenu(null); setAskAt(null); return }
      if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === ']') { e.preventDefault(); setCoachOpen((o) => !o) }
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [])

  const ask = useCallback((context: string, at?: { x: number; y: number }) => {
    const x = at?.x ?? window.innerWidth / 2 - 200, y = at?.y ?? 120
    setMenu(null); setAskAt({ x, y, context })
  }, [])

  // right click anywhere in the content: "Ask the coach". Shift + right click keeps the browser menu.
  const onContext = (e: React.MouseEvent) => {
    if (e.shiftKey || typing(e.target)) return
    const el = e.target as HTMLElement
    const sel = window.getSelection()?.toString().trim() ?? ''
    const tagged = el.closest<HTMLElement>('[data-ask]')?.dataset.ask ?? ''
    const near = (el.closest<HTMLElement>('.task, .card, li, tr, p') ?? el).innerText?.trim().replace(/\s+/g, ' ').slice(0, 280) ?? ''
    e.preventDefault()
    setAskAt(null)
    setMenu({ x: e.clientX, y: e.clientY, selection: sel, context: sel || tagged || near })
  }

  const ctx: Ctx = {
    notify, confirm, run, go, openReader: setReader, refresh, ask, setExam, tick, version, meta, ov, today, todayDate, theme, setTheme, layout, setLayout, lang, setLang, setCrumb, showUpdate: setUpdate,
  }
  const current = today?.status === 'active' ? today.current ?? null : null
  const pane = (v: View): ReactNode => {
    if (v.kind === 'day') return <DayView date={v.date || todayDate} ctx={ctx} />
    if (v.kind === 'test') return <TestPage id={v.id} ctx={ctx} version={version} />
    if (v.kind === 'khanTest') return <KhanTestPage id={v.id} ctx={ctx} />
    if (v.kind === 'notes') return <Notes id={v.id} ctx={ctx} />
    if (v.kind === 'tests') return <TestsList ctx={ctx} version={version} />
    if (v.kind === 'calendar') return <CalendarView month={v.month} ctx={ctx} />
    if (v.kind === 'progress') return <ProgressView ctx={ctx} />
    if (v.kind === 'beej') return <BeejPage page={v.page} sec={v.sec} ctx={ctx} />
    return <Dashboard ctx={ctx} />
  }
  const noPlan = !!meta && !meta.plan.ready
  const onNix = view.kind === 'nix' && !noPlan
  const sideCoach = coachOpen && !onNix && !coachFloat
  const navOpen = navWide && (roomy || !sideCoach || navPeek)
  const floatCoach = coachOpen && !onNix && coachFloat

  const ph = { size: 20 }
  const nav: { label: string; icon: ReactNode; v: View; on: boolean }[] = [
    { label: meta?.coach_name || t('Coach'), icon: <CoachAvatar ctx={ctx} size="nav" />, v: { kind: 'nix' }, on: view.kind === 'nix' },
    { label: t('Home'), icon: <PhHome {...ph} />, v: { kind: 'dash' }, on: view.kind === 'dash' },
    { label: t('Today'), icon: <PhToday {...ph} />, v: { kind: 'day', date: todayDate }, on: view.kind === 'day' && (!view.date || view.date === todayDate) },
    { label: t('Calendar'), icon: <PhCalendar {...ph} />, v: { kind: 'calendar' }, on: view.kind === 'calendar' || (view.kind === 'day' && !!view.date && view.date !== todayDate) },
    { label: t('Tests'), icon: <PhTests {...ph} />, v: { kind: 'tests' }, on: view.kind === 'tests' || view.kind === 'test' || view.kind === 'khanTest' },
    { label: t('Notes'), icon: <PhNotes {...ph} />, v: { kind: 'notes' }, on: view.kind === 'notes' },
    { label: t('Progress'), icon: <PhProgress {...ph} />, v: { kind: 'progress' }, on: view.kind === 'progress' },
  ]
  const extra: Record<string, string> = { profile: t('Profile'), settings: t('Settings'), setup: t('Plan setup'), beej: t("Beej's Guide to C") }
  const page = nav.find((n) => n.on)?.label ?? extra[view.kind] ?? ''
  const sub = crumb ?? (view.kind === 'day' && view.date && view.date !== todayDate ? fmtDate(view.date)
    : view.kind === 'test' ? t('Test {n}', { n: view.id }) : view.kind === 'khanTest' ? t('Unit test') : null)

  const runningSec = current ? current.spent_sec_live + Math.max(0, Math.floor((Date.now() - fetchedAt.current) / 1000)) : 0
  const runningPill = current && (
    <button className="running" onClick={() => go({ kind: 'day', date: todayDate })} title={t('Running task')}>
      <span className="dot accent" />
      <span className="running-t">{current.title}</span>
      <span className="mono">{fmtDur(runningSec)}</span>
    </button>
  )

  return (
    <div className={`shell nav-${layout.nav}${navOpen ? ' nav-wide' : ''} coach-${layout.coach}${sideCoach ? ' coach-on' : ''}${resizing ? ' resizing' : ''}`}
      style={{ '--coach-w': `${sideCoach ? clampCoach(coachW) : coachW}px` } as React.CSSProperties}>
      <header className="topbar">
        <button className="wordmark" onClick={() => go({ kind: 'dash' })} aria-label={t('Waymark, home')}>
          <BrandMark /><span className="wm-text">Way<em>mark</em></span>
        </button>
        {page && (
          <nav className="crumbs" aria-label={t('You are here')}>
            {view.kind !== 'dash' && view.kind !== 'nix' && <><button onClick={() => go({ kind: 'dash' })}><House size={14} strokeWidth={1.6} />{t('Home')}</button><ChevronRight size={13} strokeWidth={1.6} /></>}
            {sub ? (
              <>
                <button onClick={() => go(nav.find((n) => n.on)?.v ?? (view.kind === 'notes' ? { kind: 'notes' } : view.kind === 'settings' ? { kind: 'settings' } : view))}>{page}</button>
                <ChevronRight size={13} strokeWidth={1.6} /><span className="here">{sub}</span>
              </>
            ) : <span className="here">{page}</span>}
          </nav>
        )}
        <div className="topbar-r">
          {meta?.fake_clock && <span className="demo-chip" title={t('CTU_NOW is set: this server works on copies, not your real data')}>{t('Demo clock')}</span>}
          {!wide && runningPill}
          <Counters version={version} />
          {!onNix && (
            <button className={'btn ghost sm pill coach-toggle' + (coachOpen ? ' on' : '')} onClick={() => setCoachOpen((o) => !o)} aria-pressed={coachOpen} title={t('Coach panel  ]')}>
              <MessageSquareText size={15} strokeWidth={1.6} /><span className="ct-l">{meta?.coach_name || t('Coach')}</span>
            </button>
          )}
          <NoticeBell version={version} confirm={confirm} go={(link) => { location.hash = link }} />
          <AvatarMenu ctx={ctx} />
        </div>
      </header>

      <aside className="side" aria-label={t('Navigation')}>
        {/* the sidebar's own top: the brand and the toggle, on the top bar's line; collapsed, the toggle shows on hover */}
        <div className="side-top">
          <button className="wordmark side-brand" onClick={() => go({ kind: 'dash' })} aria-label={t('Waymark, home')} tabIndex={navOpen ? 0 : -1}>
            <BrandMark /><span className="wm-text">Way<em>mark</em></span>
          </button>
          <button className="icon-btn side-toggle" onClick={() => { setNavWide(!navOpen); setNavPeek(!navOpen) }} aria-label={navOpen ? t('Collapse the sidebar') : t('Expand the sidebar')} title={navOpen ? t('Collapse the sidebar') : t('Expand the sidebar')}>
            <PhSidebar size={20} />
          </button>
        </div>
        {!noPlan && (
          <button className="nav-row nav-new" onClick={() => { go({ kind: 'nix' }); startNewChat() }} title={t('New chat')}>
            <PhNewChat {...ph} /><span className="nav-label">{t('New chat')}</span>
          </button>
        )}
        <nav className="nav">
          {nav.map((n) => (
            <button key={n.label} className={'nav-row' + (n.on ? ' on' : '')} title={navOpen ? undefined : n.label}
              aria-current={n.on ? 'page' : undefined} onClick={() => go(n.v)}>
              {n.icon}<span className="nav-label">{n.label}</span>
            </button>
          ))}
        </nav>
        {!noPlan && <Recents ctx={ctx} active={view.kind === 'nix' ? view.id ?? null : null} onOpen={(id) => go({ kind: 'nix', id })} />}
        {wide && (
          <div className="side-foot">
            {current && (
              <button className="side-now" onClick={() => go({ kind: 'day', date: todayDate })} title={current.title}>
                <span className="side-now-i"><span className="dot accent" /></span>
                <span className="side-now-b">
                  <span className="side-now-l">{t('Running task')}</span>
                  <span className="side-now-t">{current.title}</span>
                </span>
                <span className="side-now-c mono">{fmtDur(runningSec)}</span>
              </button>
            )}
          </div>
        )}
      </aside>

      <div className="center">
        {sideCoach && (
          <Resizer edge={layout.coach} label={t('Resize coach panel')}
            onReset={() => setCoachW(COACH_W)}
            onStep={(d) => setCoachW((w) => clampCoach(clampCoach(w) + (layout.coach === 'left' ? d : -d)))}
            onDrag={(dx, ph) => {
              if (ph === 'start') { drag0.current = clampCoach(coachW); setResizing(true); return }
              setCoachW(clampCoach(drag0.current + (layout.coach === 'left' ? dx : -dx)))
              if (ph === 'end') setResizing(false)
            }} />
        )}
        <main className={'main' + (onNix ? ' main-nix' : '')} ref={mainRef} onContextMenu={onContext}>
          <Warnings meta={meta} ctx={ctx} />
          {/* a new install has no plan yet: the pages that show one ask for it to be set up first */}
          {(view.kind === 'setup' || (noPlan && (view.kind === 'nix' || view.kind === 'dash' || view.kind === 'day' || view.kind === 'calendar'))) && <Setup ctx={ctx} />}
          {onNix && <NixPage ctx={ctx} current={current} hasKey={!!meta?.has_api_key} locked={exam} render={pane} openId={view.kind === 'nix' ? view.id : undefined} />}
          {!noPlan && view.kind === 'dash' && <Dashboard ctx={ctx} />}
          {!noPlan && view.kind === 'day' && todayDate && <DayView date={view.date || todayDate} ctx={ctx} />}
          {!noPlan && view.kind === 'calendar' && <CalendarView month={view.month} ctx={ctx} />}
          {view.kind === 'progress' && <ProgressView ctx={ctx} />}
          {view.kind === 'tests' && <TestsList ctx={ctx} version={version} />}
          {view.kind === 'test' && <TestPage id={view.id} ctx={ctx} version={version} />}
          {view.kind === 'khanTest' && <KhanTestPage id={view.id} ctx={ctx} />}
          {view.kind === 'profile' && <ProfileView ctx={ctx} />}
          {view.kind === 'notes' && <Notes id={view.id} ctx={ctx} />}
          {view.kind === 'settings' && <SettingsView section={view.section} sub={view.sub} ctx={ctx} />}
          {view.kind === 'beej' && <BeejPage page={view.page} sec={view.sec} ctx={ctx} />}
        </main>
        <Scrollbar key={view.kind + ('id' in view ? String(view.id) : '')} target={mainRef} />
      </div>

      {sideCoach && <CoachPanel ctx={ctx} current={current} hasKey={!!meta?.has_api_key} locked={exam} onClose={() => setCoachOpen(false)} onFloat={() => { setGrab(null); setCoachFloat(true) }}
        onTearOff={(g) => { setGrab(g); setCoachFloat(true) }} />}
      {floatCoach && <CoachWindow ctx={ctx} current={current} hasKey={!!meta?.has_api_key} locked={exam} grab={grab}
        onClose={() => setCoachOpen(false)} onFloat={() => { setGrab(null); setCoachFloat(false) }}
        onDock={(side) => { setGrab(null); setCoachFloat(false); if (side !== layout.coach) setLayout({ coach: side }) }} />}

      {menu && (
        <>
          <div className="menu-scrim" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null) }} />
          <CtxMenu x={menu.x} y={menu.y}>
            <button role="menuitem" onClick={() => ask(menu.context, { x: menu.x, y: menu.y })}>
              <MessageSquareText size={14} strokeWidth={1.5} />{t('Ask {name}', { name: meta?.coach_name || t('the coach') })}
              {menu.context && <span className="ctx-peek">{menu.context.slice(0, 48)}</span>}
            </button>
            {menu.selection && (
              <button role="menuitem" onClick={() => { navigator.clipboard?.writeText(menu.selection).catch(() => {}); setMenu(null) }}>
                <Copy size={14} strokeWidth={1.5} />{t('Copy')}
              </button>
            )}
            <div className="ctx-foot">{t('Shift + right click for the browser menu')}</div>
          </CtxMenu>
        </>
      )}
      {askAt && (
        <AskPopup at={askAt} ctx={ctx} page={page} current={current} hasKey={!!meta?.has_api_key} exam={exam}
          onClose={() => setAskAt(null)} onOpenPanel={() => { setAskAt(null); setCoachOpen(true) }} />
      )}

      {reader && <Reader path={reader} onClose={() => setReader(null)} />}
      <Toasts toasts={toasts} close={closeToast} open={(link) => { location.hash = link }} />
      {asking && <ConfirmDialog opts={asking.opts} done={(ok) => { asking.resolve(ok); setAsking(null) }} />}
      <Tip />
      {update?.latest && <UpdateScreen info={update} onClose={() => setUpdate(null)} />}
    </div>
  )
}

/** Streak and XP in one pill. A gain floats up out of it; clicking opens the level and the recent gains. */
function Counters({ version }: { version: number }) {
  const [xp, setXp] = useState<Xp | null>(null)
  const [streak, setStreak] = useState<number | null>(null)
  const [gain, setGain] = useState<{ n: number; k: number } | null>(null)
  const [open, setOpen] = useState(false)
  const last = useRef<number | null>(null)
  const wrap = useDismiss(open, useCallback(() => setOpen(false), []))
  const load = useCallback(() => {
    api.xp().then((x) => {
      if (last.current != null && x.total > last.current) setGain({ n: x.total - last.current, k: Date.now() })
      last.current = x.total
      setXp(x)
    }).catch(() => {})
  }, [])
  useEffect(() => { load(); api.dashboard().then((d) => setStreak(d.streak)).catch(() => {}) }, [version, load])
  useEffect(() => { window.addEventListener('ctu:xp', load); return () => window.removeEventListener('ctu:xp', load) }, [load])
  if (!xp) return null
  const max = Math.max(1, ...xp.week.map((d) => d.xp))
  return (
    <div className="counters-wrap" ref={wrap}>
      <button className="counters" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={t('Streak {n} days, {x} XP', { n: streak ?? 0, x: xp.total })}>
        <span className="counter streak"><Flame size={15} strokeWidth={1.8} />{streak ?? 0}</span>
        <span className="counter xp"><Zap size={14} strokeWidth={1.8} />{xp.total}</span>
        {gain && <span key={gain.k} className="xp-float" onAnimationEnd={() => setGain(null)}>+{gain.n}</span>}
      </button>
      {open && (
        <>
          <div className="menu-scrim" onClick={() => setOpen(false)} />
          <div className="pop xp-pop" role="dialog" aria-label={t('Experience')}>
            <div className="xp-lv">
              <span className="xp-badge">{xp.level}</span>
              <div className="grow">
                <div className="xp-lv-t">{t('Level {n}', { n: xp.level })}</div>
                <div className="xp-bar"><span style={{ width: `${(100 * xp.into) / xp.span}%` }} /></div>
                <div className="xp-lv-n mono">{t('{a} / {b} XP to level {n}', { a: xp.into, b: xp.span, n: xp.level + 1 })}</div>
              </div>
            </div>
            <div className="xp-week" aria-label={t('XP over the last 7 days')}>
              {xp.week.map((d) => (
                <div key={d.date} className="xp-day" title={`${fmtDate(d.date)}: ${d.xp} XP`}>
                  <span style={{ height: `${Math.max(4, (100 * d.xp) / max)}%` }} className={d.xp ? '' : 'zero'} />
                  <i>{t('SMTWTFS')[new Date(d.date + 'T12:00:00').getDay()]}</i>
                </div>
              ))}
            </div>
            <div className="xp-today"><span>{t('Today')}</span><b className="mono">+{xp.today} XP</b></div>
            {xp.recent.length > 0 && (
              <ul className="xp-recent">
                {xp.recent.slice(0, 6).map((g, i) => (
                  <li key={i}><span className="grow">{g.label}</span><span className="mono">+{g.xp}</span></li>
                ))}
              </ul>
            )}
            <div className="xp-foot">{t('Tasks 20 · first-try answers 5 · mastered exercises 25 · test answers 10 · passed units 100 · closed days 30')}</div>
          </div>
        </>
      )}
    </div>
  )
}

/** A popover closes on Escape and on a click anywhere outside it. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close() }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close() } }
    document.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key, true)
    return () => { document.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key, true) }
  }, [open, close])
  return ref
}

/** Desktop width: the sidebar is a column (not the phone's tab bar), so the account and counters live at its foot. */
function useWide(q = '(min-width: 861px)') {
  const [wide, setWide] = useState(() => window.matchMedia(q).matches)
  useEffect(() => {
    const m = window.matchMedia(q)
    const on = () => setWide(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [q])
  return wide
}

function AvatarMenu({ ctx }: { ctx: Ctx }) {
  const [open, setOpen] = useState(false)
  // who is signed in: the GitHub profile when the user chose it, otherwise the local account
  const [gh, setGh] = useState<{ name: string; login?: string; avatar: string | null } | null>(null)
  useEffect(() => {
    api.profile().then((p) => {
      if (p.github && p.me.github === 'on') setGh({ name: p.github.name ?? p.github.login, login: p.github.login, avatar: p.github.avatar_url })
      else setGh(p.me.name || p.me.photo ? { name: p.me.name, avatar: p.me.photo } : null)
    }).catch(() => {})
  }, [ctx.version])
  const pick = (v: View) => { setOpen(false); ctx.go(v) }
  const wrap = useDismiss(open, useCallback(() => setOpen(false), []))
  const themes: { k: ThemePref; label: string; icon: ReactNode }[] = [
    { k: 'system', label: t('System'), icon: <Monitor size={14} strokeWidth={1.6} /> },
    { k: 'light', label: t('Light'), icon: <Sun size={14} strokeWidth={1.6} /> },
    { k: 'dark', label: t('Dark'), icon: <Moon size={14} strokeWidth={1.6} /> },
  ]
  return (
    <div className="avatar-wrap" ref={wrap}>
      <button className="avatar-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={t('Account menu')}>
        {gh?.avatar ? <img src={gh.avatar} alt="" /> : gh?.name.trim() ? gh.name.trim()[0].toUpperCase() : <UserRound size={16} strokeWidth={1.6} />}
      </button>
      {open && (
        <>
          <div className="menu-scrim" onClick={() => setOpen(false)} />
          <div className="pop acct-pop" role="menu">
            <div className="acct-id">
              <b>{gh?.name || t('You')}</b>
              {gh?.login && <span className="mono">@{gh.login}</span>}
            </div>
            <button role="menuitem" onClick={() => pick({ kind: 'profile' })}><UserRound size={16} strokeWidth={1.6} />{t('Profile')}</button>
            <button role="menuitem" onClick={() => pick({ kind: 'settings' })}><SettingsIcon size={16} strokeWidth={1.6} />{t('Settings')}</button>
            <div className="acct-theme">
              <span>{t('Theme')}</span>
              <div className="seg">
                {themes.map((x) => (
                  <button key={x.k} className={ctx.theme === x.k ? 'on' : ''} onClick={() => ctx.setTheme(x.k)} aria-pressed={ctx.theme === x.k}>{x.icon}{x.label}</button>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/** The Waymark mark (traced from waymark_light_logo.png; also public/waymark-light.svg and -dark.svg). It is drawn in
 *  the page's ink colour, so it follows the theme, System switching included, with no second asset to swap. */
export function BrandMark({ className = 'brand-mark' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 760 760" aria-hidden>
      <polygon points="380,63 543,169 543,294 380,193 217,294 217,169" />
      <polygon points="6,307 140,219 140,493 219,539 219,373 334,311 334,626 216,698 6,575" />
      <polygon points="754,307 620,219 620,493 541,539 541,373 426,311 426,626 544,698 754,575" />
    </svg>
  )
}

/** Context menu kept inside the viewport; it scales in from the point that was clicked. */
function CtxMenu({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth, h = el.offsetHeight
    setPos({
      left: x + w + 8 > window.innerWidth ? Math.max(8, x - w) : x,
      top: y + h + 8 > window.innerHeight ? Math.max(8, y - h) : y,
    })
  }, [x, y])
  useEffect(() => { ref.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus({ preventScroll: true }) }, [])
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLElement)
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
  }
  return (
    <div ref={ref} className="ctxmenu" role="menu" onKeyDown={onKey}
      style={{ left: pos.left, top: pos.top, transformOrigin: `${x - pos.left}px ${y - pos.top}px` }}>
      {children}
    </div>
  )
}

/** The one problem that shows over every page: a day that couldn't be closed (the plan stops moving until it is).
    Every other warning is in the bell and in Settings → System health. */
function Warnings({ meta, ctx }: { meta: Meta | null; ctx: Ctx }) {
  const ws = Object.entries(meta?.warnings ?? {}).filter(([k]) => k.startsWith('close_'))
  if (!ws.length) return null
  return (
    <div className="warnbar" role="status">
      {ws.map(([k, w]) => (
        <div key={k} className="warnrow">
          <CircleAlert size={15} strokeWidth={1.5} />
          <span>{w.message}</span>
          <button className="link" onClick={() => ctx.go({ kind: 'settings', section: 'health' })}>{t('Details')}</button>
        </div>
      ))}
    </div>
  )
}
