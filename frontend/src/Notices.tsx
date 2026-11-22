import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Bell, BellOff, Check, CheckCheck, CircleAlert, CircleCheck, Info, MessageSquareWarning, Trash2, X } from 'lucide-react'
import { api, fmtDate, type Notice, type Tone } from './api'
import { t } from './i18n'

/* Our own notifications: toasts that say what happened, a bell with the history kept on the server, and a
   confirm dialog in place of the browser's. */

export type Toast = { id: number; title: string; body?: string; tone: Tone; link?: string | null; out?: boolean; n?: number }
export type ConfirmOpts = { title: string; body?: ReactNode; action?: string; cancel?: string; danger?: boolean }

export const TONE_ICON: Record<Tone, ReactNode> = {
  info: <Info size={17} strokeWidth={1.8} />,
  ok: <CircleCheck size={17} strokeWidth={1.8} />,
  warn: <MessageSquareWarning size={17} strokeWidth={1.8} />,
  err: <CircleAlert size={17} strokeWidth={1.8} />,
}

export function ago(ts: string): string {
  const s = (Date.now() - new Date(ts).getTime()) / 1000
  if (s < 45) return t('just now')
  if (s < 3600) return t('{n} min', { n: Math.max(1, Math.round(s / 60)) })
  if (s < 86400) return t('{n} h', { n: Math.round(s / 3600) })
  if (s < 7 * 86400) return t('{n} d', { n: Math.round(s / 86400) })
  return fmtDate(ts.slice(0, 10))
}

/** The stack of toasts. Hovering one keeps it; each closes on its own after a while, errors stay longer. */
export function Toasts({ toasts, close, open }: { toasts: Toast[]; close: (id: number) => void; open: (link: string) => void }) {
  const tr = t
  const shown = toasts.slice(-4)
  return (
    <div className="toasts" role="region" aria-label={t('Notifications')} aria-live="polite">
      {toasts.length > shown.length && <div className="toast-more">{t('{n} more', { n: toasts.length - shown.length })}</div>}
      {shown.map((t) => (
        <div key={t.id} className={'toast ' + t.tone + (t.out ? ' out' : '') + (t.link ? ' link' : '')} role={t.tone === 'err' ? 'alert' : 'status'}
          onClick={(e) => { if (t.link && !(e.target as HTMLElement).closest('.toast-x')) { open(t.link); close(t.id) } }}>
          <span className="toast-ic">{TONE_ICON[t.tone]}</span>
          <div className="toast-b">
            <div className="toast-t">{t.title}{t.n && t.n > 1 ? <span className="toast-n">×{t.n}</span> : null}</div>
            {t.body && <div className="toast-d">{t.body}</div>}
          </div>
          <button className="toast-x" onClick={() => close(t.id)} aria-label={tr('Dismiss notification')}><X size={14} strokeWidth={1.8} /></button>
          <span className="toast-life" aria-hidden />
        </div>
      ))}
    </div>
  )
}

/** The bell: unread count, and the history in a panel. */
export function NoticeBell({ version, go, confirm }: { version: number; go: (link: string) => void; confirm: (o: ConfirmOpts) => Promise<boolean> }) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<{ notices: Notice[]; unread: number } | null>(null)
  const [ring, setRing] = useState(0)
  const wrap = useRef<HTMLDivElement>(null)
  const load = useCallback(() => api.notices().then(setData).catch(() => {}), [])
  useEffect(() => { load() }, [load, version])
  useEffect(() => {
    const on = (e: Event) => { load(); if ((e as CustomEvent).detail === 'new') setRing((r) => r + 1) }
    window.addEventListener('ctu:notices', on)
    return () => window.removeEventListener('ctu:notices', on)
  }, [load])
  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('.modal-wrap')) setOpen(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.modal-wrap')) { e.stopPropagation(); setOpen(false) } }
    document.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key, true)
    return () => { document.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key, true) }
  }, [open])

  const unread = data?.unread ?? 0
  const list = data?.notices ?? []
  const today = new Date().toDateString()
  const groups: [string, Notice[]][] = []
  for (const n of list) {
    const g = new Date(n.ts).toDateString() === today ? t('Today') : new Date(Date.now() - 86400000).toDateString() === new Date(n.ts).toDateString() ? t('Yesterday') : t('Earlier')
    const last = groups[groups.length - 1]
    if (last && last[0] === g) last[1].push(n); else groups.push([g, [n]])
  }
  const readOne = (n: Notice) => { if (!n.read) api.noticesRead(n.id).then(load).catch(() => {}) }
  const del = (n: Notice) => { setData((d) => d && { notices: d.notices.filter((x) => x.id !== n.id), unread: d.unread - (n.read ? 0 : 1) }); api.noticesDelete(n.id).catch(load) }

  return (
    <div className="bell-wrap" ref={wrap}>
      <button key={ring} className={'icon-btn bell' + (unread ? ' has' : '') + (ring ? ' ringing' : '')} onClick={() => setOpen((o) => !o)} aria-expanded={open}
        aria-label={unread ? t('Notifications, {n} unread', { n: unread }) : t('Notifications')} title={t('Notifications')}>
        <Bell size={17} strokeWidth={1.7} />
        {unread > 0 && <span className="bell-n">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="pop notice-pop" role="dialog" aria-label={t('Notifications')}>
          <div className="np-head">
            <b>{t('Notifications')}</b>
            {unread > 0 && <span className="np-count">{t('{n} new', { n: unread })}</span>}
            <span className="grow" />
            <button className="icon-btn sm" disabled={!unread} title={t('Mark all as read')} aria-label={t('Mark all as read')}
              onClick={() => api.noticesRead().then(load).catch(() => {})}><CheckCheck size={15} strokeWidth={1.8} /></button>
            <button className="icon-btn sm" disabled={!list.length} title={t('Clear all')} aria-label={t('Clear all')}
              onClick={async () => { if (await confirm({ title: t('Clear every notification?'), body: t('The history is emptied. Sticking points and tests stay where they are.'), action: t('Clear all'), danger: true })) api.noticesDelete().then(load).catch(() => {}) }}>
              <Trash2 size={15} strokeWidth={1.8} /></button>
          </div>
          <div className="np-list">
            {!list.length && (
              <div className="np-empty"><BellOff size={22} strokeWidth={1.5} /><span>{t('Nothing yet. Sticking points, closed days and problems that need you show up here.')}</span></div>
            )}
            {groups.map(([g, ns]) => (
              <section key={g}>
                <h5 className="np-g">{g}</h5>
                {ns.map((n) => (
                  <div key={n.id} className={'np-row ' + n.tone + (n.read ? '' : ' unread') + (n.link ? ' link' : '')}
                    onClick={(e) => { if ((e.target as HTMLElement).closest('.np-act, details')) return; readOne(n); if (n.link) { go(n.link); setOpen(false) } }}>
                    <span className="np-ic">{TONE_ICON[n.tone]}</span>
                    <div className="np-b">
                      <div className="np-t">{n.title}</div>
                      {n.body && <div className="np-d">{n.body}</div>}
                      {n.items.length > 1 && (
                        <details className="np-items"><summary>{t('Show all {n}', { n: n.items.length })}</summary><ul>{n.items.map((x, i) => <li key={i}>{x}</li>)}</ul></details>
                      )}
                      <div className="np-ts">{ago(n.ts)}</div>
                    </div>
                    <div className="np-act">
                      {!n.read && <button className="icon-btn sm" onClick={() => readOne(n)} aria-label={t('Mark as read')} title={t('Mark as read')}><Check size={14} strokeWidth={1.9} /></button>}
                      <button className="icon-btn sm" onClick={() => del(n)} aria-label={t('Delete')} title={t('Delete')}><X size={14} strokeWidth={1.9} /></button>
                    </div>
                  </div>
                ))}
              </section>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** The app's confirm dialog. Enter confirms, Esc cancels; a destructive action is red and not the default focus. */
export function ConfirmDialog({ opts, done }: { opts: ConfirmOpts; done: (ok: boolean) => void }) {
  const ok = useRef<HTMLButtonElement>(null)
  const no = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    (opts.danger ? no : ok).current?.focus()
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); done(false) } }
    window.addEventListener('keydown', k, true)
    return () => window.removeEventListener('keydown', k, true)
  }, [opts, done])
  return createPortal(
    <div className="modal-wrap" onPointerDown={(e) => { if (e.target === e.currentTarget) done(false) }}>
      <div className="modal confirm" role="alertdialog" aria-modal="true" aria-labelledby="cf-t">
        <h2 id="cf-t" className="cf-t">{opts.title}</h2>
        {opts.body && <div className="cf-b">{opts.body}</div>}
        <div className="cf-acts">
          <button ref={no} className="btn" onClick={() => done(false)}>{opts.cancel ?? t('Cancel')}</button>
          <button ref={ok} className={'btn ' + (opts.danger ? 'bad' : 'primary')} onClick={() => done(true)}>{opts.action ?? t('OK')}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
