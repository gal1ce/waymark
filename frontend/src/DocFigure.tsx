import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AlignCenter, AlignJustify, AlignLeft, AlignRight, CaseSensitive, Crop, Expand, GripHorizontal, Layers, Move, WrapText, Pencil, Rows3, RotateCcw, Shrink, Trash2 } from 'lucide-react'
import type { Align, FigBox, Fit, FreePos, PageFont, TextAlign, TextSize, TextStyle, TextTone } from './api'
import { placeOf, scrollerOf, zoomOf } from './page'
import { snapBox, snapEdge, snapLines, showGuides } from './snap'
import { t, type Key } from './i18n'

/* ----------------------------------------------------------------- a picture or graph on the page */

type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
const HANDLES: Handle[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
const MIN_W = 80, MIN_H = 60, MAX_H = 3000

export type FigDrop = { dx: number; dy: number; clientX: number; clientY: number; end: boolean }

/** Sideways drop: snaps to the left edge, the centre and the right edge when it lands within a few pixels of them. */
function settle(left: number, colW: number, w: number): Pick<FigBox, 'x' | 'align'> {
  const room = Math.max(0, colW - w), snap = 10
  if (left <= snap) return { align: 'left', x: undefined }
  if (Math.abs(left - room / 2) <= snap) return { align: 'center', x: undefined }
  if (room - left <= snap) return { align: 'right', x: undefined }
  return { x: Math.round(left), align: undefined }
}

/** A picture or a graph on a page. Click to select it: a frame with handles on every side and corner, and a small
 *  toolbar. Drag it (anywhere on it) to move it: sideways within the column, and up or down between the blocks.
 *  Corner handles keep its proportions (hold Shift to free them); side handles stretch one way only.
 *  Every handle follows the pointer one to one; sizes are page pixels and are saved with the block. */
export function Figure({ box, kind, colW, aspect, defaultW, defaultH, selected, fit, onSelect, onChange, onDrag, onDelete, onEdit, children, below, free, onFree, onLayout, extra }: {
  box: FigBox; kind: 'image' | 'graph' | 'diagram'; colW: number
  /** height / width of the picture itself, once loaded */
  aspect?: number; defaultW: number; defaultH?: number
  selected: boolean; fit?: Fit
  onSelect: () => void; onChange: (p: Partial<FigBox> & { fit?: Fit }) => void
  /** the block is being dragged: the editor shows where it would land and applies the move at the end */
  onDrag: (d: FigDrop, place: Pick<FigBox, 'x' | 'align'>) => void
  onDelete: () => void; onEdit?: () => void
  children: (w: number, h: number) => ReactNode; below?: ReactNode
  /** placed freely on the sheet (then `colW` is the sheet's width): moves both ways, and its place and size go to `onFree` */
  free?: FreePos; onFree?: (p: FreePos) => void
  /** takes it out of the flow, or puts it back */
  onLayout?: () => void
  /** more tools for this kind of block (a graph's look) */
  extra?: ReactNode
}) {
  const frame = useRef<HTMLDivElement>(null)
  const [live, setLive] = useState<{ w: number; h: number; left: number } | null>(null)
  const [move, setMove] = useState<{ dx: number; dy: number } | null>(null)
  // the toolbar opens toward the middle of the screen, so it never runs off the side
  const [barEnd, setBarEnd] = useState(false)
  const ratio = aspect && aspect > 0 ? aspect : (defaultH ?? 0.66 * defaultW) / defaultW
  const baseW = Math.min(colW, Math.max(MIN_W, (free ? free.w : box.width) ?? defaultW))
  const baseH = (free ? free.h : box.height) ?? (kind === 'image' ? baseW * ratio : defaultH ?? 340)
  const [liveTop, setLiveTop] = useState<number | null>(null)
  const w = live?.w ?? baseW, h = live?.h ?? baseH
  const left0 = free ? Math.min(Math.max(0, colW - baseW), Math.max(0, free.x)) : placeOf(box, colW, baseW)
  const left = live?.left ?? left0
  const top = liveTop ?? free?.y ?? 0

  const resize = (hd: Handle, e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault(); e.stopPropagation()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const z = zoomOf(frame.current)
    const x0 = e.clientX, y0 = e.clientY, w0 = baseW, h0 = baseH, l0 = left0, a0 = h0 / w0, t0 = free?.y ?? 0
    const scroller = scrollerOf(frame.current)
    let last = { w: w0, h: h0, left: l0 }, shownH = h0, unlocked = false
    const lines = free ? snapLines(frame.current) : null
    const mv = (ev: PointerEvent) => {
      let dx = (ev.clientX - x0) / z, dy = (ev.clientY - y0) / z
      // a free block's dragged edges snap to the lines near them, as when it moves (Alt: no snapping)
      if (lines) {
        let gx: number | null = null, gy: number | null = null
        if (hd.includes('e')) { const g = snapEdge(lines, l0 + w0 + dx, 'x', ev.altKey); dx = g.v - l0 - w0; gx = g.g }
        if (hd.includes('w')) { const g = snapEdge(lines, l0 + dx, 'x', ev.altKey); dx = g.v - l0; gx = g.g }
        if (hd.includes('s')) { const g = snapEdge(lines, t0 + h0 + dy, 'y', ev.altKey); dy = g.v - t0 - h0; gy = g.g }
        if (hd.includes('n')) { const g = snapEdge(lines, t0 + dy, 'y', ev.altKey); dy = g.v - t0; gy = g.g }
        showGuides(lines, gx, gy)
      }
      unlocked = ev.shiftKey
      let nw = w0, nh = h0, nl = l0
      if (hd.includes('e')) nw = Math.min(colW - l0, Math.max(MIN_W, w0 + dx))
      if (hd.includes('w')) { nw = Math.min(l0 + w0, Math.max(MIN_W, w0 - dx)); nl = l0 + w0 - nw }
      if (hd.includes('s')) nh = h0 + dy
      if (hd.includes('n')) nh = h0 - dy
      if (hd.length === 2 && !unlocked) nh = nw * a0          // corners keep the proportions unless Shift is held
      nh = Math.min(MAX_H, Math.max(MIN_H, nh))
      // the top edge: a free block moves its top; in the flow it can't, so the page scrolls by the change instead
      if (hd.includes('n')) { if (free) setLiveTop(Math.max(0, t0 + h0 - nh)); else if (scroller) scroller.scrollBy(0, (nh - shownH) * z) }
      shownH = nh
      last = { w: Math.round(nw), h: Math.round(nh), left: nl }
      setLive(last)
    }
    const up = () => {
      el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up)
      showGuides(lines, null, null)
      setLive(null); setLiveTop(null)
      // a picture keeps its own proportions until a side handle (or Shift) changes only one of its sizes
      const proportional = kind === 'image' && (free ? free.h : box.height) == null && (hd.length === 2 && !unlocked)
      if (free && onFree) {
        onFree({ x: Math.round(last.left), y: Math.round(hd.includes('n') ? Math.max(0, t0 + h0 - last.h) : t0), w: last.w, h: proportional ? undefined : last.h })
        return
      }
      // the edge that wasn't dragged stays where it was, so the block keeps its new place (snapping to an edge or the centre)
      onChange({ width: last.w >= colW - 1 ? undefined : last.w, height: proportional ? undefined : last.h, ...settle(last.left, colW, last.w) })
    }
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up)
    setLive({ w: w0, h: h0, left: l0 })
  }

  const grab = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const tg = e.target as HTMLElement
    if (tg.closest('.pfig-h, .pfig-bar, .gfig-btn, .graph-zoom, input, textarea')) return
    onSelect()
    const el = frame.current
    if (!el) return
    { const r = el.getBoundingClientRect(); setBarEnd(r.left + r.width / 2 > window.innerWidth / 2 && r.right > window.innerWidth * 0.6) }
    const z = zoomOf(el)
    const x0 = e.clientX, y0 = e.clientY, l0 = left0
    let moved = false
    el.setPointerCapture(e.pointerId)
    const place = (dx: number) => settle(Math.min(colW - baseW, Math.max(0, l0 + dx / z)), colW, baseW)
    const lines = free ? snapLines(el) : null
    // where a free block lands: snapped to the lines near it (Alt: no snapping)
    const freeAt = (ev: PointerEvent) => {
      const g = snapBox(lines, l0 + (ev.clientX - x0) / z, (free?.y ?? 0) + (ev.clientY - y0) / z, baseW, baseH, ev.altKey)
      showGuides(lines, g.gx, g.gy)
      return { x: Math.round(Math.min(colW - baseW, Math.max(0, g.x))), y: Math.round(Math.max(0, g.y)) }
    }
    const mv = (ev: PointerEvent) => {
      const dx = ev.clientX - x0, dy = ev.clientY - y0
      if (!moved && Math.hypot(dx, dy) < 4) return
      moved = true
      if (free) { const p = freeAt(ev); setMove({ dx: p.x - l0, dy: p.y - free.y }); return }
      setMove({ dx: dx / z, dy: dy / z })
      if (!free) onDrag({ dx, dy, clientX: ev.clientX, clientY: ev.clientY, end: false }, place(dx))
    }
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up)
      setMove(null)
      if (moved && free && onFree) {
        if (ev.type === 'pointerup') onFree({ ...free, ...freeAt(ev), w: baseW })
        showGuides(lines, null, null)
        return
      }
      if (moved) onDrag({ dx: ev.clientX - x0, dy: ev.clientY - y0, clientX: ev.clientX, clientY: ev.clientY, end: ev.type === 'pointerup' }, place(ev.clientX - x0))
    }
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up)
  }

  const at = box.x != null ? null : box.align ?? 'center'
  const FITS: { f: Fit; label: Key; icon: ReactNode }[] = [
    { f: 'cover', label: 'Crop to the frame', icon: <Crop size={14} strokeWidth={1.7} /> },
    { f: 'contain', label: 'Fit inside the frame', icon: <Shrink size={14} strokeWidth={1.7} /> },
    { f: 'fill', label: 'Stretch to the frame', icon: <Expand size={14} strokeWidth={1.7} /> },
  ]
  const aligns: { a: Align; label: Key; icon: ReactNode }[] = [
    { a: 'left', label: 'Align left', icon: <AlignLeft size={14} strokeWidth={1.7} /> },
    { a: 'center', label: 'Centre', icon: <AlignCenter size={14} strokeWidth={1.7} /> },
    { a: 'right', label: 'Align right', icon: <AlignRight size={14} strokeWidth={1.7} /> },
  ]

  return (
    <div className={'pfig-lane' + (free ? ' free' : '')} data-free={free ? '' : undefined} style={free ? { left, top, width: w } : undefined}>
      <div ref={frame} className={'pfig ' + kind + (selected ? ' on' : '') + (move ? ' moving' : '') + (live ? ' sizing' : '')}
        style={{ marginLeft: free ? 0 : left, width: w, height: h, transform: move ? `translate(${move.dx}px, ${move.dy}px)` : undefined }}
        onPointerDown={grab} title={selected ? undefined : t('Click to select, drag to move')}
        // the press captures the pointer on this frame, so a double click lands here rather than on the graph or diagram inside
        onDoubleClick={onEdit ? (e) => { if (!(e.target as HTMLElement).closest('.pfig-h, .pfig-bar, .graph-zoom, input, textarea')) { e.stopPropagation(); onEdit() } } : undefined}>
        {children(w, h)}
        {selected && !move && HANDLES.map((hd) => (
          <span key={hd} className={'pfig-h ' + hd} onPointerDown={(e) => resize(hd, e)} role="separator" aria-label={t('Resize')} />
        ))}
        {live && <span className="pfig-size mono">{live.w} × {live.h}</span>}
        {selected && !move && !live && (
          <div className={'pfig-bar' + (barEnd ? ' end' : '')} role="toolbar" aria-label={t('Picture tools')} onPointerDown={(e) => e.stopPropagation()}>
            {onLayout && <button className="icon-btn sm" onClick={onLayout} title={free ? t('Back into the flow') : t('Place freely on the page')} aria-label={free ? t('Back into the flow') : t('Place freely on the page')}>
              {free ? <Rows3 size={14} strokeWidth={1.7} /> : <Move size={14} strokeWidth={1.7} />}</button>}
            {free && onFree && <WrapToggle on={free.wrap === true} flip={() => onFree({ ...free, wrap: free.wrap ? undefined : true })} />}
            {!free && <span className="pfig-sep" />}
            {!free && aligns.map((x) => (
              <button key={x.a} className={'icon-btn sm' + (at === x.a ? ' on' : '')} aria-pressed={at === x.a} title={t(x.label)} aria-label={t(x.label)}
                onClick={() => onChange({ align: x.a, x: undefined })}>{x.icon}</button>
            ))}
            {kind === 'image' && box.height != null && <>
              <span className="pfig-sep" />
              {FITS.map((x) => (
                <button key={x.f} className={'icon-btn sm' + ((fit ?? 'cover') === x.f ? ' on' : '')} aria-pressed={(fit ?? 'cover') === x.f}
                  title={t(x.label)} aria-label={t(x.label)} onClick={() => onChange({ fit: x.f })}>{x.icon}</button>
              ))}
            </>}
            <span className="pfig-sep" />
            {extra}
            {onEdit && <button className="btn ghost sm" onClick={onEdit}><Pencil size={13} strokeWidth={1.8} />{t('Edit')}</button>}
            <button className="icon-btn sm" title={t('Reset size')} aria-label={t('Reset size')} disabled={free ? false : box.width == null && box.height == null && box.x == null && !box.align}
              onClick={() => { if (free && onFree) { onFree({ x: free.x, y: free.y, w: Math.min(defaultW, colW) }); onChange({ fit: undefined }) } else onChange({ width: undefined, height: undefined, x: undefined, align: undefined, fit: undefined }) }}><RotateCcw size={14} strokeWidth={1.7} /></button>
            <button className="icon-btn sm" title={t('Delete block')} aria-label={t('Delete block')} onClick={onDelete}><Trash2 size={14} strokeWidth={1.7} /></button>
            {kind === 'graph' && <span className="pfig-hint">{t('Alt + drag pans the graph')}</span>}
          </div>
        )}
      </div>
      {below && <div className="pfig-below" style={{ marginLeft: free ? 0 : left, width: w }}>{below}</div>}
    </div>
  )
}

/* ----------------------------------------------------------------- a text or a board placed freely on the sheet */

const MIN_FREE_W = 120

/** A block taken out of the flow: it sits at its own place on the sheet. The bar above it (on hover, or while it is
 *  in use) has the grip to move it, the button that puts it back into the flow, and delete; the side handles set its
 *  width. Its height follows what is in it. */
export function FreeBox({ id, pos, bounds, on, kind, onPos, onLayout, onDelete, children, extra }: {
  id: string; pos: FreePos; bounds: number; on: boolean; kind: string
  onPos: (p: FreePos) => void; onLayout: () => void; onDelete: () => void; children: ReactNode
  /** more tools in its bar (a text's style) */
  extra?: ReactNode
}) {
  const el = useRef<HTMLDivElement>(null)
  const [live, setLive] = useState<FreePos | null>(null)
  const p = live ?? pos
  /** moving (by the grip, or by the text itself once the pointer has gone a few pixels) or sizing from a side */
  const drag = (mode: 'move' | 'body' | 'e' | 'w', e: React.PointerEvent) => {
    if (e.button !== 0) return
    if (mode !== 'body') { e.preventDefault(); e.stopPropagation() }
    const z = zoomOf(el.current), x0 = e.clientX, y0 = e.clientY, s = pos
    let last = s, started = mode !== 'body'
    const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))
    const lines = snapLines(el.current)
    const h = (el.current?.getBoundingClientRect().height ?? 0) / z
    const mv = (ev: PointerEvent) => {
      if (!started) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return
        started = true; setLive(s); window.getSelection()?.removeAllRanges()
      }
      ev.preventDefault()
      const dx = (ev.clientX - x0) / z, dy = (ev.clientY - y0) / z
      if (mode === 'move' || mode === 'body') {
        const g = snapBox(lines, s.x + dx, s.y + dy, s.w, h, ev.altKey)
        showGuides(lines, g.gx, g.gy)
        last = { ...s, x: Math.round(clamp(g.x, 0, bounds - s.w)), y: Math.round(Math.max(0, g.y)) }
      } else if (mode === 'e') {
        const g = snapEdge(lines, s.x + s.w + dx, 'x', ev.altKey)
        showGuides(lines, g.g, null)
        last = { ...s, w: Math.round(clamp(g.v - s.x, MIN_FREE_W, bounds - s.x)) }
      } else {
        const g = snapEdge(lines, s.x + dx, 'x', ev.altKey)
        showGuides(lines, g.g, null)
        const w = Math.round(clamp(s.x + s.w - g.v, MIN_FREE_W, s.x + s.w)); last = { ...s, w, x: s.x + s.w - w }
      }
      setLive(last)
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up)
      showGuides(lines, null, null)
      if (!started) return
      setLive(null)
      // the click that ends a move must not also start editing the text
      const eat = (c: MouseEvent) => { c.stopPropagation(); c.preventDefault() }
      window.addEventListener('click', eat, { capture: true, once: true })
      window.setTimeout(() => window.removeEventListener('click', eat, { capture: true }), 400)
      if (ev.type === 'pointerup' && last !== s) onPos(last)
    }
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up)
    if (started) setLive(s)
  }
  // a text that isn't being edited moves by itself too: press on it and drag (a click still starts editing it)
  const bodyDown = (e: React.PointerEvent) => {
    if (kind !== 'text' || (e.target as HTMLElement).closest('.md-ed, .fbox-bar, .fbox-h, a, button, input, textarea, .cb-copy')) return
    drag('body', e)
  }
  return (
    <div ref={el} className={'fbox t-' + kind + (on ? ' on' : '') + (live ? ' live' : '')} data-row={id} data-free="" style={{ left: p.x, top: p.y, width: p.w }}
      onPointerDown={bodyDown}>
      <div className="fbox-bar" role="toolbar" aria-label={t('Block')}>
        <span className="fbox-grip" role="button" tabIndex={0} title={t('Drag to move')} aria-label={t('Drag to move')} onPointerDown={(e) => drag('move', e)}
          onKeyDown={(e) => {
            const k = { ArrowLeft: [-8, 0], ArrowRight: [8, 0], ArrowUp: [0, -8], ArrowDown: [0, 8] }[e.key]
            if (k) { e.preventDefault(); onPos({ ...pos, x: Math.min(bounds - pos.w, Math.max(0, pos.x + k[0])), y: Math.max(0, pos.y + k[1]) }) }
          }}><GripHorizontal size={14} strokeWidth={1.8} /></span>
        <button className="icon-btn sm" onClick={onLayout} title={t('Back into the flow')} aria-label={t('Back into the flow')}><Rows3 size={14} strokeWidth={1.7} /></button>
        <WrapToggle on={pos.wrap === true} flip={() => onPos({ ...pos, wrap: pos.wrap ? undefined : true })} />
        {extra}
        <button className="icon-btn sm" onClick={onDelete} title={t('Delete block')} aria-label={t('Delete block')}><Trash2 size={14} strokeWidth={1.7} /></button>
      </div>
      <span className="fbox-h w" onPointerDown={(e) => drag('w', e)} role="separator" aria-label={t('Resize')} />
      <span className="fbox-h e" onPointerDown={(e) => drag('e', e)} role="separator" aria-label={t('Resize')} />
      {live && live.w !== pos.w && <span className="pfig-size mono">{live.w} px</span>}
      {children}
    </div>
  )
}

/** Whether the writing makes room for a free block (flows beside it or under it) or the block sits in front of it. */
function WrapToggle({ on, flip }: { on: boolean; flip: () => void }) {
  const label = on ? t('Text flows around it') : t('In front of the text')
  return (
    <button className={'icon-btn sm' + (on ? ' on' : '')} aria-pressed={on} onClick={flip} title={label} aria-label={label}>
      {on ? <WrapText size={14} strokeWidth={1.7} /> : <Layers size={14} strokeWidth={1.7} />}
    </button>
  )
}

const T_FONTS: { f: PageFont; label: 'Serif' | 'Sans' | 'Handwriting' | 'Neat handwriting' }[] = [
  { f: 'serif', label: 'Serif' }, { f: 'sans', label: 'Sans' }, { f: 'hand', label: 'Handwriting' }, { f: 'print', label: 'Neat handwriting' },
]
const T_SIZES: { s: TextSize | undefined; label: 'Small' | 'Normal' | 'Large' | 'Very large' }[] = [
  { s: 's', label: 'Small' }, { s: undefined, label: 'Normal' }, { s: 'l', label: 'Large' }, { s: 'xl', label: 'Very large' },
]
const T_ALIGNS: { a: TextAlign | undefined; label: 'Left' | 'Centre' | 'Align right' | 'Justify'; icon: ReactNode }[] = [
  { a: undefined, label: 'Left', icon: <AlignLeft size={14} strokeWidth={1.7} /> }, { a: 'center', label: 'Centre', icon: <AlignCenter size={14} strokeWidth={1.7} /> },
  { a: 'right', label: 'Align right', icon: <AlignRight size={14} strokeWidth={1.7} /> }, { a: 'justify', label: 'Justify', icon: <AlignJustify size={14} strokeWidth={1.7} /> },
]

const T_TONES: { c: TextTone | undefined; label: 'Ink' | 'Muted' | 'Accent' }[] = [{ c: undefined, label: 'Ink' }, { c: 'muted', label: 'Muted' }, { c: 'accent', label: 'Accent' }]

/** One text's own look: its font (or the page's), its size and how its lines are aligned. */
export function TextStyleMenu({ style, onStyle }: { style: TextStyle; onStyle: (s: TextStyle) => void }) {
  // the menu opens over everything (outside the zoomed sheet), on whichever side of the button has room
  const [open, setOpen] = useState<{ x: number; y: number; up: boolean; font: string } | null>(null)
  const box = useRef<HTMLSpanElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  const toggle = () => {
    if (open || !box.current) { setOpen(null); return }
    const r = box.current.getBoundingClientRect(), W = 300, H = 390
    const up = r.bottom + 8 + H > window.innerHeight - 90 && r.top - 8 - H > 8
    setOpen({ x: Math.max(8, Math.min(r.left, window.innerWidth - W - 8)), y: up ? r.top - 8 : r.bottom + 8, up, font: getComputedStyle(box.current).getPropertyValue('--doc-font') })
  }
  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node) && !pop.current?.contains(e.target as Node)) setOpen(null) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(null) } }
    document.addEventListener('pointerdown', down, true); window.addEventListener('keydown', key, true)
    return () => { document.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key, true) }
  }, [open])
  const set = (p: TextStyle) => onStyle({ ...style, ...p })
  const styled = !!(style.font || style.size || style.talign || style.tone)
  return (
    <span className="tstyle-menu" ref={box}>
      <button className={'icon-btn sm' + (open || styled ? ' on' : '')} aria-expanded={!!open} aria-haspopup="dialog" title={t('Text style')} aria-label={t('Text style')}
        onClick={toggle}><CaseSensitive size={15} strokeWidth={1.7} /></button>
      {open && createPortal(
        <div ref={pop} className={'tstyle-pop' + (open.up ? ' up' : '')} role="dialog" aria-label={t('Text style')} onPointerDown={(e) => e.stopPropagation()}
          style={{ left: open.x, top: open.y }}>
          <div className="look-h">{t('Font')}</div>
          <div className="tstyle-fonts" role="radiogroup" aria-label={t('Font')}>
            <button role="radio" aria-checked={!style.font} className={'look-font' + (!style.font ? ' on' : '')} onClick={() => set({ font: undefined })}>
              <span className="look-sample" style={{ fontFamily: open.font || undefined }}>Ag</span><span>{t('Page font')}</span></button>
            {T_FONTS.map((x) => (
              <button key={x.f} role="radio" aria-checked={style.font === x.f} className={'look-font' + (style.font === x.f ? ' on' : '')} data-sample={x.f} onClick={() => set({ font: x.f })}>
                <span className="look-sample">Ag</span><span>{t(x.label)}</span></button>
            ))}
          </div>
          <div className="look-h">{t('Size')}</div>
          <div className="seg sm" role="radiogroup" aria-label={t('Size')}>
            {T_SIZES.map((x) => (
              <button key={x.label} role="radio" aria-checked={style.size === x.s} className={style.size === x.s ? 'on' : ''} onClick={() => set({ size: x.s })}>{t(x.label)}</button>
            ))}
          </div>
          <div className="look-h">{t('Alignment')}</div>
          <div className="seg sm" role="radiogroup" aria-label={t('Alignment')}>
            {T_ALIGNS.map((x) => (
              <button key={x.label} role="radio" aria-checked={style.talign === x.a} className={style.talign === x.a ? 'on' : ''} title={t(x.label)} aria-label={t(x.label)} onClick={() => set({ talign: x.a })}>{x.icon}</button>
            ))}
          </div>
          <div className="look-h">{t('Colour')}</div>
          <div className="seg sm" role="radiogroup" aria-label={t('Colour')}>
            {T_TONES.map((x) => (
              <button key={x.label} role="radio" aria-checked={style.tone === x.c} className={(style.tone === x.c ? 'on ' : '') + 'tone-' + (x.c ?? 'ink')} onClick={() => set({ tone: x.c })}>
                <i className="tone-dot" aria-hidden />{t(x.label)}</button>
            ))}
          </div>
        </div>, document.body)}
    </span>
  )
}
