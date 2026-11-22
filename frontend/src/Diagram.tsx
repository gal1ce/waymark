import { useEffect, useMemo, useRef, useState, type ReactNode, type SyntheticEvent } from 'react'
import { createPortal } from 'react-dom'
import { Box, CircleAlert, Pencil, RotateCcw, Square } from 'lucide-react'
import { PlotLabel } from './Graph'
import { boxFaces, CAM_3D, CAM_FLAT, project, readDiagram, STRESS_CUBE, viewDir, type Cam, type Lbl, type Prim, type Style, type V3 } from './diagram'
import { t } from './i18n'

/* ----------------------------------------------------------------- drawing */

type P2 = [number, number]
type Face = { k: 'face'; pts: P2[]; d: number; plane: ((x: number, y: number) => number) | null; s: Style; front: boolean; shade: number; box: boolean }
type Stroke = { k: 'line'; pts: P2[]; d: number[]; s: Style; arrow: boolean } | { k: 'dot'; p: P2; d: number; s: Style }
type Tag = { p: P2; label: Lbl; color: string; dir?: P2 }

const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

function inside(p: P2, poly: P2[]): boolean {
  let c = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j]
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c
  }
  return c
}
/** a planar face's depth at any spot of the screen, from three of its corners */
function planeOf(pts: P2[], ds: number[]): ((x: number, y: number) => number) | null {
  for (let i = 2; i < pts.length; i++) {
    const [x0, y0] = pts[0], [x1, y1] = pts[1], [x2, y2] = pts[i]
    const det = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
    if (Math.abs(det) < 1e-6) continue
    const a = ((ds[1] - ds[0]) * (y2 - y0) - (ds[i] - ds[0]) * (y1 - y0)) / det
    const b = ((x1 - x0) * (ds[i] - ds[0]) - (x2 - x0) * (ds[1] - ds[0])) / det
    return (x, y) => ds[0] + a * (x - x0) + b * (y - y0)
  }
  return null
}

/** Everything ready to draw at a size: faces back to front, each line and dot just before the first face that hides
 *  it (so an arrow on a front face shows over it, one on a back face under the tinted glass), labels on top. */
function layout(prims: Prim[], cam: Cam, W: number, H: number) {
  const vd = viewDir(cam)
  const all: V3[] = []
  prims.forEach((p) => {
    if (p.t === 'box') all.push(p.a, p.b, [p.a[0], p.b[1], p.a[2]], [p.b[0], p.a[1], p.b[2]], [p.a[0], p.a[1], p.b[2]], [p.b[0], p.b[1], p.a[2]], [p.a[0], p.b[1], p.b[2]], [p.b[0], p.a[1], p.a[2]])
    else if (p.t === 'line' || p.t === 'poly') all.push(...p.pts)
    else all.push(p.p)
  })
  if (!all.length) return null
  const pr = all.map((q) => project(q, cam))
  const x0 = Math.min(...pr.map((q) => q.x)), x1 = Math.max(...pr.map((q) => q.x))
  const y0 = Math.min(...pr.map((q) => q.y)), y1 = Math.max(...pr.map((q) => q.y))
  const pad = 38
  const k = Math.min((W - pad * 2) / Math.max(1e-6, x1 - x0), (H - pad * 2) / Math.max(1e-6, y1 - y0))
  const ox = W / 2 - ((x0 + x1) / 2) * k, oy = H / 2 + ((y0 + y1) / 2) * k
  const to = (q: V3): { p: P2; d: number } => { const r = project(q, cam); return { p: [ox + r.x * k, oy - r.y * k], d: r.d } }

  const faces: Face[] = [], strokes: Stroke[] = [], tags: Tag[] = []
  const face = (pts3: V3[], n: V3, s: Style, box: boolean, twoSided: boolean) => {
    const q = pts3.map(to)
    const facing = dot3(n, vd)
    const front = twoSided || facing > 1e-9
    const d = q.reduce((a, b) => a + b.d, 0) / q.length
    faces.push({ k: 'face', pts: q.map((x) => x.p), d, plane: planeOf(q.map((x) => x.p), q.map((x) => x.d)), s, front, box, shade: Math.abs(facing) })
  }
  for (const p of prims) {
    if (p.t === 'box') boxFaces(p.a, p.b).forEach((f) => face(f.pts, f.n, p.s, true, false))
    else if (p.t === 'poly') {
      face(p.pts, cross(sub(p.pts[1], p.pts[0]), sub(p.pts[2], p.pts[0])), p.s, false, true)
      if (p.label) { const c = p.pts.reduce<V3>((a, b) => [a[0] + b[0] / p.pts.length, a[1] + b[1] / p.pts.length, a[2] + b[2] / p.pts.length], [0, 0, 0]); tags.push({ p: to(c).p, label: p.label, color: p.s.color }) }
    } else if (p.t === 'line') {
      const q = p.pts.map(to)
      strokes.push({ k: 'line', pts: q.map((x) => x.p), d: q.map((x) => x.d), s: p.s, arrow: p.arrow })
      if (p.label) {
        if (p.arrow) {
          const a = q[q.length - 2].p, b = q[q.length - 1].p, L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
          tags.push({ p: b, label: p.label, color: p.s.color, dir: [(b[0] - a[0]) / L, (b[1] - a[1]) / L] })
        } else {
          const m = Math.floor((q.length - 1) / 2), a = q[m].p, b = q[m + 1].p
          tags.push({ p: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], label: p.label, color: p.s.color })
        }
      }
    } else if (p.t === 'dot') {
      const q = to(p.p)
      strokes.push({ k: 'dot', p: q.p, d: q.d, s: p.s })
      if (p.label) tags.push({ p: q.p, label: p.label, color: p.s.color })
    } else tags.push({ p: to(p.p).p, label: p.label, color: p.s.color })
  }

  // back faces of boxes are only their hidden edges; the faces that face you are tinted glass, back to front
  const back = faces.filter((f) => !f.front).sort((a, b) => a.d - b.d)
  const front = faces.filter((f) => f.front).sort((a, b) => a.d - b.d)
  const slots: Stroke[][] = front.map(() => [])
  const after: Stroke[] = []
  for (const s of strokes) {
    const pts = s.k === 'dot' ? [s.p] : s.pts, ds = s.k === 'dot' ? [s.d] : s.d
    // judged at the middle of the stroke (an arrow's shaft), where it is most itself
    let m: P2 = pts[0], md = ds[0]
    if (pts.length > 1) { const i = Math.floor((pts.length - 1) / 2); m = [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2]; md = (ds[i] + ds[i + 1]) / 2 }
    const hid = front.findIndex((f) => f.s.fill !== false && f.plane && inside(m, f.pts) && f.plane(m[0], m[1]) > md + 1e-3)
    ;(hid < 0 ? after : slots[hid]).push(s)
  }
  return { back, front, slots, after, tags }
}

const HEAD = 9

function StrokeEl({ s }: { s: Stroke }) {
  if (s.k === 'dot') return <circle cx={s.p[0]} cy={s.p[1]} r={3.6} style={{ fill: s.s.color }} className="dg-dot" />
  const pts = s.pts.map((p) => [...p] as P2)
  let head: ReactNode = null
  if (s.arrow) {
    const b = pts[pts.length - 1], a = pts[pts.length - 2]
    const L = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (L > 0.5) {
      const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L, h = Math.min(HEAD + s.s.width, L * 0.6), w = h * 0.42
      head = <path d={`M${b[0]} ${b[1]}L${b[0] - ux * h - uy * w} ${b[1] - uy * h + ux * w}L${b[0] - ux * h * 0.78} ${b[1] - uy * h * 0.78}L${b[0] - ux * h + uy * w} ${b[1] - uy * h - ux * w}Z`} style={{ fill: s.s.color }} />
      pts[pts.length - 1] = [b[0] - ux * h * 0.7, b[1] - uy * h * 0.7]
    }
  }
  return (
    <g>
      <polyline points={pts.map((p) => p.join(',')).join(' ')} className={'dg-line' + (s.s.dashed ? ' dashed' : '')} style={{ stroke: s.s.color, strokeWidth: s.s.width }} />
      {head}
    </g>
  )
}

function FaceEl({ f }: { f: Face }) {
  const d = f.pts.map((p) => p.join(',')).join(' ')
  if (!f.front) return f.s.opaque ? null : <polygon points={d} className="dg-hidden" style={{ stroke: f.s.color }} />
  const tint = f.s.fill === false ? 0 : 0.06 + 0.16 * (1 - f.shade)
  return (
    <g>
      {f.s.opaque && <polygon points={d} className="dg-paper" />}
      <polygon points={d} className={'dg-face' + (f.s.dashed ? ' dashed' : '')} style={{ fill: f.s.color, fillOpacity: f.s.opaque ? tint + 0.08 : tint, stroke: f.s.color, strokeWidth: f.box ? 1.5 : f.s.width }} />
    </g>
  )
}

/** The diagram drawn at a size. With `onCam`, dragging turns it (Shift keeps it level). */
export function DiagramSvg({ src, cam, width, height, onCam }: { src: string; cam?: Cam; width: number; height: number; onCam?: (c: Cam) => void }) {
  const c = cam ?? CAM_3D
  const lines = useMemo(() => readDiagram(src), [src])
  const prims = useMemo(() => lines.flatMap((l) => l.prims), [lines])
  const L = useMemo(() => layout(prims, c, width, height), [prims, c, width, height])
  const drag = useRef<{ x: number; y: number; c: Cam } | null>(null)
  return (
    <svg width={width} height={height} className={'dg-svg' + (onCam ? ' turnable' : '')} role="img" aria-label={t('Diagram')}
      onPointerDown={onCam ? (e) => { if (e.button !== 0) return; e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, c }; e.stopPropagation() } : undefined}
      onPointerMove={onCam ? (e) => {
        const d = drag.current
        if (!d) return
        const az = d.c.az - (e.clientX - d.x) * 0.5
        const el = e.shiftKey ? d.c.el : Math.max(-90, Math.min(90, d.c.el + (e.clientY - d.y) * 0.4))
        onCam({ az: Math.round(((az % 360) + 540) % 360 - 180), el: Math.round(el) })
      } : undefined}
      onPointerUp={() => { drag.current = null }}>
      {L && <>
        {L.back.map((f, i) => <FaceEl key={'b' + i} f={f} />)}
        {L.front.map((f, i) => <g key={'f' + i}>{L.slots[i].map((s, j) => <StrokeEl key={j} s={s} />)}<FaceEl f={f} /></g>)}
        {L.after.map((s, i) => <StrokeEl key={'a' + i} s={s} />)}
        {L.tags.map((g, i) => {
          // an arrow's label with no side given sits just past its tip
          const p: P2 = g.dir && g.label.anchor === 'c' ? [g.p[0] + g.dir[0] * 13, g.p[1] + g.dir[1] * 13] : g.p
          return <PlotLabel key={'t' + i} x={p[0]} y={p[1]} text={g.label.text} anchor={g.label.anchor} />
        })}
      </>}
    </svg>
  )
}

/* ----------------------------------------------------------------- the editor */

const stop = (e: SyntheticEvent) => e.stopPropagation()
const same = (a: Cam, b: Cam) => a.az === b.az && a.el === b.el

/** The lines in a window over the page, with a large live drawing you can turn. */
export function DiagramEditor({ src, cam, onSrc, onCam, onClose }: { src: string; cam?: Cam; onSrc: (s: string) => void; onCam: (c: Cam | undefined) => void; onClose: () => void }) {
  const narrow = typeof window !== 'undefined' && window.innerWidth < 760
  const [view, setView] = useState<Cam>(cam ?? CAM_3D)
  const box = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(560)
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', k, true)
    return () => window.removeEventListener('keydown', k, true)
  }, [onClose])
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(Math.max(200, el.clientWidth)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // the turned view is kept a moment after the drag stops, not on every step of it
  const commit = useRef<number | undefined>(undefined)
  const turn = (c: Cam) => {
    setView(c)
    window.clearTimeout(commit.current)
    commit.current = window.setTimeout(() => onCam(same(c, CAM_3D) ? undefined : c), 300)
  }
  const lines = useMemo(() => readDiagram(src), [src])
  const errors = lines.map((l, i) => ({ i, e: l.error })).filter((x) => x.e)
  const preset = (c: Cam, label: string, icon: ReactNode) => (
    <button className={'btn ghost sm' + (same(view, c) ? ' on' : '')} onClick={() => turn(c)} title={label}>{icon}{label}</button>
  )
  return createPortal(
    <div className="modal-wrap gx-wrap" onPointerDown={(e) => { stop(e); if (e.target === e.currentTarget) onClose() }}
      onPointerMove={stop} onPointerUp={stop} onKeyDown={stop} onKeyUp={stop} onDoubleClick={stop} onPaste={stop} onClick={stop} onWheel={stop}>
      <div className="modal gx-modal dg-modal" role="dialog" aria-modal="true" aria-labelledby="dg-t">
        <div className="gx-modal-h">
          <h2 id="dg-t">{t('Edit diagram')}</h2>
          <span className="t3 gx-modal-n">{t('One shape per line. Drag the drawing to turn it.')}</span>
          <button className="btn primary sm" onClick={onClose}>{t('Done')}</button>
        </div>
        <div className={'dg-body' + (narrow ? ' stack' : '')}>
          <div className="dg-code">
            <textarea value={src} spellCheck={false} autoFocus aria-label={t('Diagram lines')} onChange={(e) => onSrc(e.target.value)}
              rows={narrow ? 8 : 16} placeholder={'box (0,0,0) (2,2,2) blue\narrow (1,1,2) (1,1,3) "$\\sigma$" n'} />
            {errors.length > 0 && (
              <ul className="dg-errs">
                {errors.map((x) => <li key={x.i}><CircleAlert size={13} strokeWidth={1.8} />{t('Line {n}', { n: x.i + 1 })}: {x.e}</li>)}
              </ul>
            )}
            <details className="gx-more">
              <summary>{t('What can be drawn')}</summary>
              <ul>
                <li><code>box (0,0,0) (2,2,2) blue</code> {t('a box between two opposite corners; hidden edges dashed (opaque hides them)')}</li>
                <li><code>arrow (2,1,1) (3,1,1) "$\sigma_{'{'}11{'}'}$" e</code> {t('an arrow, with a label at its tip')}</li>
                <li><code>line (0,0) (1,1) (2,0) dashed</code> {t('a line through points; (x, y) is (x, y, 0)')}</li>
                <li><code>poly (0,0,0) (1,0,0) (0,1,0) green</code> {t('a filled polygon')}</li>
                <li><code>point (1,1,1) "A" ne</code> · <code>text (1,1,1) "words"</code> {t('a labelled dot, or the words alone')}</li>
                <li><code>axes (-2,0,0) 1</code> {t('the x₁ x₂ x₃ arrows from a point (names may follow in quotes)')}</li>
                <li><code>a = 2</code> {t('a number for the lines below: (a, 0, a/2)')}</li>
                <li>{t('Colours: blue red green orange purple ink gray · also dashed, thin, thick, nofill, opaque · label sides: n ne e se s sw w nw c · # starts a comment')}</li>
              </ul>
              <button className="btn ghost sm" onClick={() => onSrc(STRESS_CUBE)}>{t('Load the example: stress on a cube')}</button>
            </details>
          </div>
          <div className="dg-preview" ref={box}>
            <DiagramSvg src={src} cam={view} width={w} height={narrow ? 280 : 400} onCam={turn} />
            <div className="dg-views">
              {preset(CAM_3D, t('3D'), <Box size={14} strokeWidth={1.7} />)}
              {preset(CAM_FLAT, t('Flat'), <Square size={14} strokeWidth={1.7} />)}
              <span className="t3 dg-angle">{view.az}° · {view.el}°</span>
              <button className="icon-btn sm" onClick={() => turn(CAM_3D)} title={t('Reset view')} aria-label={t('Reset view')}><RotateCcw size={14} strokeWidth={1.7} /></button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** A diagram as it sits on the page: only the drawing. "Edit" (or a double click) opens its lines. */
export function DiagramFigure({ src, cam, height, onSrc, onCam, edit, setEdit }: {
  src: string; cam?: Cam; height: number; onSrc: (s: string) => void; onCam: (c: Cam | undefined) => void; edit: boolean; setEdit: (on: boolean) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(380)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(Math.max(80, el.clientWidth)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const bad = useMemo(() => readDiagram(src).filter((l) => l.error).length, [src])
  return (
    <div className="gfig dgfig" ref={box} style={{ height }} onDoubleClick={(e) => { e.stopPropagation(); setEdit(true) }}>
      <DiagramSvg src={src} cam={cam} width={w} height={height} />
      <div className="gfig-bar">
        {bad > 0 && (
          <button className="gfig-btn warn" onClick={() => setEdit(true)} onPointerDown={stop}>
            <CircleAlert size={13} strokeWidth={1.8} />{bad === 1 ? t('1 line needs a fix') : t('{n} lines need a fix', { n: bad })}
          </button>
        )}
        <button className="gfig-btn" onClick={() => setEdit(true)} onPointerDown={stop} title={t('Change the drawing  (double click)')}>
          <Pencil size={13} strokeWidth={1.8} />{t('Edit')}
        </button>
      </div>
      {edit && <DiagramEditor src={src} cam={cam} onSrc={onSrc} onCam={onCam} onClose={() => setEdit(false)} />}
    </div>
  )
}
