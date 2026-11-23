import { useId, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

/* A folded section: reference material that is one click away instead of in the way.
   Closed by default; with `remember` its open/closed state is kept per browser under that key. */

const KEY = 'ctu.fold.'
const read = (k: string | undefined, d: boolean) => {
  if (!k) return d
  try { const v = localStorage.getItem(KEY + k); return v == null ? d : v === '1' } catch { return d }
}

export function Fold({ title, meta, remember, defaultOpen = false, className, children }: {
  title: ReactNode; meta?: ReactNode; remember?: string; defaultOpen?: boolean; className?: string; children: ReactNode
}) {
  const [open, setOpen] = useState(() => read(remember, defaultOpen))
  const id = useId()
  const toggle = () => {
    const o = !open
    setOpen(o)
    if (remember) try { localStorage.setItem(KEY + remember, o ? '1' : '0') } catch { /* only a preference */ }
  }
  return (
    <div className={'fold' + (open ? ' open' : '') + (className ? ' ' + className : '')}>
      <button type="button" className="fold-h" aria-expanded={open} aria-controls={id + 'b'} id={id + 'h'} onClick={toggle}>
        <ChevronRight className="fold-ic" size={14} strokeWidth={1.8} aria-hidden />
        <span className="fold-t">{title}</span>
        {meta != null && <span className="fold-m">{meta}</span>}
      </button>
      <div className="fold-b" id={id + 'b'} role="region" aria-labelledby={id + 'h'} hidden={!open}>{children}</div>
    </div>
  )
}
