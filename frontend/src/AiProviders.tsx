import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { flushSync } from 'react-dom'
import { Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, ExternalLink, GripVertical, KeyRound, Plug, X } from 'lucide-react'
import { api, type AiModel, type AiProvider, type AiView, type Effort } from './api'
import type { Ctx } from './App'
import { Select, Switch } from './controls'
import { ModelPicker, toModel, type Catalog } from './ModelPicker'
import { t } from './i18n'
import { Group, PathField, Row } from './settingsui'
import { busyProps, useBusy, useShake } from './interact'

/** Settings → AI providers. Each provider keeps several keys in .env, tried in order; the first provider that is set
    up answers, and the next ones only when the user allows it. */
// the effort levels by name (shown through t())
const EFFORT_NAME = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Maximum' } as const

export function AiProviders({ ctx, onSaved, bare, detail }: { ctx: Ctx; onSaved?: () => void; bare?: boolean; detail?: string }) {
  const [v, setV] = useState<AiView | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [busy, run] = useBusy()
  const first = useRef(true)
  // reloads after every save: only the very first one opens the provider that answers; later ones leave the panels be
  useEffect(() => {
    let off = false
    api.ai().then((x) => {
      if (off) return
      setV(x)
      if (first.current) { first.current = false; setOpen(bare ? x.primary ?? null : null) }
    }).catch(() => {})
    return () => { off = true }
  }, [ctx.version])
  const sort = useSortable(v?.providers.map((p) => p.id) ?? [], (order) => {
    if (!v) return
    // shown in the new order at once; the server's answer follows
    setV({ ...v, providers: order.map((id) => v.providers.find((p) => p.id === id)!) })
    put({ order })
  }, () => { if (bare) setOpen(null) })   // a row open inline closes while one is dragged
  if (!v) return null

  const put = (b: Parameters<typeof api.aiPut>[0]) => run(async () => {
    const x = await ctx.run(api.aiPut(b))
    if (x) { setV(x); ctx.refresh(); onSaved?.() }
    else ctx.refresh()   // not saved: reload, so a row moved ahead of time goes back to its place
  })
  const others = v.providers.filter((p) => p.ready && !p.primary).length
  // the order as it would be if the row being dragged were dropped now: numbers and "answers first" follow it
  const preview = sort.preview.map((id) => v.providers.find((p) => p.id === id)!)
  const primary = preview.find((p) => p.ready)?.id ?? null
  const ready = preview.filter((p) => p.ready)

  const list = (
    <div className="ai">
      <div className="ai-order-h">
        <span className={'ai-preview' + (sort.dragging ? ' on' : '')} aria-hidden={!sort.dragging}>
          {ready.length
            ? ready.map((p, k) => <span key={p.id} className={k === 0 ? 'first' : ''}>{p.label}</span>)
              .flatMap((el, k) => (k ? [<span key={'s' + k} className="ai-preview-s">{v.fallback ? '→' : '·'}</span>, el] : [el]))
            : <span>{t('No provider is set up yet')}</span>}
          {!v.fallback && ready.length > 1 && <span className="ai-preview-n">{t('only the first answers')}</span>}
        </span>
      </div>
      <ol className={'ai-list' + (sort.dragging ? ' sorting' : '')} ref={sort.listRef}>
        {v.providers.map((p, i) => (
          <ProviderRow key={p.id} p={p} pos={sort.preview.indexOf(p.id)} primary={p.id === primary} open={open === p.id} view={v} ctx={ctx} master={!bare}
            toggle={() => { if (sort.justDropped()) return; if (bare) setOpen(open === p.id ? null : p.id); else ctx.go({ kind: 'settings', section: 'ai', sub: p.id }) }}
            setV={(x) => { setV(x); ctx.refresh(); onSaved?.() }}
            drag={sort.rowProps(p.id, i, p.label)} handle={sort.handleProps(i, p.label)} />
        ))}
      </ol>
      <span className="sr-only" aria-live="polite">{sort.said}</span>
    </div>
  )
  const fallback = (
    <Row label={t('When a provider fails, try the next one')} hint={v.fallback
      ? t('On: the providers above are tried top to bottom until one answers. A reply from another provider says so.')
      : others
        ? t('Off: only the first provider that is set up answers; the {n} other set-up provider(s) wait.', { n: others })
        : t('Off: only the first provider that is set up answers.')}>
      <Switch checked={v.fallback} disabled={busy} onChange={(on) => put({ fallback: on })} label={t('When a provider fails, try the next one')} />
    </Row>
  )
  const keys = (
    <Row label={t('Where the keys are kept')} hint={t('In this file on this computer, never in a backup. A provider can have several keys: they are tried one after the other.')}>
      <PathField path={v.env_file} keep={2} />
    </Row>
  )
  // in plan setup the providers sit on the wizard's own panel: no cards inside it
  if (bare) return <>{list}{fallback}{keys}</>
  // Settings: the list; a provider opens on a page of its own (#/settings/ai/<id>), with a way back to the list
  const sel = detail ? v.providers.find((p) => p.id === detail) : undefined
  if (sel) {
    const st = status(sel, v)
    return (
      <>
        <header className="set-head">
          <button type="button" className="set-up" onClick={() => ctx.go({ kind: 'settings', section: 'ai' })}><ChevronLeft size={15} strokeWidth={1.7} /><span>{t('AI providers')}</span></button>
          <h1>{sel.label}{sel.id === primary && <span className="ai-main">{t('Answers first')}</span>}</h1>
          <p>{st.text}</p>
        </header>
        <Group title={t('Settings')}>
          <ProviderBody key={sel.id} p={sel} view={v} ctx={ctx} setV={(x) => { setV(x); ctx.refresh(); onSaved?.() }} />
        </Group>
      </>
    )
  }
  return (
    <>
      <Group title={t('Providers')} note={t('Drag a row to change the order: the first one that is set up answers. Open one for its keys and models.')}>{list}</Group>
      <Group title={t('How they are used')}>{fallback}{keys}</Group>
    </>
  )
}

/** Reordering a list by dragging any of its rows (a press that moves more than a few pixels; a plain click stays a
    click), or with the arrow keys on a row's grip. While a row is held, the others slide to where they would end up. */
function useSortable(ids: string[], onDrop: (order: string[]) => void, onStart: () => void) {
  const listRef = useRef<HTMLOListElement>(null)
  const [drag, setDrag] = useState<{ id: string; from: number; over: number; dy: number } | null>(null)
  const [said, setSaid] = useState('')
  const dropped = useRef(0)
  const geo = useRef<{ tops: number[]; hs: number[]; gap: number }>({ tops: [], hs: [], gap: 8 })

  const order = (from: number, over: number) => {
    const o = [...ids]
    const [x] = o.splice(from, 1)
    o.splice(over, 0, x)
    return o
  }
  const preview = drag ? order(drag.from, drag.over) : ids

  const measure = () => {
    const lis = [...(listRef.current?.children ?? [])] as HTMLElement[]
    const tops = lis.map((li) => li.getBoundingClientRect().top), hs = lis.map((li) => li.offsetHeight)
    geo.current = { tops, hs, gap: lis.length > 1 ? tops[1] - tops[0] - hs[0] : 8 }
  }
  const overFor = (from: number, dy: number) => {
    const { tops, hs } = geo.current
    const mid = tops[from] + hs[from] / 2 + dy
    let over = 0
    for (let k = 0; k < tops.length; k++) if (k !== from && tops[k] + hs[k] / 2 < mid) over++
    return over
  }

  const begin = (e: React.PointerEvent, id: string, from: number, label: string) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('input, a, .ai-body')) return
    const sx = e.clientX, sy = e.clientY
    const scroller = listRef.current?.closest('.main') as HTMLElement | null
    let s0 = 0, live = false, lastY = sy, raf = 0
    const dyNow = () => lastY - sy + (scroller ? scroller.scrollTop - s0 : 0)
    const update = () => { const dy = dyNow(); setDrag({ id, from, over: overFor(from, dy), dy }) }
    // near the top or bottom of the window the page scrolls along
    const tick = () => {
      if (!scroller) return
      const edge = 70, h = window.innerHeight
      const v = lastY < edge ? -(edge - lastY) / 4 : lastY > h - edge ? (lastY - (h - edge)) / 4 : 0
      if (v) { scroller.scrollTop += v; update() }
      raf = requestAnimationFrame(tick)
    }
    const move = (ev: PointerEvent) => {
      lastY = ev.clientY
      if (!live) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return
        live = true
        flushSync(onStart)          // an open panel closes first, so rows are measured at their folded height
        measure()
        s0 = scroller?.scrollTop ?? 0
        document.body.classList.add('is-sorting')
        raf = requestAnimationFrame(tick)
      }
      ev.preventDefault()
      update()
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      cancelAnimationFrame(raf)
      document.body.classList.remove('is-sorting')
      if (!live) return
      dropped.current = Date.now()
      const over = overFor(from, dyNow())
      setDrag(null)
      if (over !== from) {
        const o = order(from, over)
        onDrop(o)
        setSaid(t('{p} moved to place {n} of {m}.', { p: label, n: over + 1, m: ids.length }))
      }
    }
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  const shift = (k: number): CSSProperties | undefined => {
    if (!drag) return undefined
    const { hs, gap } = geo.current
    if (k === drag.from) return { transform: `translateY(${drag.dy}px)` }
    const step = (hs[drag.from] ?? 0) + gap
    if (drag.from < drag.over && k > drag.from && k <= drag.over) return { transform: `translateY(${-step}px)` }
    if (drag.from > drag.over && k >= drag.over && k < drag.from) return { transform: `translateY(${step}px)` }
    return { transform: 'translateY(0)' }
  }

  return {
    listRef, preview, said, dragging: !!drag,
    /** a click that ends a drag must not also open or close the row */
    justDropped: () => Date.now() - dropped.current < 250,
    rowProps: (id: string, k: number, label: string) => ({
      onPointerDown: (e: React.PointerEvent) => begin(e, id, k, label),
      style: shift(k),
      held: drag?.id === id,
    }),
    handleProps: (k: number, label: string) => ({
      'aria-label': t('Move {p}: arrow keys, place {n} of {m}', { p: label, n: k + 1, m: ids.length }),
      onKeyDown: (e: React.KeyboardEvent) => {
        const d = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0
        if (!d) return
        e.preventDefault()
        const to = k + d
        if (to < 0 || to >= ids.length) return
        onDrop(order(k, to))
        setSaid(t('{p} moved to place {n} of {m}.', { p: label, n: to + 1, m: ids.length }))
        // the grip keeps the focus at its new place
        requestAnimationFrame(() => (listRef.current?.children[to]?.querySelector('.ai-grip') as HTMLElement | null)?.focus())
      },
    }),
  }
}

function status(p: AiProvider, v: AiView): { text: string; tone: 'ok' | 'warn' | 'off' } {
  if (p.kind === 'cli') return !p.installed ? { text: t('Not installed'), tone: 'off' } : !p.on ? { text: t('Off'), tone: 'off' }
    : p.models.main ? { text: t('On'), tone: 'ok' } : { text: `${t('On')} · ${t('no model')}`, tone: 'warn' }
  if (p.id === 'local') return !v.local_on ? { text: t('Off'), tone: 'off' } : p.models.main ? { text: t('On'), tone: 'ok' } : { text: `${t('On')} · ${t('no model')}`, tone: 'warn' }
  if (!p.keys.length) return { text: t('No key'), tone: 'off' }
  const bad = p.keys.filter((k) => k.ok === false).length
  const n = p.keys.length === 1 ? t('1 key') : t('{n} keys', { n: p.keys.length })
  if (!p.models.main) return { text: `${n} · ${t('no model')}`, tone: 'warn' }
  return bad ? { text: `${n} · ${t('{n} failing', { n: bad })}`, tone: 'warn' } : { text: n, tone: 'ok' }
}

function ProviderRow({ p, pos, primary, open, view, ctx, toggle, setV, drag, handle, master }: {
  p: AiProvider; pos: number; primary: boolean; open: boolean; view: AiView; ctx: Ctx; toggle: () => void
  /** in Settings a row picks the provider shown beside the list, instead of opening under itself */
  master?: boolean
  setV: (v: AiView) => void
  drag: { onPointerDown: (e: React.PointerEvent) => void; style?: CSSProperties; held: boolean }
  handle: { 'aria-label': string; onKeyDown: (e: React.KeyboardEvent) => void }
}) {
  const st = status(p, view)
  const body = useId()
  return (
    <li className={'ai-row' + (open ? (master ? ' sel' : ' open') : '') + (primary ? ' primary' : '') + (drag.held ? ' held' : '') + (p.ready ? '' : ' idle')}
      style={drag.style} onPointerDown={drag.onPointerDown}>
      <div className="ai-row-head">
        <button type="button" className="ai-grip" {...handle}><GripVertical size={16} strokeWidth={1.6} /></button>
        <span className="ai-pos" aria-hidden>{pos + 1}</span>
        <button type="button" className="ai-row-btn" {...(master ? { 'aria-pressed': open } : { 'aria-expanded': open, 'aria-controls': body })} onClick={toggle}>
          <span className="ai-name">{p.label}</span>
          {primary && <span className="ai-main">{t('Answers first')}</span>}
          <span className={'ai-st ' + st.tone}>{st.text}</span>
          {master ? <ChevronRight className="ai-chev" size={16} strokeWidth={1.6} /> : <ChevronDown className="ai-chev" size={16} strokeWidth={1.6} />}
        </button>
      </div>
      {open && !master && <div className="ai-body" id={body}><ProviderBody p={p} view={view} ctx={ctx} setV={setV} /></div>}
    </li>
  )
}

function ProviderBody({ p, view, ctx, setV }: { p: AiProvider; view: AiView; ctx: Ctx; setV: (v: AiView) => void }) {
  const [key, setKey] = useState('')
  const [cat, setCat] = useState<Catalog>({ models: null, loading: false, error: '' })
  const [url, setUrl] = useState(view.local_url)
  const [tests, setTests] = useState<Record<number, { ok: boolean; reason: string }> | null>(null)
  const [busy, run] = useBusy()
  const [shaking, shake] = useShake()
  const list = useId()
  const local = p.id === 'local'
  const sub = p.kind === 'cli'
  const canAsk = local ? view.local_on : sub ? !!(p.on && p.installed) : p.keys.length > 0

  // The list is fetched once, when a picker opens (the server keeps it ten minutes); errors show in the picker.
  const load = (fresh = false) => {
    setCat((c) => ({ ...c, loading: true, error: '' }))
    api.aiModels(p.id, fresh).then((r) => setCat({ models: (r.models as (AiModel | string)[]).map(toModel), loading: false, error: '' }))
      .catch((e) => setCat((c) => ({ models: fresh ? c.models : null, loading: false, error: e instanceof Error ? e.message : String(e) })))
  }
  const add = () => {
    if (!key.trim()) { shake(); return }
    run(async () => {
      const r = await ctx.run(api.aiAddKey(p.id, key.trim()))
      if (!r) { shake(); return }
      setKey(''); setV(r)
      const n = r.providers.find((x) => x.id === p.id)?.keys.length ?? 1
      ctx.notify(t('{p} accepted the key. It is key {n}, saved in .env.', { p: p.label, n }), 'ok')
    })
  }
  const remove = async (i: number, hint: string) => {
    const ok = await ctx.confirm({ title: t('Remove {p} key {n}?', { p: p.label, n: i + 1 }), body: t('The key ending {h} is taken out of .env. The provider itself keeps it; delete it there too if it leaked.', { h: hint }), action: t('Remove'), danger: true })
    if (!ok) return
    run(async () => { const r = await ctx.run(api.aiRemoveKey(p.id, i)); if (r) { setV(r); setTests(null) } })
  }
  const pickModel = (role: 'main' | 'chat', id: string) => run(async () => {
    const r = await ctx.run(api.aiPut({ models: { [p.id]: { [role]: id } } }))
    if (r) { setV(r); setTests(null); ctx.notify(t('{p} now uses {m} for {r}.', { p: p.label, m: id || t('the same model'), r: role === 'main' ? t('tests and plans') : t('the coach chat') }), 'ok') }
  })
  const pickEffort = (e: Effort | '') => run(async () => {
    const r = await ctx.run(api.aiPut({ effort: { [p.id]: e } }))
    if (r) { setV(r); ctx.notify(e ? t('{p} now thinks at {e} for tests and plans.', { p: p.label, e: t(EFFORT_NAME[e]) }) : t('{p} uses each task\'s own effort again.', { p: p.label }), 'ok') }
  })
  const pickWeb = (on: boolean) => run(async () => {
    const r = await ctx.run(api.aiPut({ web: { [p.id]: on } }))
    if (r) { setV(r); ctx.notify(on ? t('{p} may search the web for plans and the coach.', { p: p.label }) : t('{p} no longer searches the web.', { p: p.label }), 'ok') }
  })
  const test = () => run(async () => {
    const r = await ctx.run(api.aiTest(p.id))
    if (r) { setV(r); setTests(Object.fromEntries(r.results.map((x) => [x.index, x]))) }
  })

  const picker = (role: 'main' | 'chat') => canAsk
    ? <ModelPicker label={role === 'main' ? t('{p} model for tests and plans', { p: p.label }) : t('{p} model for the coach chat', { p: p.label })}
        value={p.models[role]} catalog={cat} load={load} provider={p.label} same={role === 'chat' ? p.models.main : undefined} onPick={(id) => pickModel(role, id)} />
    : <span className="sr-v mono">{p.models[role] || (role === 'chat' ? t('Same as tests and plans') : '—')}</span>
  const testHint = tests?.[0] && sub ? (tests[0].ok ? t('Works') : tests[0].reason)
    : !canAsk ? (local ? t('Switch the local model on to see the models it has.') : sub ? t('Switch it on to pick a model.') : t('Add a key to see the models {p} offers.', { p: p.label }))
      : !p.models.main ? t('Pick a model: until then {p} is skipped.', { p: p.label })
        : sub ? t('Sends one short question through the program.') : t('Asks every key for a one-word reply.')

  return (
    <div className="ai-in">
      <p className="ai-about">{p.note}{p.keys_url && <>{' '}<a href={p.keys_url} target="_blank" rel="noreferrer">{t('Get a key')}<ExternalLink size={12} strokeWidth={1.6} /></a></>}</p>

      {local && (<>
        <Row label={t('Use a model running on this computer')}>
          <Switch checked={view.local_on} disabled={busy} label={t('Use a model running on this computer')} onChange={(on) => run(async () => { const r = await ctx.run(api.aiPut({ local_on: on })); if (r) setV(r) })} />
        </Row>
        <Row label={t('Server address')} htmlFor={list + '-url'} hint={t('Ollama: http://localhost:11434/v1 · LM Studio: http://localhost:1234/v1. A key is only needed if your server asks for one.')} stack>
          <form className="inline-form" onSubmit={(e) => { e.preventDefault(); run(async () => { const r = await ctx.run(api.aiPut({ local_url: url })); if (r) { setV(r); ctx.notify(t('Saved'), 'ok') } }) }}>
            <input id={list + '-url'} className="input mono ai-url" value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} placeholder="http://localhost:11434/v1" />
            {url !== view.local_url && <button className="btn sm" type="submit" {...busyProps(busy)}><span>{t('Save')}</span></button>}
          </form>
        </Row>
      </>)}

      {sub && (
        <Row label={t('Use my subscription through the {c} program', { c: p.command })}
          hint={p.installed
            ? t('Sign in once: run {c} in a terminal and log in with your account. The app runs it in the background with its own tools switched off, apart from web search when that is on; API keys in .env are not passed to it.', { c: p.command })
            : t('The {c} program isn\'t installed on this computer. Install it, sign in once, then switch this on.', { c: p.command })}>
          <Switch checked={!!p.on} disabled={busy || !p.installed} label={t('Use my subscription through the {c} program', { c: p.command })}
            onChange={(on) => run(async () => { const r = await ctx.run(api.aiPut({ cli_on: { [p.id]: on } })); if (r) { setV(r); setTests(null) } })} />
        </Row>
      )}

      {!sub && (
        <Row label={t('Keys')} hint={t('The key is checked with {p} first, then added to the end of its line in .env.', { p: p.label })} stack>
          {p.keys.length > 0 && (
            <ol className="ai-keys">
              {p.keys.map((k) => {
                const r = tests?.[k.index]
                const ok = r ? r.ok : k.ok
                const reason = r ? r.reason : k.reason
                return (
                  <li key={k.index} className="ai-key">
                    <span className="ai-key-n">{k.index + 1}</span>
                    <span className="mono">{k.hint}</span>
                    <span className={'ai-key-st ' + (ok === true ? 'ok' : ok === false ? 'bad' : '')}>
                      {ok === true ? <><Check size={13} strokeWidth={2} />{t('Works')}</>
                        : ok === false ? <><CircleAlert size={13} strokeWidth={1.8} />{reason}{k.resting ? ' · ' + t('resting for a few minutes') : ''}</>
                          : t('Not used yet')}
                    </span>
                    <button type="button" className="icon-btn sm" onClick={() => remove(k.index, k.hint)} aria-label={t('Remove key {n}', { n: k.index + 1 })} title={t('Remove')}><X size={14} strokeWidth={1.6} /></button>
                  </li>
                )
              })}
            </ol>
          )}
          <form className="inline-form" onSubmit={(e) => { e.preventDefault(); e.stopPropagation(); add() }}>
            <label className="sr-only" htmlFor={list + '-key'}>{t('{p} API key', { p: p.label })}</label>
            <input id={list + '-key'} className={'input key-input mono' + (shaking ? ' shake' : '')} type="password" autoComplete="off" spellCheck={false}
              placeholder={p.keys.length ? t('Another key') : t('Paste a key')} value={key} onChange={(e) => setKey(e.target.value)} />
            <button type="submit" className="btn sm" {...busyProps(busy)}><KeyRound size={14} strokeWidth={1.6} /><span>{t('Check and add')}</span></button>
          </form>
        </Row>
      )}

      <Row label={t('Model for tests and plans')} hint={<>{t('Writes the tests, grades them and drafts plans: pick a strong one.')}{p.default_models.main && p.models.main !== p.default_models.main
        ? <>{' '}<button type="button" className="linkish" onClick={() => pickModel('main', p.default_models.main)}>{t('Back to the default ({m})', { m: p.default_models.main })}</button></> : null}</>}>
        {picker('main')}
      </Row>
      <Row label={t('Model for the coach chat')} hint={t('Answers in the chat: a fast, cheap one is fine.')}>{picker('chat')}</Row>
      <Row label={t('Thinking effort for tests and plans')}
        hint={p.effort_levels.length === 0 ? t('{p} takes no effort setting: its models think as they are made to.', { p: p.label })
          : p.effort ? t('Every test, grading and plan is written at this level. Higher thinks longer and uses more of your limits.')
            : t('Plans, days and test questions are written at high, practice sets and lessons at medium, checks and grading at low.')}>
        {p.effort_levels.length > 0 && (
          <Select size="sm" value={p.effort} label={t('{p} thinking effort for tests and plans', { p: p.label })} onChange={pickEffort}
            options={[{ value: '' as Effort | '', label: t('Each task\'s own (recommended)') }, ...p.effort_levels.map((e) => ({ value: e as Effort | '', label: t(EFFORT_NAME[e]), text: e }))]} />
        )}
      </Row>
      {p.web !== null && (
        <Row label={t('Search the web')} hint={t('While drafting a plan it looks up real, current courses and sources; the coach looks up current things you ask about and lists the links. Only search and page reading: the program gets nothing else on this computer. It is slower and counts against your plan\'s limits.')}>
          <Switch checked={p.web} disabled={busy} onChange={pickWeb} label={t('Search the web')} />
        </Row>
      )}
      <Row label={t('Connection')} hint={testHint} tone={(!p.models.main && canAsk) || (tests?.[0] && sub && !tests[0].ok) ? 'warn' : undefined}>
        <button type="button" className="btn sm" {...busyProps(busy)} disabled={busy || !canAsk || !p.models.main} onClick={test}>
          <Plug size={14} strokeWidth={1.6} /><span>{sub ? t('Test it') : t('Test the keys')}</span></button>
      </Row>
    </div>
  )
}
