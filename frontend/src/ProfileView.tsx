import { Fragment, useState } from 'react'
import { ChevronDown, ChevronRight, ExternalLink, ImageUp, Pencil, Plus, X } from 'lucide-react'
import { api, fmtDate, fmtHours, MONTHS, weekNo, type Goal, type Health, type Me, type Profile } from './api'
import type { Ctx } from './App'
import { ActivityFeed, YearGraph } from './Activity'
import { Fig, Fold, useFold, useLoad } from './ui'
import { busyProps, useBusy } from './interact'
import { squareAvatar } from './picture'
import { t, tx } from './i18n'

/** GitHub-profile layout: identity and goals on the left; numbers, the year graph, activity and roadmap on the right. */
export default function ProfileView({ ctx }: { ctx: Ctx }) {
  const p = useLoad(() => api.profile(), [ctx.version])
  const act = useLoad(() => api.activity(), [ctx.version])
  if (!p) return <div className="page" />
  const g = p.github
  const tot = p.totals
  const phase = p.roadmap.find((r) => r.current)
  const since = g ? `${MONTHS[Number(g.created_at.slice(5, 7)) - 1]} ${g.created_at.slice(0, 4)}` : ''

  return (
    <div className="page prof">
      <aside className="prof-side">
        {g && p.me.github === 'on' ? (
          <>
            <img className="avatar" src={g.avatar_url} alt="" width={160} height={160} />
            <div className="prof-id">
              <div>
                <div className="prof-name">{g.name ?? g.login}</div>
                <div className="prof-login mono">{g.login}</div>
              </div>
              <a className="btn ghost sm prof-gh" href={g.html_url} target="_blank" rel="noreferrer">GitHub<ExternalLink size={13} strokeWidth={1.5} /></a>
            </div>
            <div className="prof-meta">
              <span>{t('{n} public repos', { n: g.public_repos })}</span>
              <span>{t('On GitHub since {date}', { date: since })}</span>
              <span>{t('Week {n}', { n: weekNo(p.week) })} · {t('started {date}', { date: fmtDate(p.start) })}</span>
              {phase && <span>{t('Phase {name}', { name: phase.label })}</span>}
            </div>
            <button type="button" className="btn ghost sm prof-switch" onClick={async () => { if (await ctx.run(api.meGithub('off'))) ctx.refresh() }}>{t('Show my local profile instead')}</button>
          </>
        ) : (
          <>
            <LocalId me={p.me} ctx={ctx} week={p.week} start={p.start} phase={phase?.label} />
            {p.me.github === 'on' && <div className="side-note">{t('Your GitHub profile couldn\'t be loaded. The gh command needs to be logged in on this computer:')} <span className="mono">gh auth status</span></div>}
            {p.github_offer && p.me.github === null && <GithubOffer login={p.github_offer.login} ctx={ctx} />}
            {p.github_offer && p.me.github === 'off' && <button type="button" className="btn ghost sm prof-switch" onClick={async () => { if (await ctx.run(api.meGithub('on'))) ctx.refresh() }}>{t('Show my GitHub profile ({login}) instead', { login: p.github_offer.login })}</button>}
          </>
        )}

        <Goals goals={p.goals} ctx={ctx} />
      </aside>

      <div className="prof-main">
        <div className="figures">
          <Fig label={t('Total study')} value={fmtHours(tot.minutes)} note={t(tot.closed_days === 1 ? '{n} day closed' : '{n} days closed', { n: tot.closed_days })} />
          <Fig label={t('Tasks done')} value={tot.tasks_done} />
          <Fig label={t('Tests')} value={<>{tot.test_correct}<small>/{tot.test_total}</small></>} note={t(tot.tests === 1 ? '{n} test' : '{n} tests', { n: tot.tests })} />
          <Fig label={t('Streak')} value={<>{tot.streak}<small> {t(tot.streak === 1 ? 'day' : 'days')}</small></>} note={t('best {n} · 30+ min a day', { n: tot.best_streak })} />
        </div>

        <YearGraph act={act} ctx={ctx} />

        <Fold title={t('Activity')} fold="prof.activity">
          <ActivityFeed ctx={ctx} initial={5} />
        </Fold>

        <Fold title={t('Roadmap')} meta={ctx.meta?.plan?.key === 'ctu' ? 'COACH.md' : undefined} fold="prof.roadmap">
          <ol className="road card">
            {p.roadmap.map((r) => <Phase key={r.label} r={r} today={p.today} />)}
            {p.roadmap.length === 0 && <div className="empty">{ctx.meta?.plan?.key === 'ctu' ? t('No roadmap found in COACH.md') : t('This plan has no phases')}</div>}
          </ol>
        </Fold>
      </div>
    </div>
  )
}

/** The local account: a name and a picture kept on this computer. The picture is copied into the data folder. */
function LocalId({ me, ctx, week, start, phase }: { me: Me; ctx: Ctx; week: number; start: string; phase?: string }) {
  const [draft, setDraft] = useState<string | null>(null)
  const [busy, run] = useBusy()
  const choose = () => {
    const inp = document.createElement('input')
    inp.type = 'file'; inp.accept = 'image/png,image/jpeg,image/webp,image/gif'
    inp.onchange = () => {
      const f = inp.files?.[0]
      if (f) run(async () => {
        try { await api.mePhoto(await squareAvatar(f)); ctx.refresh() }
        catch (e) { ctx.notify(t('The picture wasn\'t saved: {e}', { e: (e as Error).message }), 'err') }
      })
    }
    inp.click()
  }
  const save = () => run(async () => { if (draft !== null && await ctx.run(api.meName(draft))) { setDraft(null); ctx.refresh() } })
  return (
    <>
      <button type="button" className="avatar me-pic" onClick={choose} {...busyProps(busy)} aria-label={me.photo ? t('Change your picture') : t('Add a picture')} title={me.photo ? t('Change your picture') : t('Add a picture')}>
        {me.photo ? <img src={me.photo} alt="" draggable={false} /> : <span className="me-initial">{(me.name.trim()[0] ?? '').toUpperCase() || <ImageUp size={28} strokeWidth={1.4} />}</span>}
      </button>
      {draft === null ? (
        <div className="prof-id">
          <div>
            <div className={'prof-name' + (me.name ? '' : ' t3')}>{me.name || t('Your name')}</div>
            <div className="prof-login">{t('Local profile on this computer')}</div>
          </div>
          <button type="button" className="icon-btn sm" onClick={() => setDraft(me.name)} aria-label={t('Edit your name')} title={t('Edit your name')}><Pencil size={13} strokeWidth={1.5} /></button>
        </div>
      ) : (
        <form className="me-edit" onSubmit={(e) => { e.preventDefault(); save() }}>
          <input className="input" value={draft} maxLength={60} autoFocus placeholder={t('Your name')} aria-label={t('Your name')}
            onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setDraft(null) }} />
          <div className="inline-form">
            <button type="submit" className="btn sm" {...busyProps(busy)}><span>{t('Save')}</span></button>
            <button type="button" className="btn ghost sm" onClick={() => setDraft(null)}>{t('Cancel')}</button>
          </div>
        </form>
      )}
      <div className="prof-meta">
        <span>{t('Week {n}', { n: weekNo(week) })} · {t('started {date}', { date: fmtDate(start) })}</span>
        {phase && <span>{t('Phase {name}', { name: phase })}</span>}
      </div>
      {me.photo && <button type="button" className="btn ghost sm prof-switch" {...busyProps(busy)} onClick={() => run(async () => { if (await ctx.run(api.mePhotoDelete())) ctx.refresh() })}>{t('Remove the picture')}</button>}
    </>
  )
}

/** GitHub is used only if the user says so. Asked once, here, when the gh command on this computer is logged in. */
function GithubOffer({ login, ctx }: { login: string; ctx: Ctx }) {
  const [busy, run] = useBusy()
  const pick = (v: 'on' | 'off') => run(async () => { if (await ctx.run(api.meGithub(v))) ctx.refresh() })
  return (
    <section className="side-sec">
      <h2 className="side-h">GitHub</h2>
      <p className="side-note gh-q">{t('This computer is signed in to GitHub as {login}. Show that profile here?', { login })}</p>
      <div className="inline-form">
        <button type="button" className="btn sm" {...busyProps(busy)} onClick={() => pick('on')}><span>{t('Use GitHub')}</span></button>
        <button type="button" className="btn ghost sm" {...busyProps(busy)} onClick={() => pick('off')}><span>{t('Keep it local')}</span></button>
      </div>
    </section>
  )
}

function Phase({ r, today }: { r: Profile['roadmap'][number]; today: string }) {
  const [open, toggle] = useFold('road.' + r.label, r.current)
  const past = r.end < today && !r.current
  return (
    <li className={'road-i' + (r.current ? ' cur' : past ? ' past' : '')}>
      <span className="road-dot" />
      <div>
        <button type="button" className="road-h fold-btn" onClick={() => toggle()} aria-expanded={open}>
          {r.label}{r.current && <span className="now-tag">{t('now')}</span>}
          <span className="road-n">{t(r.items.length === 1 ? '{n} item' : '{n} items', { n: r.items.length })}</span>
          {open ? <ChevronDown size={14} strokeWidth={1.5} /> : <ChevronRight size={14} strokeWidth={1.5} />}
        </button>
        {open && <ul>{r.items.map((it, i) => <li key={i}>{it}</li>)}</ul>}
      </div>
    </li>
  )
}

/** Goals are display text you own. Editing them changes nothing in the plan or the thresholds. */
function Goals({ goals, ctx }: { goals: Goal[]; ctx: Ctx }) {
  const [draft, setDraft] = useState<Goal[] | null>(null)
  const [busy, setBusy] = useState(false)
  const set = (i: number, k: keyof Goal, v: string) => setDraft((d) => d!.map((g, j) => (j === i ? { ...g, [k]: v } : g)))
  const save = async () => {
    setBusy(true)
    const r = await ctx.run(api.saveGoals(draft!.filter((g) => g.label.trim())))
    setBusy(false)
    if (r) { setDraft(null); ctx.refresh() }
  }

  return (
    <div className="side-sec">
      <h3 className="side-h">
        {t('Goals')}
        {!draft && <button className="icon-btn sm" onClick={() => setDraft(goals.map((g) => ({ ...g })))} aria-label={t('Edit goals')} title={t('Edit goals')}><Pencil size={13} strokeWidth={1.5} /></button>}
      </h3>
      {!draft && goals.map((x) => (
        <div key={x.label} className="goal" data-ask={`Goal: ${x.label} ${x.target}${x.note ? ` (${x.note})` : ''}`}>
          <div className="goal-top"><span>{x.label}</span><b className="mono">{x.target}</b></div>
          {x.note && <div className="goal-n">{x.note}</div>}
        </div>
      ))}
      {!draft && goals.length === 0 && <div className="empty">{t('No goals yet')}</div>}
      {draft && (
        <form className="goal-edit" onSubmit={(e) => { e.preventDefault(); save() }}>
          {draft.map((g, i) => (
            <div key={i} className="goal-row">
              <div className="goal-row-top">
                <input className="input" placeholder={t('Goal')} value={g.label} onChange={(e) => set(i, 'label', e.target.value)} />
                <input className="input mono w80" placeholder={t('Target')} value={g.target} onChange={(e) => set(i, 'target', e.target.value)} />
                <button type="button" className="icon-btn sm" aria-label={t('Remove goal')} onClick={() => setDraft((d) => d!.filter((_, j) => j !== i))}><X size={14} strokeWidth={1.5} /></button>
              </div>
              <input className="input" placeholder={t('Note')} value={g.note} onChange={(e) => set(i, 'note', e.target.value)} />
            </div>
          ))}
          <button type="button" className="btn ghost sm" onClick={() => setDraft((d) => [...d!, { label: '', target: '', note: '' }])}><Plus size={13} strokeWidth={1.5} />{t('Add goal')}</button>
          <div className="inline-form">
            <button className="btn primary sm" type="submit" disabled={busy}>{t('Save')}</button>
            <button className="btn ghost sm" type="button" onClick={() => setDraft(null)}>{t('Cancel')}</button>
          </div>
          <p className="side-note">{t("Goals are your own notes. Thresholds and the plan don't change here")}</p>
        </form>
      )}
    </div>
  )
}

// shown through tx()
const WATCH_LABEL: Record<string, string> = { watching: 'watching', waiting: 'waiting for the folder', error: 'error', restarting: 'restarting', starting: 'starting', unused: 'off (this plan has no study repo)' }
const when = (ts: string | null | undefined) => (ts ? ts.slice(0, 16).replace('T', ' ') : t('never'))

/** Everything that can go wrong without anyone noticing: paths, watcher, backups, unfinished closes, what the app wrote. */
export function HealthPanel({ ctx }: { ctx: Ctx }) {
  const h = useLoad(() => api.health(), [ctx.version])
  const [busy, run] = useBusy()
  const [data, setData] = useState<Health | null>(null)
  const x = data ?? h
  if (!x) return null
  const jobs = Object.entries(x.close_jobs)
  const ws = Object.entries(x.warnings)
  const problems = ws.length + jobs.length + (x.watcher.state === 'watching' || x.watcher.state === 'unused' ? 0 : 1) + Object.values(x.paths).filter((p) => !p.ok).length
  const r = x.runway
  return (
    <Fold title={t('Health')} meta={problems ? t('{n} to look at', { n: problems }) : t('all good')} fold="prof.health">
      <div className="card" style={{ padding: 16 }}>
        <dl className="health-grid">
          <dt>{t('API key')}</dt><dd>{x.api_key ? t('set') : t('not set: built-in questions, template plans, no coach')}</dd>
          {Object.entries(x.paths).map(([k, p]) => (
            <Fragment key={k}><dt>{k}</dt><dd className={p.ok ? '' : 'neg'}><span className="mono">{p.path}</span>{p.ok ? '' : ` · ${t('missing')}`}</dd></Fragment>
          ))}
          <dt>{t('Repo watcher')}</dt><dd className={x.watcher.state === 'watching' || x.watcher.state === 'unused' ? '' : 'neg'}>{tx(WATCH_LABEL[x.watcher.state] ?? x.watcher.state)}{x.watcher.state !== 'watching' && x.watcher.state !== 'unused' && x.watcher.detail ? ` · ${x.watcher.detail}` : ''}</dd>
          <dt>{t('Code sandbox')}</dt><dd>{x.sandbox ? t('bubblewrap (test code runs isolated)') : t('not available: test code runs with limits only')}</dd>
          <dt>{t('Last backup')}</dt><dd>{when(x.last_backup?.ts)} · {t('{n} kept', { n: x.backups })}{x.last_backup ? <> · <span className="mono">{x.last_backup.path}</span></> : null}</dd>
          <dt>{t('Curriculum left')}</dt><dd>{r.tracks ? r.tracks.map((x) => `${x.label} ${t('{a}/{b} units', { a: x.left, b: x.units })}`).join(' · ')
            : <>C {t('{n} study days', { n: r.c_days ?? `${r.horizon}+` })} · Kintsugi {r.kintsugi_days ?? `${r.horizon}+`} · Khan {t('{n} units', { n: r.khan_units_left })}</>}</dd>
          <dt>{t('Database')}</dt><dd>{t('schema v{n}', { n: x.schema_version })}{x.fake_clock ? ` · ${t('demo clock (CTU_NOW)')}` : ''}</dd>
        </dl>
        {jobs.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div className="note">{t('Unfinished closes (retried every 10 minutes):')}</div>
            <ul className="checklist">
              {jobs.map(([ds, j]) => (
                <li key={ds} className="no"><span><b>{ds}</b>: {j.pending.join(', ')}{Object.keys(j.errors).length ? ` · ${Object.entries(j.errors).map(([k, v]) => `${k}: ${v}`).join('; ')}` : ''} · {t('{n} tries', { n: j.attempts })}</span></li>
              ))}
            </ul>
            <button className="btn sm" {...busyProps(busy)} onClick={() => run(async () => { const y = await ctx.run(api.retryCloses()); if (y) { setData(y); ctx.refresh() } })}><span>{t('Retry now')}</span></button>
          </div>
        )}
        {x.phases.length > 0 && <div style={{ marginTop: 12 }}>
          <div className="note">{t('Next phases from the COACH.md roadmap. Each one changes the plan only after you approve it; until then, finished tracks review earlier work:')}</div>
          <ul className="checklist">
            {x.phases.map((ph) => (
              <li key={ph.key} className={ph.approved ? 'ok' : ''}>
                <span style={{ flex: 1 }}><b>{ph.label}</b>{ph.approved ? ` · ${t('approved')}` : ''}. {ph.what} <span className="t3">{ph.roadmap}</span></span>
                <button className={'btn sm' + (ph.approved ? ' ghost' : '')} {...busyProps(busy)} onClick={() => run(async () => {
                  const y = await ctx.run(api.setPhase(ph.key, !ph.approved))
                  if (y) { ctx.notify(ph.approved ? t('{name}: approval withdrawn', { name: ph.label }) : t('{name} approved; new days use it', { name: ph.label })); setData(null); ctx.refresh() }
                })}><span>{ph.approved ? t('Withdraw') : t('Approve')}</span></button>
              </li>
            ))}
          </ul>
        </div>}
        {x.external_writes.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div className="note">{t('Files the app wrote outside its database (newest first):')}</div>
            <ul className="checklist">
              {x.external_writes.map((w, i) => <li key={i}><span className="mono">{when(w.ts)}</span><span>{w.action} · <span className="mono">{w.file}</span></span></li>)}
            </ul>
          </div>
        )}
      </div>
    </Fold>
  )
}
