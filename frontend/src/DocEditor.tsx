import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Box, Check, ChartSpline, Eraser, GripVertical, ImagePlus, Move, PenLine, Plus, Trash2, Type, Undo2 } from 'lucide-react'
import { api, type TextStyle, type Board, type BlockLayout, type DocBlock, type FigBox, type Fit, type FreePos, type Stroke } from './api'
import { PageInk, type InkTool } from './PageInk'
import { inkBottom, PAGE_INKS, PAGE_SIZES_PX } from './ink'
import type { Ctx } from './App'
import BoardView from './Board'
import { Figure, FreeBox, TextStyleMenu, type FigDrop } from './DocFigure'
import { GraphFigure, GraphLookMenu, STARTER } from './Graph'
import { DiagramFigure } from './Diagram'
import { DIAGRAM_STARTER } from './diagramcore'
import { MdEditor, NoteMd } from './NoteMd'
import { scrollerOf, zoomOf } from './page'
import { t, type Key } from './i18n'

const uid = () => Math.random().toString(36).slice(2, 10)

/** the size a block gets when it is put down somewhere on the sheet: width and (for the outline shown) height */
const PLACE: Record<string, [number, number]> = { text: [300, 64], graph: [380, 260], image: [320, 220], diagram: [360, 300] }

const ADD: { type: DocBlock['type']; label: Key; icon: ReactNode; note: Key }[] = [
  { type: 'text', label: 'Text', icon: <Type size={16} strokeWidth={1.7} />, note: 'Paragraphs, headings, $maths$' },
  { type: 'graph', label: 'Graph', icon: <ChartSpline size={16} strokeWidth={1.7} />, note: 'Plot equations, sliders' },
  { type: 'diagram', label: 'Diagram', icon: <Box size={16} strokeWidth={1.7} />, note: '3D boxes, arrows, labels' },
  { type: 'image', label: 'Image', icon: <ImagePlus size={16} strokeWidth={1.7} />, note: 'A picture or a screenshot' },
]

function fresh(type: DocBlock['type']): DocBlock {
  const id = uid()
  if (type === 'text') return { id, type, md: '' }
  if (type === 'graph') return { id, type, fns: STARTER }
  if (type === 'image') return { id, type, src: '' }
  if (type === 'diagram') return { id, type, src: DIAGRAM_STARTER }
  return { id, type: 'canvas', height: 420, items: [], arrows: [], strokes: [] }
}

/** space between two columns (the divider that sets their widths sits in it) */
const GAP = 32
const MAX_COLS = 4
const MIN_COL = 120

const omit = (b: DocBlock, ...keys: (keyof BlockLayout | keyof FigBox)[]): DocBlock => {
  const c = { ...b } as Record<string, unknown>
  for (const k of keys) delete c[k]
  return c as DocBlock
}

/** One line of the flow: a single block, or the blocks of one row side by side. `i` is each block's index in the page. */
type Line = { key: string; items: { b: DocBlock; i: number }[]; auto?: boolean }
/** With `cols` set for the page, the blocks that aren't in a row of their own fill a grid of that many columns,
 *  left to right and then the next line (a row made by hand stays as it is). */
function linesOf(blocks: DocBlock[], cols = 1): Line[] {
  const out: Line[] = []
  blocks.forEach((b, i) => {
    if (b.free) return
    const last = out[out.length - 1]
    if (b.row) {
      if (last && !last.auto && last.items[0].b.row === b.row && last.items.length < MAX_COLS) last.items.push({ b, i })
      else out.push({ key: b.row, items: [{ b, i }] })
    } else if (cols > 1 && last?.auto && last.items.length < cols) last.items.push({ b, i })
    else out.push({ key: b.id, items: [{ b, i }], auto: cols > 1 })
  })
  return out
}

/** Keeps the layout fields honest: a row left with one block is no row, and a free block belongs to no row. */
function tidy(blocks: DocBlock[]): DocBlock[] {
  const solo = new Set(linesOf(blocks).filter((l) => l.items.length === 1).map((l) => l.items[0].b.id))
  return blocks.map((b) => (b.free && (b.row || b.span) ? omit(b, 'row', 'span') : solo.has(b.id) && (b.row || b.span) ? omit(b, 'row', 'span') : b))
}

const styleOf = (b: DocBlock): TextStyle => (b.type === 'text' ? { font: b.font, size: b.size, talign: b.talign, tone: b.tone } : {})
/** a text's own look, read by the page's styles */
const styleAttrs = (b: DocBlock) => (b.type === 'text' ? { 'data-font': b.font, 'data-tsize': b.size, 'data-talign': b.talign, 'data-tone': b.tone } : {})

/** room left around a free block, in page pixels */
const WRAP_M = 14
const NO_INK: Stroke[] = []
const TAIL = '\u0000tail'
type Box = { x0: number; x1: number; y0: number; y1: number }
type Spacer = { side: 'left' | 'right'; clear: 'left' | 'right' | 'both' | 'none'; w: number; h: number }
type Wrap = { sp?: Spacer[]; push?: number }

/** The invisible floats that make a text's lines run beside the obstacles crossing it. Each obstacle becomes a float
 *  on the side away from the wider gap (so the text takes the wider one), or across the whole width when neither
 *  side has room for a line; zero-width floats in front push each one down to its height. A float ends where the
 *  text ends, so the next block carries on beside the rest of the obstacle. */
function floatsFor(h: Box, host: HTMLElement, rel: (r: DOMRect) => Box, obs: Box[]): Spacer[] {
  let bottom = h.y0
  for (const c of host.children) if (!c.classList.contains('wrap-sp')) bottom = Math.max(bottom, rel(c.getBoundingClientRect()).y1)
  const items: { side: 'left' | 'right' | 'full'; top: number; bot: number; w: number }[] = []
  for (const o of obs) {
    if (o.x1 + WRAP_M <= h.x0 || o.x0 - WRAP_M >= h.x1) continue
    const top = o.y0 - WRAP_M, bot = o.y1 + WRAP_M
    if (bot <= h.y0 || top >= bottom) continue
    const left = o.x0 - WRAP_M - h.x0, right = h.x1 - (o.x1 + WRAP_M)
    const side = Math.max(left, right) < 110 ? 'full' : right >= left ? 'left' : 'right'
    const w = side === 'full' ? h.x1 - h.x0 : side === 'left' ? o.x1 + WRAP_M - h.x0 : h.x1 - (o.x0 - WRAP_M)
    items.push({ side, top: Math.max(0, top - h.y0), bot: (side === 'full' ? bot : Math.min(bot, bottom)) - h.y0, w })
  }
  items.sort((a, b) => a.top - b.top)
  const out: Spacer[] = []
  const prev = { left: 0, right: 0 }
  let last = 0
  for (const it of items) {
    const s = it.side === 'full' ? 'left' : it.side
    const clear = it.side === 'full' ? 'both' : s
    const start = Math.max(it.side === 'full' ? Math.max(prev.left, prev.right) : prev[s], last)
    if (it.top - start > 0.5) { out.push({ side: s, clear, w: 0, h: Math.round(it.top - start) }); last = start }
    const ftop = Math.max(it.top, start), fh = Math.round(it.bot - ftop)
    if (fh <= 1) continue
    out.push({ side: s, clear, w: Math.round(it.w), h: fh }); last = ftop
    if (it.side === 'full') prev.left = prev.right = ftop + fh; else prev[s] = ftop + fh
  }
  return out
}

/** Where a dragged block would land: beside another block (making or joining a row), or between two lines. */
type Drop = { side: 'left' | 'right'; id: string } | { line: number } | { swap: string }

export type SheetInfo = { colW: number; sheetW: number; pad: number; dock: HTMLElement | null; free: HTMLElement | null; onExtent: (px: number) => void; cols?: number }

/** A page's blocks. They flow down the sheet; blocks can sit side by side in columns (drag one to the left or right
 *  edge of another), and any block can be taken out of the flow and put anywhere on the sheet. A double click on
 *  empty paper starts a text right there. */
export function DocEditor({ blocks, onChange, ctx, sheet, ink = NO_INK, onInk }: {
  blocks: DocBlock[]; onChange: (b: DocBlock[]) => void
  /** what is written with the pen straight on the sheet */
  ink?: Stroke[]; onInk?: (s: Stroke[]) => void
  /** without it (scratch paper) pictures can't be added: they would be uploaded to the notebook */
  ctx?: Ctx; sheet: SheetInfo
}) {
  const kinds = ctx ? ADD : ADD.filter((a) => a.type !== 'image')
  const { colW, sheetW, dock, free: freeLayer, onExtent } = sheet
  const cols = sheet.cols ?? 1
  const [editing, setEditing] = useState<string | null>(() => (blocks.length === 1 && blocks[0].type === 'text' && !blocks[0].md ? blocks[0].id : null))
  const [sel, setSel] = useState<string | null>(null)
  const [adding, setAdding] = useState<number | null>(null)
  const [drop, setDrop] = useState<(Drop & { from: string }) | null>(null)
  const [graphEdit, setGraphEdit] = useState<string | null>(null)
  const [aspects, setAspects] = useState<Record<string, number>>({})
  const doc = useRef<HTMLDivElement>(null)
  const wasActive = useRef(false)
  // the pen: while it is in hand the sheet takes ink, and the dock holds its colours, sizes, the eraser and undo
  const [inkTool, setInkTool] = useState<InkTool | null>(null)
  const [inkColor, setInkColor] = useState<string>('ink')
  const [inkSize, setInkSize] = useState<number>(PAGE_SIZES_PX[1])
  const inkPast = useRef<Stroke[][]>([])
  const [undoable, setUndoable] = useState(0)
  const undoInk = () => { const prev = inkPast.current.pop(); setUndoable(inkPast.current.length); if (prev) onInk?.(prev) }
  useEffect(() => {
    if (!inkTool) return
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setInkTool(null) }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && inkPast.current.length) {
        e.preventDefault(); const prev = inkPast.current.pop()!; setUndoable(inkPast.current.length); onInk?.(prev)
      }
    }
    window.addEventListener('keydown', k, true)
    return () => window.removeEventListener('keydown', k, true)
  }, [inkTool, onInk])
  const lines = linesOf(blocks, cols)
  const change = (next: DocBlock[]) => onChange(tidy(next))
  const patch = (id: string, p: Partial<DocBlock>) => change(blocks.map((b) => (b.id === id ? ({ ...b, ...p } as DocBlock) : b)))

  const insert = async (at: number, type: DocBlock['type'], file?: File, place?: FreePos) => {
    let blk = fresh(type)
    if (type === 'image') {
      if (!ctx) return
      const f = file ?? await pick()
      if (!f) return
      const src = await ctx.run(api.notesUpload(f))
      if (!src) return
      blk = { ...blk, src } as DocBlock
    }
    if (place) blk = { ...blk, free: place }
    change([...blocks.slice(0, at), blk, ...blocks.slice(at)])
    setAdding(null)
    if (type === 'text') { setEditing(blk.id); setSel(null) }
    else { setSel(blk.id); setEditing(null) }
  }
  /** the page index in front of which a block dropped on line `k` goes (the end of the page past the last line) */
  const lineStart = (k: number) => (k < lines.length ? lines[k].items[0].i : blocks.length)

  const target = (x: number, y: number, from: string): Drop => {
    const root = doc.current
    if (!root) return { line: lines.length }
    const z = zoomOf(root)
    const fromRow = blocks.find((b) => b.id === from)?.row
    for (const c of root.querySelectorAll<HTMLElement>('[data-cell]')) {
      const id = c.dataset.cell!
      if (id === from) continue
      const r = c.getBoundingClientRect()
      if (y < r.top || y > r.bottom || x < r.left - (GAP / 2) * z || x > r.right + (GAP / 2) * z) continue
      const line = lines.find((l) => l.items.some((it) => it.b.id === id))
      const full = line && !line.auto && line.items.length >= MAX_COLS && fromRow !== line.items[0].b.row
      const edge = Math.min(140 * z, r.width * 0.25)
      if (!full && x < r.left + edge) return { side: 'left', id }
      if (!full && x > r.right - edge) return { side: 'right', id }
      // in the page's grid, the middle of another block swaps the two
      if (line?.auto && x >= r.left && x <= r.right) return { swap: id }
    }
    const els = [...root.querySelectorAll<HTMLElement>(':scope > .doc-line')]
    const k = els.findIndex((l) => { const b = l.getBoundingClientRect(); return y < b.top + b.height / 2 })
    return { line: k < 0 ? els.length : k }
  }
  /** whether dropping `from` there changes nothing (so no marker is shown) */
  const idle = (from: string, d: Drop) => {
    if ('side' in d || 'swap' in d) return false
    const k = lines.findIndex((l) => l.items.some((it) => it.b.id === from))
    return k >= 0 && lines[k].items.length === 1 && (d.line === k || d.line === k + 1)
  }
  const applyDrop = (from: string, d: Drop, extra?: Partial<DocBlock>) => {
    const next = blocks.slice()
    const si = next.findIndex((b) => b.id === from)
    if (si < 0) return
    let moving = { ...omit(next[si], 'row', 'span', 'free'), ...extra } as DocBlock
    if ('swap' in d) {
      const ti = next.findIndex((b) => b.id === d.swap)
      if (ti < 0) return
      next[si] = next[ti]; next[ti] = moving
      change(next)
      return
    }
    if ('side' in d) {
      next.splice(si, 1)
      const ti = next.findIndex((b) => b.id === d.id)
      if (ti < 0) return
      if (lines.find((l) => l.items.some((it) => it.b.id === d.id))?.auto) {
        // in the page's grid, beside a block = in front of it or after it: the grid places it
        next.splice(d.side === 'left' ? ti : ti + 1, 0, moving)
        change(next)
        return
      }
      const row = next[ti].row ?? uid()
      next[ti] = { ...next[ti], row }
      moving = { ...moving, row }
      next.splice(d.side === 'left' ? ti : ti + 1, 0, moving)
    } else {
      if (idle(from, d)) { if (extra) patch(from, extra); return }
      const at = lineStart(d.line)
      next.splice(si, 1)
      next.splice(at > si ? at - 1 : at, 0, moving)
    }
    change(next)
  }
  const edgeScroll = (y: number) => {
    const m = scrollerOf(doc.current)
    if (m) { const r = m.getBoundingClientRect(); if (y < r.top + 50) m.scrollBy(0, -12); else if (y > r.bottom - 50) m.scrollBy(0, 12) }
  }
  // dragging any block by its grip: a line (or a bar beside a block) shows where it lands
  const grab = (b: DocBlock, e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const mv = (ev: PointerEvent) => {
      const d = target(ev.clientX, ev.clientY, b.id)
      setDrop(idle(b.id, d) ? null : { ...d, from: b.id }); edgeScroll(ev.clientY)
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up)
      setDrop(null)
      if (ev.type === 'pointerup') applyDrop(b.id, target(ev.clientX, ev.clientY, b.id))
    }
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up)
  }
  const nudge = (b: DocBlock, by: -1 | 1) => {
    const k = lines.findIndex((l) => l.items.some((it) => it.b.id === b.id))
    if (k < 0) return
    applyDrop(b.id, { line: by < 0 ? Math.max(0, k - 1) : Math.min(lines.length, k + 2) })
  }
  // a picture or graph dragged by itself: sideways it moves in its column, beside another block it joins its row,
  // past its neighbours it changes places
  const figDrag = (b: DocBlock) => (d: FigDrop, place: Pick<FigBox, 'x' | 'align'>) => {
    const cell = doc.current?.querySelector<HTMLElement>(`[data-cell="${b.id}"]`)?.getBoundingClientRect()
    const inside = !!cell && d.clientY >= cell.top && d.clientY <= cell.bottom
    const tg = target(d.clientX, d.clientY, b.id)
    const eff: Drop | null = 'side' in tg || 'swap' in tg ? tg : inside || idle(b.id, tg) ? null : tg
    if (!d.end) { setDrop(eff ? { ...eff, from: b.id } : null); edgeScroll(d.clientY); return }
    setDrop(null)
    if (!eff) patch(b.id, place as Partial<DocBlock>)
    else applyDrop(b.id, eff, ('line' in eff ? place : { x: undefined, align: undefined }) as Partial<DocBlock>)
  }
  // a divider between two columns: drag it to share the width differently
  const split = (line: Line, k: number) => (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault(); e.stopPropagation()
    const L = line.items[k - 1].b, R = line.items[k].b
    const sum = line.items.reduce((a, it) => a + (it.b.span ?? 1), 0)
    const avail = colW - GAP * (line.items.length - 1)
    const sL = L.span ?? 1, sR = R.span ?? 1, wL = (avail * sL) / sum, wR = (avail * sR) / sum
    const z = zoomOf(doc.current), x0 = e.clientX
    const tg = e.currentTarget as HTMLElement
    tg.setPointerCapture(e.pointerId)
    const mv = (ev: PointerEvent) => {
      const nl = Math.min(wL + wR - MIN_COL, Math.max(MIN_COL, wL + (ev.clientX - x0) / z))
      const nL = Math.round(((sL + sR) * nl / (wL + wR)) * 1000) / 1000
      change(blocks.map((b) => (b.id === L.id ? { ...b, span: nL } : b.id === R.id ? { ...b, span: Math.round((sL + sR - nL) * 1000) / 1000 } : b)))
    }
    const up = () => { tg.removeEventListener('pointermove', mv); tg.removeEventListener('pointerup', up); tg.removeEventListener('pointercancel', up) }
    tg.addEventListener('pointermove', mv); tg.addEventListener('pointerup', up); tg.addEventListener('pointercancel', up)
  }
  const evenOut = (line: Line) => change(blocks.map((b) => (line.items.some((it) => it.b.id === b.id) ? omit(b, 'span') : b)))

  const paperOf = () => doc.current?.closest<HTMLElement>('.paper') ?? null

  // putting a block anywhere on the sheet: a dock button is armed by a click (then a click on the sheet puts the
  // block there) or dragged straight onto the sheet. It lands in front of everything: nothing else on the page moves.
  const [placing, setPlacing] = useState<{ type: DocBlock['type']; drag: boolean } | null>(null)
  const [ghost, setGhost] = useState<FreePos | null>(null)
  const spot = (type: DocBlock['type'], cx: number, cy: number, over: EventTarget | null): FreePos | null => {
    const paper = paperOf()
    if (!paper || (over as HTMLElement | null)?.closest?.('.doc-dock, .page-look, .note-bar')) return null
    const pr = (freeLayer ?? paper).getBoundingClientRect()
    if (cx < pr.left || cx > pr.right || cy < pr.top || cy > pr.bottom) return null
    const z = zoomOf(paper), [w, h] = PLACE[type] ?? PLACE.text
    const x = (cx - pr.left) / z - w / 2, y = (cy - pr.top) / z - (type === 'text' ? 18 : h / 2)
    const p: FreePos = { x: Math.round(Math.max(4, Math.min(x, sheetW - w - 4))), y: Math.round(Math.max(4, y)), w: Math.min(w, sheetW - 8) }
    if (type === 'graph' || type === 'diagram') p.h = h
    return p
  }
  /** the click that follows a press used to put a block down must not also do what a click there does */
  const swallowClick = () => {
    const eat = (ev: MouseEvent) => { ev.stopPropagation(); ev.preventDefault() }
    window.addEventListener('click', eat, { capture: true, once: true })
    window.setTimeout(() => window.removeEventListener('click', eat, { capture: true }), 700)
  }
  useEffect(() => {
    const paper = paperOf()
    paper?.classList.toggle('placing', !!placing)
    if (!placing || placing.drag) return
    const type = placing.type
    const mv = (e: PointerEvent) => setGhost(spot(type, e.clientX, e.clientY, e.target))
    const down = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest('.doc-dock')) return
      const p = spot(type, e.clientX, e.clientY, e.target)
      setPlacing(null); setGhost(null)
      if (!p) return
      e.preventDefault(); e.stopPropagation(); swallowClick()
      insert(blocks.length, type, undefined, p)
    }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setPlacing(null); setGhost(null) } }
    window.addEventListener('pointermove', mv)
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key, true)
    return () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key, true) }
  })
  useEffect(() => () => paperOf()?.classList.remove('placing'), [])
  const dockDown = (type: DocBlock['type']) => (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const x0 = e.clientX, y0 = e.clientY
    let dragging = false
    const mv = (ev: PointerEvent) => {
      if (!dragging && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return
      if (!dragging) { dragging = true; setPlacing({ type, drag: true }); setSel(null) }
      setGhost(spot(type, ev.clientX, ev.clientY, ev.target))
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up)
      setGhost(null)
      if (!dragging) { setPlacing((cur) => (cur?.type === type ? null : { type, drag: false })); return }
      setPlacing(null)
      const p = ev.type === 'pointerup' ? spot(type, ev.clientX, ev.clientY, ev.target) : null
      if (p) { swallowClick(); insert(blocks.length, type, undefined, p) }
    }
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up)
  }

  // out of the flow: it stays exactly where it was on the sheet, and from now on it can go anywhere
  const toFree = (b: DocBlock) => {
    const paper = paperOf(), cell = doc.current?.querySelector<HTMLElement>(`[data-cell="${b.id}"]`)
    if (!paper || !cell) return
    const z = zoomOf(paper), pr = paper.getBoundingClientRect()
    const box = cell.querySelector<HTMLElement>('.pfig') ?? cell.querySelector<HTMLElement>('.doc-text, .md-ed, .board') ?? cell
    const r = box.getBoundingClientRect()
    const pos: FreePos = { x: Math.round((r.left - pr.left) / z), y: Math.round((r.top - pr.top) / z), w: Math.round(r.width / z) }
    if ((b.type === 'image' && b.height != null) || b.type === 'graph' || b.type === 'diagram') pos.h = Math.round(r.height / z)
    if (b.type === 'text') { pos.x += 10; pos.w -= 20 }   // the text's own box, without the hover padding
    change(blocks.map((x) => (x.id === b.id ? ({ ...omit(x, 'row', 'span', 'x', 'align'), free: pos } as DocBlock) : x)))
    setSel(b.type === 'text' ? null : b.id)
  }
  // back into the flow: in front of the first line that starts below it
  const toFlow = (b: DocBlock) => {
    const paper = paperOf(), root = doc.current
    if (!paper || !root || !b.free) return
    const z = zoomOf(paper), pr = paper.getBoundingClientRect()
    const els = [...root.querySelectorAll<HTMLElement>(':scope > .doc-line')]
    const k = els.findIndex((l) => (l.getBoundingClientRect().top - pr.top) / z > b.free!.y)
    const keep: Partial<DocBlock> = b.type === 'image' || b.type === 'graph' || b.type === 'diagram' ? { width: b.free.w, height: b.free.h } as Partial<DocBlock> : {}
    applyDrop(b.id, { line: k < 0 ? lines.length : k }, keep)
  }

  const drop1 = (id: string) => {
    const next = blocks.filter((b) => b.id !== id)
    change(next.length ? next : [fresh('text')])
    setSel(null)
  }
  const endText = useCallback((id: string) => {
    setEditing((cur) => (cur === id ? null : cur))
    const b = blocks.find((x) => x.id === id)
    if (b?.type === 'text' && !b.md.trim() && blocks.length > 1) onChange(tidy(blocks.filter((x) => x.id !== id)))
  }, [blocks, onChange])
  // clicking the empty paper under the last block writes at the end (unless it was only leaving a block)
  const writeAtEnd = () => {
    const last = lines[lines.length - 1]?.items.at(-1)?.b
    if (last?.type === 'text') setEditing(last.id)
    else insert(blocks.length, 'text')
  }

  // leaving a block: a press anywhere on the page that isn't the block itself (or its tools) ends the editing and
  // drops the selection. Toolbars, the dock, the inserter, dialogs and the page bar keep it.
  useEffect(() => {
    if (!editing && !sel) return
    const down = (e: PointerEvent) => {
      const tg = e.target as HTMLElement
      if (!tg.closest('.note-doc')) return
      if (tg.closest('.pfig-bar, .doc-dock, .doc-ins, .modal-wrap, .note-bar, .md-tools, .col-split, .page-look')) return
      if (editing && tg.closest(`[data-row="${editing}"]`)?.querySelector('.md-ed')) return
      if (sel && tg.closest(`[data-row="${sel}"] .pfig, [data-row="${sel}"].fbox`)) return
      wasActive.current = true
      if (editing) { (document.activeElement as HTMLElement | null)?.blur?.(); endText(editing) }
      setSel(null)
    }
    const key = (e: KeyboardEvent) => {
      if (!sel || graphEdit) return
      const inField = (e.target as HTMLElement).closest('input, textarea, select, [contenteditable]')
      if (e.key === 'Escape') { setSel(null); return }
      if (!inField && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); drop1(sel) }
    }
    document.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key) }
  }) // re-subscribes each render, so it always sees the current blocks

  // a double click on empty paper (the margins too) starts a text right there
  useEffect(() => {
    const paper = paperOf()
    if (!paper) return
    const dbl = (e: MouseEvent) => {
      if (inkTool) return
      const tg = e.target as HTMLElement
      if (tg.closest('[data-cell], [data-free], .note-title, .paper-meta, .pfig-bar, .doc-ins, .modal-wrap')) return
      const z = zoomOf(paper), pr = paper.getBoundingClientRect()
      const x = (e.clientX - pr.left) / z, y = (e.clientY - pr.top) / z
      const w = Math.max(160, Math.min(360, sheetW - x - 12))
      insert(blocks.length, 'text', undefined, { x: Math.round(Math.max(4, Math.min(x - 6, sheetW - w - 4))), y: Math.round(Math.max(4, y - 18)), w: Math.round(w) })
    }
    paper.addEventListener('dblclick', dbl)
    return () => paper.removeEventListener('dblclick', dbl)
  })

  // ---- making room for free blocks -------------------------------------------------------------------------------
  // A free block (unless set to sit in front) is an obstacle on the sheet. Each text in the flow gets invisible floats
  // where an obstacle crosses it, so its lines run beside the obstacle (on the wider side) or, when there is no room
  // beside it, continue under it. Pictures, graphs and boards in the flow are moved down below an obstacle instead.
  // Measured from the page itself, then re-measured until nothing moves (the wrapped text is taller, and so on).
  const [wraps, setWraps] = useState<Record<string, Wrap>>({})
  const burst = useRef({ n: 0, t: 0 })
  const layoutWraps = useRef<() => void>(() => {})
  useEffect(() => {
    layoutWraps.current = () => {
      const root = doc.current, paper = paperOf()
      if (!root || !paper || !freeLayer) return
      const z = zoomOf(paper), pr = paper.getBoundingClientRect()
      const rel = (r: DOMRect) => ({ x0: (r.left - pr.left) / z, x1: (r.right - pr.left) / z, y0: (r.top - pr.top) / z, y1: (r.bottom - pr.top) / z })
      const obs: Box[] = []
      for (const b of blocks) {
        if (!b.free || b.free.wrap !== true) continue
        const el = freeLayer.querySelector<HTMLElement>(`[data-row="${b.id}"]`)
        const box = el?.classList.contains('free-fig') ? el.querySelector<HTMLElement>('.pfig-lane') : el
        if (box) obs.push(rel(box.getBoundingClientRect()))
      }
      obs.sort((a, b) => a.y0 - b.y0)
      const next: Record<string, Wrap> = {}
      // the hint under the writing is a line of text like any other
      const tail = root.querySelector<HTMLElement>(':scope > .paper-tail > .wrap-host')
      if (tail) { const sp = floatsFor(rel(tail.getBoundingClientRect()), tail, rel, obs); if (sp.length) next[TAIL] = { sp } }
      for (const cell of root.querySelectorAll<HTMLElement>('[data-cell]')) {
        const id = cell.dataset.cell!
        const host = cell.querySelector<HTMLElement>(':scope > .wrap-host')
        if (host) {
          const sp = floatsFor(rel(host.getBoundingClientRect()), host, rel, obs)
          if (sp.length) next[id] = { sp }
        } else {
          const target = cell.querySelector<HTMLElement>('.pfig, .board') ?? cell
          const pushed = wraps[id]?.push ?? 0, t0 = rel(target.getBoundingClientRect())
          const nat = { ...t0, y0: t0.y0 - pushed, y1: t0.y1 - pushed }
          let push = 0
          for (const o of obs) {
            if (o.x1 + WRAP_M <= nat.x0 || o.x0 - WRAP_M >= nat.x1) continue
            if (o.y1 + WRAP_M <= nat.y0 + push || o.y0 - WRAP_M >= nat.y1 + push) continue
            push = Math.max(push, Math.ceil(o.y1 + WRAP_M - nat.y0))
          }
          if (push > 0) next[id] = { push }
        }
      }
      setWraps((prev) => {
        if (JSON.stringify(prev) === JSON.stringify(next)) return prev
        const now = performance.now(), bu = burst.current
        if (now - bu.t > 600) { bu.n = 0; bu.t = now }
        if (++bu.n > 12) return prev     // it keeps changing: stop, rather than shake
        return next
      })
    }
  })
  useEffect(() => {
    const root = doc.current
    if (!root || !freeLayer) return
    let raf = 0
    const run = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => layoutWraps.current()) }
    const ro = new ResizeObserver(run)
    ro.observe(root); ro.observe(freeLayer)
    for (const c of freeLayer.children) ro.observe(c)
    for (const h of root.querySelectorAll('.wrap-host > :not(.wrap-sp)')) ro.observe(h)
    run()
    return () => { ro.disconnect(); cancelAnimationFrame(raf) }
  }, [freeLayer, blocks, editing])

  // how far down the free blocks reach, so the sheet grows to hold them
  useEffect(() => {
    if (!freeLayer) return
    const measure = () => {
      let m = inkBottom(ink)
      for (const c of freeLayer.children) {
        const el = (c.classList.contains('free-fig') ? c.querySelector('.pfig-lane') : c) as HTMLElement | null
        if (el) m = Math.max(m, el.offsetTop + el.offsetHeight)
      }
      onExtent(m)
    }
    const ro = new ResizeObserver(measure)
    ro.observe(freeLayer)
    for (const c of freeLayer.children) ro.observe(c.classList.contains('free-fig') ? c.querySelector('.pfig-lane') ?? c : c)
    return () => ro.disconnect()
  }, [freeLayer, blocks, onExtent, ink])

  // the hint under the writing steps aside where a free block sits on its line
  useEffect(() => {
    const hint = doc.current?.querySelector<HTMLElement>('.paper-hint')
    if (!hint || !freeLayer) return
    const r = hint.getBoundingClientRect()
    const hit = [...freeLayer.children].some((c) => {
      const q = (c.classList.contains('free-fig') ? c.querySelector('.pfig-lane') ?? c : c).getBoundingClientRect()
      return q.bottom > r.top - 10 && q.top < r.bottom + 10 && q.right > r.left && q.left < r.right
    })
    hint.classList.toggle('covered', hit)
  })

  const textOf = (b: Extract<DocBlock, { type: 'text' }>, first: boolean) => editing === b.id
    ? <MdEditor bare value={b.md} onChange={(md) => patch(b.id, { md })} onDone={() => endText(b.id)}
        placeholder={first ? t('Start writing. ## for a heading, $x^2$ for maths, $$…$$ for a displayed line.') : t('Write…')} />
    : <div className="doc-text" role="button" tabIndex={0} onClick={(e) => { if (!(e.target as HTMLElement).closest('a, .cb-copy')) { setEditing(b.id); setSel(null) } }}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); setEditing(b.id) } }}>
        {b.md.trim() ? <NoteMd text={b.md} /> : <span className="doc-empty">{t('Write…')}</span>}
      </div>

  const figure = (b: Extract<DocBlock, { type: 'image' | 'graph' | 'diagram' }>, width: number) => {
    const common = {
      box: { width: b.width, height: b.height, x: b.x, align: b.align }, colW: b.free ? sheetW : width, selected: sel === b.id,
      onSelect: () => { setSel(b.id); if (editing) endText(editing) },
      onChange: (p: Partial<FigBox> & { fit?: Fit }) => patch(b.id, p as Partial<DocBlock>),
      onDrag: figDrag(b), onDelete: () => drop1(b.id),
      free: b.free, onFree: (p: FreePos) => patch(b.id, { free: p }),
      onLayout: () => (b.free ? toFlow(b) : toFree(b)),
    }
    if (b.type === 'image') {
      return (
        <Figure {...common} kind="image" aspect={aspects[b.id]} defaultW={Math.min(width, 480)} fit={b.fit}
          below={<input className="pfig-cap" value={b.caption ?? ''} onChange={(e) => patch(b.id, { caption: e.target.value })} placeholder={t('Add a caption')} aria-label={t('Caption')} />}>
          {() => b.src ? <img className="pfig-img" src={b.src} alt={b.caption ?? ''} draggable={false} style={{ objectFit: (b.free ? b.free.h : b.height) != null ? b.fit ?? 'cover' : 'fill' }}
            onLoad={(e) => { const im = e.currentTarget; const a = im.naturalHeight / Math.max(1, im.naturalWidth); if (a && aspects[b.id] !== a) setAspects((x) => ({ ...x, [b.id]: a })) }} /> : null}
        </Figure>
      )
    }
    if (b.type === 'diagram') {
      return (
        <Figure {...common} kind="diagram" defaultW={b.free ? Math.min(colW, 420) : Math.min(width, 520)} defaultH={360} onEdit={() => setGraphEdit(b.id)}>
          {(_, h) => <DiagramFigure src={b.src} cam={b.cam} height={h} onSrc={(src) => patch(b.id, { src })} onCam={(cam) => patch(b.id, { cam })}
            edit={graphEdit === b.id} setEdit={(on) => setGraphEdit(on ? b.id : null)} />}
        </Figure>
      )
    }
    return (
      <Figure {...common} kind="graph" defaultW={b.free ? Math.min(colW, 440) : width} defaultH={340} onEdit={() => setGraphEdit(b.id)}
        extra={<GraphLookMenu look={b.look} onLook={(look) => patch(b.id, { look })} />}>
        {(_, h) => <GraphFigure fns={b.fns} view={b.view} onView={(view) => patch(b.id, { view })} onFns={(fns) => patch(b.id, { fns })} height={h}
          panKey look={b.look} edit={graphEdit === b.id} setEdit={(on) => setGraphEdit(on ? b.id : null)} />}
      </Figure>
    )
  }
  const board = (b: Extract<DocBlock, { type: 'canvas' }>) => (
    <BoardView mode="block" board={{ items: b.items, arrows: b.arrows, strokes: b.strokes }} height={b.height ?? 420}
      onHeight={(height) => patch(b.id, { height })}
      onChange={(c: Board) => patch(b.id, { items: c.items, arrows: c.arrows, strokes: c.strokes })} />
  )

  const tools = inkTool && onInk ? (
    <div className="doc-dock ink-dock" role="toolbar" aria-label={t('Pen')}>
      <button className={'dock-b icon' + (inkTool === 'pen' ? ' on' : '')} aria-pressed={inkTool === 'pen'} onClick={() => setInkTool('pen')} title={t('Pen')} aria-label={t('Pen')}><PenLine size={16} strokeWidth={1.7} /></button>
      <button className={'dock-b icon' + (inkTool === 'eraser' ? ' on' : '')} aria-pressed={inkTool === 'eraser'} onClick={() => setInkTool('eraser')} title={t('Eraser')} aria-label={t('Eraser')}><Eraser size={16} strokeWidth={1.7} /></button>
      <span className="dock-sep" />
      {PAGE_INKS.map((c) => (
        <button key={c} className={'dock-ink' + (inkColor === c ? ' on' : '')} aria-pressed={inkColor === c} aria-label={t('Ink {c}', { c })} title={t('Ink {c}', { c })}
          onClick={() => { setInkColor(c); setInkTool('pen') }}><i style={{ background: `var(--c-${c})` }} /></button>
      ))}
      <button className="dock-ink size" aria-label={t('Pen size')} title={t('Pen size')}
        onClick={() => { setInkSize(PAGE_SIZES_PX[(PAGE_SIZES_PX.indexOf(inkSize as typeof PAGE_SIZES_PX[number]) + 1) % PAGE_SIZES_PX.length]); setInkTool('pen') }}>
        <i style={{ width: inkSize * 2 + 2, height: inkSize * 2 + 2 }} /></button>
      <span className="dock-sep" />
      <button className="dock-b icon" disabled={!undoable} onClick={undoInk} title={t('Undo  Ctrl Z')} aria-label={t('Undo')}><Undo2 size={16} strokeWidth={1.7} /></button>
      <button className="dock-b done" onClick={() => setInkTool(null)} title={t('Done (Esc)')}><Check size={16} strokeWidth={1.8} /><span>{t('Done')}</span></button>
    </div>
  ) : (
    <div className="doc-dock" role="toolbar" aria-label={t('Add to the page')}>
      {kinds.map((a) => (
        <button key={a.type} className={'dock-b' + (placing?.type === a.type ? ' on' : '')} aria-pressed={placing?.type === a.type}
          onPointerDown={dockDown(a.type)} onClick={(e) => { if (e.detail === 0) insert(blocks.length, a.type) }}
          title={t('Click, then click where it goes on the page, or drag it there')}>
          {a.icon}<span>{t(a.label)}</span>
        </button>
      ))}
      {placing && !placing.drag && <span className="dock-note" role="status">{t('Click on the page where it goes · Esc to cancel')}</span>}
      {onInk && <>
        <span className="dock-sep" />
        <button className="dock-b" onClick={() => { setInkTool('pen'); setSel(null); if (editing) endText(editing) }} title={t('Write and draw with the pen anywhere on the page')}>
          <PenLine size={16} strokeWidth={1.7} /><span>{t('Pen')}</span>
        </button>
      </>}
    </div>
  )

  const free = blocks.filter((b) => b.free)
  const freeView = free.map((b) => {
    if (b.type === 'image' || b.type === 'graph' || b.type === 'diagram') return <div key={b.id} data-row={b.id} data-free="" className="free-fig">{figure(b, sheetW)}</div>
    return (
      <FreeBox key={b.id} id={b.id} pos={b.free!} bounds={sheetW} on={editing === b.id || sel === b.id} kind={b.type}
        onPos={(p) => patch(b.id, { free: p })} onLayout={() => toFlow(b)} onDelete={() => drop1(b.id)}
        extra={b.type === 'text' ? <TextStyleMenu style={styleOf(b)} onStyle={(st) => patch(b.id, st as Partial<DocBlock>)} /> : undefined}>
        {b.type === 'text' ? <div className="tstyle" {...styleAttrs(b)}>{textOf(b, false)}</div> : board(b)}
      </FreeBox>
    )
  })

  return (
    <div className="doc" ref={doc} onPaste={async (e) => {
      if ((e.target as HTMLElement).closest('textarea, input, .board')) return
      const f = [...e.clipboardData.files].find((x) => x.type.startsWith('image/'))
      if (f) { e.preventDefault(); insert(blocks.length, 'image', f) }
    }}>
      {lines.map((line, k) => {
        const n = line.auto ? cols : line.items.length
        const sum = line.auto ? cols : line.items.reduce((a, it) => a + (it.b.span ?? 1), 0)
        const avail = colW - GAP * (n - 1)
        const at = line.items[0].i
        return (
          <div key={line.key} className={'doc-line' + (n > 1 ? ' cols' : '') + (drop && 'line' in drop && drop.line === k ? ' drop-here' : '')}>
            <Inserter kinds={kinds} open={adding === at} onOpen={() => setAdding(adding === at ? null : at)} onPick={(x) => insert(at, x)} />
            {line.items.map(({ b }, j) => {
              const width = line.auto ? avail / cols : (avail * (b.span ?? 1)) / sum
              const side = drop && 'side' in drop && drop.id === b.id ? ' drop-' + drop.side : drop && 'swap' in drop && drop.swap === b.id ? ' drop-swap' : ''
              return (
                <Fragment key={b.id}>
                  {j > 0 && line.auto && <span className="col-gap" aria-hidden />}
                  {j > 0 && !line.auto && <span className="col-split" role="separator" aria-orientation="vertical" aria-label={t('Drag to change the column widths')}
                    title={t('Drag to change the column widths (double-click: equal)')} onPointerDown={split(line, j)} onDoubleClick={() => evenOut(line)} />}
                  <div data-cell={b.id} data-row={b.id} style={{ ...(n > 1 ? { flex: `0 0 ${width}px`, width } : null), ...(wraps[b.id]?.push ? { paddingTop: wraps[b.id].push } : null) }}
                    className={'doc-row doc-cell t-' + b.type + (j > 0 ? ' later' : '') + (editing === b.id ? ' editing' : '') + (sel === b.id ? ' selected' : '')
                      + (drop?.from === b.id ? ' lifted' : '') + side}>
                    <div className="doc-gutter" role="group" aria-label={t('Block')}>
                      <button className="icon-btn sm doc-grip" onPointerDown={(e) => grab(b, e)} aria-label={t('Move block (drag, or Up / Down keys)')} title={line.auto ? t('Drag onto another block to swap places') : t('Drag to move: beside another block for columns')}
                        onKeyDown={(e) => { if (e.key === 'ArrowUp') { e.preventDefault(); nudge(b, -1) } else if (e.key === 'ArrowDown') { e.preventDefault(); nudge(b, 1) } }}>
                        <GripVertical size={15} strokeWidth={1.7} /></button>
                      {b.type === 'text' && <TextStyleMenu style={styleOf(b)} onStyle={(st) => patch(b.id, st as Partial<DocBlock>)} />}
                      {(b.type === 'text' || b.type === 'canvas') && (
                        <button className="icon-btn sm" onClick={() => toFree(b)} aria-label={t('Place freely on the page')} title={t('Place freely on the page')}><Move size={14} strokeWidth={1.7} /></button>
                      )}
                      <button className="icon-btn sm" onClick={() => drop1(b.id)} aria-label={t('Delete block')} title={t('Delete block')}><Trash2 size={14} strokeWidth={1.7} /></button>
                    </div>
                    {b.type === 'text' && (
                      <div className="wrap-host" {...styleAttrs(b)}>
                        {wraps[b.id]?.sp?.map((f, q) => <span key={q} className="wrap-sp" aria-hidden style={{ float: f.side, clear: f.clear, width: f.w, height: f.h }} />)}
                        {textOf(b, k === 0 && j === 0)}
                      </div>
                    )}
                    {(b.type === 'graph' || b.type === 'image' || b.type === 'diagram') && figure(b, n > 1 ? width : colW)}
                    {b.type === 'canvas' && board(b)}
                  </div>
                </Fragment>
              )
            })}
          </div>
        )
      })}
      <div className={'paper-tail' + (drop && 'line' in drop && drop.line === lines.length ? ' drop-here' : '')}
        onPointerDown={() => { if (!editing && !sel) wasActive.current = false }}
        onClick={(e) => { if (e.target !== e.currentTarget) return; if (wasActive.current) { wasActive.current = false; return } writeAtEnd() }}>
        <div className="wrap-host">
          {wraps[TAIL]?.sp?.map((f, q) => <span key={q} className="wrap-sp" aria-hidden style={{ float: f.side, clear: f.clear, width: f.w, height: f.h }} />)}
          <p className="paper-hint">{t('Click to write at the end · double-click anywhere on the paper to write there')}</p>
        </div>
      </div>
      {freeLayer ? createPortal(freeView, freeLayer) : null}
      {freeLayer && placing && ghost ? createPortal(
        <div className="place-ghost" aria-hidden style={{ left: ghost.x, top: ghost.y, width: ghost.w, height: PLACE[placing.type]?.[1] ?? 64 }}>
          {ADD.find((a) => a.type === placing.type)?.icon}</div>, freeLayer) : null}
      {freeLayer?.parentElement && onInk ? createPortal(
        <PageInk strokes={ink} onChange={onInk} onBegin={() => { inkPast.current.push(ink); if (inkPast.current.length > 100) inkPast.current.shift(); setUndoable(inkPast.current.length) }}
          tool={inkTool} color={inkColor} size={inkSize} />, freeLayer.parentElement) : null}
      {dock ? createPortal(tools, dock) : tools}
    </div>
  )
}

function Inserter({ kinds, open, onOpen, onPick }: { kinds: typeof ADD; open: boolean; onOpen: () => void; onPick: (t: DocBlock['type']) => void }) {
  return (
    <div className={'doc-ins' + (open ? ' open' : '')}>
      <button className="doc-ins-btn" onClick={onOpen} aria-label={t('Insert a block here')} aria-expanded={open}><Plus size={13} strokeWidth={2} /></button>
      {open && <div className="doc-ins-menu">{kinds.map((a) => <button key={a.type} className="paper-add-b" onClick={() => onPick(a.type)}>{a.icon}<span>{t(a.label)}</span></button>)}</div>}
    </div>
  )
}

function pick(): Promise<File | null> {
  return new Promise((res) => {
    const inp = document.createElement('input')
    inp.type = 'file'; inp.accept = 'image/png,image/jpeg,image/gif,image/webp'
    inp.onchange = () => res(inp.files?.[0] ?? null)
    inp.click()
  })
}
