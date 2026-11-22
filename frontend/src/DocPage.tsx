import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { CaseSensitive, Columns2, Columns3, Columns4, RectangleHorizontal, RectangleVertical, Square } from 'lucide-react'
import { fmtDate, type PageFont, type PageSetup, type PageSize, type PaperKind } from './api'
import type { SheetInfo } from './DocEditor'
import { PAGE_SIZES, sheetOf } from './page'
import { t, type Key } from './i18n'
import { Select } from './controls'

/** The sheet: real paper proportions (A4 unless chosen otherwise), zoomed down to fit the column, growing by whole
 *  sheets when the writing runs past one, with a dashed line and the page number where each new sheet starts. */
export function DocPage({ title, setTitle, blank, created, words, setup, onSetup, bar, children }: {
  /** without a title (scratch paper) the sheet starts with the blocks */
  title?: string; setTitle?: (t: string) => void; blank?: boolean; created?: string; words?: number
  setup?: PageSetup; onSetup: (p: PageSetup) => void; bar: ReactNode
  children: (sheet: SheetInfo) => ReactNode
}) {
  const sheet = sheetOf(setup)
  const [free, setFree] = useState<HTMLDivElement | null>(null)
  const [freeH, setFreeH] = useState(0)
  const [look, setLook] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  const [avail, setAvail] = useState(sheet.w)
  const [pages, setPages] = useState(1)
  const [dock, setDock] = useState<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(() => { const cs = getComputedStyle(el); setAvail(el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const zoom = Math.min(1, avail / sheet.w)
  useLayoutEffect(() => {
    const el = inner.current
    if (!el) return
    // offsetHeight is in the sheet's own pixels (before zoom), like sheet.h
    const ro = new ResizeObserver(() => setPages(Math.max(1, Math.ceil((el.offsetHeight + sheet.pad * 2) / sheet.h - 0.02))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [sheet.h, sheet.pad])
  const colW = sheet.w - sheet.pad * 2 - 2   // the sheet has a 1 px border on each side
  // free blocks can sit lower than the writing: the sheet grows by whole pages to hold them too
  const all = Math.max(pages, Math.ceil((freeH + sheet.pad * 0.5) / sheet.h - 0.02))
  const font = setup?.font ?? 'serif', paper = setup?.paper ?? 'plain'
  const set = (p: Partial<PageSetup>) => onSetup({ size: sheet.size, landscape: sheet.landscape || undefined, font: setup?.font, paper: setup?.paper, cols: setup?.cols, rules: setup?.rules, ...p })
  return (
    <div className="note-doc" ref={wrap}>
      <div className="note-bar" style={{ maxWidth: Math.max(320, sheet.w * zoom) }}>
        {bar}
        <span className="page-setup">
          <Select size="sm" label={t('Page size')} value={sheet.size} onChange={(v) => set({ size: v })}
            options={(Object.keys(PAGE_SIZES) as PageSize[]).map((k) => ({ value: k, label: k, text: k, hint: `${PAGE_SIZES[k][0]} × ${PAGE_SIZES[k][1]} mm` }))} />
          <button className={'icon-btn sm' + (sheet.landscape ? ' on' : '')} aria-pressed={sheet.landscape}
            title={sheet.landscape ? t('Landscape') : t('Portrait')} aria-label={t('Turn the page')}
            onClick={() => set({ landscape: !sheet.landscape || undefined })}>
            {sheet.landscape ? <RectangleHorizontal size={15} strokeWidth={1.7} /> : <RectangleVertical size={15} strokeWidth={1.7} />}
          </button>
          <ColsPick cols={setup?.cols ?? 1} set={(cols) => set({ cols: cols > 1 ? cols : undefined })} />
          <PageLook open={look} setOpen={setLook} font={font} paper={paper} rules={!!setup?.rules} set={set} />
        </span>
      </div>
      <article className="paper" data-font={font} data-paper={paper} data-rules={setup?.rules ? '' : undefined}
        style={{ width: sheet.w, minHeight: sheet.h * all, padding: `${Math.round(sheet.pad * 0.9)}px ${sheet.pad}px ${sheet.pad}px`, zoom, '--inv': 1 / zoom } as CSSProperties}
        data-size={sheet.size}>
        <div className="paper-in" ref={inner}>
          {setTitle && <>
            <input className="note-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('Untitled')} aria-label={t('Page title')} maxLength={200}
              autoFocus={!title && blank}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== 'ArrowDown') return
                e.preventDefault()
                const ta = document.querySelector<HTMLElement>('.paper .md-ta')
                if (ta) ta.focus(); else document.querySelector<HTMLElement>('.paper .doc-text')?.click()
              }} />
            <div className="paper-meta">{fmtDate((created ?? '').slice(0, 10))}{words ? ' · ' + t(words === 1 ? '{n} word' : '{n} words', { n: words }) : ''}</div>
          </>}
          {children({ colW, sheetW: sheet.w, pad: sheet.pad, dock, free, onExtent: setFreeH, cols: setup?.cols })}
        </div>
        <div className="paper-free" ref={setFree} />
        {Array.from({ length: all - 1 }, (_, k) => (
          <div key={k} className="pg-break" style={{ top: sheet.h * (k + 1) }} aria-hidden><span>{k + 2}</span></div>
        ))}
      </article>
      <div className="doc-dock-slot" ref={setDock} />
    </div>
  )
}

const FONTS: { f: PageFont; label: Key }[] = [
  { f: 'serif', label: 'Serif' }, { f: 'sans', label: 'Sans' }, { f: 'hand', label: 'Handwriting' }, { f: 'print', label: 'Neat handwriting' },
]
const PAPERS: { p: PaperKind; label: Key }[] = [{ p: 'plain', label: 'Plain' }, { p: 'grid', label: 'Squared' }, { p: 'dots', label: 'Dotted' }]

/** The page's look: the type it is written in, and the paper under it. */
function PageLook({ open, setOpen, font, paper, rules, set }: {
  open: boolean; setOpen: (o: boolean) => void; font: PageFont; paper: PaperKind; rules: boolean; set: (p: Partial<PageSetup>) => void
}) {
  const box = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', down, true); window.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key) }
  }, [open, setOpen])
  return (
    <span className="page-look" ref={box}>
      <button className={'icon-btn sm' + (open ? ' on' : '')} aria-expanded={open} aria-haspopup="dialog" title={t('Font and paper')} aria-label={t('Font and paper')}
        onClick={() => setOpen(!open)}><CaseSensitive size={16} strokeWidth={1.7} /></button>
      {open && (
        <div className="look-pop" role="dialog" aria-label={t('Font and paper')}>
          <div className="look-h">{t('Font')}</div>
          <div className="look-fonts" role="radiogroup" aria-label={t('Font')}>
            {FONTS.map((x) => (
              <button key={x.f} role="radio" aria-checked={font === x.f} className={'look-font' + (font === x.f ? ' on' : '')} data-font={x.f}
                onClick={() => set({ font: x.f === 'serif' ? undefined : x.f })}>
                <span className="look-sample">Ag</span><span>{t(x.label)}</span>
              </button>
            ))}
          </div>
          <div className="look-h">{t('Paper')}</div>
          <div className="look-papers" role="radiogroup" aria-label={t('Paper')}>
            {PAPERS.map((x) => (
              <button key={x.p} role="radio" aria-checked={paper === x.p} className={'look-paper' + (paper === x.p ? ' on' : '')} onClick={() => set({ paper: x.p === 'plain' ? undefined : x.p })}>
                <span className="look-swatch" data-paper={x.p} /><span>{t(x.label)}</span>
              </button>
            ))}
          </div>
          <div className="look-h">{t('Headings')}</div>
          <button className="glook-row" role="switch" aria-checked={rules} onClick={() => set({ rules: !rules || undefined })}>
            <span>{t('A line under each heading')}</span><span className={'glook-sw' + (rules ? ' on' : '')} aria-hidden />
          </button>
        </div>
      )}
    </span>
  )
}

/** The page as a grid: one column (the plain flow) up to four; the blocks fill it left to right, line by line. */
function ColsPick({ cols, set }: { cols: number; set: (n: number) => void }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', down, true); window.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key) }
  }, [open])
  const ICONS = [Square, Columns2, Columns3, Columns4]
  const Now = ICONS[Math.min(4, Math.max(1, cols)) - 1]
  return (
    <span className="page-look" ref={box}>
      <button className={'icon-btn sm' + (open || cols > 1 ? ' on' : '')} aria-expanded={open} aria-haspopup="dialog" title={t('Columns on the page')} aria-label={t('Columns on the page')}
        onClick={() => setOpen(!open)}><Now size={15} strokeWidth={1.7} /></button>
      {open && (
        <div className="look-pop cols-pop" role="dialog" aria-label={t('Columns on the page')}>
          <div className="look-h">{t('Columns on the page')}</div>
          <div className="look-papers cols4" role="radiogroup" aria-label={t('Columns on the page')}>
            {ICONS.map((I, k) => (
              <button key={k} role="radio" aria-checked={cols === k + 1} className={'look-paper' + (cols === k + 1 ? ' on' : '')} onClick={() => { set(k + 1); setOpen(false) }}>
                <I size={20} strokeWidth={1.5} /><span>{k + 1}</span>
              </button>
            ))}
          </div>
          <p className="look-note">{t('The blocks fill the columns left to right, then the next line. Drag a block onto another to swap places.')}</p>
        </div>
      )}
    </span>
  )
}
