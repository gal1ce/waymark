import { useRef, useState } from 'react'
import type { Stroke } from './api'
import { PAGE_INKS, strokePath } from './ink'
import { zoomOf } from './page'

export type InkTool = 'pen' | 'eraser'
const inkVar = (c: string) => `var(--c-${(PAGE_INKS as readonly string[]).includes(c) ? c : 'ink'})`
const uid = () => Math.random().toString(36).slice(2, 10)

const near = (pts: number[], x: number, y: number, r: number) => {
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const ax = pts[i], ay = pts[i + 1], bx = pts[i + 2] ?? ax, by = pts[i + 3] ?? ay
    const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy
    const t = l ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l)) : 0
    if (Math.hypot(ax + t * dx - x, ay + t * dy - y) <= r) return true
  }
  return false
}

/** Ink written straight on the sheet, over everything on it: the writing, graphs and pictures. It only takes the
 *  pointer while the pen or the eraser is in hand; otherwise it is just drawn. Points are page pixels from the
 *  sheet's top-left corner, so the ink stays where it was written at any zoom. */
export function PageInk({ strokes, onChange, onBegin, tool, color, size }: {
  strokes: Stroke[]; onChange: (s: Stroke[]) => void
  /** a stroke or an erasing begins (one step to undo) */
  onBegin: () => void
  tool: InkTool | null; color: string; size: number
}) {
  const svg = useRef<SVGSVGElement>(null)
  const [live, setLive] = useState<number[] | null>(null)
  const down = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!tool || e.button !== 0) return
    e.preventDefault(); e.stopPropagation()
    const el = svg.current!
    el.setPointerCapture(e.pointerId)
    onBegin()
    const z = zoomOf(el), r = el.getBoundingClientRect()
    const at = (ev: PointerEvent | React.PointerEvent) => [Math.round(((ev.clientX - r.left) / z) * 10) / 10, Math.round(((ev.clientY - r.top) / z) * 10) / 10]
    let pts = at(e), left = strokes
    const rub = (x: number, y: number) => {
      const keep = left.filter((s) => !near(s.pts, x, y, 8 + s.size))
      if (keep.length !== left.length) { left = keep; onChange(keep) }
    }
    if (tool === 'pen') setLive(pts); else rub(pts[0], pts[1])
    const mv = (ev: PointerEvent) => {
      const [x, y] = at(ev)
      if (tool === 'pen') {
        const lx = pts[pts.length - 2], ly = pts[pts.length - 1]
        if (Math.hypot(x - lx, y - ly) < 1.2) return
        pts = [...pts, x, y]; setLive(pts)
      } else rub(x, y)
    }
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up)
      setLive(null)
      if (tool === 'pen' && ev.type === 'pointerup') onChange([...strokes, { id: uid(), pts, color, size }])
    }
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up)
  }
  return (
    <svg ref={svg} className={'paper-ink' + (tool ? ' on ' + tool : '')} onPointerDown={down} aria-hidden={!tool}>
      {strokes.map((s) => <path key={s.id} d={strokePath(s.pts, s.size)} style={{ fill: inkVar(s.color) }} />)}
      {live && <path d={strokePath(live, size)} style={{ fill: inkVar(color) }} />}
    </svg>
  )
}
