import { useEffect, useId, useState, type ReactNode } from 'react'
import { ArchiveRestore, ChevronDown, ChevronRight, Download, RotateCcw, Trash2, FileText, HardDrive, KeyRound, Keyboard, ListChecks, MessageSquareText, Monitor, Moon, Palette, PencilLine, RefreshCw, Stethoscope, Sun } from 'lucide-react'
import type { Ctx } from './App'
import { ACCENTS, DEFAULT_ACCENT, useAccent, type Side, type ThemePref } from './prefs'
import { CoachSettingsView } from './Coach'
import { t, tx, type Key, type Lang } from './i18n'
import { HealthPanel } from './ProfileView'
import { api, type PlanView, type TrackStatus } from './api'
import { busyProps, useBusy } from './interact'
import { useLoad } from './ui'
import { ExamDates, KeyCard } from './Setup'
import { Checkbox, ColorField, Switch } from './controls'
import { UpdateSection } from './Update'

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

const SECTIONS: { id: string; label: Key; icon: ReactNode }[] = [
  { id: 'plan', label: 'Plan', icon: <ListChecks size={16} strokeWidth={1.6} /> },
  { id: 'key', label: 'AI providers', icon: <KeyRound size={16} strokeWidth={1.6} /> },
  { id: 'appearance', label: 'Appearance', icon: <Palette size={16} strokeWidth={1.6} /> },
  { id: 'coach', label: 'Coach', icon: <MessageSquareText size={16} strokeWidth={1.6} /> },
  { id: 'keys', label: 'Keyboard', icon: <Keyboard size={16} strokeWidth={1.6} /> },
  { id: 'data', label: 'Data', icon: <HardDrive size={16} strokeWidth={1.6} /> },
  { id: 'updates', label: 'Updates', icon: <RefreshCw size={16} strokeWidth={1.6} /> },
  { id: 'health', label: 'System health', icon: <Stethoscope size={16} strokeWidth={1.6} /> },
]

/** Preferences that belong to this computer and the app, apart from the profile (who you are, what you did). */
export default function SettingsView({ ctx }: { ctx: Ctx }) {
  const tr = t
  const [accent, setAccent] = useAccent()
  useEffect(() => { document.title = t('Settings · Waymark'); return () => { document.title = 'Waymark' } }, [])
  return (
    <div className="page settings-page">
      <div className="head"><div className="head-l"><h1 className="title">{t('Settings')}</h1><div className="sub">{t('How the app looks, how the coach talks, and whether everything behind it is working.')}</div></div></div>
      <div className="set-grid">
        <nav className="set-nav" aria-label={t('Settings sections')}>
          {SECTIONS.map((s) => (
            <a key={s.id} href={`#/settings`} onClick={(e) => { e.preventDefault(); document.getElementById('set-' + s.id)?.scrollIntoView({ block: 'start' }) }}>{s.icon}{t(s.label)}</a>
          ))}
        </nav>
        <div className="set-main">
          <section id="set-plan" className="card sec">
            <h2 className="sec-h">{tr('Plan')}</h2>
            <PlanSection ctx={ctx} />
          </section>
          <section id="set-key" className="card sec">
            <h2 className="sec-h">{tr('AI providers')}</h2>
            <KeyCard ctx={ctx} />
          </section>
          <section id="set-appearance" className="card sec">
            <h2 className="sec-h">{t('Appearance')}</h2>
            <div className="theme-cards" role="radiogroup" aria-label={t('Theme')}>
              {THEMES.map((t) => (
                <button key={t.k} role="radio" aria-checked={ctx.theme === t.k} className={'theme-card' + (ctx.theme === t.k ? ' on' : '')} onClick={() => ctx.setTheme(t.k)}>
                  <span className={'theme-swatch ' + t.k} aria-hidden><i /><i /><i /></span>
                  <span className="theme-l">{t.icon}{tr(t.label)}</span>
                  <span className="theme-n">{tr(t.note)}</span>
                </button>
              ))}
            </div>
            <h3 className="set-sub">{tr('Language')}</h3>
            <p className="set-note">{tr('The language of menus, buttons and dates. The coach\'s reply language is set under Coach.')}</p>
            <div className="seg lang-seg" role="radiogroup" aria-label={tr('Language')}>
              {(['en', 'tr'] as Lang[]).map((l) => (
                <button key={l} type="button" role="radio" aria-checked={ctx.lang === l} className={ctx.lang === l ? 'on' : ''} onClick={() => ctx.setLang(l)}>
                  {l === 'en' ? 'English' : 'Türkçe'}
                </button>
              ))}
            </div>
            <h3 className="set-sub">{tr('Accent')}</h3>
            <p className="set-note">{tr('Buttons, links, the selection and focus rings. Dark colours are lifted to a lighter tone of the same hue on the dark theme, so they stay visible.')}</p>
            <div className="accent-row" role="radiogroup" aria-label={tr('Accent colour')}>
              {ACCENTS.map((a) => (
                <button key={a.hex} role="radio" aria-checked={accent === a.hex} className={'accent-sw' + (accent === a.hex ? ' on' : '')}
                  style={{ background: a.hex }} title={tr(a.name as Key) + (a.hex === DEFAULT_ACCENT ? ' ' + tr('(default)') : '')} aria-label={tr(a.name as Key)} onClick={() => setAccent(a.hex)} />
              ))}
              <span className={'accent-custom-wrap' + (ACCENTS.some((a) => a.hex === accent) ? '' : ' on')}>
                <ColorField value={accent} onChange={setAccent} label={tr('Custom accent colour')}><span>{tr('Custom')}</span></ColorField>
              </span>
            </div>
            <h3 className="set-sub">{tr('Layout')}</h3>
            <p className="set-note">{tr('Which side the navigation and the coach panel sit on.')}</p>
            <div className="layout-cards" role="radiogroup" aria-label={tr('Layout')}>
              {LAYOUTS.map((l) => {
                const on = ctx.layout.nav === l.nav && ctx.layout.coach === l.coach
                return (
                  <button key={l.label} role="radio" aria-checked={on} className={'layout-card' + (on ? ' on' : '')} onClick={() => ctx.setLayout({ nav: l.nav, coach: l.coach })}>
                    <span className="layout-pic" aria-hidden>
                      {l.cols.map((c, i) => <i key={i} className={'lp-' + c} />)}
                    </span>
                    <span className="theme-l">{tr(l.label)}</span>
                  </button>
                )
              })}
            </div>
          </section>
          <section id="set-coach" className="card sec">
            <h2 className="sec-h">{tr('Coach')}</h2>
            <CoachSettingsView ctx={ctx} />
          </section>
          <section id="set-keys" className="card sec">
            <h2 className="sec-h">{tr('Keyboard')}</h2>
            <div className="keys">
              {KEYS.map(([g, rows]) => (
                <div key={g} className="keys-g">
                  <div className="keys-h">{tr(g)}</div>
                  <ul>{rows.map(([k, d]) => <li key={k}><span className="keys-k">{k.split('  ').map((x) => <kbd key={x}>{x === 'Right click' || x === 'Ctrl + wheel' || x === 'Delete' ? tr(x) : x}</kbd>)}</span><span className="t2">{tr(d)}</span></li>)}</ul>
                </div>
              ))}
            </div>
          </section>
          <section id="set-data" className="card sec">
            <h2 className="sec-h">{tr('Data')}</h2>
            <DataSection ctx={ctx} />
          </section>
          <section id="set-updates" className="card sec">
            <h2 className="sec-h">{tr('Updates')}</h2>
            <UpdateSection onShow={ctx.showUpdate} />
          </section>
          <section id="set-health">
            <HealthPanel ctx={ctx} />
          </section>
        </div>
      </div>
    </div>
  )
}

/** Where this install keeps what it records, and moving all of it as one file. */
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
    <>
      <p className="set-note">{t('Everything you record lives in one folder on this computer, apart from the app: the database, notebook pictures, your picture and the automatic backups. Deleting or updating the app doesn\'t touch it.')}</p>
      {folder && <p className="data-path mono">{folder}</p>}
      <h3 className="set-sub">{t('Backup file')}</h3>
      <p className="set-note">{t('All of it in one file, to keep somewhere safe or to move to another computer. Your API key isn\'t in it.')}</p>
      <div className="inline-form">
        <button type="button" className="btn sm" {...busyProps(busy)} onClick={download}><Download size={14} strokeWidth={1.6} /><span>{t('Download a backup')}</span></button>
      </div>
      <h3 className="set-sub">{t('Restore')}</h3>
      <p className="set-note">{t('Replaces everything here with a backup file. A running task is paused first, and what is here now is kept in the backups folder.')}</p>
      <div className="inline-form">
        <button type="button" className="btn ghost sm" {...busyProps(busy)} onClick={restore}><ArchiveRestore size={14} strokeWidth={1.6} /><span>{t('Restore from a backup…')}</span></button>
      </div>
      <ResetPanel ctx={ctx} kind="start" download={download} busy={busy} />
      <ResetPanel ctx={ctx} kind="delete" download={download} busy={busy} />
    </>
  )
}

/** Starting over (the plan goes, the account stays) or deleting the account (everything goes). Each opens a panel that
    says what goes and what stays, and acts only once the confirming word is typed. */
function ResetPanel({ ctx, kind, download, busy: outerBusy }: { ctx: Ctx; kind: 'start' | 'delete'; download: () => void; busy: boolean }) {
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
  return (
    <>
      <h3 className="set-sub">{start ? t('Start over') : t('Delete the account')}</h3>
      <p className="set-note">{start
        ? t('Removes the plan and everything done under it: days, tasks, tests, scores, notes and the coach\'s conversations. Your name, picture, the coach\'s settings and memory notes, and the AI providers stay. A backup file of everything is saved to the backups folder first, so Restore can bring it back. Then you set up a new plan.')
        : t('Removes everything this app recorded on this computer, the automatic backups included: the app is as on the day it was installed. The app itself, downloaded Khan content and files of yours outside the data folder stay. This can\'t be undone.')}</p>
      {!open
        ? <div className="inline-form"><button type="button" className="btn danger sm" disabled={outerBusy} onClick={() => setOpen(true)}>
            {start ? <RotateCcw size={14} strokeWidth={1.6} /> : <Trash2 size={14} strokeWidth={1.6} />}<span>{start ? t('Start over…') : t('Delete the account…')}</span></button></div>
        : (
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
              <button type="submit" className="btn danger sm" {...busyProps(busy)} disabled={busy || !ok}>
                {start ? <RotateCcw size={14} strokeWidth={1.6} /> : <Trash2 size={14} strokeWidth={1.6} />}<span>{start ? t('Start over') : t('Delete everything')}</span></button>
              <button type="button" className="btn ghost sm" disabled={busy} onClick={() => { setOpen(false); setTyped(''); setKeys(false) }}><span>{t('Cancel')}</span></button>
            </div>
          </form>
        )}
    </>
  )
}

// shown through tx(), in the interface language (the Progress page uses the same words)
const UNIT_STATUS: Record<TrackStatus, string> = {
  passed: 'passed', done: 'done', current: 'now', doing: 'in progress', tried: 'tried, below threshold', planned: 'planned', todo: 'up next', removed: 'taken out',
}

/** Each course's units with a tick for being in the plan: unticked, a unit is taken out (and can be put back). A passed
    unit is done and stays; a course keeps at least one unit. */
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
    <div className="draft-tracks plan-units">
      {p.progress.map((tr, ti) => {
        const kept = tr.units.filter((u) => u.status !== 'removed').length
        const on = open === tr.key
        return (
          <div key={tr.key} className={'draft-track' + (on ? ' open' : '')}>
            <button type="button" className="draft-track-h" aria-expanded={on} onClick={() => setOpen(on ? null : tr.key)}>
              {on ? <ChevronDown size={16} strokeWidth={1.6} /> : <ChevronRight size={16} strokeWidth={1.6} />}
              <span className={'trk-dot trk-' + (ti % 6)} aria-hidden />{tr.label}
              <span className="t3 mono">{kept < tr.units.length ? t('{a} of {b} units', { a: kept, b: tr.units.length }) : tr.units.length}</span>
            </button>
            {on && (
              <div className="draft-track-b">
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
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** The plan the app runs: what it is, how far each track is, its file, and changing it (always through a new draft). */
function PlanSection({ ctx }: { ctx: Ctx }) {
  const p = useLoad(() => api.plan(), [ctx.version])
  const [examBusy, runExam] = useBusy()
  if (!p) return null
  if (!p.ready) return (
    <>
      <p className="set-note">{t('There is no plan yet. Answer a few questions and the model drafts one for you to approve.')}</p>
      <div className="inline-form"><button type="button" className="btn primary sm" onClick={() => ctx.go({ kind: 'setup' })}><PencilLine size={14} strokeWidth={1.6} /><span>{t('Set up your plan')}</span></button></div>
    </>
  )
  if (p.key === 'ctu') return (
    <>
      <p className="plan-name">{p.label}</p>
      <p className="set-note">{t('The plan this app was built with. Its next phases are approved under System health; its log is COACH.md.')}</p>
      <div className="inline-form"><button type="button" className="btn ghost sm" onClick={() => ctx.go({ kind: 'setup' })}><PencilLine size={14} strokeWidth={1.6} /><span>{t('Set up a different plan…')}</span></button></div>
    </>
  )
  return (
    <>
      <p className="plan-name">{p.label}</p>
      <p className="set-note">{t('Approved {date}. Starts {start}.', { date: (p.approved_at ?? '').slice(0, 10), start: p.start_date })}</p>
      {(p.projected_end || p.deadline) && (
        <p className="set-note">
          {p.projected_end && t('At this pace the last unit ends {end}.', { end: p.projected_end })}{' '}
          {p.deadline && t('Deadline: {date}.', { date: p.deadline })}{' '}
          {p.projected_end && p.deadline && p.projected_end > p.deadline && <b>{t('That is after the deadline: change the plan to fit it.')}</b>}
        </p>
      )}
      <ul className="plan-tracks">
        {p.progress.map((tr, i) => {
          const passed = tr.units.filter((u) => u.status === 'passed').length
          const cur = tr.units.find((u) => u.status === 'current' || u.status === 'tried')
          return (
            <li key={tr.key}>
              <span className={'trk-dot trk-' + (i % 6)} aria-hidden />
              <span className="pt-l">{tr.label}</span>
              <span className="pt-n mono">{passed}/{tr.units.length}</span>
              {cur && <span className="pt-c t3">{t('now: {unit}', { unit: cur.name })}</span>}
            </li>
          )
        })}
      </ul>
      <h3 className="set-sub">{t('Units in the plan')}</h3>
      <p className="set-note">{t('Untick a unit to take it out of the plan. Days you have started keep their tasks; the days not started yet are planned again without it. Tick it again to put it back.')}</p>
      <PlanUnits p={p} ctx={ctx} />
      <h3 className="set-sub">{t('Exam dates')}</h3>
      <ExamDates key={p.tracks.map((x) => x.deadline ?? '').join()} tracks={p.tracks} start={p.start_date} today={ctx.meta?.today ?? p.start_date} busy={examBusy} ends={p.track_ends}
        note={t('Each course can have its own exam. In the last week before one, its unfinished units take blocks from courses whose exam is further away; once an exam is over, its blocks go to the next one. Days already planned keep their blocks.')}
        action={t('Save exam dates')}
        onSave={(dates) => runExam(async () => {
          const r = await ctx.run(api.setExams(dates))
          if (r) { ctx.notify(r.notes.length ? r.notes.join(' ') : t('Exam dates saved'), r.notes.length ? 'warn' : 'ok'); ctx.refresh() }
        })} />
      <div className="inline-form">
        <a className="btn ghost sm" href="/api/plan/file" download="PLAN.md"><FileText size={14} strokeWidth={1.6} /><span>{t('Download PLAN.md')}</span></a>
        <button type="button" className="btn ghost sm" onClick={() => ctx.go({ kind: 'setup' })}><PencilLine size={14} strokeWidth={1.6} /><span>{t('Change the plan…')}</span></button>
      </div>
      {p.plan_md && <p className="data-path mono">{p.plan_md}</p>}
    </>
  )
}
