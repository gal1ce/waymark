import { useEffect, useId, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  ArchiveRestore, ArrowLeft, ChevronDown, Search, ChevronRight, Download, FileText, HardDrive, KeyRound, Keyboard, ListChecks, MessageSquareText,
  Monitor, Moon, Palette, PencilLine, RefreshCw, RotateCcw, Stethoscope, Sun, Trash2, X,
} from 'lucide-react'
import type { Ctx } from './App'
import { ACCENTS, DEFAULT_ACCENT, useAccent, type Side, type ThemePref } from './prefs'
import { CoachSettingsView } from './Coach'
import { t, tx, type Key, type Lang } from './i18n'
import { api, type Health, type PlanView, type TrackStatus } from './api'
import { busyProps, useBusy } from './interact'
import { useLoad } from './ui'
import { ExamDates } from './Setup'
import { AiProviders } from './AiProviders'
import { Checkbox, ColorField, Switch } from './controls'
import { UpdateSection } from './Update'
import { longDate } from './dates'
import { Grid, Group, PathField, Row } from './settingsui'

const THEMES: { k: ThemePref; label: Key; note: Key; icon: ReactNode }[] = [
  { k: 'system', label: 'System', note: 'Follows this computer, switches with it', icon: <Monitor size={16} strokeWidth={1.6} /> },
  { k: 'light', label: 'Light', note: 'Dot paper, inked accent', icon: <Sun size={16} strokeWidth={1.6} /> },
  { k: 'dark', label: 'Dark', note: 'Neutral graphite, easy at night', icon: <Moon size={16} strokeWidth={1.6} /> },
]

const LAYOUTS: { label: Key; nav: Side; coach: Side; cols: string[] }[] = [
  { label: 'Menu left, coach right', nav: 'left', coach: 'right', cols: ['rail', 'main', 'coach'] },
  { label: 'Coach left, menu right', nav: 'right', coach: 'left', cols: ['coach', 'main', 'rail'] },
  { label: 'Both on the left', nav: 'left', coach: 'left', cols: ['rail', 'coach', 'main'] },
  { label: 'Both on the right', nav: 'right', coach: 'right', cols: ['main', 'coach', 'rail'] },
]

const KEYS: [Key, [string, Key][]][] = [
  ['Everywhere', [[']', 'Open or close the coach'], ['Right click', 'Ask the coach about what you clicked'], ['Esc', 'Close menus and popups']]],
  ['Lessons, practice and tests', [['Enter', 'Check, then continue'], ['1 – 9', 'Pick a choice'], ['← →', 'Previous and next question'], ['H', 'Next hint'], ['D', 'Scratch paper']]],
  ['Notebook canvas', [['V  H', 'Select, hand'], ['T  G  I', 'Text, graph, image'], ['A  P  E', 'Arrow, pen, eraser'], ['Ctrl Z', 'Undo (Ctrl Shift Z redoes)'], ['Delete', 'Remove the selection'], ['Ctrl + wheel', 'Zoom; Space + drag pans']]],
]

type SectionId = 'plan' | 'ai' | 'coach' | 'appearance' | 'keys' | 'data' | 'updates' | 'health'
type Section = { id: SectionId; label: Key; about: Key; icon: ReactNode; words: Key[] }
// the menu's groups, as the sections are thought of: the plan, how the app works for you, your data and the app itself
const GROUPS: { label: Key; items: Section[] }[] = [
  { label: 'Study', items: [
    { id: 'plan', label: 'Plan', about: 'What you study, by when, and the units in it.', icon: <ListChecks size={16} strokeWidth={1.6} />,
      words: ['Courses and units', 'Exam dates', 'Deadline', 'Change the plan…'] },
  ] },
  { label: 'App', items: [
    { id: 'ai', label: 'AI providers', about: 'Who writes your plans and tests and answers in the coach chat.', icon: <KeyRound size={16} strokeWidth={1.6} />,
      words: ['Keys', 'Model for tests and plans', 'Model for the coach chat', 'Thinking effort for tests and plans', 'Search the web'] },
    { id: 'coach', label: 'Coach', about: 'Its name, how it replies, and what it remembers about you.', icon: <MessageSquareText size={16} strokeWidth={1.6} />,
      words: ['Name', 'Picture', 'Reply length', 'Reply language', 'Thinking', 'Personality', 'Memory'] },
    { id: 'appearance', label: 'Appearance', about: 'Theme, language, colour and where the panels sit.', icon: <Palette size={16} strokeWidth={1.6} />,
      words: ['Theme', 'Language', 'Accent', 'Layout'] },
    { id: 'keys', label: 'Keyboard', about: 'Shortcuts that work across the app.', icon: <Keyboard size={16} strokeWidth={1.6} />, words: ['Shortcuts'] },
  ] },
  { label: 'Data and system', items: [
    { id: 'data', label: 'Data', about: 'Where everything is kept, backups, and starting again.', icon: <HardDrive size={16} strokeWidth={1.6} />,
      words: ['Backup file', 'Restore', 'Start over', 'Delete the account', 'Data folder'] },
    { id: 'updates', label: 'Updates', about: 'The version you have and how new ones arrive.', icon: <RefreshCw size={16} strokeWidth={1.6} />, words: ['Check for updates'] },
    { id: 'health', label: 'System health', about: 'Whether everything behind the app is working.', icon: <Stethoscope size={16} strokeWidth={1.6} />,
      words: ['Last backup', 'Code sandbox', 'Repo watcher', 'Details'] },
  ] },
]
const SECTIONS = GROUPS.flatMap((g) => g.items)
// older links (#/settings, a notice's link, the coach's) name sections by these
const ALIAS: Record<string, SectionId> = { key: 'ai' }

/** Settings are a screen of their own: their menu replaces the app's (with a way back and a search), and the
    section shows as one column of headed lists, words on the left and controls on the right. */
export default function SettingsView({ ctx, section, sub }: { ctx: Ctx; section?: string; sub?: string }) {
  const id: SectionId = SECTIONS.find((s) => s.id === (ALIAS[section ?? ''] ?? section))?.id ?? 'plan'
  const cur = SECTIONS.find((s) => s.id === id)!
  const problems = Object.keys(ctx.meta?.warnings ?? {}).length
  const [q, setQ] = useState('')
  const back = () => { let to = '#/'; try { to = sessionStorage.getItem('ctu.lastPage') || '#/' } catch { /* private window */ } location.hash = to }
  useEffect(() => {
    document.title = `${t(cur.label)} · ${t('Settings')} · Waymark`
    return () => { document.title = 'Waymark' }
  }, [cur.label])
  useEffect(() => {
    // Esc goes back to the app, unless something on the page (a menu, a dialog, a text box) has it
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('.modal-wrap, .pop, [role="listbox"]')) return
      if ((e.target as HTMLElement).closest('input, textarea')) return
      back()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
  const fold = (x: string) => x.toLocaleLowerCase()
  const hit = (sec: Section) => !q.trim() || [sec.label, sec.about, ...sec.words].some((w) => fold(t(w)).includes(fold(q.trim())))
  return createPortal(
    <div className="set-shell" role="region" aria-label={t('Settings')}>
      <aside className="set-side">
        <button type="button" className="set-back" onClick={back}><ArrowLeft size={16} strokeWidth={1.7} /><span>{t('Back to the app')}</span></button>
        <label className="set-search">
          <Search size={15} strokeWidth={1.7} aria-hidden />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search settings')} aria-label={t('Search settings')} />
        </label>
        <nav className="set-nav" aria-label={t('Settings sections')}>
          {GROUPS.map((g) => {
            const items = g.items.filter(hit)
            if (!items.length) return null
            return (
              <div key={g.label} className="set-nav-g">
                <div className="set-nav-h">{t(g.label)}</div>
                {items.map((s) => (
                  <a key={s.id} href={`#/settings/${s.id}`} aria-current={s.id === id ? 'page' : undefined} onClick={() => setQ('')}>
                    {s.icon}<span>{t(s.label)}</span>
                    {s.id === 'health' && problems > 0 && <span className="set-nav-n" aria-label={t('{n} to look at', { n: problems })}>{problems}</span>}
                  </a>
                ))}
              </div>
            )
          })}
          {!SECTIONS.some(hit) && <p className="set-nav-none">{t('Nothing matches “{q}”.', { q: q.trim() })}</p>}
        </nav>
      </aside>
      <main className="set-body">
        <div className="set-content" key={id + (sub ?? '')}>
          {!(id === 'ai' && sub) && <header className="set-head"><h1>{t(cur.label)}</h1><p>{t(cur.about)}</p></header>}
          {id === 'plan' && <PlanSection ctx={ctx} />}
          {id === 'ai' && <AiProviders ctx={ctx} detail={sub} />}
          {id === 'coach' && <CoachSettingsView ctx={ctx} split />}
          {id === 'appearance' && <AppearanceSection ctx={ctx} />}
          {id === 'data' && <DataSection ctx={ctx} />}
          {id === 'updates' && <UpdateSection onShow={ctx.showUpdate} />}
          {id === 'health' && <HealthSection ctx={ctx} />}
          {id === 'keys' && <Grid><KeysSection /></Grid>}
        </div>
      </main>
    </div>,
    document.body,
  )
}

// ------------------------------------------------------------------ plan
/** The plan the app runs: what it is and when it ends, its courses and units (each can be taken out), exam dates.
    Changing the plan itself always goes through a new draft. */
function PlanSection({ ctx }: { ctx: Ctx }) {
  const p = useLoad(() => api.plan(), [ctx.version])
  const [examBusy, runExam] = useBusy()
  if (!p) return null
  const change = (label: string, primary = false) => (
    <button type="button" className={'btn sm' + (primary ? ' primary' : '')} onClick={() => ctx.go({ kind: 'setup' })}><PencilLine size={14} strokeWidth={1.6} /><span>{label}</span></button>
  )
  if (!p.ready) return <Grid><Group wide title={t('No plan yet')} note={t('There is no plan yet. Answer a few questions and the model drafts one for you to approve.')} action={change(t('Set up your plan'), true)} /></Grid>
  if (p.key === 'ctu') return (
    <Grid><Group wide title={p.label} note={t('The plan this app was built with. Its next phases are approved under System health; its log is COACH.md.')}
      action={change(t('Set up a different plan…'))} /></Grid>
  )
  const late = !!(p.projected_end && p.deadline && p.projected_end > p.deadline)
  return (
    <Grid>
      <Group title={p.label} note={p.approved_at ? t('Approved {date}.', { date: longDate(p.approved_at.slice(0, 10)) }) : undefined}
        action={<>
          <a className="btn ghost sm" href="/api/plan/file" download="PLAN.md" title={p.plan_md ?? undefined}><FileText size={14} strokeWidth={1.6} /><span>PLAN.md</span></a>
          {change(t('Change the plan…'))}
        </>}>
        <Row label={t('Starts')}><span className="sr-v">{longDate(p.start_date)}</span></Row>
        {p.projected_end && (
          <Row label={t('Last unit')} hint={late ? t('That is after the deadline: change the plan to fit it.') : t('If every unit check passes the first time; a retake moves it later.')} tone={late ? 'warn' : undefined}>
            <span className="sr-v">{longDate(p.projected_end)}</span>
          </Row>
        )}
        <Row label={t('Deadline')}><span className="sr-v">{p.deadline ? longDate(p.deadline) : t('None: the plan goes at your pace')}</span></Row>
      </Group>
      <Group wide title={t('Courses and units')} note={t('Untick a unit to take it out of the plan. Days you have started keep their tasks; the days not started yet are planned again without it. Tick it again to put it back.')}>
        <PlanUnits p={p} ctx={ctx} />
      </Group>
      <Group title={t('Exam dates')} note={t('Each course can have its own exam. In the last week before one, its unfinished units take blocks from courses whose exam is further away; once an exam is over, its blocks go to the next one. Days already planned keep their blocks.')}>
        <ExamDates key={p.tracks.map((x) => x.deadline ?? '').join()} tracks={p.tracks} start={p.start_date} today={ctx.meta?.today ?? p.start_date} busy={examBusy} ends={p.track_ends}
          note="" action={t('Save exam dates')}
          onSave={(dates) => runExam(async () => {
            const r = await ctx.run(api.setExams(dates))
            if (r) { ctx.notify(r.notes.length ? r.notes.join(' ') : t('Exam dates saved'), r.notes.length ? 'warn' : 'ok'); ctx.refresh() }
          })} />
      </Group>
    </Grid>
  )
}

// shown through tx(), in the interface language (the Progress page uses the same words)
const UNIT_STATUS: Record<TrackStatus, string> = {
  passed: 'passed', done: 'done', current: 'now', doing: 'in progress', tried: 'tried, below threshold', planned: 'planned', todo: 'up next', removed: 'taken out',
}

/** Each course: how far it is, and (opened) its units, each with a tick for being in the plan. A passed unit is done
    and stays; a course keeps at least one unit. */
function PlanUnits({ p, ctx }: { p: PlanView; ctx: Ctx }) {
  const [open, setOpen] = useState<string | null>(null)
  const [busy, run] = useBusy()
  const set = (track: string, unit: number, on: boolean) => run(async () => {
    const r = await ctx.run(api.setPlanUnit(track, unit, on))
    if (r) {
      ctx.notify(on ? t('Unit put back into the plan') : t('Unit taken out of the plan'), 'ok',
        r.replanned.length ? t('The days not started yet were planned again.') : undefined)
      ctx.refresh()
    }
  })
  return (
    <div className="plan-units">
      {p.progress.map((tr, ti) => {
        const kept = tr.units.filter((u) => u.status !== 'removed').length
        const passed = tr.units.filter((u) => u.status === 'passed').length
        const now = tr.units.find((u) => u.status === 'current' || u.status === 'tried')
        const on = open === tr.key
        return (
          <div key={tr.key} className={'pu' + (on ? ' open' : '')}>
            <button type="button" className="pu-h" aria-expanded={on} onClick={() => setOpen(on ? null : tr.key)}>
              {on ? <ChevronDown size={16} strokeWidth={1.6} /> : <ChevronRight size={16} strokeWidth={1.6} />}
              <span className={'trk-dot trk-' + (ti % 6)} aria-hidden />
              <span className="pu-l">{tr.label}{now && <span className="pu-now">{t('now: {unit}', { unit: now.name })}</span>}</span>
              <span className="pu-n mono" title={t('{a}/{b} passed', { a: passed, b: kept })}>{passed}/{kept}{kept < tr.units.length && <span className="t3"> · {t('{n} taken out', { n: tr.units.length - kept })}</span>}</span>
            </button>
            {on && (
              <ol className="draft-units">
                {tr.units.map((u) => {
                  const out = u.status === 'removed'
                  const why = u.status === 'passed' ? t('Passed: it stays in the plan') : !out && kept <= 1 ? t('A course keeps at least one unit') : undefined
                  return (
                    <li key={u.idx} className={out ? 'du-out' : undefined}>
                      <div className="du-h">
                        <span className="du-t">{u.name}</span>
                        <span className="t3 mono">{tx(UNIT_STATUS[u.status])}</span>
                        <Checkbox className="du-cb" checked={!out} disabled={busy || !!why} title={why}
                          label={out ? t('Put {unit} back into the plan', { unit: u.name }) : t('Take {unit} out of the plan', { unit: u.name })}
                          onChange={(v) => set(tr.key, u.idx, v)} />
                      </div>
                    </li>
                  )
                })}
              </ol>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ------------------------------------------------------------------ appearance
function AppearanceSection({ ctx }: { ctx: Ctx }) {
  const [accent, setAccent] = useAccent()
  return (
    <Grid>
      <Group title={t('Visual style')}>
        <Row label={t('Theme')} hint={t('Light or dark, or follow this computer.')}>
          <div className="mini-picks" role="radiogroup" aria-label={t('Theme')}>
            {THEMES.map((x) => (
              <button key={x.k} type="button" role="radio" aria-checked={ctx.theme === x.k} className={'mini-pick' + (ctx.theme === x.k ? ' on' : '')}
                onClick={() => ctx.setTheme(x.k)} title={`${t(x.label)} · ${t(x.note)}`}>
                <span className={'theme-swatch ' + x.k} aria-hidden><i /><i /><i /></span>
                <span className="mini-l">{t(x.label)}</span>
              </button>
            ))}
          </div>
        </Row>
        <Row label={t('Accent')} hint={t('Buttons, links, the selection and focus rings.')}>
          <div className="accent-row" role="radiogroup" aria-label={t('Accent colour')}>
            {ACCENTS.map((a) => (
              <button key={a.hex} role="radio" aria-checked={accent === a.hex} className={'accent-sw' + (accent === a.hex ? ' on' : '')}
                style={{ background: a.hex }} title={t(a.name as Key) + (a.hex === DEFAULT_ACCENT ? ' ' + t('(default)') : '')} aria-label={t(a.name as Key)} onClick={() => setAccent(a.hex)} />
            ))}
            <span className={'accent-custom-wrap' + (ACCENTS.some((a) => a.hex === accent) ? '' : ' on')}>
              <ColorField value={accent} onChange={setAccent} label={t('Custom accent colour')}><span>{t('Custom')}</span></ColorField>
            </span>
          </div>
        </Row>
        <Row label={t('Layout')} hint={t('Which side the navigation and the coach panel sit on.')}>
          <div className="mini-picks" role="radiogroup" aria-label={t('Layout')}>
            {LAYOUTS.map((l) => {
              const on = ctx.layout.nav === l.nav && ctx.layout.coach === l.coach
              return (
                <button key={l.label} type="button" role="radio" aria-checked={on} className={'mini-pick' + (on ? ' on' : '')} title={t(l.label)} aria-label={t(l.label)}
                  onClick={() => ctx.setLayout({ nav: l.nav, coach: l.coach })}>
                  <span className="layout-pic" aria-hidden>{l.cols.map((c, i) => <i key={i} className={'lp-' + c} />)}</span>
                </button>
              )
            })}
          </div>
        </Row>
      </Group>
      <Group title={t('Language')}>
        <Row label={t('Language of the app')} hint={t('The language of menus, buttons and dates. The coach\'s reply language is set under Coach.')}>
          <div className="seg lang-seg" role="radiogroup" aria-label={t('Language')}>
            {(['en', 'tr'] as Lang[]).map((l) => (
              <button key={l} type="button" role="radio" aria-checked={ctx.lang === l} className={ctx.lang === l ? 'on' : ''} onClick={() => ctx.setLang(l)}>
                {l === 'en' ? 'English' : 'Türkçe'}
              </button>
            ))}
          </div>
        </Row>
      </Group>
    </Grid>
  )
}

// ------------------------------------------------------------------ data
/** Where this install keeps what it records, moving all of it as one file, and starting again. */
function DataSection({ ctx }: { ctx: Ctx }) {
  const h = useLoad(() => api.health(), [ctx.version])
  const [busy, run] = useBusy()
  const folder = h?.paths['data folder']?.path
  const download = () => run(async () => {
    const name = await ctx.run(api.backupExport())
    if (name) ctx.notify(t('Backup saved: {name}', { name }))
  })
  const restore = () => {
    const inp = document.createElement('input')
    inp.type = 'file'; inp.accept = '.zip,application/zip'
    inp.onchange = async () => {
      const f = inp.files?.[0]
      if (!f) return
      const ok = await ctx.confirm({
        title: t('Restore from this backup?'),
        body: t('Everything here is replaced by “{name}”: days, tests, notes, pictures and your profile. What is here now is kept in the backups folder first.', { name: f.name }),
        action: t('Restore'), danger: true,
      })
      if (!ok) return
      run(async () => {
        const r = await ctx.run(api.backupRestore(f))
        if (r) { ctx.notify(t('Restored. A copy of what was here before is in the backups folder.')); ctx.refresh() }
      })
    }
    inp.click()
  }
  return (
    <Grid>
      <Group title={t('Your data')} note={t('Everything you record lives in one folder on this computer, apart from the app: the database, notebook pictures, your picture and the automatic backups. Deleting or updating the app doesn\'t touch it.')}>
        {folder && <Row label={t('Data folder')}><PathField path={folder} /></Row>}
        {h?.last_backup && <Row label={t('Last automatic backup')} hint={t('{n} kept', { n: h.backups })}><span className="sr-v">{h.last_backup.ts.slice(0, 16).replace('T', ' ')}</span></Row>}
      </Group>
      <Group title={t('Backup file')} note={t('All of it in one file, to keep somewhere safe or to move to another computer. Your API key isn\'t in it.')}>
        <Row label={t('Download a backup')} hint={t('A .zip file with everything above.')}>
          <button type="button" className="btn sm" {...busyProps(busy)} onClick={download}><Download size={14} strokeWidth={1.6} /><span>{t('Download')}</span></button>
        </Row>
        <Row label={t('Restore')} hint={t('Replaces everything here with a backup file. A running task is paused first, and what is here now is kept in the backups folder.')}>
          <button type="button" className="btn sm" {...busyProps(busy)} onClick={restore}><ArchiveRestore size={14} strokeWidth={1.6} /><span>{t('Restore from a backup…')}</span></button>
        </Row>
      </Group>
      <Group wide title={t('Start again')} danger note={t('These can\'t be undone from here. Each one asks you to type a word first.')}>
        <ResetRow ctx={ctx} kind="start" download={download} busy={busy} />
        <ResetRow ctx={ctx} kind="delete" download={download} busy={busy} />
      </Group>
    </Grid>
  )
}

/** Starting over (the plan goes, the account stays) or deleting the account (everything goes). Each opens a panel that
    says what goes and what stays, and acts only once the confirming word is typed. */
function ResetRow({ ctx, kind, download, busy: outerBusy }: { ctx: Ctx; kind: 'start' | 'delete'; download: () => void; busy: boolean }) {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const [keys, setKeys] = useState(false)
  const [busy, run] = useBusy()
  const id = useId()
  const start = kind === 'start'
  const word = start ? t('start over') : t('delete')
  const ok = typed.trim().toLocaleLowerCase() === word.toLocaleLowerCase()
  const go = () => run(async () => {
    if (start) {
      const r = await ctx.run(api.startOver())
      if (!r) return
      ctx.notify(t('Started over. Your old plan is in the backups folder: {f}', { f: r.kept.split(/[\\/]/).pop() ?? '' }), 'ok')
      setOpen(false); setTyped('')
      location.hash = '#/'
      ctx.refresh()
    } else {
      const r = await ctx.run(api.deleteAccount(keys))
      if (!r) return
      // what this browser kept for the app (notes beside videos, folded panels…) goes too; the language stays
      try { for (const k of Object.keys(localStorage)) if (k.startsWith('ctu.') && k !== 'ctu.lang') localStorage.removeItem(k) } catch { /* private window */ }
      location.hash = '#/'
      location.reload()
    }
  })
  const icon = start ? <RotateCcw size={14} strokeWidth={1.6} /> : <Trash2 size={14} strokeWidth={1.6} />
  return (
    <>
      <Row label={start ? t('Start over') : t('Delete the account')}
        hint={start
          ? t('Removes the plan and everything done under it: days, tasks, tests, scores, notes and the coach\'s conversations. Your name, picture, the coach\'s settings and memory notes, and the AI providers stay. A backup file of everything is saved to the backups folder first, so Restore can bring it back. Then you set up a new plan.')
          : t('Removes everything this app recorded on this computer, the automatic backups included: the app is as on the day it was installed. The app itself, downloaded Khan content and files of yours outside the data folder stay. This can\'t be undone.')}>
        {!open && <button type="button" className="btn danger sm" disabled={outerBusy} onClick={() => setOpen(true)}>{icon}<span>{start ? t('Start over…') : t('Delete the account…')}</span></button>}
      </Row>
      {open && (
        <form className="reset-box" onSubmit={(e) => { e.preventDefault(); if (ok) go() }}>
          {!start && (
            <>
              <p className="field-h">{t('Want to keep a copy? Download a backup first.')}{' '}
                <button type="button" className="linkish" disabled={outerBusy} onClick={download}>{t('Download a backup')}</button></p>
              <Switch checked={keys} disabled={busy} onChange={setKeys}>{t('Also remove the AI keys from .env')}</Switch>
            </>
          )}
          <label className="field-l" htmlFor={id}>{t('Type “{w}” to confirm', { w: word })}</label>
          <div className="inline-form">
            <input id={id} className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} autoFocus placeholder={word} />
            <button type="button" className="btn ghost sm" disabled={busy} onClick={() => { setOpen(false); setTyped(''); setKeys(false) }}><span>{t('Cancel')}</span></button>
            <button type="submit" className="btn danger sm" {...busyProps(busy)} disabled={busy || !ok}>{icon}<span>{start ? t('Start over') : t('Delete everything')}</span></button>
          </div>
        </form>
      )}
    </>
  )
}

// ------------------------------------------------------------------ health
// shown through tx()
const WATCH_LABEL: Record<string, string> = { watching: 'watching', waiting: 'waiting for the folder', error: 'error', restarting: 'restarting', starting: 'starting', unused: 'off (this plan has no study repo)' }
const when = (ts: string | null | undefined) => (ts ? ts.slice(0, 16).replace('T', ' ') : t('never'))

/** What needs you first (warnings, days that couldn't be closed), then the state of each part, then the details
    someone fixing a problem needs (paths, what the app wrote), folded. */
function HealthSection({ ctx }: { ctx: Ctx }) {
  const h = useLoad(() => api.health(), [ctx.version])
  const [busy, run] = useBusy()
  const [data, setData] = useState<Health | null>(null)
  const [more, setMore] = useState(false)
  const x = data ?? h
  if (!x) return null
  const jobs = Object.entries(x.close_jobs)
  const ws = Object.entries(x.warnings)
  const watcherOk = x.watcher.state === 'watching' || x.watcher.state === 'unused'
  const missing = Object.entries(x.paths).filter(([, p]) => !p.ok)
  const r = x.runway
  return (
    <Grid>
      <Group wide title={ws.length + jobs.length ? t('Needs attention') : t('Everything works')}
        note={ws.length + jobs.length ? undefined : t('Nothing needs you right now. Problems show here and in the notifications.')}>
        {ws.map(([k, w]) => (
          <Row key={k} label={w.message} hint={when(w.ts)}>
            <button type="button" className="btn ghost sm" onClick={async () => { await ctx.run(api.dismissWarning(k)); ctx.refresh() }}><X size={14} strokeWidth={1.6} /><span>{t('Dismiss')}</span></button>
          </Row>
        ))}
        {jobs.map(([ds, j]) => (
          <Row key={ds} tone="warn" label={t('Closing {d} is unfinished', { d: ds })}
            hint={`${j.pending.join(', ')}${Object.keys(j.errors).length ? ` · ${Object.entries(j.errors).map(([k, v]) => `${k}: ${v}`).join('; ')}` : ''} · ${t('{n} tries', { n: j.attempts })} · ${t('retried every 10 minutes')}`}>
            <button className="btn sm" {...busyProps(busy)} onClick={() => run(async () => { const y = await ctx.run(api.retryCloses()); if (y) { setData(y); ctx.refresh() } })}><span>{t('Retry now')}</span></button>
          </Row>
        ))}
      </Group>
      <Group wide title={t('Parts')}>
        <Row label={t('AI provider')}><span className="sr-v">{x.api_key ? t('set') : t('not set: built-in questions, template plans, no coach')}</span></Row>
        <Row label={t('Last backup')} hint={t('{n} kept', { n: x.backups })}><span className="sr-v">{when(x.last_backup?.ts)}</span></Row>
        {x.watcher.state !== 'unused' && (
          <Row label={t('Repo watcher')} tone={watcherOk ? undefined : 'warn'} hint={!watcherOk ? x.watcher.detail : undefined}><span className="sr-v">{tx(WATCH_LABEL[x.watcher.state] ?? x.watcher.state)}</span></Row>
        )}
        <Row label={t('Code sandbox')}><span className="sr-v">{x.sandbox ? t('bubblewrap (test code runs isolated)') : t('not available: test code runs with limits only')}</span></Row>
        {/* one line per course: joined into one string, a long plan ran off the side of the row */}
        <Row label={t('Curriculum left')} stack={!!r.tracks}>
          {r.tracks ? (
            <ul className="sr-list">
              {r.tracks.map((y) => <li key={y.label}><span className="sr-list-l">{y.label}</span><span className="sr-list-v">{t('{a}/{b} units', { a: y.left, b: y.units })}</span></li>)}
            </ul>
          ) : <span className="sr-v">C {t('{n} study days', { n: r.c_days ?? `${r.horizon}+` })} · Kintsugi {r.kintsugi_days ?? `${r.horizon}+`} · Khan {t('{n} units', { n: r.khan_units_left })}</span>}
        </Row>
        {missing.map(([k, p]) => <Row key={k} tone="warn" label={tx(k)} hint={t('missing')}><PathField path={p.path} /></Row>)}
      </Group>
      {x.phases.length > 0 && (
        <Group wide title={t('Next phases')} note={t('Next phases from the COACH.md roadmap. Each one changes the plan only after you approve it; until then, finished tracks review earlier work:')}>
          {x.phases.map((ph) => (
            <Row key={ph.key} label={<>{ph.label}{ph.approved ? ` · ${t('approved')}` : ''}</>} hint={<>{ph.what} <span className="t3">{ph.roadmap}</span></>}>
              <button className={'btn sm' + (ph.approved ? ' ghost' : '')} {...busyProps(busy)} onClick={() => run(async () => {
                const y = await ctx.run(api.setPhase(ph.key, !ph.approved))
                if (y) { ctx.notify(ph.approved ? t('{name}: approval withdrawn', { name: ph.label }) : t('{name} approved; new days use it', { name: ph.label })); setData(null); ctx.refresh() }
              })}><span>{ph.approved ? t('Withdraw') : t('Approve')}</span></button>
            </Row>
          ))}
        </Group>
      )}
      <Group wide title={t('Details')} note={t('Where each file is and what the app wrote, for when something needs fixing.')}
        action={<button type="button" className="btn ghost sm" aria-expanded={more} onClick={() => setMore(!more)}>
          {more ? <ChevronDown size={14} strokeWidth={1.6} /> : <ChevronRight size={14} strokeWidth={1.6} />}<span>{more ? t('Hide') : t('Show')}</span></button>}>
        {more && <>
          {Object.entries(x.paths).map(([k, p]) => <Row key={k} label={tx(k)} tone={p.ok ? undefined : 'warn'}><PathField path={p.path} /></Row>)}
          <Row label={t('Database')}><span className="sr-v">{t('schema v{n}', { n: x.schema_version })}{x.fake_clock ? ` · ${t('demo clock (CTU_NOW)')}` : ''}</span></Row>
          {x.external_writes.length > 0 && (
            <Row label={t('Files the app wrote outside its database (newest first):')} stack>
              <ul className="writes">
                {x.external_writes.map((w, i) => <li key={i}><span className="mono t3">{when(w.ts)}</span><span>{w.action}</span><PathField path={w.file} keep={2} /></li>)}
              </ul>
            </Row>
          )}
        </>}
      </Group>
    </Grid>
  )
}

// ------------------------------------------------------------------ keyboard
function KeysSection() {
  return (
    <Group wide title={t('Shortcuts')}>
      <div className="sg-pad">
        <div className="keys">
          {KEYS.map(([g, rows]) => (
            <div key={g} className="keys-g">
              <div className="keys-h">{t(g)}</div>
              <ul>{rows.map(([k, d]) => <li key={k}><span className="keys-k">{k.split('  ').map((x) => <kbd key={x}>{x === 'Right click' || x === 'Ctrl + wheel' || x === 'Delete' ? t(x as Key) : x}</kbd>)}</span><span className="t2">{t(d)}</span></li>)}</ul>
            </div>
          ))}
        </div>
      </div>
    </Group>
  )
}
