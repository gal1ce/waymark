import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import { t } from './i18n'

/* The building blocks of every settings page, so they all read the same way:
   - Group: a titled card. Its title says what the settings in it are about; an action that concerns the whole group
     (one, at most) sits on the right of the title.
   - Row: one setting. What it is and what it does on the left, the control on the right; on a narrow screen, or with
     `stack` for a wide control (a list, a text box), the control goes under the words.
   - PathField: a file or folder path, shortened to its end, with a copy button (the full path is in the tooltip).
   - useSaved: settings save the moment they change; this says so for a moment next to the group's title.
   Buttons follow one order everywhere: a group's main action is `btn primary sm` (one per page at most), others
   `btn sm`, small inline ones `btn ghost sm`, and anything that removes data `btn danger sm` inside a danger Group. */

export function Group({ title, note, action, danger, saved, children, id, wide }: {
  title: ReactNode; note?: ReactNode; action?: ReactNode; danger?: boolean; saved?: boolean; children?: ReactNode; id?: string
  /** in a Grid, the whole width (a long group, or one with no partner of about its height) */
  wide?: boolean
}) {
  return (
    <section className={'sg' + (danger ? ' danger' : '') + (wide ? ' wide' : '')} id={id} aria-label={typeof title === 'string' ? title : undefined}>
      <header className="sg-h">
        <div className="sg-hl">
          <h2 className="sg-t">{title}{saved && <span className="sg-saved" role="status"><Check size={13} strokeWidth={2.2} />{t('Saved')}</span>}</h2>
          {note && <p className="sg-n">{note}</p>}
        </div>
        {action && <div className="sg-a">{action}</div>}
      </header>
      {children && <div className="sg-b">{children}</div>}
    </section>
  )
}

/** A section's groups, two to a row: side by side only groups of about the same height (so each row ends level
    without padding a card); a long one, or one without a partner, is `wide`. One column on a narrow screen. */
export function Grid({ children }: { children: ReactNode }) {
  return <div className="set-grid2">{children}</div>
}

/** A section's layout: the main column (what the section is for) wide, the aside (what supports it) narrow beside it.
    On a narrow screen they stack, the main column first; `asideFirst` puts the aside first and on the left (a list
    whose picked item the main column shows). */
export function Split({ main, aside, asideFirst }: { main: ReactNode; aside?: ReactNode; asideFirst?: boolean }) {
  if (!aside) return <div className="set-split solo"><div className="set-col">{main}</div></div>
  const m = <div className="set-col set-col-main">{main}</div>
  const a = <div className="set-col set-col-aside">{aside}</div>
  return <div className={'set-split' + (asideFirst ? ' aside-first' : '')}>{asideFirst ? <>{a}{m}</> : <>{m}{a}</>}</div>
}

export function Row({ label, hint, children, htmlFor, stack, tone }: {
  label: ReactNode; hint?: ReactNode; children?: ReactNode; htmlFor?: string; stack?: boolean; tone?: 'warn'
}) {
  return (
    <div className={'sr' + (stack ? ' stack' : '') + (tone ? ' ' + tone : '')}>
      <div className="sr-l">
        {htmlFor ? <label className="sr-t" htmlFor={htmlFor}>{label}</label> : <div className="sr-t">{label}</div>}
        {hint && <div className="sr-h">{hint}</div>}
      </div>
      {children !== undefined && <div className="sr-c">{children}</div>}
    </div>
  )
}

/** The end of a long path, enough to recognise it: "…/waymark/ctu.db". */
export const shortPath = (p: string, keep = 3) => {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts.length <= keep ? p : '…/' + parts.slice(-keep).join('/')
}

export function PathField({ path, keep }: { path: string; keep?: number }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try { await navigator.clipboard.writeText(path); setCopied(true); setTimeout(() => setCopied(false), 1400) } catch { /* no clipboard: the path is still in the tooltip */ }
  }
  return (
    <span className="path-f">
      <span className="path-t mono" title={path}>{shortPath(path, keep)}</span>
      <button type="button" className="icon-btn sm" onClick={copy} aria-label={t('Copy the full path')} title={copied ? t('Copied') : t('Copy the full path')}>
        {copied ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={1.7} />}
      </button>
    </span>
  )
}

/** [saved, mark]: call mark() after a save went through; `saved` is true for a moment. */
export function useSaved(): [boolean, () => void] {
  const [saved, setSaved] = useState(false)
  const timer = useRef<number>(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return [saved, () => { setSaved(true); window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setSaved(false), 1600) }]
}
