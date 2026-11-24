import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Maximize2, X } from 'lucide-react'
import { fmtDate, type Task } from './api'
import { fromHash, type Ctx, type View } from './App'
import { CoachPanel } from './Coach'
import { t } from './i18n'

/* The coach's own page, where the app opens: conversations on the left, the chat in the middle, and on the right
   whatever the coach made or pointed to (a practice test it wrote, a day it planned, a note), live and usable there.
   The side coach panel and its top-bar button are off here; everything else in the app is one click away. */

function title(v: View): string {
  switch (v.kind) {
    case 'test': return t('Test {n}', { n: v.id })
    case 'khanTest': return t('Unit test')
    case 'day': return v.date ? fmtDate(v.date) : t('Today')
    case 'notes': return t('Notes')
    case 'tests': return t('Tests')
    case 'calendar': return t('Calendar')
    case 'progress': return t('Progress')
    case 'beej': return t("Beej's Guide to C")
    default: return t('Home')
  }
}

export default function NixPage({ ctx, current, hasKey, locked, render, openId }: {
  ctx: Ctx; current: Task | null; hasKey: boolean; locked: boolean; render: (v: View) => ReactNode; openId?: number
}) {
  const [href, setHref] = useState<string | null>(null)
  const v = href ? fromHash(href) : null
  const show = useCallback((h: string) => setHref(h), [])
  useEffect(() => {
    if (!href) return
    const f = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target as HTMLElement)?.closest('input, textarea, [contenteditable]')) setHref(null) }
    window.addEventListener('keydown', f)
    return () => window.removeEventListener('keydown', f)
  }, [href])

  return (
    <div className={'nix-page' + (v ? ' with-pv' : '')}>
      <CoachPanel ctx={ctx} current={current} hasKey={hasKey} locked={locked} onClose={() => {}} page onPreview={show} openId={openId} />
      {v && (
        <aside className="nix-pv" aria-label={title(v)}>
          <div className="nix-pv-h">
            <span className="nix-pv-t">{title(v)}</span>
            <button className="icon-btn" onClick={() => ctx.go(v)} aria-label={t('Open as a full page')} title={t('Open as a full page')}><Maximize2 size={15} strokeWidth={1.6} /></button>
            <button className="icon-btn" onClick={() => setHref(null)} aria-label={t('Close')} title={t('Close')}><X size={16} strokeWidth={1.6} /></button>
          </div>
          <div className="nix-pv-b">{render(v)}</div>
        </aside>
      )}
    </div>
  )
}
