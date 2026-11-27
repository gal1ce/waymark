import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useDrag } from './drag'
import Markdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkMath from 'remark-math'
import {
  ArrowUp, Check, Copy, History, ImageUp, Lock, PanelRightOpen, PenLine, Pencil, Plus, RotateCcw, Settings2, ShieldCheck, Square, Trash2, X,
} from 'lucide-react'
import { api, ApiError, fmtDate, streamChat, type ChatBody, type ChatMsg, type CoachSettings, type Convo, type Effort, type ReplyLanguage, type GenLive, type StreamEv, type Task } from './api'
import type { Ctx } from './App'
import { fixMathInMd, rehypeGluePunct } from './mathtex'
import { GenLog } from './genlog'
import { MD_CODE } from './codefmt'
import { squareAvatar } from './picture'
import { t as tr, tx, type Key } from './i18n'
import { Scrollbar } from './Scrollbar'
import { Slider } from './controls'
import { Grid, Group, Row, useSaved } from './settingsui'
import { NixFly, Topo } from './Scenery'

// ------------------------------------------------------------------ active conversation (per day, per browser)
const CONVO_KEY = 'ctu.convo'
const CONVO_EV = 'ctu:convo'
function storedConvo(today: string | undefined): number | null {
  try {
    const [d, id] = (localStorage.getItem(CONVO_KEY) ?? '').split(':')
    return d && d === today && Number(id) > 0 ? Number(id) : null
  } catch { return null }
}
function storeConvo(today: string | undefined, id: number | null) {
  try { if (id && today) localStorage.setItem(CONVO_KEY, `${today}:${id}`); else localStorage.removeItem(CONVO_KEY) } catch { /* private mode */ }
}
const NEW_EV = 'ctu:newchat'
const LIST_EV = 'ctu:convos'
/** The sidebar's "New chat": the Nix page starts a fresh conversation. */
export function startNewChat() { requestAnimationFrame(() => window.dispatchEvent(new Event(NEW_EV))) }

/** Tell an open panel to switch to this conversation (used by the right-click popup). */
export function showConvo(today: string | undefined, id: number) {
  storeConvo(today, id)
  window.dispatchEvent(new CustomEvent(CONVO_EV, { detail: id }))
}

// ------------------------------------------------------------------ markdown with direct links
/** App links (#/day/…, #/test/3, #/read/<file>) navigate inside the app; anything else opens in a new tab. */
/** On the Nix page, links to the app's own pages open beside the chat: the handler says whether it took the link. */
export const AppLinkCtx = createContext<((href: string) => boolean) | null>(null)

export function CoachMd({ text, ctx, onNav }: { text: string; ctx: Ctx; onNav?: () => void }) {
  const take = useContext(AppLinkCtx)
  return (
    <Markdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex, rehypeGluePunct]} components={{
      ...MD_CODE,
      a: ({ href = '', children }) => {
        if (href.startsWith('#/')) {
          return <a href={href} className="app-link" onClick={(e) => {
            if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return
            e.preventDefault()
            if (href.startsWith('#/read/')) ctx.openReader(decodeURIComponent(href.slice(7)))
            else if (!take?.(href)) location.hash = href
            onNav?.()
          }}>{children}</a>
        }
        if (!/^https?:\/\//i.test(href)) return <>{children}</>
        return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
      },
    }}>{fixMathInMd(text)}</Markdown>
  )
}

// ------------------------------------------------------------------ thinking indicator
const FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']
const VERBS = [
  'Thinking', 'Pondering', 'Bending the universe', 'Consulting the syllabus', 'Untangling pointers', 'Sharpening pencils',
  'Reading the fine print', 'Checking the thresholds', 'Brewing an answer', 'Asking the rubber duck', 'Herding semicolons',
  'Compiling thoughts', 'Warming up neurons', 'Counting to 4/5', 'Dereferencing ideas', 'Balancing the B+tree',
  'Factoring the question', 'Flipping through Beej', 'Choosing words carefully', 'Squinting at the problem',
]

function useReducedMotion() {
  const q = '(prefers-reduced-motion: reduce)'
  const [r, setR] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(q).matches)
  useEffect(() => {
    const m = window.matchMedia?.(q)
    if (!m) return
    const f = () => setR(m.matches)
    m.addEventListener('change', f)
    return () => m.removeEventListener('change', f)
  }, [])
  return r
}

export type Draft = { text: string; phase: 'thinking' | 'tool' | 'running' | 'writing'; label?: string; since: number; tests?: { id: number; live: GenLive | null }[] }

export function Thinking({ phase, label, since, name }: { phase: Draft['phase']; label?: string; since: number; name: string }) {
  const reduce = useReducedMotion()
  const [f, setF] = useState(0)
  const [v, setV] = useState(() => Math.floor(Math.random() * VERBS.length))
  const [, setNow] = useState(0)
  useEffect(() => {
    if (reduce) return
    const i = setInterval(() => setF((x) => (x + 1) % FRAMES.length), 120)
    return () => clearInterval(i)
  }, [reduce])
  useEffect(() => {
    if (reduce || phase !== 'thinking') return
    const i = setInterval(() => setV((x) => (x + 1 + Math.floor(Math.random() * (VERBS.length - 1))) % VERBS.length), 2600)
    return () => clearInterval(i)
  }, [reduce, phase])
  useEffect(() => { const i = setInterval(() => setNow((x) => x + 1), 1000); return () => clearInterval(i) }, [])
  const secs = Math.max(0, Math.floor((Date.now() - since) / 1000))
  const text = phase === 'thinking' || phase === 'writing' ? (reduce ? tx('Thinking') : tx(VERBS[v])) : (label ? tx(label) : tx('Working'))
  const real = phase === 'tool' || phase === 'running'
  return (
    <div className={'thinking' + (real ? ' real' : '')} role="status">
      <span className="sr-only">{name} is {real ? label : 'thinking'}</span>
      <span className="spin" aria-hidden="true">{reduce ? '✻' : FRAMES[f]}</span>
      <span key={text} className="thinking-l" aria-hidden="true">{text}…</span>
      <span className="thinking-t mono" aria-hidden="true">{secs}s</span>
    </div>
  )
}

// A turn lives outside the components, so closing and reopening the panel mid-reply keeps the stream.
type Turn = { draft: Draft | null; pending: ChatMsg | null; userId: number | null; convo?: number }
const NONE: Turn = { draft: null, pending: null, userId: null }
const turns = new Map<string, Turn>()
const ctls = new Map<string, AbortController>()
const subs = new Set<() => void>()
const getTurn = (k: string) => turns.get(k) ?? NONE
const patchTurn = (k: string, f: (t: Turn) => Turn) => { turns.set(k, f(getTurn(k))); subs.forEach((s) => s()) }
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f) } }
/** A reply streaming into this conversation from somewhere else (the right-click popup), so the panel can show it. */
const otherKey = (key: string, convo: number | null): string | null => {
  if (convo == null) return null
  for (const [k, t] of turns) if (k !== key && t.draft && t.convo === convo) return k
  return null
}

/** Runs one streamed turn. The caller calls end() once it has put the result on screen. */
function useTurn(ctx: Ctx, key: string) {
  const t = useSyncExternalStore(subscribe, () => getTurn(key))
  const notify = useRef(ctx.notify); notify.current = ctx.notify
  const run = useCallback(async (body: ChatBody, pending: ChatMsg | null, onStart?: (convo: number, userId: number) => void): Promise<{ reply: string; convo_id: number } | null> => {
    const ac = new AbortController(); ctls.set(key, ac)
    patchTurn(key, () => ({ draft: { text: '', phase: 'thinking', since: Date.now() }, pending, userId: null }))
    const setDraft = (f: (d: Draft) => Draft) => patchTurn(key, (x) => ({ ...x, draft: x.draft && f(x.draft) }))
    const on = (ev: StreamEv) => {
      if (ev.type === 'start') { patchTurn(key, (x) => ({ ...x, userId: ev.user_id, convo: ev.convo_id })); onStart?.(ev.convo_id, ev.user_id) }
      else if (ev.type === 'status') setDraft((d) => ({ ...d, phase: ev.phase, label: ev.label }))
      else if (ev.type === 'test') setDraft((d) => ({ ...d, tests: [...(d.tests ?? []).filter((x) => x.id !== ev.id), { id: ev.id, live: ev.live }] }))
      else if (ev.type === 'delta') setDraft((d) => ({ ...d, text: d.text + ev.text, phase: 'writing' }))
      else if (ev.type === 'replace') setDraft((d) => ({ ...d, text: ev.text, phase: 'writing' }))
      else if (ev.type === 'done') setDraft((d) => ({ ...d, text: ev.reply, phase: 'writing' }))
    }
    try {
      return await streamChat(body, on, ac.signal)
    } catch (e) {
      if ((e as Error).name !== 'AbortError') notify.current(e instanceof ApiError ? e.message : String(e), 'warn')
      return null
    } finally {
      ctls.delete(key)
    }
  }, [key])
  const end = useCallback(() => { turns.delete(key); subs.forEach((s) => s()) }, [key])
  const stop = useCallback(() => ctls.get(key)?.abort(), [key])
  return { draft: t.draft, pending: t.pending, userId: t.userId, run, stop, end }
}

/** The coach's face: the picture set in its settings, or Nix the firefly on a night-blue disc. */
export function CoachAvatar({ ctx, size, busy }: { ctx: Ctx; size?: 'xs' | 'sm' | 'nav' | 'big' | 'hero'; busy?: boolean }) {
  const src = ctx.meta?.coach_avatar
  const [broken, setBroken] = useState<string | null>(null)
  const pic = src && broken !== src
  return (
    <span className={'coach-av' + (size ? ' ' + size : '') + (busy ? ' busy' : '') + (pic ? ' pic' : ' mascot')} aria-hidden>
      {pic ? <img src={src} alt="" draggable={false} onError={() => setBroken(src)} /> : <img src="/nix/avatar.webp" alt="" draggable={false} />}
    </span>
  )
}

/** While a reply streams, an unfinished link or formula is held back so the raw `[text](http…` or `$x^` never shows. */
function settle(text: string): string {
  let t = text.replace(/\[([^\]\n]*)\]\([^)\s]*\s*$/, '$1').replace(/\[([^\]\n]*)$/, '$1')
  const dollars = (t.match(/(?<!\\)\$/g) ?? []).length
  if (dollars % 2) t = t.slice(0, t.lastIndexOf('$')).replace(/\$$/, '')
  return t
}

function DraftView({ draft, name, ctx }: { draft: Draft; name: string; ctx: Ctx }) {
  const shown = settle(draft.text)
  return (
    <div className="msg assistant streaming">
      <CoachAvatar ctx={ctx} size="sm" busy />
      <div className="msg-b">
        {draft.tests?.map((t) => <GenLog key={t.id} id={t.id} init={t.live} compact />)}
        {shown && <div className="md"><CoachMd text={shown} ctx={ctx} /></div>}
        {draft.phase !== 'writing' || !shown
          ? <Thinking phase={draft.phase} label={draft.label} since={draft.since} name={name} />
          : <span className="caret" aria-hidden="true" />}
      </div>
    </div>
  )
}

function RuleLine({ current, locked, short, ctx }: { current: Task | null; locked?: boolean; short?: boolean; ctx?: Ctx }) {
  const [asking, setAsking] = useState(false)
  const mins = current ? Math.floor(current.spent_sec_live / 60) : 0
  const early = current?.meta?.explain_early != null
  const hintLeft = current && current.learning && !early ? Math.max(0, 30 - mins) : 0
  const why = tr('While a learning task runs, the coach spends its first 30 minutes on guiding questions and points you to the right part of the source, so you try it yourself first; then it also explains the concept. "Explain now" opens explanations early. With no task running it explains directly. It never writes the solution to your own exercise or the code for you.')
  const explainNow = () => {
    if (!current || !ctx) return
    setAsking(true)
    ctx.run(api.explainNow(current.id)).then((r) => { if (r) { ctx.notify(tr('Explanations are open for this task')); ctx.refresh() } }).finally(() => setAsking(false))
  }
  if (short) return (
    <div className="rule short" title={why}>
      <ShieldCheck size={13} strokeWidth={1.5} />
      <span>{!current
        ? tr('No task running: the coach explains directly · never your exercise solutions')
        : hintLeft ? tr('Task running: guiding questions · explanations in {n} min · never the solution', { n: hintLeft })
        : early ? tr('Task running: explanations open (you asked early) · never the solution')
        : tr('Task running: guiding questions and explanations · never the solution')}</span>
      {hintLeft > 0 && ctx && <button className="mini rule-act" disabled={asking} onClick={explainNow}
        title={tr('Open concept explanations now instead of in {n} min. Trying first helps you remember, so use it when you are really stuck.', { n: hintLeft })}>{tr('Explain now')}</button>}
    </div>
  )
  return (
    <div className="rule">
      <ShieldCheck size={14} strokeWidth={1.5} />
      <span>
        {locked ? <>{tr('Test in progress: closed book. Ask from the test for a rule or formula')}</> : <>
          {tr("The coach doesn't write exercise solutions or code.")}{' '}
          {current
            ? hintLeft ? tr('Right now it asks guiding questions and points you to the source; concept explanations open in {n} min.', { n: hintLeft }) : tr('Concept explanations are open for this task')
            : tr('With no task running it explains directly; during a task, explanations open 30 min in.')}
        </>}
      </span>
    </div>
  )
}

// ------------------------------------------------------------------ small pieces
function Confirm({ onYes, label, icon }: { onYes: () => void; label: string; icon?: React.ReactNode }) {
  const [ask, setAsk] = useState(false)
  useEffect(() => { if (!ask) return; const t = setTimeout(() => setAsk(false), 3000); return () => clearTimeout(t) }, [ask])
  return ask
    ? <button className="mini danger" onClick={() => { setAsk(false); onYes() }}>{tr('Delete?')}</button>
    : <button className="mini" onClick={() => setAsk(true)} title={label} aria-label={label}>{icon ?? <Trash2 size={13} strokeWidth={1.5} />}</button>
}

function CopyBtn({ text }: { text: string }) {
  const [ok, setOk] = useState(false)
  return (
    <button className="mini" title={tr('Copy')} aria-label={tr('Copy')} onClick={() => {
      navigator.clipboard?.writeText(text).then(() => { setOk(true); setTimeout(() => setOk(false), 1200) }).catch(() => {})
    }}>{ok ? <Check size={13} strokeWidth={1.75} /> : <Copy size={13} strokeWidth={1.5} />}</button>
  )
}

const dayLabel = (ds: string, today: string) => {
  if (ds === today) return tr('Today')
  const y = new Date(today + 'T12:00:00'); y.setDate(y.getDate() - 1)
  if (Number.isNaN(y.getTime())) return fmtDate(ds)   // today not loaded yet
  if (ds === y.toISOString().slice(0, 10)) return tr('Yesterday')
  return fmtDate(ds)
}

// ------------------------------------------------------------------ conversation list
/** The sidebar's recent conversations: grouped by day, rename and delete on hover; opening one goes to the Nix page. */
export function Recents({ ctx, active, onOpen }: { ctx: Ctx; active: number | null; onOpen: (id: number) => void }) {
  const [list, setList] = useState<Convo[]>([])
  const load = useCallback(() => { api.convos().then((x) => setList(x.convos)).catch(() => {}) }, [])
  useEffect(() => { load() }, [load, ctx.version])
  useEffect(() => { window.addEventListener(LIST_EV, load); return () => window.removeEventListener(LIST_EV, load) }, [load])
  if (!list.length) return null
  return (
    <div className="side-recents" aria-label={tr('Recent conversations')}>
      <div className="side-recents-h">{tr('Recents')}</div>
      <ConvoList list={list} today={ctx.meta?.today ?? ''} active={active} ctx={ctx} reload={() => { load(); window.dispatchEvent(new Event(LIST_EV)) }} onOpen={onOpen} onNew={() => {}} hideNew />
    </div>
  )
}

function ConvoList({ list, today, active, onOpen, onNew, ctx, reload, hideNew }: {
  list: Convo[]; today: string; active: number | null; onOpen: (id: number) => void; onNew: () => void; ctx: Ctx; reload: () => void; hideNew?: boolean
}) {
  const [edit, setEdit] = useState<{ id: number; title: string } | null>(null)
  const groups = useMemo(() => {
    const m = new Map<string, Convo[]>()
    for (const c of list) m.set(c.date, [...(m.get(c.date) ?? []), c])
    return [...m.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1))
  }, [list])
  const rename = async () => {
    if (!edit) return
    const t = edit.title.trim()
    setEdit(null)
    if (t) { await ctx.run(api.renameConvo(edit.id, t)); reload() }
  }
  return (
    <div className="convos">
      {!hideNew && <button className="btn sm convo-new" onClick={onNew}><Plus size={14} strokeWidth={1.5} />{tr('New chat for today')}</button>}
      {groups.length === 0 && <div className="empty">{tr('No conversations yet')}</div>}
      {groups.map(([d, cs]) => (
        <div key={d} className="convo-group">
          <div className="convo-day">{dayLabel(d, today)}</div>
          {cs.map((c) => (
            <div key={c.id} className={'convo-row' + (c.id === active ? ' on' : '')}>
              {edit?.id === c.id ? (
                <form className="convo-edit" onSubmit={(e) => { e.preventDefault(); rename() }}>
                  <input className="input" autoFocus value={edit.title} maxLength={80} aria-label={tr('Conversation title')}
                    onChange={(e) => setEdit({ ...edit, title: e.target.value })} onBlur={rename}
                    onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setEdit(null) } }} />
                </form>
              ) : (
                <button className="convo-open" onClick={() => onOpen(c.id)}>
                  <span className="convo-title">{c.title || 'Untitled'}</span>
                  <span className="convo-meta mono">{c.count} · {c.updated_at.slice(11, 16)}</span>
                </button>
              )}
              <div className="convo-act">
                <button className="mini" title={tr('Rename')} aria-label={tr('Rename')} onClick={() => setEdit({ id: c.id, title: c.title })}><Pencil size={13} strokeWidth={1.5} /></button>
                <Confirm label={tr('Delete conversation')} onYes={async () => { await ctx.run(api.delConvo(c.id)); if (storedConvo(ctx.meta?.today) === c.id) storeConvo(ctx.meta?.today, null); reload() }} />
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

// ------------------------------------------------------------------ settings

function AvatarField({ ctx }: { ctx: Ctx }) {
  const name = ctx.meta?.coach_name || 'Coach'
  const has = !!ctx.meta?.coach_avatar
  const [busy, setBusy] = useState(false)
  const choose = () => {
    const inp = document.createElement('input')
    inp.type = 'file'; inp.accept = 'image/png,image/jpeg,image/webp,image/gif'
    inp.onchange = async () => {
      const f = inp.files?.[0]
      if (!f) return
      setBusy(true)
      try { await api.coachAvatar(await squareAvatar(f)); ctx.refresh() }
      catch (e) { ctx.notify(tr('The picture wasn\'t saved: {e}', { e: (e as Error).message }), 'err') }
      finally { setBusy(false) }
    }
    inp.click()
  }
  return (
    <Row label={tr('Picture')} hint={tr('Shown next to {name}\'s replies. Any image; it\'s cut to a circle', { name })}>
      <span className="av-row">
        <CoachAvatar ctx={ctx} size="big" busy={busy} />
        <button type="button" className="btn sm" onClick={choose} disabled={busy}><ImageUp size={14} strokeWidth={1.6} />{has ? tr('Change') : tr('Upload')}</button>
        {has && <button type="button" className="btn ghost sm" disabled={busy} onClick={async () => { if (await ctx.run(api.coachAvatarDelete())) ctx.refresh() }}>{tr('Remove')}</button>}
      </span>
    </Row>
  )
}

/** The coach's settings, saved the moment they change (a text when you leave the box, the reply length when the
    slider stops). Shown in Settings → Coach and in the coach panel's own settings. */
export function CoachSettingsView({ ctx, split }: { ctx: Ctx; split?: boolean }) {
  type Form = { name: string; personality: string; verbosity: number; effort: Effort; language: ReplyLanguage }
  const [s, setS] = useState<CoachSettings | null>(null)
  const [form, setForm] = useState<Form>({ name: '', personality: '', verbosity: 2, effort: 'low', language: 'auto' })
  const [note, setNote] = useState('')
  const [edit, setEdit] = useState<{ id: number; text: string } | null>(null)
  const [saved, markSaved] = useSaved()
  const timer = useRef<number>(0)
  const ids = useId()
  const load = useCallback((x: CoachSettings) => { setS(x); setForm({ name: x.name, personality: x.personality, verbosity: x.verbosity, effort: x.effort, language: x.language }) }, [])
  useEffect(() => { api.coach().then(load).catch(() => {}) }, [load])
  useEffect(() => () => window.clearTimeout(timer.current), [])
  if (!s) return <div className="settings" />
  const commit = async (patch: Partial<Form>) => {
    const next = { ...form, ...patch }
    setForm(next)
    if (!next.name.trim()) return
    const x = await ctx.run(api.saveCoach({ ...next, model: '' }))
    if (x) { load(x); markSaved(); ctx.refresh() }
  }
  const later = (patch: Partial<Form>) => {   // the slider: saved once it stops moving
    setForm((f) => ({ ...f, ...patch }))
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => commit(patch), 450)
  }
  const memo = async (p: Promise<CoachSettings>) => { const x = await ctx.run(p); if (x) setS(x); return x }
  const length = ['', 'terse', 'short', 'moderate', 'detailed', 'thorough']
  const nameGroup = (
      <Group title={tr('Name and picture')} saved={saved}>
        <AvatarField ctx={ctx} />
        <Row label={tr('Name')} htmlFor={ids + 'n'}>
          <input id={ids + 'n'} className="input sr-in" value={form.name} maxLength={32} onChange={(e) => setForm({ ...form, name: e.target.value })}
            onBlur={() => { if (!form.name.trim()) setForm({ ...form, name: s.name }); else if (form.name !== s.name) commit({}) }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
        </Row>
      </Group>
  )
  const repliesGroup = (
      <Group title={tr('How it replies')}>
        <Row label={<>{tr('Reply length')} <span className="t3">· {tx(length[form.verbosity])}</span></>} hint={s.verbosity_labels[String(form.verbosity)]} stack>
          <Slider label={tr('Reply length')} min={1} max={5} value={form.verbosity} valueText={length[form.verbosity]} onChange={(v) => later({ verbosity: v })} />
          <div className="range-ends t3"><span>{tr('Terse')}</span><span>{tr('Detailed')}</span></div>
        </Row>
        <Row label={tr('Reply language')} hint={tx(s.language_labels[form.language] ?? '')}>
          <div className="seg" role="radiogroup" aria-label={tr('Reply language')}>
            {(['auto', 'tr', 'en'] as ReplyLanguage[]).map((l) => (
              <button key={l} type="button" role="radio" aria-checked={form.language === l} className={form.language === l ? 'on' : ''}
                onClick={() => commit({ language: l })}>{{ auto: tr('Auto'), tr: 'Türkçe', en: 'English' }[l]}</button>
            ))}
          </div>
        </Row>
        <Row label={tr('Thinking')} hint={tx(s.effort_labels[form.effort] ?? '')} stack>
          <div className="seg" role="radiogroup" aria-label={tr('Thinking effort')}>
            {(['low', 'medium', 'high', 'xhigh', 'max'] as Effort[]).map((e) => (
              <button key={e} type="button" role="radio" aria-checked={form.effort === e} className={form.effort === e ? 'on' : ''}
                onClick={() => commit({ effort: e })}>{{ low: tr('Fast'), medium: tr('Balanced'), high: tr('Deep'), xhigh: tr('Deeper'), max: tr('Max') }[e]}</button>
            ))}
          </div>
        </Row>
        <Row label={tr('Personality')} htmlFor={ids + 'p'} hint={tr('Tone only. The core rules always win: no code or solutions, the 30-minute hint rule, thresholds')} stack>
          <textarea id={ids + 'p'} className="input" rows={3} maxLength={1200} value={form.personality}
            placeholder={tr('e.g. Dry humour, calls me out when I procrastinate, uses football analogies')}
            onChange={(e) => setForm({ ...form, personality: e.target.value })} onBlur={() => { if (form.personality !== s.personality) commit({}) }} />
        </Row>
        <Row label={tr('Model')} hint={tr('Each provider has its own coach model; choose it under AI providers.')}>
          <span className="sr-v mono">{s.provider ? `${s.provider} · ${s.model_active || tr('no model chosen')}` : tr('No AI provider is set up')}</span>
          <button type="button" className="btn ghost sm" onClick={() => ctx.go({ kind: 'settings', section: 'ai' })}>{tr('Change')}</button>
        </Row>
      </Group>
  )
  const memoryGroup = (
      <Group title={<>{tr('Memory')} <span className="t3 mono sg-count">{s.memory.length}/50</span></>}
        note={tr('Facts and preferences the coach keeps in mind in every conversation. You can also say "remember that…" in chat')}>
        {s.memory.length > 0 && (
          <div className="notes">
            {s.memory.map((n) => (
              <div key={n.id} className="note-row">
                {edit?.id === n.id ? (
                  <form className="note-edit" onSubmit={async (e) => { e.preventDefault(); if (await memo(api.editNote(n.id, edit.text))) setEdit(null) }}>
                    <textarea className="input" rows={2} autoFocus maxLength={400} value={edit.text} aria-label={tr('Edit note')}
                      onChange={(e) => setEdit({ ...edit, text: e.target.value })}
                      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setEdit(null) } }} />
                    <div className="inline-form">
                      <button type="button" className="btn ghost sm" onClick={() => setEdit(null)}>{tr('Cancel')}</button>
                      <button className="btn sm" disabled={!edit.text.trim()}>{tr('Save')}</button>
                    </div>
                  </form>
                ) : (
                  <>
                    <span className="note-t">{n.text}</span>
                    <div className="convo-act">
                      <button className="mini" title={tr('Edit')} aria-label={tr('Edit note')} onClick={() => setEdit({ id: n.id, text: n.text })}><Pencil size={13} strokeWidth={1.5} /></button>
                      <Confirm label={tr('Delete note')} onYes={() => memo(api.delNote(n.id))} />
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
        <form className="inline-form sg-add" onSubmit={async (e) => { e.preventDefault(); if (note.trim() && await memo(api.addNote(note))) setNote('') }}>
          <input className="input" value={note} maxLength={400} placeholder={tr('Add a note, e.g. I learn faster with diagrams')} aria-label={tr('New memory note')} onChange={(e) => setNote(e.target.value)} />
          <button className="btn sm" disabled={!note.trim()}><Plus size={14} strokeWidth={1.5} />{tr('Add')}</button>
        </form>
      </Group>
  )
  // Settings → Coach: what it says and remembers wide, who it is beside; the coach panel: one under the other
  if (split) return <Grid>{nameGroup}{repliesGroup}{memoryGroup}</Grid>
  return <div className="settings">{nameGroup}{repliesGroup}{memoryGroup}</div>
}

// ------------------------------------------------------------------ suggestions
type Sugg = { label: string; send?: string; fill?: string }

/** What to ask, from what's going on: the running task, open sticking points, the time of day. One click sends it;
 *  the ones that need a word from you fill the box instead. */
function suggestions(ctx: Ctx, current: Task | null): Sugg[] {
  const out: Sugg[] = []
  const day = ctx.today
  const tasks = (day?.blocks ?? []).flatMap((b) => b.tasks)
  const next = tasks.find((t) => t.status === 'todo')
  const stuck = (day?.stuck ?? []).filter((x) => !x.resolved)
  if (current) {
    out.push({ label: tr('What does “{t}” ask of me?', { t: current.title }), send: `I'm on "${current.title}". In plain words, what does this task ask me to do, and how should I start?` })
    out.push({ label: tr('I\'m stuck on this task'), fill: `I'm stuck on "${current.title}". Here's where: ` })
    out.push({ label: tr('Quiz me on it'), send: `Ask me 3 short questions, one at a time, to check I understood the topic of "${current.title}". Wait for my answer before the next.` })
  } else if (next) {
    out.push({ label: tr('Get me ready for “{t}”', { t: next.title }), send: `Next I'm starting "${next.title}". Before the formal version: what is the idea in plain words, with a concrete picture or numbers, and what do I need from earlier courses? Check that with one quick question. Keep it short.` })
  }
  if (stuck[0]) out.push({ label: tr('Work through: {t}', { t: stuck[0].summary }), send: `Help me understand my sticking point "${stuck[0].summary}". Don't give me the answer; ask me questions until I get it.` })
  out.push({ label: tr('What should I do now?'), send: 'Looking at my day so far, what should I do now, and why?' })
  out.push({ label: tr('How is my week going?'), send: 'How is my week going against the plan? Be honest, and name one thing to change.' })
  out.push({ label: tr('Explain a term'), fill: 'Explain this term simply, with one example: ' })
  return out.slice(0, 5)
}

const FOLLOW: { label: Key; send: string }[] = [
  { label: 'Simpler', send: 'Explain that more simply, with an everyday example.' },
  { label: 'Give an example', send: 'Show me one worked example of that idea (not my exercise), starting with the simplest concrete case.' },
  { label: 'Quiz me', send: 'Ask me one question to check I understood that.' },
  { label: 'In Turkish', send: 'Say that again in Turkish, keeping the maths terms in English in brackets.' },
]

const hello = () => { const h = new Date().getHours(); return tr(h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening') }

// ------------------------------------------------------------------ panel
/** Toggleable right panel: conversations, the streamed thread and the coach's settings. */
/** The empty box shows what you could ask: one example is typed out, held, then erased for the next, like someone
 *  thinking aloud. The first line is the plain prompt; with reduced motion it simply stays. */
function useTyping(lines: string[], on: boolean): string {
  const [text, setText] = useState(lines[0] ?? '')
  const key = lines.join('\n')
  useEffect(() => {
    setText(lines[0] ?? '')
    if (!on || lines.length < 2) return
    let i = 0, n = lines[0].length, dir = -1, t = 0
    const step = () => {
      if (dir < 0) {
        if (n > 0) { n--; setText(lines[i].slice(0, n)); t = window.setTimeout(step, 26) }
        else { i = (i + 1) % lines.length; dir = 1; t = window.setTimeout(step, 900) }
      } else if (n < lines[i].length) {
        n++; setText(lines[i].slice(0, n)); t = window.setTimeout(step, 55 + Math.random() * 70)
      } else { dir = -1; t = window.setTimeout(step, i === 0 ? 6000 : 4800) }
    }
    t = window.setTimeout(step, 5000)
    return () => window.clearTimeout(t)
  }, [key, on])  // eslint-disable-line react-hooks/exhaustive-deps
  return text
}

/** The typed-out example, in a component of its own: its many small updates must not re-render the panel, or React
 *  writes the box's value back on every frame and eats a character still being composed (ç, ş, dead keys, an IME). */
function TypeHint({ lines, on }: { lines: string[]; on: boolean }) {
  const text = useTyping(lines, on)
  return <div className="type-hint" aria-hidden="true">{text}<span className="type-caret" /></div>
}

function examples(name: string, current: Task | null): string[] {
  const out = [tr('Ask {name} anything…', { name })]
  if (current) out.push(tr('Get me ready for “{t}”', { t: current.title.split(' · ')[0] }))
  out.push(tr('Make me a practice test mixing equations and C pointers'), tr('Explain where my last unit test went wrong'),
    tr('Give me one hard problem on today’s topic, no hints'), tr('Move tomorrow’s C block to Friday'), tr('Sum up what I learned this week in five lines'))
  return out
}

export function CoachPanel({ ctx, current, hasKey, locked, onClose, page = false, onPreview, openId }: {
  ctx: Ctx; current: Task | null; hasKey: boolean; locked: boolean; onClose: () => void
  /** the Nix page: conversations on the left, the chat in the middle, what the coach made opens on the right */
  page?: boolean; onPreview?: (href: string) => void; openId?: number
}) {
  const today = ctx.meta?.today
  const name = ctx.meta?.coach_name || 'Coach'
  const [view, setView] = useState<'chat' | 'list' | 'settings'>('chat')
  // the Nix page opens on a new chat, like a fresh chat app; the side panel picks up where you left off
  const [cid, setCid] = useState<number | null>(() => (page ? null : storedConvo(today)))
  const [fresh, setFresh] = useState(page)
  const [list, setList] = useState<Convo[]>([])
  const [msgs, setMsgs] = useState<ChatMsg[]>([])
  const [text, setText] = useState('')
  const own = useTurn(ctx, 'panel')
  const { pending, userId, run, end: endTurn } = own
  // a question asked in the popup and continued here: show its reply as it streams
  const otherK = useSyncExternalStore(subscribe, () => otherKey('panel', fresh ? null : cid))
  const other = useSyncExternalStore(subscribe, () => (otherK ? getTurn(otherK) : NONE))
  const draft = own.draft ?? other.draft
  const stop = () => { own.stop(); if (otherK) ctls.get(otherK)?.abort() }
  const end = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const busy = draft != null
  const savedId = useRef<number | null>(null) // server id of the message being sent, once stored

  const open = useCallback((id: number | null) => { setCid(id); setFresh(id == null); storeConvo(today, id); setView('chat') }, [today])

  const reload = useCallback(() => {
    api.convos().then((x) => {
      setList(x.convos)
      window.dispatchEvent(new Event(LIST_EV))
      setCid((c) => {
        if (c != null && x.convos.some((k) => k.id === c)) return c
        return fresh ? null : x.default
      })
    }).catch(() => {})
  }, [fresh])

  useEffect(() => { reload() }, [ctx.version, reload])
  useEffect(() => {
    if (cid == null) { setMsgs([]); return }
    let off = false
    api.convo(cid).then((c) => { if (!off) setMsgs(c.messages) }).catch(() => { if (!off) setMsgs([]) })
    return () => { off = true }
  }, [cid, ctx.version])
  useEffect(() => {
    const f = (e: Event) => open((e as CustomEvent<number>).detail)
    window.addEventListener(CONVO_EV, f)
    return () => window.removeEventListener(CONVO_EV, f)
  }, [open])
  const wasBusy = useRef(busy)
  useEffect(() => {
    if (wasBusy.current && !busy) {
      const id = storedConvo(today)
      reload()
      if (id != null) { setCid(id); api.convo(id).then((c) => setMsgs(c.messages)).catch(() => {}) }
    }
    wasBusy.current = busy
  }, [busy, today, reload])
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [msgs.length, pending, draft?.text, draft?.phase, view])

  const sendText = async (t: string) => {
    if (!t || busy || locked) return
    const d = new Date(), ts = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19)
    const mine: ChatMsg = { id: -d.getTime(), ts, role: 'user', display: t }
    savedId.current = null
    let got: number | null = fresh ? null : cid
    const r = await run({ text: t, convo_id: fresh ? null : cid, new: fresh }, mine,
      (id, uid) => { got = id; savedId.current = uid; setFresh(false); setCid(id); storeConvo(today, id) })
    // keep the finished reply on screen until the stored thread arrives, so nothing flickers
    if (r) setMsgs((m) => [...m.filter((x) => x.id !== mine.id), ...(m.some((x) => x.id === savedId.current) ? [] : [mine]), { id: -d.getTime() - 1, ts, role: 'assistant', display: r.reply }])
    endTurn()
    if (r) { got = r.convo_id; setCid(r.convo_id) }
    reload()
    if (got != null) api.convo(got).then((c) => setMsgs(c.messages)).catch(() => {})
  }
  const send = () => { const t = text.trim(); if (!t) return; setText(''); sendText(t) }

  const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
  const lastAsst = msgs.length && msgs[msgs.length - 1].role === 'assistant' ? msgs[msgs.length - 1] : null
  const retry = async () => {
    if (!lastUser || busy || locked) return
    await ctx.run(api.delMsg(lastUser.id))
    setMsgs((m) => m.filter((x) => x.id < lastUser.id))
    sendText(lastUser.display)
  }
  const del = async (m: ChatMsg) => { if (await ctx.run(api.delMsg(m.id)) !== undefined) { reload(); if (cid) api.convo(cid).then((c) => setMsgs(c.messages)).catch(() => {}) } }

  const off = !hasKey || locked
  const conv = list.find((c) => c.id === cid)
  // once the stored copy of the message has loaded, stop showing the local one
  const shown = pending && !msgs.some((m) => m.id === userId) ? [...msgs, pending] : msgs

  // a practice test the coach starts opens beside the chat as it is written
  const seenTests = useRef(new Set<number>())
  useEffect(() => {
    if (!page || !onPreview) return
    for (const x of draft?.tests ?? []) if (!seenTests.current.has(x.id)) { seenTests.current.add(x.id); onPreview(`#/test/${x.id}`) }
  }, [draft?.tests, page, onPreview])
  useEffect(() => { if (page && openId != null && openId !== cid) open(openId) }, [page, openId])  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!page) return
    const f = () => { open(null); requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.nix .composer textarea')?.focus()) }
    window.addEventListener(NEW_EV, f)
    return () => window.removeEventListener(NEW_EV, f)
  }, [page, open])
  useEffect(() => { if (page && !fresh && cid != null && cid !== openId) ctx.go({ kind: 'nix', id: cid }) }, [page, fresh, cid])  // eslint-disable-line react-hooks/exhaustive-deps
  const [me, setMe] = useState('')
  useEffect(() => { if (page) api.profile().then((p) => setMe((p.me.name || p.me.system_name || '').trim().split(/\s+/)[0] ?? '')).catch(() => {}) }, [page])
  // a Khan unit test is a full-screen sheet of its own; everything else opens beside the chat
  const take = useCallback((href: string) => { if (!onPreview || href.startsWith('#/khan-test/')) return false; onPreview(href); return true }, [onPreview])

  const reduce = useReducedMotion()
  const hints = useMemo(() => examples(name, current), [name, current?.title])  // eslint-disable-line react-hooks/exhaustive-deps
  const pick = (x: Sugg) => {
    if (x.send) sendText(x.send)
    else { setText(x.fill ?? ''); requestAnimationFrame(() => { const ta = document.querySelector<HTMLTextAreaElement>('.composer textarea'); ta?.focus(); ta?.setSelectionRange(ta.value.length, ta.value.length) }) }
  }
  const composer = (
    <form className={'composer' + (page ? ' big' : '')} onSubmit={(e) => { e.preventDefault(); if (busy) stop(); else send() }}>
      {page && !text && !off && <TypeHint lines={hints} on={!reduce} />}
      <textarea rows={page ? 2 : 1} value={text} autoFocus={page} aria-label={tr('Ask {name}', { name })}
        placeholder={!hasKey ? tr('Agent is off') : locked ? tr('Test in progress') : page ? '' : tr('Ask {name} anything…', { name })} disabled={off}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} />
      {busy
        ? <button className="btn send" type="submit" aria-label={tr('Stop')} title={tr('Stop')}><Square size={14} strokeWidth={2} /></button>
        : <button className="btn primary send" type="submit" disabled={off || !text.trim()} aria-label={tr('Send')}><ArrowUp size={16} strokeWidth={1.75} /></button>}
    </form>
  )
  const thread = <>
    {conv && conv.date !== today && !fresh && <div className="convo-old t3">{tr('From {date}. Messages you send now use today\'s status', { date: fmtDate(conv.date) })}</div>}
    {shown.map((m) => (
      <div key={m.id} className={'msg ' + m.role}>
        {m.role === 'assistant' && <CoachAvatar ctx={ctx} size="sm" />}
        {m.role === 'assistant' ? <div className="md"><CoachMd text={m.display} ctx={ctx} /></div> : m.display}
        <div className="msg-foot">
          <time className="ts" dateTime={m.ts} title={`${fmtDate(m.ts.slice(0, 10))} ${m.ts.slice(11, 16)}`}>{m.ts.slice(11, 16)}</time>
          {m.id > 0 && !busy && (
            <span className="msg-act">
              <CopyBtn text={m.display} />
              {m === lastAsst && !locked && hasKey && <button className="mini" title={tr('Regenerate reply')} aria-label={tr('Regenerate reply')} onClick={retry}><RotateCcw size={13} strokeWidth={1.5} /></button>}
              <Confirm label={m.role === 'user' ? tr('Delete message and its reply') : tr('Delete reply')} onYes={() => del(m)} />
            </span>
          )}
        </div>
      </div>
    ))}
    {draft && <DraftView draft={draft} name={name} ctx={ctx} />}
    <div ref={end} />
  </>
  const follow = lastAsst && !busy && !off && (
    <div className="follow" role="group" aria-label={tr('Follow up')}>
      {FOLLOW.map((f) => <button key={f.label} className="follow-b" onClick={() => sendText(f.send)}>{tr(f.label)}</button>)}
    </div>
  )
  const empty = shown.length === 0 && !draft

  if (page) {
    return (
      <AppLinkCtx.Provider value={take}>
        <div className="nix">
          <section className={'nix-main' + (empty && view === 'chat' ? ' is-empty' : '')}>
            <Topo calm={!(empty && view === 'chat')} />
            <div className="nix-top">
              <span className="nix-top-gap" />
              <span className="nix-title">{view === 'settings' ? tr('Coach settings') : !empty && conv && !fresh ? (conv.title || tr('Untitled')) : ''}</span>
              <button className={'icon-btn' + (view === 'settings' ? ' on' : '')} onClick={() => setView((v) => (v === 'settings' ? 'chat' : 'settings'))} aria-label={tr('Coach settings')} title={tr('Coach settings')}><Settings2 size={16} strokeWidth={1.5} /></button>
            </div>
            {view === 'settings' ? <div className="msgs nix-scroll" ref={scroller}><div className="nix-col"><CoachSettingsView ctx={ctx} /></div></div>
              : empty ? (
                <div className="nix-hello">
                  <NixFly mood={busy ? 'think' : text ? 'look' : 'idle'} />
                  <h1 className="nix-hi">{me ? tr('{hello}, {name}', { hello: hello(), name: me }) : hello()}<span className="nix-hi-q">{tr('What are we working on?')}</span></h1>
                  {composer}
                  {hasKey && !locked
                    ? <div className="nix-sugg">{suggestions(ctx, current).map((x) => (
                        <button key={x.label} className="chip" onClick={() => pick(x)}>{x.label}</button>
                      ))}</div>
                    : <p className="ch-n">{locked ? tr('A test is in progress: the panel is off until you submit. Ask from the test with the Ask button: rules, formulas and words, not answers.') : tr('The agent is off. Add an AI provider in Settings.')}</p>}
                </div>
              ) : <>
                <div className="msgs nix-scroll" ref={scroller}><div className="nix-col">{thread}</div></div>
                <div className="nix-col nix-foot">{follow}{composer}<RuleLine current={current} locked={locked} short ctx={ctx} /></div>
              </>}
            <Scrollbar key={view + String(cid)} target={scroller} />
          </section>
        </div>
      </AppLinkCtx.Provider>
    )
  }

  return (
    <aside className="coach" aria-label={tr('Coach')}>
      <div className="coach-head">
        <CoachAvatar ctx={ctx} busy={busy} />
        <span className="coach-id">
          <span className="coach-name">{name}</span>
          <span className="coach-conv" title={conv?.title}>
            {view === 'list' ? tr('Conversations') : view === 'settings' ? tr('Settings') : busy ? tr('thinking…') : fresh || !conv ? tr('New chat') : (conv.title || tr('Untitled'))}
          </span>
        </span>
        <button className={'icon-btn' + (view === 'list' ? ' on' : '')} onClick={() => setView((v) => (v === 'list' ? 'chat' : 'list'))} aria-label={tr('Conversations')} title={tr('Conversations')}><History size={16} strokeWidth={1.5} /></button>
        <button className="icon-btn" onClick={() => open(null)} aria-label={tr('New chat')} title={tr('New chat')} disabled={busy}><Plus size={16} strokeWidth={1.5} /></button>
        <button className={'icon-btn' + (view === 'settings' ? ' on' : '')} onClick={() => setView((v) => (v === 'settings' ? 'chat' : 'settings'))} aria-label={tr('Coach settings')} title={tr('Coach settings')}><Settings2 size={16} strokeWidth={1.5} /></button>
        <button className="icon-btn" onClick={onClose} aria-label={tr('Close coach panel')} title={tr('Close  ]')}><X size={16} strokeWidth={1.5} /></button>
      </div>

      {view === 'list' && <div className="msgs" ref={scroller}><ConvoList list={list} today={today ?? ''} active={fresh ? null : cid} ctx={ctx} reload={reload} onOpen={open} onNew={() => open(null)} /></div>}
      {view === 'settings' && <div className="msgs" ref={scroller}><CoachSettingsView ctx={ctx} /></div>}

      {view === 'chat' && <>
        <div className="msgs" ref={scroller}>
          {empty && (
            <div className="coach-hello">
              <CoachAvatar ctx={ctx} size="big" />
              <h3 className="ch-t">{tr('{hello}. What are we working on?', { hello: hello() })}</h3>
              {hasKey && !locked ? <>
                <p className="ch-n">{tr('{name} sees your plan, scores, repo files and sticking points. Pick one, or right click anything on the page and choose “Ask {name}”.', { name })}</p>
                <div className="sugg">
                  {suggestions(ctx, current).map((x) => (
                    <button key={x.label} className="sugg-b" title={x.fill ? tr('Puts the start in the box for you to finish') : tr('Sends it now')} onClick={() => pick(x)}>
                      <span className="sugg-t">{x.label}</span>{x.fill ? <PenLine size={14} strokeWidth={1.7} className="sugg-go" /> : <ArrowUp size={14} strokeWidth={1.8} className="sugg-go" />}
                    </button>
                  ))}
                </div>
              </> : <p className="ch-n">{locked ? tr('A test is in progress: the panel is off until you submit. Ask from the test with the Ask button: rules, formulas and words, not answers.') : tr('The agent is off. Add ANTHROPIC_API_KEY to ctu-app/.env and restart the server.')}</p>}
            </div>
          )}
          {thread}
        </div>
        {follow}
        {composer}
        <RuleLine current={current} locked={locked} short ctx={ctx} />
      </>}
      <Scrollbar key={view + String(cid)} target={scroller} />
    </aside>
  )
}

/** Small floating chat opened from the right-click menu, quoting what was clicked. Follow-ups stay in the same
 *  conversation; "Open in panel" continues it with the full history. */
export function AskPopup({ at, ctx, page, current, hasKey, exam = false, onClose, onOpenPanel }: {
  at: { x: number; y: number; context: string }; ctx: Ctx; page: string; current: Task | null; hasKey: boolean
  /** a graded test is open: closed book, in a conversation of its own that the panel doesn't open */
  exam?: boolean
  onClose: () => void; onOpenPanel: () => void
}) {
  const name = ctx.meta?.coach_name || 'Coach'
  const [q, setQ] = useState('')
  const [ex, setEx] = useState<{ q: string; a: string | null }[]>([])
  const [convo, setConvo] = useState<number | null>(null)
  const popupKey = 'popup' + useId()
  const { draft, run, stop, end: endTurn } = useTurn(ctx, popupKey)
  const box = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: at.x, top: at.y })
  const drag = useDrag()        // moved by its head, out of the way of the question; stays where it was put
  const ax = drag.pos?.x ?? at.x, ay = drag.pos?.y ?? at.y
  const input = useRef<HTMLTextAreaElement>(null)
  const busy = draft != null
  const context = at.context.trim()
  const first = ex.length === 0

  // keep the whole popup on screen as it grows. offsetWidth/Height, not getBoundingClientRect: the pop-in animation
  // scales the box, and a rect measured mid-animation is too small, which pushed the popup past the bottom edge
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const place = () => {
      const w = el.offsetWidth || 420, h = el.offsetHeight || 240
      const left = Math.max(16, Math.min(ax, window.innerWidth - w - 16)), top = Math.max(16, Math.min(ay, window.innerHeight - h - 16))
      setPos((p) => (p.left === left && p.top === top ? p : { left, top }))
    }
    place()
    const ro = new ResizeObserver(place)
    ro.observe(el)
    window.addEventListener('resize', place)
    return () => { ro.disconnect(); window.removeEventListener('resize', place) }
  }, [ax, ay])
  useEffect(() => { body.current?.scrollTo({ top: body.current.scrollHeight }) }, [ex.length, draft?.text, draft?.phase])
  useEffect(() => { if (!busy) input.current?.focus() }, [busy])
  // closing the popup doesn't cancel: the reply still lands in the conversation

  const send = async () => {
    if (busy || !hasKey) return
    const typed = q.trim()
    const blank = !typed && first && !!context && !exam  // empty question about a quote: "explain this" (not in a test)
    if (!typed && !blank) return
    const question = typed || 'Explain this'
    const quote = first && context ? context.slice(0, 600).split('\n').map((l) => `> ${l}`).join('\n') + '\n\n' : ''
    // the app's own lines are in [brackets] so the server's language detection ignores them
    const text = (first ? `[from the ${page} page]\n` : '') + quote + (blank ? '[no question typed: explain the quoted part]' : typed)
    setEx((x) => [...x, { q: question, a: null }]); setQ('')
    const keep = (id: number) => { setConvo(id); if (!exam) storeConvo(ctx.meta?.today, id) }
    const r = await run(exam ? { text, convo_id: convo, new: convo == null, exam } : { text, convo_id: convo ?? storedConvo(ctx.meta?.today) }, null, keep)
    endTurn()
    if (r) {
      setEx((x) => x.map((e, i) => (i === x.length - 1 ? { ...e, a: r.reply } : e)))
      keep(r.convo_id)
    } else {  // failed or stopped before a reply: give the question back instead of leaving it unanswered
      setEx((x) => x.slice(0, -1)); setQ(typed)
    }
    ctx.refresh()
  }
  const toPanel = () => { if (convo) showConvo(ctx.meta?.today, convo); onOpenPanel() }
  const placeholder = !hasKey ? tr('The coach is off: it needs an API key (Settings)')
    : !first ? tr('Ask a follow-up')
    : exam ? tr('Which rule, formula or word do you need?')
    : context ? tr('Ask, or press Enter to explain this') : tr('What do you want to ask {name}?', { name })
  const closedWhy = tr('Graded test: rules, formulas and words, never the answer to this question')

  return (
    <div className={'ask' + (exam ? ' closed' : '')} ref={box} role="dialog" aria-label={`Ask ${name}`} style={{ ...pos, transformOrigin: `${at.x - pos.left}px ${at.y - pos.top}px` }}>
      {/* the head is the handle: who answers, from where, and in a test that it's closed book */}
      <div className="ask-head" onPointerDown={(e) => drag.start(e, box.current)}>
        <CoachAvatar ctx={ctx} size="sm" busy={busy} />
        <div className="ask-id">
          <span className="ask-title">{name}</span>
          {page && <span className="ask-page">{page}</span>}
        </div>
        {exam && <span className="ask-badge" title={closedWhy}><Lock size={11} strokeWidth={2} />{tr('Closed book')}</span>}
        <span className="ask-acts">
          {!exam && <button className="icon-btn sm" onClick={toPanel} aria-label={tr('Open in panel')} title={tr('Continue this in the coach panel')}><PanelRightOpen size={15} strokeWidth={1.5} /></button>}
          <button className="icon-btn sm" onClick={onClose} aria-label={tr('Close')} title={`${tr('Close')}  Esc`}><X size={15} strokeWidth={1.5} /></button>
        </span>
      </div>
      <div className="ask-body" ref={body}>
        {context && (
          <div className="ask-quote" title={context.length > 280 ? context.slice(0, 600) : undefined}>
            <Markdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>{fixMathInMd(context)}</Markdown>
          </div>
        )}
        {exam && first && !draft && <p className="ask-note">{tr('Ask for a rule, a formula, a definition or what a word means. {name} won’t solve this question or check your answer.', { name })}</p>}
        {ex.map((e, i) => (
          <div key={i} className="ask-ex">
            <div className="msg user">{e.q}</div>
            {e.a != null && <div className="msg assistant"><div className="md"><CoachMd text={e.a} ctx={ctx} onNav={onClose} /></div></div>}
          </div>
        ))}
        {draft && <DraftView draft={draft} name={name} ctx={ctx} />}
      </div>
      <form className="ask-compose" onSubmit={(e) => { e.preventDefault(); if (busy) stop(); else send() }}>
        <textarea ref={input} rows={1} className="ask-input" value={q} disabled={!hasKey || busy} placeholder={placeholder} aria-label={tr('Question for {name}', { name })}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} />
        {busy
          ? <button className="btn send" type="submit" aria-label={tr('Stop')} title={tr('Stop')}><Square size={12} strokeWidth={2.2} /></button>
          : <button className="btn primary send" type="submit" disabled={!hasKey || (!q.trim() && !(first && context && !exam))} aria-label={tr('Ask')}><ArrowUp size={15} strokeWidth={2} /></button>}
      </form>
      {!exam && <RuleLine current={current} short ctx={ctx} />}
    </div>
  )
}
