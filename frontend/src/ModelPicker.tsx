import { Fragment, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { Check, ChevronDown, RotateCw, Search } from 'lucide-react'
import type { AiModel } from './api'
import { Popover } from './controls'
import { t } from './i18n'

export type Catalog = { models: AiModel[] | null; loading: boolean; error: string }

/** 1048576 → "1M", 131072 → "131K". */
function ctxLabel(n: number) {
  if (!n) return ''
  if (n >= 1e6) return `${+(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M`
  return `${Math.round(n / 1000)}K`
}

/** A list entry as the server sends it. An older server sends bare ids: those count as chat models with nothing known. */
export function toModel(m: AiModel | string): AiModel {
  if (typeof m === 'string') return { id: m, name: '', context: 0, free: false, price: '', chat: true, created: 0 }
  return { ...m, name: m.name ?? '', chat: m.chat !== false }
}

const loose = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** How well a model answers the search: -1 not at all; lower is better (id starts with it, then a word does, then
    anywhere). "gpt5mini" finds gpt-5-mini: punctuation is ignored. */
function score(m: AiModel, words: string[]) {
  if (!words.length) return 0
  const hay = (m.id + ' ' + m.name).toLowerCase(), flat = loose(hay)
  let s = 0
  for (const w of words) {
    const lw = loose(w)
    if (!hay.includes(w) && !(lw && flat.includes(lw))) return -1
    s += m.id.toLowerCase().startsWith(w) || loose(m.id).startsWith(lw) ? 0 : new RegExp(`(^|[\\s/:._-])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(hay) ? 1 : 2
  }
  return s
}

type Row = { kind: 'same' } | { kind: 'model'; m: AiModel } | { kind: 'typed'; id: string }

/** Picks one of the models a provider offers: searchable, with context window and price, the speech/picture/embedding
    ones hidden until asked for. A name the list doesn't have can still be typed in. */
export function ModelPicker({ label, value, catalog, load, onPick, provider, same }: {
  label: string; value: string; catalog: Catalog; load: (fresh?: boolean) => void; onPick: (id: string) => void
  provider: string; same?: string   // same: the model "" falls back to (the coach picker's "same as tests and plans")
}) {
  const btn = useRef<HTMLButtonElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [free, setFree] = useState(false)
  const [act, setAct] = useState(0)
  const id = useId()
  const models = catalog.models
  const known = models?.find((m) => m.id === value)

  const show = () => {
    setQ(''); setAct(0); setOpen(true)
    if (!models && !catalog.loading) load()
  }
  useEffect(() => { if (open) input.current?.focus() }, [open])

  const anyFree = !!models?.some((m) => m.free)
  // Everything is listed: models that chat first, the rest (speech, pictures, embeddings…) after a divider.
  const rows = useMemo<Row[]>(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    const ms = (models ?? []).map((m, i) => ({ m, i, s: score(m, words) })).filter((x) => x.s >= 0 && (!free || x.m.free))
      .sort((a, b) => Number(!a.m.chat) - Number(!b.m.chat) || a.s - b.s || a.i - b.i)
    const out: Row[] = []
    if (same !== undefined && !words.length) out.push({ kind: 'same' })
    for (const { m } of ms) out.push({ kind: 'model', m })
    const typed = q.trim()
    if (typed && !/\s/.test(typed) && !(models ?? []).some((m) => loose(m.id) === loose(typed))) out.push({ kind: 'typed', id: typed })
    return out
  }, [models, q, free, same])
  const firstOther = rows.findIndex((r) => r.kind === 'model' && !r.m.chat)
  useEffect(() => { setAct((a) => Math.min(a, Math.max(0, rows.length - 1))) }, [rows.length])
  // opening (or the list arriving) puts the cursor on the model in use
  useEffect(() => {
    if (!open) return
    const i = rows.findIndex((r) => (r.kind === 'same' ? value === '' : r.kind === 'model' && r.m.id === value))
    if (i >= 0) setAct(i)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, models])
  useEffect(() => { if (open) list.current?.querySelector(`[data-i="${act}"]`)?.scrollIntoView({ block: 'nearest' }) }, [open, act])

  const pick = (r: Row | undefined) => {
    if (!r) return
    onPick(r.kind === 'same' ? '' : r.kind === 'model' ? r.m.id : r.id)
    setOpen(false); btn.current?.focus()
  }
  const key = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setAct((a) => Math.min(rows.length - 1, a + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAct((a) => Math.max(0, a - 1)) }
    else if (e.key === 'PageDown') { e.preventDefault(); setAct((a) => Math.min(rows.length - 1, a + 8)) }
    else if (e.key === 'PageUp') { e.preventDefault(); setAct((a) => Math.max(0, a - 8)) }
    else if (e.key === 'Enter') { e.preventDefault(); pick(rows[act]) }
    else if (e.key === 'Tab') setOpen(false)
  }
  const selected = (r: Row) => (r.kind === 'same' ? value === '' : r.kind === 'model' ? r.m.id === value : false)

  return (
    <>
      <button ref={btn} type="button" className={'input ctl-field ctl-select mp-btn' + (value || same !== undefined ? '' : ' empty')}
        aria-haspopup="dialog" aria-expanded={open} aria-label={`${label}: ${value || (same !== undefined ? t('same as tests and plans') : t('none'))}`}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); show() } }}>
        <span className="mp-v">
          {value
            ? <>{known?.name && <span className="mp-name">{known.name}</span>}<span className="mono">{value}</span></>
            : same !== undefined
              ? <span className="t3">{t('Same as tests and plans')}{same ? <> · <span className="mono">{same}</span></> : null}</span>
              : <span className="ph">{t('Pick a model')}</span>}
        </span>
        <ChevronDown size={15} strokeWidth={1.6} className="ctl-chev" />
      </button>
      <Popover anchor={btn} open={open} onClose={() => setOpen(false)} label={label} className="mp-pop">
        <div className="mp-search">
          <Search size={14} strokeWidth={1.7} aria-hidden />
          <input ref={input} value={q} onChange={(e) => { setQ(e.target.value); setAct(0) }} onKeyDown={key} spellCheck={false}
            placeholder={t('Search {p} models, or type a model name', { p: provider })} aria-label={t('Search models')}
            role="combobox" aria-expanded aria-controls={id} aria-activedescendant={rows.length ? `${id}-${act}` : undefined} />
          {catalog.loading && models && <span className="busy-road" role="status" aria-label={t('Refreshing the list…')} />}
        </div>
        {anyFree && (
          <div className="mp-filters">
            <button type="button" className={'chip' + (free ? ' on' : '')} aria-pressed={free} onClick={() => { setFree(!free); setAct(0) }}>{t('Free only')}</button>
          </div>
        )}
        <div ref={list} id={id} className="mp-list" role="listbox" aria-label={label}>
          {catalog.loading && !models && (
            <div className="mp-loading" role="status" aria-live="polite">
              <div className="mp-loading-h"><span className="busy-road" aria-hidden />{t('Asking {p} for its models…', { p: provider })}</div>
              {[62, 48, 70, 40, 56, 66, 44].map((w, i) => (
                <div key={i} className="mp-skel" aria-hidden style={{ '--i': i, '--w': `${w}%` } as CSSProperties}>
                  <span className="mp-skel-l"><i /><i /></span><i className="mp-skel-m" />
                </div>
              ))}
            </div>
          )}
          {catalog.error && !models && (
            <div className="mp-note err">
              <span>{catalog.error}</span>
              <button type="button" className="btn ghost sm" onClick={() => load(true)}><RotateCw size={13} strokeWidth={1.7} /><span>{t('Try again')}</span></button>
            </div>
          )}
          {rows.map((r, i) => {
            const sel = selected(r)
            return (
              <Fragment key={r.kind === 'model' ? r.m.id : r.kind}>
              {i === firstOther && <div className="mp-sep" role="presentation">{t('Probably not for chat: speech, pictures, embeddings, fixed snapshots')}</div>}
              <div id={`${id}-${i}`} data-i={i} role="option" aria-selected={sel}
                className={'mp-opt' + (i === act ? ' act' : '') + (sel ? ' sel' : '') + (r.kind === 'model' && !r.m.chat ? ' other' : '')}
                onPointerMove={() => { if (i !== act) setAct(i) }} onClick={() => pick(r)}>
                {r.kind === 'same' ? (
                  <span className="mp-opt-l"><span className="mp-opt-n">{t('Same as tests and plans')}</span>{same && <span className="mono mp-opt-id">{same}</span>}</span>
                ) : r.kind === 'typed' ? (
                  <span className="mp-opt-l"><span className="mp-opt-n">{t('Use “{m}”', { m: r.id })}</span><span className="mp-opt-id">{t('Not in the list; {p} will say if it doesn’t exist.', { p: provider })}</span></span>
                ) : (
                  <>
                    <span className="mp-opt-l">
                      <span className="mp-opt-n">{r.m.name || r.m.id}</span>
                      {r.m.name && <span className="mono mp-opt-id">{r.m.id}</span>}
                    </span>
                    <span className="mp-meta">
                      {r.m.context > 0 && <span title={t('Context window (tokens)')}>{ctxLabel(r.m.context)}</span>}
                      {r.m.free ? <span className="mp-free">{t('Free')}</span> : r.m.price && <span className="mono" title={t('Dollars per million tokens, in / out')}>{r.m.price}</span>}
                    </span>
                  </>
                )}
                <span className="mp-check">{sel && <Check size={14} strokeWidth={2} />}</span>
              </div>
              </Fragment>
            )
          })}
          {models && !rows.length && <p className="mp-note">{t('No model matches.')}</p>}
        </div>
        {models && (
          <div className="mp-foot">
            <span>{t('{n} models', { n: rows.filter((r) => r.kind === 'model').length })}{models.some((m) => m.price) ? ' · ' + t('prices are dollars per million tokens, in / out') : ''}</span>
            <button type="button" className="linkish mp-refresh" disabled={catalog.loading} onClick={() => load(true)}><RotateCw size={12} strokeWidth={1.7} className={catalog.loading ? 'spin' : ''} />{t('Refresh')}</button>
          </div>
        )}
      </Popover>
    </>
  )
}
