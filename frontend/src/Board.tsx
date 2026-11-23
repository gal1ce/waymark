import { t as tr } from './i18n'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  ChartSpline, Copy, Eraser, GripHorizontal, Pencil, Hand, ImagePlus, MousePointer2, MoveUpRight, PenLine, Redo2, Trash2, Type, Undo2, WandSparkles,
} from 'lucide-react'
import { strokePath } from './ink'
import { api, type Arrow, type Board, type CanvasItem, type End, type Stroke } from './api'
import { joins, morph, morphAt, read, redraw, type Morph } from './tidy'
import { classify, warm } from './inkmodel'
import { GraphFigure, STARTER } from './Graph'
import { zoomOf } from './page'
import { MdEditor, NoteMd } from './NoteMd'

export type Tool = 'select' | 'hand' | 'text' | 'graph' | 'image' | 'arrow' | 'pen' | 'eraser'
type Cam = { x: number; y: number; z: number }
type Pt = { x: number; y: number }

export const INKS = ['ink', 'blue', 'red', 'green', 'amber', 'purple'] as const
export const TONES = ['sheet', 'blue', 'amber', 'green', 'rose', 'clear'] as const
const SIZES = [2, 4, 8]
const ink = (c?: string) => `var(--c-${c && (INKS as readonly string[]).includes(c) ? c : 'ink'})`
const uid = () => Math.random().toString(36).slice(2, 10)
const EMPTY: Board = { items: [], arrows: [], strokes: [] }

const segDist = (p: Pt, a: Pt, b: Pt) => {
  const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy
  const t = l ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/** Where a line from `from` towards the centre of rect `r` crosses the rect's edge (plus a small gap). */
function clip(r: { x: number; y: number; w: number; h: number }, from: Pt, gap = 8): Pt {
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2
  const dx = from.x - cx, dy = from.y - cy
  if (!dx && !dy) return { x: cx, y: cy }
  const tx = dx ? (r.w / 2 + gap) / Math.abs(dx) : Infinity, ty = dy ? (r.h / 2 + gap) / Math.abs(dy) : Infinity
  const t = Math.min(tx, ty, 1)
  return { x: cx + dx * t, y: cy + dy * t }
}

export type Geo = { a: Pt; b: Pt; c: Pt; mid: Pt; d: string }

/** The curve of an arrow: quadratic, bent sideways by `bend` × its length; ends clipped at the cards they join. */
export function arrowGeo(ar: Arrow, rect: (id: string) => { x: number; y: number; w: number; h: number } | null): Geo | null {
  const centre = (e: End): Pt | null => {
    if ('item' in e) { const r = rect(e.item); return r ? { x: r.x + r.w / 2, y: r.y + r.h / 2 } : null }
    return { x: e.x, y: e.y }
  }
  const ca = centre(ar.from), cb = centre(ar.to)
  if (!ca || !cb) return null
  const bend = ar.bend ?? 0.12
  const len = Math.hypot(cb.x - ca.x, cb.y - ca.y) || 1
  const nx = -(cb.y - ca.y) / len, ny = (cb.x - ca.x) / len
  const ctl = { x: (ca.x + cb.x) / 2 + nx * bend * len, y: (ca.y + cb.y) / 2 + ny * bend * len }
  const a = 'item' in ar.from ? clip(rect(ar.from.item)!, ctl) : ca
  const b = 'item' in ar.to ? clip(rect(ar.to.item)!, ctl, 10) : cb
  // the control point moves with the clipped ends so the bend stays the same shape
  const L = Math.hypot(b.x - a.x, b.y - a.y) || 1
  const c = { x: (a.x + b.x) / 2 - ((b.y - a.y) / L) * bend * L, y: (a.y + b.y) / 2 + ((b.x - a.x) / L) * bend * L }
  const mid = { x: 0.25 * a.x + 0.5 * c.x + 0.25 * b.x, y: 0.25 * a.y + 0.5 * c.y + 0.25 * b.y }
  return { a, b, c, mid, d: `M${a.x.toFixed(1)} ${a.y.toFixed(1)}Q${c.x.toFixed(1)} ${c.y.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}` }
}

type Drag =
  | { k: 'pan'; sx: number; sy: number; cam: Cam }
  | { k: 'move'; sx: number; sy: number; start: Board; ids: string[]; moved: boolean }
  | { k: 'resize'; sx: number; sy: number; start: Board; id: string; w: number; h: number }
  | { k: 'pen'; pts: number[] }
  | { k: 'erase'; start: Board; hit: boolean }
  | { k: 'arrow'; from: End; to: Pt }
  | { k: 'bend'; start: Board; id: string }
  | { k: 'marquee'; a: Pt; b: Pt }

/** An editable board: cards of text (Markdown + LaTeX), graphs and images, freehand ink, and arrows that stay
 *  attached to the cards they join. `page` fills its parent, `block` sits inside a document at a fixed height,
 *  `scratch` is ink only (practice scratch paper). */
export default function BoardView({ board, onChange, mode, height, onHeight, toolbar = true }: {
  board: Board; onChange: (b: Board) => void; mode: 'page' | 'block' | 'scratch'; height?: number; onHeight?: (h: number) => void; toolbar?: boolean
}) {
  const box = useRef<HTMLDivElement>(null)
  const [b, setB] = useState<Board>(board ?? EMPTY)
  const latest = useRef(b)   // the board as it is now, for work that finishes later (tidying)
  latest.current = b
  const [cam, setCam] = useState<Cam>({ x: 0, y: 0, z: 1 })
  const [tool, setTool] = useState<Tool>(mode === 'scratch' ? 'pen' : 'select')
  const [sel, setSel] = useState<string[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [labelEdit, setLabelEdit] = useState<string | null>(null)
  const [graphEdit, setGraphEdit] = useState<string | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [penColor, setPenColor] = useState<string>('ink')
  const [penSize, setPenSize] = useState(4)
  // tidy handwriting (tidy.ts): each digit or sign is redrawn neatly the moment the pen lifts; one undo brings the ink back
  const [tidy, setTidy] = useState(() => { try { return localStorage.getItem('ctu.ink.tidy') !== 'off' } catch { return true } })
  const toggleTidy = () => setTidy((on) => { try { localStorage.setItem('ctu.ink.tidy', on ? 'off' : 'on') } catch { /* only a preference */ } return !on })
  /** the character written last: its raw strokes, the strokes standing for it now, and when (a 7 may still get its bar) */
  const lastChar = useRef<{ raw: Stroke[]; out: string[]; at: number } | null>(null)
  useEffect(() => { if (tidy && tool === 'pen') warm() }, [tidy, tool])   // the reading models load in the background
  /** the ink flowing from what was written into its neat form (a fifth of a second); the neat strokes wait hidden */
  const [flow, setFlow] = useState<{ m: Morph; hide: Set<string>; t: number } | null>(null)
  const play = (m: Morph, hide: string[]) => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const t0 = performance.now(), ids = new Set(hide)
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / 200)
      if (k >= 1) { setFlow(null); return }
      setFlow({ m, hide: ids, t: 1 - (1 - k) ** 3 })
      requestAnimationFrame(step)
    }
    setFlow({ m, hide: ids, t: 0 })
    requestAnimationFrame(step)
  }
  const [space, setSpace] = useState(false)
  const [, bump] = useState(0)
  const past = useRef<Board[]>([]), future = useRef<Board[]>([])
  const sizes = useRef(new Map<string, { w: number; h: number }>())
  const fitted = useRef(false)
  const editStart = useRef<{ before: Board; fresh: boolean } | null>(null)
  const erased = useRef(false)

  // outside changes (another block saved, page reloaded) replace the working copy when nothing is in hand
  useEffect(() => { if (!drag && !editing) setB(board ?? EMPTY) }, [board]) // eslint-disable-line react-hooks/exhaustive-deps

  // first view: the content fitted in, never zoomed past 100 % (runs once: `fitted` guards it)
  useLayoutEffect(() => {
    if (fitted.current || !box.current) return
    fitted.current = true
    const el = box.current, W = el.clientWidth, H = el.clientHeight
    const items = b.items
    const xs = [...items.flatMap((i) => [i.x, i.x + i.w]), ...b.strokes.flatMap((s) => s.pts.filter((_, k) => k % 2 === 0))]
    const ys = [...items.flatMap((i) => [i.y, i.y + i.h]), ...b.strokes.flatMap((s) => s.pts.filter((_, k) => k % 2 === 1))]
    if (!xs.length) { setCam({ x: W / 2 - 160, y: Math.min(120, H / 3), z: 1 }); return }
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys)
    const z = Math.min(1, (W - 80) / Math.max(1, x1 - x0), (H - 80) / Math.max(1, y1 - y0))
    setCam({ z, x: W / 2 - ((x0 + x1) / 2) * z, y: H / 2 - ((y0 + y1) / 2) * z })
  })

  const startEdit = (id: string, fresh = false, before: Board = b) => { editStart.current = { before, fresh }; setEditing(id) }
  const endEdit = () => {
    const id = editing
    const st = editStart.current
    setEditing(null); editStart.current = null
    if (!id) return
    const cur = b.items.find((i) => i.id === id)
    if (cur?.type === 'text' && !cur.md.trim()) {
      // an empty card leaves no trace: a new one is undone, an emptied one is removed
      if (st?.fresh) { const prev = past.current.pop() ?? { ...b, items: b.items.filter((i) => i.id !== id) }; setB(prev); onChange(prev) }
      else commit({ ...b, items: b.items.filter((i) => i.id !== id), arrows: b.arrows.filter((a) => !('item' in a.from && a.from.item === id) && !('item' in a.to && a.to.item === id)) }, st?.before)
      setSel([])
      return
    }
    if (st && JSON.stringify(st.before.items.find((i) => i.id === id)) !== JSON.stringify(cur)) {
      if (st.fresh) onChange(b)   // the creation is already in the history; the text rides along with it
      else commit(b, st.before)
    }
  }
  const commit = useCallback((next: Board, before: Board = b) => {
    past.current.push(before)
    if (past.current.length > 120) past.current.shift()
    future.current = []
    latest.current = next
    setB(next)
    onChange(next)
  }, [b, onChange])
  const undo = () => { const p = past.current.pop(); if (!p) return; future.current.push(b); setB(p); onChange(p); setSel([]) }
  const redo = () => { const n = future.current.pop(); if (!n) return; past.current.push(b); setB(n); onChange(n) }

  const toWorld = (cx: number, cy: number): Pt => {
    // a board inside a page is scaled with the sheet: screen pixels → the board's own pixels first
    const r = box.current!.getBoundingClientRect(), k = zoomOf(box.current)
    return { x: ((cx - r.left) / k - cam.x) / cam.z, y: ((cy - r.top) / k - cam.y) / cam.z }
  }
  const rect = useCallback((id: string) => {
    const it = b.items.find((i) => i.id === id)
    if (!it) return null
    const s = sizes.current.get(id)
    return { x: it.x, y: it.y, w: s?.w ?? it.w, h: s?.h ?? it.h }
  }, [b.items])
  const itemAt = (cx: number, cy: number): string | null => {
    for (const el of document.elementsFromPoint(cx, cy)) {
      const id = (el as HTMLElement).closest?.('[data-item]')?.getAttribute('data-item')
      if (id && box.current?.contains(el)) return id
    }
    return null
  }

  const add = (it: CanvasItem) => { commit({ ...b, items: [...b.items, it] }); setSel([it.id]); setTool('select') }
  const viewCentre = (): Pt => { const el = box.current!; const r = el.getBoundingClientRect(); return toWorld(r.left + el.clientWidth / 2, r.top + el.clientHeight / 2) }
  const addImage = async (file: File, at?: Pt) => {
    const src = await api.notesUpload(file).catch((e) => { window.dispatchEvent(new CustomEvent('ctu:notify', { detail: { text: tr("The picture wasn't added: {e}", { e: e.message }), tone: 'err' } })); return null })
    if (!src) return
    const img = new Image()
    img.onload = () => {
      const w = Math.min(420, img.naturalWidth), h = Math.round((w * img.naturalHeight) / Math.max(1, img.naturalWidth))
      const p = at ?? viewCentre()
      add({ id: uid(), type: 'image', src, x: Math.round(p.x - w / 2), y: Math.round(p.y - h / 2), w, h })
    }
    img.src = src
  }
  const pickImage = (at?: Pt) => {
    const inp = document.createElement('input')
    inp.type = 'file'; inp.accept = 'image/png,image/jpeg,image/gif,image/webp'
    inp.onchange = () => { const f = inp.files?.[0]; if (f) addImage(f, at) }
    inp.click()
  }
  const remove = (ids: string[]) => {
    if (!ids.length) return
    const set = new Set(ids)
    commit({
      items: b.items.filter((i) => !set.has(i.id)),
      arrows: b.arrows.filter((a) => !set.has(a.id) && !('item' in a.from && set.has(a.from.item)) && !('item' in a.to && set.has(a.to.item))),
      strokes: b.strokes,
    })
    setSel([])
  }
  const duplicate = (ids: string[]) => {
    const copies = b.items.filter((i) => ids.includes(i.id)).map((i) => ({ ...i, id: uid(), x: i.x + 24, y: i.y + 24 }) as CanvasItem)
    if (!copies.length) return
    commit({ ...b, items: [...b.items, ...copies] })
    setSel(copies.map((c) => c.id))
  }
  const patchItem = (id: string, p: Partial<CanvasItem>, record = true) => {
    const next = { ...b, items: b.items.map((i) => (i.id === id ? ({ ...i, ...p } as CanvasItem) : i)) }
    if (record) commit(next); else setB(next)
  }
  const patchArrow = (id: string, p: Partial<Arrow>) => commit({ ...b, arrows: b.arrows.map((a) => (a.id === id ? { ...a, ...p } : a)) })

  // keyboard: tools, delete, undo / redo, duplicate, nudge, space to pan
  const onKey = (e: React.KeyboardEvent) => {
    if (editing || labelEdit) return
    const t = e.target as HTMLElement
    if (t.closest('input, textarea')) return
    const mod = e.ctrlKey || e.metaKey
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return }
    if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicate(sel); return }
    if (mod || e.altKey) return
    if (e.key === ' ') { e.preventDefault(); setSpace(true); return }
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel.length) { e.preventDefault(); remove(sel); return }
    if (e.key === 'Escape') { setSel([]); setTool(mode === 'scratch' ? 'pen' : 'select'); return }
    if (e.key === 'Enter' && sel.length === 1 && b.items.find((i) => i.id === sel[0])?.type === 'text') { e.preventDefault(); startEdit(sel[0]); return }
    if (e.key.startsWith('Arrow') && sel.length) {
      e.preventDefault()
      const d = e.shiftKey ? 16 : 2, dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0, dy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0
      commit({ ...b, items: b.items.map((i) => (sel.includes(i.id) ? { ...i, x: i.x + dx, y: i.y + dy } : i)) })
      return
    }
    const keys: Record<string, Tool> = mode === 'scratch'
      ? { h: 'hand', p: 'pen', e: 'eraser' }
      : { v: 'select', h: 'hand', t: 'text', g: 'graph', i: 'image', a: 'arrow', p: 'pen', e: 'eraser' }
    const k = keys[e.key.toLowerCase()]
    if (k) { e.preventDefault(); if (k === 'image') pickImage(); else setTool(k) }
  }

  // wheel: a page or scratch board pans and Ctrl-zooms; a block inside a document only zooms with Ctrl
  useEffect(() => {
    const el = box.current
    if (!el) return
    const wheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest('.gplot:focus-within, .md-ed, .gfns')) return
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const r = el.getBoundingClientRect(), k = zoomOf(el), px = (e.clientX - r.left) / k, py = (e.clientY - r.top) / k
        setCam((c) => {
          const z = Math.min(3, Math.max(0.2, c.z * Math.exp(-e.deltaY * 0.0018)))
          return { z, x: px - ((px - c.x) / c.z) * z, y: py - ((py - c.y) / c.z) * z }
        })
      } else if (mode !== 'block') {
        e.preventDefault()
        setCam((c) => ({ ...c, x: c.x - e.deltaX, y: c.y - e.deltaY }))
      }
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [mode])

  const down = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return
    const target = e.target as HTMLElement
    if (target.closest('.md-ed, .board-tools, .sel-tools, .arrow-label-ed, .gfig-btn')) return
    box.current?.focus({ preventScroll: true })
    const p = toWorld(e.clientX, e.clientY)
    const pan = e.button === 1 || space || tool === 'hand'
    if (labelEdit) setLabelEdit(null)
    if (editing && !target.closest(`[data-item="${editing}"]`)) endEdit()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    if (pan) { setDrag({ k: 'pan', sx: e.clientX, sy: e.clientY, cam }); return }
    if (tool === 'pen') { setDrag({ k: 'pen', pts: [Math.round(p.x * 2) / 2, Math.round(p.y * 2) / 2] }); return }
    if (tool === 'eraser') { erased.current = false; setDrag({ k: 'erase', start: b, hit: false }); erase(p); return }
    if (tool === 'arrow') {
      const id = itemAt(e.clientX, e.clientY)
      setDrag({ k: 'arrow', from: id ? { item: id } : { x: p.x, y: p.y }, to: p })
      return
    }
    if (tool === 'text') {
      const it: CanvasItem = { id: uid(), type: 'text', md: '', x: Math.round(p.x), y: Math.round(p.y - 20), w: 260, h: 60, tone: 'sheet' }
      commit({ ...b, items: [...b.items, it] }); setSel([it.id]); startEdit(it.id, true); setTool('select')
      return
    }
    if (tool === 'graph') { add({ id: uid(), type: 'graph', fns: STARTER, x: Math.round(p.x - 320), y: Math.round(p.y - 170), w: 640, h: 320 }); return }
    if (tool === 'image') { pickImage(p); setTool('select'); return }
    // select tool
    if (target.closest('.rs-handle')) {
      const id = target.closest('[data-item]')!.getAttribute('data-item')!
      const r = rect(id)!
      setDrag({ k: 'resize', sx: e.clientX, sy: e.clientY, start: b, id, w: r.w, h: r.h })
      return
    }
    if (target.closest('.bend-handle')) { setDrag({ k: 'bend', start: b, id: target.closest('[data-arrow]')!.getAttribute('data-arrow')! }); return }
    const arrowId = target.closest('[data-arrow]')?.getAttribute('data-arrow')
    if (arrowId) { setSel(e.shiftKey ? [...sel, arrowId] : [arrowId]); return }
    const id = target.closest('[data-item]')?.getAttribute('data-item')
    if (id) {
      if (editing === id) return
      const ids = sel.includes(id) ? sel : e.shiftKey ? [...sel, id] : [id]
      setSel(ids)
      // every card, graphs included, moves by dragging it anywhere; a graph's formulas open in their own window
      setDrag({ k: 'move', sx: e.clientX, sy: e.clientY, start: b, ids, moved: false })
      return
    }
    setSel([])
    if (mode === 'block') setDrag({ k: 'pan', sx: e.clientX, sy: e.clientY, cam })
    else setDrag({ k: 'marquee', a: p, b: p })
  }

  const erase = (p: Pt) => {
    const r = 10 / cam.z
    setB((cur) => {
      const strokes = cur.strokes.filter((s) => {
        for (let i = 0; i + 3 < s.pts.length; i += 2) if (segDist(p, { x: s.pts[i], y: s.pts[i + 1] }, { x: s.pts[i + 2], y: s.pts[i + 3] }) < r + s.size) return false
        return !(s.pts.length === 2 && Math.hypot(p.x - s.pts[0], p.y - s.pts[1]) < r + s.size)
      })
      const arrows = cur.arrows.filter((a) => {
        const g = arrowGeo(a, rect)
        if (!g) return true
        for (let t = 0; t < 1; t += 0.05) {
          const q = (u: number) => ({ x: (1 - u) ** 2 * g.a.x + 2 * (1 - u) * u * g.c.x + u * u * g.b.x, y: (1 - u) ** 2 * g.a.y + 2 * (1 - u) * u * g.c.y + u * u * g.b.y })
          if (segDist(p, q(t), q(t + 0.05)) < r) return false
        }
        return true
      })
      if (strokes.length === cur.strokes.length && arrows.length === cur.arrows.length) return cur
      erased.current = true
      return { ...cur, strokes, arrows }
    })
  }

  const move = (e: React.PointerEvent) => {
    if (!drag) return
    const p = toWorld(e.clientX, e.clientY)
    switch (drag.k) {
      case 'pan': { const k = zoomOf(box.current); setCam({ ...drag.cam, x: drag.cam.x + (e.clientX - drag.sx) / k, y: drag.cam.y + (e.clientY - drag.sy) / k }); break }
      case 'pen': {
        const x = Math.round(p.x * 2) / 2, y = Math.round(p.y * 2) / 2
        setDrag((d) => {
          if (!d || d.k !== 'pen') return d
          const n = d.pts.length
          return Math.hypot(x - d.pts[n - 2], y - d.pts[n - 1]) > 1.5 / cam.z ? { ...d, pts: [...d.pts, x, y] } : d
        })
        break
      }
      case 'erase': erase(p); break
      case 'arrow': setDrag({ ...drag, to: p }); break
      case 'marquee': setDrag({ ...drag, b: p }); break
      case 'move': {
        const k = zoomOf(box.current), dx = (e.clientX - drag.sx) / k / cam.z, dy = (e.clientY - drag.sy) / k / cam.z
        if (!drag.moved && Math.hypot(dx, dy) * cam.z < 3) return
        setB({ ...drag.start, items: drag.start.items.map((i) => (drag.ids.includes(i.id) ? { ...i, x: Math.round(i.x + dx), y: Math.round(i.y + dy) } : i)) })
        if (!drag.moved) setDrag({ ...drag, moved: true })
        break
      }
      case 'resize': {
        const it = drag.start.items.find((i) => i.id === drag.id)!
        const k = zoomOf(box.current)
        let w = Math.max(120, drag.w + (e.clientX - drag.sx) / k / cam.z), h = Math.max(48, drag.h + (e.clientY - drag.sy) / k / cam.z)
        if (it.type === 'image' && !e.shiftKey) h = (w * it.h) / it.w
        setB({ ...drag.start, items: drag.start.items.map((i) => (i.id === drag.id ? { ...i, w: Math.round(w), h: it.type === 'text' ? i.h : Math.round(h) } : i)) })
        break
      }
      case 'bend': {
        const a = drag.start.arrows.find((x) => x.id === drag.id)!
        const g = arrowGeo({ ...a, bend: 0 }, rect)
        if (!g) return
        const L = Math.hypot(g.b.x - g.a.x, g.b.y - g.a.y) || 1
        const nx = -(g.b.y - g.a.y) / L, ny = (g.b.x - g.a.x) / L
        const m = { x: (g.a.x + g.b.x) / 2, y: (g.a.y + g.b.y) / 2 }
        // the handle sits at the curve's middle, which is half-way to the control point
        const bend = Math.max(-0.8, Math.min(0.8, (((p.x - m.x) * nx + (p.y - m.y) * ny) * 2) / L))
        setB({ ...drag.start, arrows: drag.start.arrows.map((x) => (x.id === drag.id ? { ...x, bend: Math.abs(bend) < 0.03 ? 0 : +bend.toFixed(3) } : x)) })
        break
      }
    }
  }

  /** after the pen lifts: the new stroke, alone or with the character just before it, redrawn neatly if it is clearly a
   *  digit or sign. Its own history step, so Ctrl Z gives the ink back exactly as written. */
  // characters are read one after another (the models answer asynchronously), against the board as it is by then
  const tidyQueue = useRef<Promise<void>>(Promise.resolve())
  const tidyStroke = (s: Stroke) => { tidyQueue.current = tidyQueue.current.then(() => tidyOne(s)).catch(() => { /* the ink stays as written */ }) }
  const tidyOne = async (s: Stroke) => {
    const prev = lastChar.current, now = () => new Set(latest.current.strokes.map((x) => x.id))
    let raw = [s], drop = [s.id], r = null
    if (prev && Date.now() - prev.at < 4000 && prev.raw.length < 3 && prev.raw[0].color === s.color
      && prev.out.every((id) => now().has(id)) && joins(prev.raw, s)) {
      const both = await read([...prev.raw, s], classify)
      if (both) { raw = [...prev.raw, s]; drop = [...prev.out, s.id]; r = both }
    }
    r ??= await read([s], classify)
    const cur = latest.current, have = now()
    if (!drop.every((id) => have.has(id))) return              // rubbed out or undone while it was being read
    if (!r) { lastChar.current = { raw: [s], out: [s.id], at: Date.now() }; return }
    const neat = redraw(raw, r), gone = new Set(drop)
    commit({ ...cur, strokes: [...cur.strokes.filter((x) => !gone.has(x.id)), ...neat] }, cur)
    play(morph(raw, neat), neat.map((x) => x.id))
    lastChar.current = { raw, out: neat.map((x) => x.id), at: Date.now() }
  }
  const up = (e: React.PointerEvent) => {
    if (!drag) return
    const d = drag
    setDrag(null)
    switch (d.k) {
      case 'pen': {
        const s: Stroke = { id: uid(), pts: d.pts, color: penColor, size: penSize }
        const drawn = { ...b, strokes: [...b.strokes, s] }
        commit(drawn)
        if (tidy) tidyStroke(s)
        break
      }
      case 'erase': if (erased.current) commit(b, d.start); break
      case 'move': if (d.moved) commit(b, d.start); break
      case 'resize': case 'bend': commit(b, d.start); break
      case 'arrow': {
        const id = itemAt(e.clientX, e.clientY)
        const to: End = id ? { item: id } : { x: d.to.x, y: d.to.y }
        const same = 'item' in d.from && 'item' in to && d.from.item === to.item
        const short = !('item' in d.from) && !('item' in to) && Math.hypot(d.to.x - d.from.x, d.to.y - d.from.y) < 12
        if (!same && !short) {
          const ar: Arrow = { id: uid(), from: d.from, to, color: 'ink' }
          commit({ ...b, arrows: [...b.arrows, ar] })
          setSel([ar.id])
        }
        setTool('select')
        break
      }
      case 'marquee': {
        const x0 = Math.min(d.a.x, d.b.x), x1 = Math.max(d.a.x, d.b.x), y0 = Math.min(d.a.y, d.b.y), y1 = Math.max(d.a.y, d.b.y)
        if (x1 - x0 > 4 || y1 - y0 > 4) setSel(b.items.filter((i) => { const r = rect(i.id)!; return r.x < x1 && r.x + r.w > x0 && r.y < y1 && r.y + r.h > y0 }).map((i) => i.id))
        break
      }
    }
  }

  const onPaste = (e: React.ClipboardEvent) => {
    if (editing || (e.target as HTMLElement).closest('input, textarea')) return
    const f = [...e.clipboardData.files].find((x) => x.type.startsWith('image/'))
    if (f && mode !== 'scratch') { e.preventDefault(); addImage(f); return }
    const t = e.clipboardData.getData('text/plain')
    if (t && mode !== 'scratch') {
      e.preventDefault()
      const p = viewCentre()
      add({ id: uid(), type: 'text', md: t, x: Math.round(p.x - 140), y: Math.round(p.y - 30), w: 280, h: 60, tone: 'sheet' })
    }
  }

  const geos = new Map(b.arrows.map((a) => [a.id, arrowGeo(a, rect)]))
  const one = sel.length === 1 ? sel[0] : null
  const selItem = one ? b.items.find((i) => i.id === one) : undefined
  const selArrow = one ? b.arrows.find((a) => a.id === one) : undefined
  const preview = drag?.k === 'arrow' ? arrowGeo({ id: '_', from: drag.from, to: { x: drag.to.x, y: drag.to.y }, bend: 0.12 }, rect) : null

  const tools: { t: Tool; icon: ReactNode; label: string; key: string }[] = mode === 'scratch'
    ? [{ t: 'pen', icon: <PenLine size={17} strokeWidth={1.7} />, label: tr('Pen'), key: 'P' },
      { t: 'eraser', icon: <Eraser size={17} strokeWidth={1.7} />, label: tr('Eraser'), key: 'E' },
      { t: 'hand', icon: <Hand size={17} strokeWidth={1.7} />, label: tr('Move the paper'), key: 'H' }]
    : [{ t: 'select', icon: <MousePointer2 size={17} strokeWidth={1.7} />, label: tr('Select and move'), key: 'V' },
      { t: 'hand', icon: <Hand size={17} strokeWidth={1.7} />, label: tr('Move the board'), key: 'H' },
      { t: 'text', icon: <Type size={17} strokeWidth={1.7} />, label: tr('Text card (Markdown + LaTeX)'), key: 'T' },
      { t: 'graph', icon: <ChartSpline size={17} strokeWidth={1.7} />, label: tr('Graph'), key: 'G' },
      { t: 'image', icon: <ImagePlus size={17} strokeWidth={1.7} />, label: tr('Image (or paste one)'), key: 'I' },
      { t: 'arrow', icon: <MoveUpRight size={17} strokeWidth={1.7} />, label: tr('Arrow: drag from one card to another'), key: 'A' },
      { t: 'pen', icon: <PenLine size={17} strokeWidth={1.7} />, label: tr('Pen'), key: 'P' },
      { t: 'eraser', icon: <Eraser size={17} strokeWidth={1.7} />, label: tr('Eraser (ink and arrows)'), key: 'E' }]

  const cursor = drag?.k === 'pan' ? 'grabbing' : space || tool === 'hand' ? 'grab' : tool === 'pen' ? 'crosshair' : tool === 'eraser' ? 'cell'
    : tool === 'text' ? 'text' : tool === 'arrow' || tool === 'graph' ? 'crosshair' : 'default'

  return (
    <div className={`board b-${mode}`} ref={box} tabIndex={0} style={{ height: mode === 'block' ? height ?? 420 : undefined, cursor,
      backgroundPosition: `${cam.x}px ${cam.y}px`, backgroundSize: `${24 * cam.z}px ${24 * cam.z}px` }}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      onKeyDown={onKey} onKeyUp={(e) => { if (e.key === ' ') setSpace(false) }} onPaste={onPaste}
      onDoubleClick={(e) => {
        if (mode === 'scratch' || tool !== 'select') return
        const t = e.target as HTMLElement
        const aid = t.closest('[data-arrow]')?.getAttribute('data-arrow')
        if (aid) { setLabelEdit(aid); return }
        const id = t.closest('[data-item]')?.getAttribute('data-item')
        if (id) { const k = b.items.find((i) => i.id === id)?.type; if (k === 'text') startEdit(id); else if (k === 'graph') setGraphEdit(id); return }
        const p = toWorld(e.clientX, e.clientY)
        const it: CanvasItem = { id: uid(), type: 'text', md: '', x: Math.round(p.x - 20), y: Math.round(p.y - 20), w: 260, h: 60, tone: 'sheet' }
        commit({ ...b, items: [...b.items, it] }); setSel([it.id]); startEdit(it.id, true)
      }}
      onDragOver={(e) => { if (mode !== 'scratch') e.preventDefault() }}
      onDrop={(e) => {
        const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/'))
        if (!f || mode === 'scratch') return
        e.preventDefault(); addImage(f, toWorld(e.clientX, e.clientY))
      }}>
      <div className="world" style={{ transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})` }}>
        <svg className="ink-layer" aria-hidden>
          <defs>
            {INKS.map((c) => (
              <marker key={c} id={`ah-${c}`} viewBox="0 0 12 12" refX="10" refY="6" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
                <path d="M1.5 1.5 L10.5 6 L1.5 10.5 Q4 6 1.5 1.5 Z" style={{ fill: ink(c) }} />
              </marker>
            ))}
          </defs>
          {b.strokes.map((s) => <path key={s.id} d={strokePath(s.pts, s.size)} style={{ fill: ink(s.color), opacity: flow?.hide.has(s.id) ? 0 : undefined }} />)}
          {flow && morphAt(flow.m, flow.t).map((s, i) => <path key={'flow' + i} d={strokePath(s.pts, s.size)} style={{ fill: ink(s.color) }} />)}
          {drag?.k === 'pen' && <path d={strokePath(drag.pts, penSize)} style={{ fill: ink(penColor) }} />}
          {b.arrows.map((a) => {
            const g = geos.get(a.id)
            if (!g) return null
            const on = sel.includes(a.id)
            return (
              <g key={a.id} data-arrow={a.id} className={'arrow' + (on ? ' on' : '')}>
                <path d={g.d} className="arrow-hit" />
                <path d={g.d} className="arrow-line" style={{ stroke: ink(a.color) }} markerEnd={`url(#ah-${a.color ?? 'ink'})`} />
                {on && one === a.id && tool === 'select' && <circle className="bend-handle" cx={g.mid.x} cy={g.mid.y} r={6 / cam.z} />}
              </g>
            )
          })}
          {preview && <path d={preview.d} className="arrow-line preview" markerEnd="url(#ah-blue)" style={{ stroke: ink('blue') }} />}
          {drag?.k === 'marquee' && (
            <rect className="marquee" x={Math.min(drag.a.x, drag.b.x)} y={Math.min(drag.a.y, drag.b.y)} width={Math.abs(drag.b.x - drag.a.x)} height={Math.abs(drag.b.y - drag.a.y)} />
          )}
        </svg>

        {b.arrows.map((a) => {
          const g = geos.get(a.id)
          if (!g || (!a.label && labelEdit !== a.id)) return null
          return labelEdit === a.id ? (
            <input key={a.id} className="arrow-label-ed" autoFocus defaultValue={a.label ?? ''} style={{ left: g.mid.x, top: g.mid.y }}
              onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur() }}
              onBlur={(e) => { const v = e.target.value.trim(); if (v !== (a.label ?? '')) patchArrow(a.id, { label: v || undefined }); setLabelEdit(null) }} />
          ) : <div key={a.id} className="arrow-label" data-arrow={a.id} style={{ left: g.mid.x, top: g.mid.y }}>{a.label}</div>
        })}

        {b.items.map((it) => (
          <Item key={it.id} it={it} graphEdit={graphEdit === it.id} setGraphEdit={(on) => setGraphEdit(on ? it.id : null)} on={sel.includes(it.id)} solo={one === it.id} editing={editing === it.id} z={cam.z} tool={tool}
            onSize={(w, h) => { const s = sizes.current.get(it.id); if (!s || s.w !== w || s.h !== h) { sizes.current.set(it.id, { w, h }); bump((x) => x + 1) } }}
            onText={(md) => patchItem(it.id, { md } as Partial<CanvasItem>, false)}
            onEndEdit={endEdit}
            onFns={(fns) => patchItem(it.id, { fns } as Partial<CanvasItem>)}
            onView={(view) => patchItem(it.id, { view } as Partial<CanvasItem>)} />
        ))}

        {one && selItem && !editing && tool === 'select' && !drag && (
          <div className="sel-tools" style={{ left: selItem.x, top: selItem.y, transform: `translateY(-100%) scale(${1 / cam.z})`, transformOrigin: '0 100%' }}>
            {selItem.type === 'text' && TONES.map((t) => (
              <button key={t} className={'tone-sw ' + t + ((selItem.tone ?? 'sheet') === t ? ' on' : '')} aria-label={tr('Card colour {c}', { c: t })} title={t}
                onClick={() => patchItem(selItem.id, { tone: t } as Partial<CanvasItem>)} />
            ))}
            {selItem.type === 'graph' && <button className="btn ghost sm" onClick={() => setGraphEdit(selItem.id)}><Pencil size={13} strokeWidth={1.8} />{tr('Edit graph')}</button>}
            <button className="icon-btn sm" title={tr('Duplicate  Ctrl D')} aria-label={tr('Duplicate')} onClick={() => duplicate([selItem.id])}><Copy size={14} strokeWidth={1.7} /></button>
            <button className="icon-btn sm" title={tr('Delete')} aria-label={tr('Delete')} onClick={() => remove([selItem.id])}><Trash2 size={14} strokeWidth={1.7} /></button>
          </div>
        )}
        {one && selArrow && tool === 'select' && !drag && geos.get(selArrow.id) && (
          <div className="sel-tools" style={{ left: geos.get(selArrow.id)!.mid.x, top: geos.get(selArrow.id)!.mid.y - 18 / cam.z, transform: `translate(-50%, -100%) scale(${1 / cam.z})`, transformOrigin: '50% 100%' }}>
            {INKS.map((c) => (
              <button key={c} className={'ink-sw' + ((selArrow.color ?? 'ink') === c ? ' on' : '')} style={{ background: ink(c) }} aria-label={tr('Arrow colour {c}', { c })}
                onClick={() => patchArrow(selArrow.id, { color: c })} />
            ))}
            <button className="btn ghost sm" onClick={() => setLabelEdit(selArrow.id)}>{tr('Label')}</button>
            <button className="btn ghost sm" onClick={() => patchArrow(selArrow.id, { bend: (selArrow.bend ?? 0.12) ? 0 : 0.12 })}>{(selArrow.bend ?? 0.12) ? tr('Straight') : tr('Curved')}</button>
            <button className="icon-btn sm" title={tr('Delete')} aria-label={tr('Delete arrow')} onClick={() => remove([selArrow.id])}><Trash2 size={14} strokeWidth={1.7} /></button>
          </div>
        )}
      </div>

      {b.items.length === 0 && b.strokes.length === 0 && mode !== 'scratch' && (
        <div className="board-empty">
          {mode === 'block' ? tr('Double-click for a text card · T text · G graph · A arrow · P pen') : <>{tr('Double-click anywhere to write.')}<br />{tr('T text · G graph · I image · A arrow · P pen. Maths goes in $…$.')}</>}
        </div>
      )}

      {toolbar && (
        <div className="board-tools" role="toolbar" aria-label={tr('Board tools')} onPointerDown={(e) => e.stopPropagation()}>
          {tools.map((x) => (
            <button key={x.t} className={'tool' + (tool === x.t ? ' on' : '')} title={`${x.label}  ${x.key}`} aria-label={x.label} aria-pressed={tool === x.t}
              onClick={() => (x.t === 'image' ? pickImage() : setTool(x.t))}>{x.icon}</button>
          ))}
          {tool === 'pen' && (
            <span className="pen-opts">
              {INKS.map((c) => <button key={c} className={'ink-sw' + (penColor === c ? ' on' : '')} style={{ background: ink(c) }} aria-label={tr('Ink {c}', { c })} onClick={() => setPenColor(c)} />)}
              {SIZES.map((s) => <button key={s} className={'size-sw' + (penSize === s ? ' on' : '')} aria-label={tr('Pen size {s}', { s })} onClick={() => setPenSize(s)}><i style={{ width: s + 2, height: s + 2 }} /></button>)}
              <button className={'tool tidy' + (tidy ? ' on' : '')} onClick={toggleTidy} aria-pressed={tidy} aria-label={tr('Tidy handwriting')}
                title={tr('Tidy handwriting: each digit and sign is redrawn neatly as you lift the pen. Ctrl Z brings back what you wrote.')}>
                <WandSparkles size={16} strokeWidth={1.7} /></button>
            </span>
          )}
          <span className="tool-sep" />
          <button className="tool" onClick={undo} disabled={!past.current.length} title={tr('Undo  Ctrl Z')} aria-label={tr('Undo')}><Undo2 size={17} strokeWidth={1.7} /></button>
          <button className="tool" onClick={redo} disabled={!future.current.length} title={tr('Redo  Ctrl Shift Z')} aria-label={tr('Redo')}><Redo2 size={17} strokeWidth={1.7} /></button>
          {mode === 'scratch'
            ? <button className="tool danger" onClick={() => commit({ ...b, strokes: [] })} disabled={!b.strokes.length} title={tr('Clear the paper')} aria-label={tr('Clear the paper')}><Trash2 size={17} strokeWidth={1.7} /></button>
            : <button className="tool" onClick={() => remove(sel)} disabled={!sel.length} title={tr('Remove the selection')} aria-label={tr('Remove the selection')}><Trash2 size={17} strokeWidth={1.7} /></button>}
          <button className="tool zoom mono" onClick={() => setCam((c) => ({ ...c, z: 1 }))} title={tr('Back to 100 %')}>{Math.round(cam.z * 100)}%</button>
        </div>
      )}
      {mode === 'block' && onHeight && (
        <div className="block-resize" aria-hidden onPointerDown={(e) => {
          e.stopPropagation()
          const y0 = e.clientY, h0 = height ?? 420, k = zoomOf(box.current)
          const mv = (ev: PointerEvent) => { box.current!.style.height = Math.max(220, h0 + (ev.clientY - y0) / k) + 'px' }
          const upv = (ev: PointerEvent) => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', upv); onHeight(Math.max(220, Math.round(h0 + (ev.clientY - y0) / k))) }
          window.addEventListener('pointermove', mv); window.addEventListener('pointerup', upv)
        }}><GripHorizontal size={14} strokeWidth={1.7} /></div>
      )}
    </div>
  )
}

function Item({ it, on, solo, editing, onSize, onText, onEndEdit, onFns, onView, graphEdit, setGraphEdit }: {
  it: CanvasItem; on: boolean; graphEdit: boolean; setGraphEdit: (on: boolean) => void; solo: boolean; editing: boolean; z: number; tool: Tool
  onSize: (w: number, h: number) => void; onText: (md: string) => void; onEndEdit: () => void
  onFns: (f: Extract<CanvasItem, { type: 'graph' }>['fns']) => void; onView: (v: NonNullable<Extract<CanvasItem, { type: 'graph' }>['view']>) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => onSize(el.offsetWidth, el.offsetHeight))
    ro.observe(el)
    return () => ro.disconnect()
  })
  const cls = `item ${it.type}` + (on ? ' on' : '') + (editing ? ' editing' : '') + (it.type === 'text' ? ' tone-' + (it.tone ?? 'sheet') : '')
  return (
    <div ref={ref} className={cls} data-item={it.id}
      style={{ left: it.x, top: it.y, width: it.w, height: it.type === 'text' ? undefined : it.h, minHeight: it.type === 'text' ? 40 : undefined }}>
      {it.type === 'text' && (editing
        ? <MdEditor value={it.md} onChange={onText} onDone={onEndEdit} compact />
        : it.md.trim() ? <NoteMd text={it.md} /> : <span className="t3">{tr('Empty card')}</span>)}
      {it.type === 'graph' && (
        <GraphFigure panKey fns={it.fns} view={it.view} onFns={onFns} onView={onView} height={it.h} edit={graphEdit} setEdit={setGraphEdit} />
      )}
      {it.type === 'image' && (
        <>
          <img src={it.src} alt={it.caption ?? ''} draggable={false} />
          {it.caption && <div className="item-cap">{it.caption}</div>}
        </>
      )}
      {solo && !editing && <span className="rs-handle" aria-hidden />}
    </div>
  )
}

