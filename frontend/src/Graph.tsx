import katex from 'katex'
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type SyntheticEvent } from 'react'
import { createPortal } from 'react-dom'
import { CircleAlert, Crosshair, Minus, Palette, Pencil, Plus, X } from 'lucide-react'
import type { GraphFn, GraphLook, GraphView } from './api'
import { t } from './i18n'
import { fmtTick, fmtVal, labelHtml, lineTex, niceStep, PLOT_COLORS, readAll, splitLine, type Anchor, type Plot, type Read } from './graphcore'
import { Slider } from './controls'

export const DEFAULT_VIEW: GraphView = { x0: -10, x1: 10, y0: -6, y1: 6 }
/** What a new graph starts with: one curve to change, not a blank. */
export const STARTER: GraphFn[] = [{ expr: 'y = x^2' }]

const colorOf = (fns: GraphFn[], i: number) => fns[i]?.color ?? PLOT_COLORS[i % PLOT_COLORS.length]

const katexHtml = (src: string) => { try { return katex.renderToString(src, { throwOnError: false, strict: 'ignore' }) } catch { return src } }

/** A label beside a spot on the plot, set as HTML so $…$ can be maths. It sits on the side `anchor` names. */
export function PlotLabel({ x, y, text, anchor, className }: { x: number; y: number; text: string; anchor: Anchor; className?: string }) {
  const W = 320, H = 90, gap = anchor === 'c' ? 0 : 7
  const hor = anchor.includes('e') ? 'e' : anchor.includes('w') ? 'w' : 'c'
  const ver = anchor.includes('n') ? 'n' : anchor.includes('s') ? 's' : 'c'
  const fx = hor === 'e' ? x + gap : hor === 'w' ? x - gap - W : x - W / 2
  const fy = ver === 'n' ? y - gap - H : ver === 's' ? y + gap : y - H / 2
  const html = useMemo(() => labelHtml(text, katexHtml), [text])
  return (
    <foreignObject x={fx} y={fy} width={W} height={H} className="g-label-fo">
      <div className={'g-label ' + (className ?? '')} style={{
        justifyContent: hor === 'e' ? 'flex-start' : hor === 'w' ? 'flex-end' : 'center',
        alignItems: ver === 'n' ? 'flex-end' : ver === 's' ? 'flex-start' : 'center',
      }}><span dangerouslySetInnerHTML={{ __html: html }} /></div>
    </foreignObject>
  )
}

/* ----------------------------------------------------------------- drawing */

type View = GraphView
type Geo = { d: string; fill?: string; dashed?: boolean }

function sampleX(f: (x: number) => number, v: View, w: number, h: number): string {
  const sx = (x: number) => ((x - v.x0) / (v.x1 - v.x0)) * w
  const sy = (y: number) => h - ((y - v.y0) / (v.y1 - v.y0)) * h
  const n = Math.min(1600, Math.round(w * 1.5))
  const span = v.y1 - v.y0
  let d = '', pen = false, prev = NaN
  for (let i = 0; i <= n; i++) {
    const x = v.x0 + ((v.x1 - v.x0) * i) / n
    const y = f(x)
    const px = v.x0 + ((v.x1 - v.x0) * (i - 1)) / n
    const pt = (a: number, b: number) => `${sx(a).toFixed(1)} ${Math.max(-h * 4, Math.min(h * 5, sy(b))).toFixed(1)}`
    if (!Number.isFinite(y)) {
      if (pen) { const e = edge(f, px, x); d += 'L' + pt(e, f(e)) }
      pen = false; prev = y; continue
    }
    // a break: a jump across most of the view (an asymptote, not a steep line)
    if (pen && Math.abs(y - prev) > span * 1.5) { pen = false; prev = y; continue }
    if (!pen && i > 0 && !Number.isFinite(prev)) { const e = edge(f, x, px); d += 'M' + pt(e, f(e)); pen = true }
    d += `${pen ? 'L' : 'M'}${pt(x, y)}`
    pen = true; prev = y
  }
  return d
}
/** Between `a` (defined) and `b` (not), the last place the function is still defined. */
function edge(f: (u: number) => number, a: number, b: number): number {
  for (let k = 0; k < 30; k++) { const m = (a + b) / 2; if (Number.isFinite(f(m))) a = m; else b = m }
  return a
}
function sampleY(f: (y: number) => number, v: View, w: number, h: number): string {
  const sx = (x: number) => ((x - v.x0) / (v.x1 - v.x0)) * w
  const sy = (y: number) => h - ((y - v.y0) / (v.y1 - v.y0)) * h
  const n = Math.min(1200, Math.round(h * 1.5))
  const span = v.x1 - v.x0
  let d = '', pen = false, prev = NaN
  for (let i = 0; i <= n; i++) {
    const y = v.y0 + ((v.y1 - v.y0) * i) / n
    const x = f(y)
    const py = v.y0 + ((v.y1 - v.y0) * (i - 1)) / n
    const pt = (b: number, a: number) => `${Math.max(-w * 4, Math.min(w * 5, sx(b))).toFixed(1)} ${sy(a).toFixed(1)}`
    if (!Number.isFinite(x)) {
      if (pen) { const e = edge(f, py, y); d += 'L' + pt(f(e), e) }
      pen = false; prev = x; continue
    }
    if (pen && Math.abs(x - prev) > span * 1.5) { pen = false; prev = x; continue }
    if (!pen && i > 0 && !Number.isFinite(prev)) { const e = edge(f, y, py); d += 'M' + pt(f(e), e); pen = true }
    d += `${pen ? 'L' : 'M'}${pt(x, y)}`
    pen = true; prev = x
  }
  return d
}
/** F(x, y) = 0 by marching squares on a 4 px grid. Crossings where F blows up (tan, 1/x) are poles, not zeros. */
function contour(F: (x: number, y: number) => number, v: View, w: number, h: number, cell = 4): string {
  const nx = Math.ceil(w / cell), ny = Math.ceil(h / cell)
  const X = (i: number) => v.x0 + (i * cell / w) * (v.x1 - v.x0)
  const Y = (j: number) => v.y1 - (j * cell / h) * (v.y1 - v.y0)
  const g = new Float64Array((nx + 1) * (ny + 1))
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) g[j * (nx + 1) + i] = F(X(i), Y(j))
  const at = (i: number, j: number) => g[j * (nx + 1) + i]
  let d = ''
  const cross = (i0: number, j0: number, i1: number, j1: number): [number, number] | null => {
    const a = at(i0, j0), b = at(i1, j1)
    if (!Number.isFinite(a) || !Number.isFinite(b) || (a > 0) === (b > 0) || a === b) return null
    const t = a / (a - b)
    const px = (i0 + (i1 - i0) * t) * cell, py = (j0 + (j1 - j0) * t) * cell
    const fx = v.x0 + (px / w) * (v.x1 - v.x0), fy = v.y1 - (py / h) * (v.y1 - v.y0)
    const m = Math.abs(F(fx, fy))
    if (!(m <= 0.5 * (Math.abs(a) + Math.abs(b)) + 1e-12)) return null
    return [px, py]
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const pts = [cross(i, j, i + 1, j), cross(i + 1, j, i + 1, j + 1), cross(i, j + 1, i + 1, j + 1), cross(i, j, i, j + 1)].filter(Boolean) as [number, number][]
      for (let k = 0; k + 1 < pts.length; k += 2) d += `M${pts[k][0].toFixed(1)} ${pts[k][1].toFixed(1)}L${pts[k + 1][0].toFixed(1)} ${pts[k + 1][1].toFixed(1)}`
    }
  }
  return d
}
/** A region as runs of 5 px cells, row by row. */
function region(test: (x: number, y: number) => boolean, v: View, w: number, h: number, cell = 5): string {
  let d = ''
  for (let py = 0; py < h; py += cell) {
    const y = v.y1 - ((py + cell / 2) / h) * (v.y1 - v.y0)
    let run = -1
    for (let px = 0; px <= w; px += cell) {
      const inside = px < w && test(v.x0 + ((px + cell / 2) / w) * (v.x1 - v.x0), y)
      if (inside && run < 0) run = px
      if (!inside && run >= 0) { d += `M${run} ${py}h${px - run}v${cell}h${run - px}z`; run = -1 }
    }
  }
  return d
}
/** (x(t), y(t)) for t across its range, with exact ends where a restriction cuts it. */
function sampleT(p: Extract<Plot, { kind: 'param' }>, v: View, w: number, h: number): string {
  const sx = (x: number) => ((x - v.x0) / (v.x1 - v.x0)) * w
  const sy = (y: number) => h - ((y - v.y0) / (v.y1 - v.y0)) * h
  const ok = (t: number) => Number.isFinite(p.x(t)) && Number.isFinite(p.y(t))
  const at = (t: number) => `${Math.max(-w * 4, Math.min(w * 5, sx(p.x(t)))).toFixed(1)} ${Math.max(-h * 4, Math.min(h * 5, sy(p.y(t)))).toFixed(1)}`
  const cut = (a: number, b: number) => { for (let k = 0; k < 30; k++) { const m = (a + b) / 2; if (ok(m)) a = m; else b = m } return a }
  const n = 1500, far = Math.max(w, h) * 1.5
  let d = '', pen = false, was = false, lx = 0, ly = 0
  for (let i = 0; i <= n; i++) {
    const t = p.t0 + ((p.t1 - p.t0) * i) / n, tp = p.t0 + ((p.t1 - p.t0) * (i - 1)) / n
    if (!ok(t)) { if (pen) d += 'L' + at(cut(tp, t)); pen = false; was = false; continue }
    const X = sx(p.x(t)), Y = sy(p.y(t))
    if (pen && Math.hypot(X - lx, Y - ly) > far) pen = false
    if (!pen && i > 0 && !was) { d += 'M' + at(cut(t, tp)); pen = true }
    d += (pen ? 'L' : 'M') + at(t)
    pen = true; was = true; lx = X; ly = Y
  }
  return d
}
function geometry(p: Plot, v: View, w: number, h: number): Geo[] {
  switch (p.kind) {
    case 'param': return [{ d: sampleT(p, v, w, h) }]
    case 'segment': {
      const sx = (x: number) => ((x - v.x0) / (v.x1 - v.x0)) * w
      const sy = (y: number) => h - ((y - v.y0) / (v.y1 - v.y0)) * h
      return [{ d: `M${sx(p.a[0]).toFixed(1)} ${sy(p.a[1]).toFixed(1)}L${sx(p.b[0]).toFixed(1)} ${sy(p.b[1]).toFixed(1)}` }]
    }
    case 'fn': return [{ d: sampleX(p.f, v, w, h) }]
    case 'fny': return [{ d: sampleY(p.f, v, w, h) }]
    case 'implicit': return [{ d: contour(p.F, v, w, h) }]
    case 'region': {
      const out: Geo[] = [{ d: region(p.test, v, w, h), fill: 'region' }]
      if (p.edge) out.push(...geometry(p.edge, v, w, h).map((g) => ({ ...g, dashed: p.strict })))
      return out
    }
    default: return []
  }
}

/** The plot on graph paper. Drag to move, wheel (when focused, or with Ctrl) and the buttons to zoom, hover to read
 *  the first curve. The view is reported back so the page can keep it. */
export function GraphPlot({ fns, reads, view, onView, height = 280, still, panKey, look }: {
  fns: GraphFn[]; reads?: Read[]; view?: GraphView; onView?: (v: GraphView) => void; height?: number
  /** a picture of the graph: no panning, hovering or zooming (on a canvas, dragging it moves the card) */
  still?: boolean
  /** dragging moves whatever holds the graph; it pans only with Alt held (the zoom buttons and hover still work) */
  panKey?: boolean
  /** what is drawn besides the curves, and whether it looks drawn by hand */
  look?: GraphLook
}) {
  const box = useRef<HTMLDivElement>(null)
  const grid = look?.grid !== false, axes = look?.axes !== false, numbers = look?.numbers !== false, frame = look?.frame !== false, hand = !!look?.hand
  const arrows = !!look?.arrows, xName = look?.xName?.trim(), yName = look?.yName?.trim()
  const fid = 'hand' + useId().replace(/:/g, '')
  const [w, setW] = useState(480)
  const [v, setV] = useState<GraphView>(view ?? DEFAULT_VIEW)
  const [hover, setHover] = useState<number | null>(null)
  const drag = useRef<{ x: number; y: number; v: GraphView; sw: number; sh: number } | null>(null)
  const commit = useRef<number | undefined>(undefined)
  useEffect(() => { if (view) setV(view) }, [view?.x0, view?.x1, view?.y0, view?.y1]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(Math.max(120, el.clientWidth)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const ownReads = useMemo(() => reads ?? readAll(fns), [reads, fns])
  const h = height
  const sx = (x: number) => ((x - v.x0) / (v.x1 - v.x0)) * w
  const sy = (y: number) => h - ((y - v.y0) / (v.y1 - v.y0)) * h
  const setView = (nv: GraphView) => {
    setV(nv)
    window.clearTimeout(commit.current)
    commit.current = window.setTimeout(() => onView?.(nv), 400)
  }
  const zoom = (k: number, cx = (v.x0 + v.x1) / 2, cy = (v.y0 + v.y1) / 2) =>
    setView({ x0: cx + (v.x0 - cx) * k, x1: cx + (v.x1 - cx) * k, y0: cy + (v.y0 - cy) * k, y1: cy + (v.y1 - cy) * k })

  useEffect(() => {
    const el = box.current
    if (!el) return
    if (still) return
    const wheel = (e: WheelEvent) => {
      // the page scrolls past a graph; it zooms when it's the focused thing or with Ctrl
      if (!(e.ctrlKey || e.metaKey || el.contains(document.activeElement))) return
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const cx = v.x0 + ((e.clientX - r.left) / r.width) * (v.x1 - v.x0)
      const cy = v.y0 + (1 - (e.clientY - r.top) / r.height) * (v.y1 - v.y0)
      zoom(Math.exp(e.deltaY * 0.0015), cx, cy)
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  })

  // the drawn shapes only change with the lines, the view and the size, not with the hover
  const geos = useMemo(() => ownReads.map((r, i) => (fns[i]?.hidden ? [] : geometry(r, v, w, h))), [ownReads, fns, v, w, h])

  const sxStep = niceStep(v.x1 - v.x0, Math.max(4, w / 70))
  const syStep = niceStep(v.y1 - v.y0, Math.max(3, h / 55))
  const lines = (a: number, b: number, s: number) => { const out: number[] = []; for (let t = Math.ceil(a / s) * s; t <= b; t += s) out.push(t); return out }
  const xs = lines(v.x0, v.x1, sxStep), ys = lines(v.y0, v.y1, syStep)
  const xs5 = lines(v.x0, v.x1, sxStep / 5), ys5 = lines(v.y0, v.y1, syStep / 5)
  const ax = Math.min(Math.max(sy(0), 0), h), ay = Math.min(Math.max(sx(0), 0), w)

  const first = ownReads.findIndex((p, i) => p.kind === 'fn' && !fns[i]?.hidden)
  const hoverY = hover != null && first >= 0 ? (ownReads[first] as Extract<Plot, { kind: 'fn' }>).f(hover) : NaN

  return (
    <div className={'gplot' + (still ? ' still' : '') + (panKey ? ' pan-key' : '') + (frame ? '' : ' bare') + (hand ? ' hand' : '')} ref={box} tabIndex={still ? undefined : 0} style={{ height: h }} aria-label={'Graph of ' + fns.map((f) => f.expr).filter(Boolean).join(', ')}
      onPointerDown={(e) => {
        if (still || e.button !== 0 || (panKey && !e.altKey)) return
        e.currentTarget.focus({ preventScroll: true })
        e.currentTarget.setPointerCapture(e.pointerId)
        const rr = e.currentTarget.getBoundingClientRect()
        drag.current = { x: e.clientX, y: e.clientY, v, sw: rr.width, sh: rr.height }
        e.stopPropagation()
      }}
      onPointerMove={(e) => {
        if (still) return
        const r = e.currentTarget.getBoundingClientRect()
        const d = drag.current
        if (d) {
          const dx = ((e.clientX - d.x) / d.sw) * (d.v.x1 - d.v.x0), dy = ((e.clientY - d.y) / d.sh) * (d.v.y1 - d.v.y0)
          setView({ x0: d.v.x0 - dx, x1: d.v.x1 - dx, y0: d.v.y0 + dy, y1: d.v.y1 + dy })
          return
        }
        setHover(v.x0 + ((e.clientX - r.left) / r.width) * (v.x1 - v.x0))
      }}
      onPointerUp={() => { drag.current = null }}
      onPointerLeave={() => setHover(null)}
      onKeyDown={(e) => {
        const k = { '+': 0.8, '=': 0.8, '-': 1.25 }[e.key]
        if (k) { e.preventDefault(); zoom(k) }
      }}>
      <svg width={w} height={h} className="graph-svg">
        {hand && (
          // drawn by hand: every line wobbles a little, and the curves get a second, lighter pass like a pencil
          <defs>
            <filter id={fid} x="-5%" y="-5%" width="110%" height="110%">
              <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="3" />
              <feDisplacementMap in="SourceGraphic" scale="3.2" xChannelSelector="R" yChannelSelector="G" />
            </filter>
            <filter id={fid + 'b'} x="-5%" y="-5%" width="110%" height="110%">
              <feTurbulence type="fractalNoise" baseFrequency="0.05" numOctaves="2" seed="11" />
              <feDisplacementMap in="SourceGraphic" scale="4" xChannelSelector="R" yChannelSelector="G" />
            </filter>
          </defs>
        )}
        {grid && <g filter={hand ? `url(#${fid})` : undefined}>
          {!hand && xs5.map((t) => <line key={'a' + t} x1={sx(t)} x2={sx(t)} y1={0} y2={h} className="g-minor" />)}
          {!hand && ys5.map((t) => <line key={'b' + t} y1={sy(t)} y2={sy(t)} x1={0} x2={w} className="g-minor" />)}
          {xs.map((t) => <line key={'c' + t} x1={sx(t)} x2={sx(t)} y1={0} y2={h} className="g-major" />)}
          {ys.map((t) => <line key={'d' + t} y1={sy(t)} y2={sy(t)} x1={0} x2={w} className="g-major" />)}
        </g>}
        {geos.map((gs, i) => gs.filter((g) => g.fill).map((g, k) => <path key={`r${i}-${k}`} d={g.d} className="g-region" style={{ fill: colorOf(fns, i) }} />))}
        {axes && <g filter={hand ? `url(#${fid})` : undefined}>
          <line x1={0} x2={w - (arrows ? 2 : 0)} y1={ax} y2={ax} className="g-axis" />
          <line y1={arrows ? 2 : 0} y2={h} x1={ay} x2={ay} className="g-axis" />
          {arrows && <>
            <path d={`M${w - 11} ${ax - 5}L${w - 1} ${ax}L${w - 11} ${ax + 5}`} className="g-axis g-arrow" />
            <path d={`M${ay - 5} 11L${ay} 1L${ay + 5} 11`} className="g-axis g-arrow" />
          </>}
        </g>}
        {axes && xName && <PlotLabel x={w - 4} y={ax} text={xName} anchor={ax > h - 30 ? 'nw' : 'sw'} className="axis" />}
        {axes && yName && <PlotLabel x={ay} y={4} text={yName} anchor={ay > w - 40 ? 'sw' : 'se'} className="axis" />}
        {numbers && xs.filter((t) => Math.abs(t) > sxStep / 1e6).map((t) => (
          <text key={'tx' + t} x={sx(t)} y={Math.min(h - 4, ax + 14)} className="g-tick" textAnchor="middle">{fmtTick(t, sxStep)}</text>
        ))}
        {numbers && ys.filter((t) => Math.abs(t) > syStep / 1e6).map((t) => (
          <text key={'ty' + t} x={Math.max(4, Math.min(w - 4, ay - 6))} y={sy(t) + 4} className="g-tick" textAnchor={ay - 6 < 30 ? 'start' : 'end'}>{fmtTick(t, syStep)}</text>
        ))}
        <g filter={hand ? `url(#${fid})` : undefined}>
          {geos.map((gs, i) => gs.filter((g) => !g.fill).map((g, k) => (
            <path key={`c${i}-${k}`} d={g.d} className={'g-curve' + (g.dashed ? ' dashed' : '')} style={{ stroke: colorOf(fns, i) }} />
          )))}
        </g>
        {hand && <g filter={`url(#${fid}b)`} className="g-pencil">
          {geos.map((gs, i) => gs.filter((g) => !g.fill).map((g, k) => (
            <path key={`s${i}-${k}`} d={g.d} className="g-curve" style={{ stroke: colorOf(fns, i) }} />
          )))}
        </g>}
        {ownReads.map((p, i) => p.kind === 'segment' && p.label && !fns[i]?.hidden && (
          <PlotLabel key={'sl' + i} x={sx((p.a[0] + p.b[0]) / 2)} y={sy((p.a[1] + p.b[1]) / 2)} text={p.label.text} anchor={p.label.anchor} />
        ))}
        {ownReads.map((p, i) => p.kind === 'point' && !fns[i]?.hidden && (
          <g key={'p' + i}>
            {p.label?.anchor !== 'c' && <circle cx={sx(p.x)} cy={sy(p.y)} r={p.label ? 4 : 5} style={{ fill: colorOf(fns, i) }} className="g-point" />}
            {p.label
              ? <PlotLabel x={sx(p.x)} y={sy(p.y)} text={p.label.text} anchor={p.label.anchor} />
              : <text x={sx(p.x) + 9} y={sy(p.y) - 8} className="g-tick strong">({fmtVal(+p.x.toFixed(3))}, {fmtVal(+p.y.toFixed(3))})</text>}
          </g>
        ))}
        {hover != null && Number.isFinite(hoverY) && !drag.current && (
          <g className="g-hover">
            <circle cx={sx(hover)} cy={sy(hoverY)} r={4.5} style={{ fill: colorOf(fns, first) }} />
            <text x={Math.min(w - 120, sx(hover) + 10)} y={Math.max(16, sy(hoverY) - 10)} className="g-tick strong">
              ({+hover.toFixed(2)}, {+hoverY.toFixed(3)})
            </text>
          </g>
        )}
      </svg>
      {!still && <div className="graph-zoom" onPointerDown={(e) => e.stopPropagation()}>
        <button className="icon-btn sm" onClick={() => zoom(0.8)} aria-label={t('Zoom in')}><Plus size={14} strokeWidth={1.8} /></button>
        <button className="icon-btn sm" onClick={() => zoom(1.25)} aria-label={t('Zoom out')}><Minus size={14} strokeWidth={1.8} /></button>
        <button className="icon-btn sm" onClick={() => setView(DEFAULT_VIEW)} aria-label={t('Reset view')} title={t('Back to −10…10')}><Crosshair size={14} strokeWidth={1.8} /></button>
      </div>}
    </div>
  )
}

/* ----------------------------------------------------------------- the expression list */

function Tex({ src }: { src: string }) {
  const html = useMemo(() => { try { return katex.renderToString(src, { throwOnError: false, strict: 'ignore' }) } catch { return null } }, [src])
  return html ? <span className="gx-tex" dangerouslySetInnerHTML={{ __html: html }} /> : null
}

/** A Desmos-style graph: the lines on the left, typed as maths, checked as you go; the plot on the right.
 *  `a = 2` makes a slider, `f(x) = …` a function the other lines can use, `x^2 + y^2 = 9` a curve, `y > x` a region. */
export function GraphCard({ fns, view, onFns, onView, height = 320, stack, autoFocus }: {
  fns: GraphFn[]; view?: GraphView; onFns: (f: GraphFn[]) => void; onView: (v: GraphView) => void; height?: number; stack?: boolean; autoFocus?: boolean
}) {
  const reads = useMemo(() => readAll(fns), [fns])
  const [focus, setFocus] = useState<number | null>(autoFocus ? 0 : null)
  const list = useRef<HTMLDivElement>(null)
  const focusRow = (i: number, end = true) => requestAnimationFrame(() => {
    const el = list.current?.querySelectorAll<HTMLInputElement>('.gx-in')[i]
    if (!el) return
    el.focus({ preventScroll: true })
    if (end) el.setSelectionRange(el.value.length, el.value.length)
  })
  useEffect(() => { if (autoFocus) focusRow(0) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const set = (i: number, patch: Partial<GraphFn>) => onFns(fns.map((g, j) => (j === i ? { ...g, ...patch } : g)))
  const insert = (at: number, expr = '') => { const next = [...fns]; next.splice(at, 0, { expr }); onFns(next); setFocus(at); focusRow(at) }
  const remove = (i: number) => { const next = fns.filter((_, j) => j !== i); onFns(next); const k = Math.max(0, i - 1); if (next.length) { setFocus(k); focusRow(k) } }
  const addSlider = (names: string[], before: number) => {
    const next = [...fns]
    next.splice(before, 0, ...names.map((n) => ({ expr: `${n} = 1` })))
    onFns(next)
  }

  return (
    <div className={'gx' + (stack ? ' stack' : '')}>
      <div className="gx-list" ref={list} style={stack ? undefined : { maxHeight: height }} onKeyDown={(e) => e.stopPropagation()}>
        {fns.map((f, i) => {
          const r = reads[i]
          const editing = focus === i
          const tex = !editing && r.kind !== 'error' ? lineTex(f.expr, fns) : null
          const plotted = ['fn', 'fny', 'implicit', 'region', 'point', 'param', 'segment'].includes(r.kind)
          const label = tex ? splitLine(f.expr).label : undefined
          const c = colorOf(fns, i)
          return (
            <div key={i} className={'gx-row' + (r.kind === 'error' ? ' bad' : '') + (editing ? ' on' : '') + (f.hidden ? ' off' : '')}>
              <div className="gx-side">
                <span className="gx-n">{i + 1}</span>
                {plotted
                  ? <button className="gx-sw" style={{ '--c': c } as CSSProperties} onClick={() => set(i, { hidden: !f.hidden })}
                      aria-label={f.hidden ? t('Show on the graph') : t('Hide from the graph')} title={f.hidden ? t('Hidden: click to show') : t('Click to hide')} />
                  : r.kind === 'error' ? <CircleAlert size={16} strokeWidth={1.8} className="gx-alert" /> : null}
              </div>
              <div className="gx-main" onClick={() => { if (!editing) { setFocus(i); focusRow(i) } }}>
                {tex && <div className="gx-show" aria-hidden><Tex src={tex} />{label && <span className="gx-label" dangerouslySetInnerHTML={{ __html: labelHtml(label.text, katexHtml) }} />}</div>}
                <input className={'gx-in' + (tex ? ' behind' : '')} value={f.expr} spellCheck={false} autoComplete="off" aria-label={t('Line {n}', { n: i + 1 })}
                  placeholder={i === 0 ? 'y = x^2' : ''}
                  onFocus={() => setFocus(i)} onBlur={() => setFocus((x) => (x === i ? null : x))}
                  onChange={(e) => set(i, { expr: e.target.value })}
                  onKeyDown={(e) => {
                    const el = e.currentTarget
                    if (e.key === 'Enter') { e.preventDefault(); insert(i + 1) }
                    else if (e.key === 'Backspace' && !el.value && fns.length > 1) { e.preventDefault(); remove(i) }
                    else if (e.key === 'ArrowUp' && i > 0) { e.preventDefault(); setFocus(i - 1); focusRow(i - 1) }
                    else if (e.key === 'ArrowDown' && i < fns.length - 1) { e.preventDefault(); setFocus(i + 1); focusRow(i + 1) }
                    else if (e.key === 'Escape') el.blur()
                  }} />
                {r.kind === 'slider' && (() => {
                  const lo = Math.min(f.min ?? -10, r.value), hi = Math.max(f.max ?? 10, r.value)
                  return (
                    <div className="gx-slider" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
                      <span className="mono">{fmtVal(lo)}</span>
                      <Slider label={`${r.name} slider`} min={lo} max={hi} step={(hi - lo) / 200} value={r.value} valueText={fmtVal(r.value)}
                        onChange={(v) => set(i, { expr: `${r.name} = ${+v.toFixed(2)}` })} />
                      <span className="mono">{fmtVal(hi)}</span>
                    </div>
                  )
                })()}
                {r.kind === 'value' && <div className="gx-val">= {fmtVal(r.value)}</div>}
                {r.kind === 'error' && (
                  <div className="gx-err">
                    {r.message}
                    {r.missing && <button className="gx-fix" onClick={(e) => { e.stopPropagation(); addSlider(r.missing!, i) }}>{r.missing.length > 1 ? t('Add sliders: {x}', { x: r.missing.join(', ') }) : t('Add a slider: {x}', { x: r.missing.join(', ') })}</button>}
                  </div>
                )}
                {editing && r.kind !== 'error' && r.kind !== 'empty' && r.what && <div className="gx-what">{r.what}</div>}
              </div>
              <button className="gx-del" onClick={() => (fns.length > 1 ? remove(i) : set(i, { expr: '' }))} aria-label={t('Delete line {n}', { n: i + 1 })}><X size={14} strokeWidth={1.8} /></button>
            </div>
          )
        })}
        <button className="gx-add" onClick={() => insert(fns.length)}><Plus size={14} strokeWidth={1.8} />{t('Add a line')}<span className="gx-eg">y = …, a = 2, x² + y² = 9, y &gt; x, (1, 2) "A", y = x {'{'}0 &lt; x &lt; 3{'}'}</span></button>
      </div>
      <div className="gx-plot"><GraphPlot fns={fns} reads={reads} view={view} onView={onView} height={height} /></div>
    </div>
  )
}

/* ----------------------------------------------------------------- the graph on a page or a canvas */

const stop = (e: SyntheticEvent) => e.stopPropagation()

/** The formulas in a window over the page: the line list with its checks, and a large live plot. The events stay
 *  inside it, so the board or page underneath never sees the clicks and keys. */
export function GraphEditor({ fns, view, onFns, onView, onClose }: {
  fns: GraphFn[]; view?: GraphView; onFns: (f: GraphFn[]) => void; onView: (v: GraphView) => void; onClose: () => void
}) {
  const narrow = typeof window !== 'undefined' && window.innerWidth < 720
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', k, true)
    return () => window.removeEventListener('keydown', k, true)
  }, [onClose])
  return createPortal(
    <div className="modal-wrap gx-wrap" onPointerDown={(e) => { stop(e); if (e.target === e.currentTarget) onClose() }}
      onPointerMove={stop} onPointerUp={stop} onKeyDown={stop} onKeyUp={stop} onDoubleClick={stop} onPaste={stop} onClick={stop} onWheel={stop}>
      <div className="modal gx-modal" role="dialog" aria-modal="true" aria-labelledby="gx-t">
        <div className="gx-modal-h">
          <h2 id="gx-t">{t('Edit graph')}</h2>
          <span className="t3 gx-modal-n">{t('One line each: y = …, a = 2 for a slider, x² + y² = 9, y > x, (1, 2)')}</span>
          <button className="btn primary sm" onClick={onClose}>{t('Done')}</button>
        </div>
        <details className="gx-more">
          <summary>{t('Labels, segments, restrictions')}</summary>
          <ul>
            <li><code>(80, 30) "X"</code> {t('a labelled point; text between $ signs is maths:')} <code>(80, 30) "$X(\sigma_x, \tau_{'{'}xy{'}'})$"</code></li>
            <li><code>(20, -30) "Y" sw</code> {t('where the label sits: n, ne, e, se, s, sw, w, nw; c shows the label alone, without the point')}</li>
            <li><code>segment((80, 30), (20, -30))</code> {t('a segment between two points (a label after it sits at its middle)')}</li>
            <li><code>y = 2x + 1 {'{'}0 &lt; x &lt; 3{'}'}</code> {t('draws a curve or region only where the braces hold')}</li>
            <li><code>(50 + 12cos(t), 12sin(t)) {'{'}0 &lt; t &lt; 0.5{'}'}</code> {t('a curve drawn by t (0 to 1 unless the braces say otherwise): arcs, spirals')}</li>
          </ul>
        </details>
        <GraphCard fns={fns} view={view} onFns={onFns} onView={onView} height={narrow ? 300 : 460} stack={narrow} autoFocus />
      </div>
    </div>,
    document.body,
  )
}

/** A graph as it sits on the page: only the plot. "Edit" (or a double click) opens the formulas; a line that
 *  doesn't read is flagged on the plot so it isn't missed. */
export function GraphFigure({ fns, view, onFns, onView, height, still, panKey, edit, setEdit, look }: {
  fns: GraphFn[]; view?: GraphView; onFns: (f: GraphFn[]) => void; onView: (v: GraphView) => void; height: number
  still?: boolean; panKey?: boolean; edit?: boolean; setEdit?: (on: boolean) => void; look?: GraphLook
}) {
  const [own, setOwn] = useState(false)
  const open = edit ?? own, setOpen = setEdit ?? setOwn
  const reads = useMemo(() => readAll(fns), [fns])
  const bad = reads.filter((r, i) => r.kind === 'error' && fns[i].expr.trim()).length
  return (
    <div className="gfig" onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest('.graph-zoom')) { e.stopPropagation(); setOpen(true) } }}>
      <GraphPlot fns={fns} reads={reads} view={view} onView={onView} height={height} still={still} panKey={panKey} look={look} />
      <div className="gfig-bar">
        {bad > 0 && (
          <button className="gfig-btn warn" onClick={() => setOpen(true)} onPointerDown={stop}>
            <CircleAlert size={13} strokeWidth={1.8} />{bad === 1 ? t('1 line needs a fix') : t('{n} lines need a fix', { n: bad })}
          </button>
        )}
        <button className="gfig-btn" onClick={() => setOpen(true)} onPointerDown={stop} title={t('Change the formulas  (double click)')}>
          <Pencil size={13} strokeWidth={1.8} />{t('Edit')}
        </button>
      </div>
      {open && <GraphEditor fns={fns} view={view} onFns={onFns} onView={onView} onClose={() => setOpen(false)} />}
    </div>
  )
}

type Flag = 'grid' | 'axes' | 'numbers' | 'frame' | 'hand' | 'arrows'
const LOOKS: { k: Flag; label: 'Grid' | 'Axes' | 'Numbers' | 'Frame' | 'Hand-drawn' | 'Arrows on the axes' }[] = [
  { k: 'grid', label: 'Grid' }, { k: 'axes', label: 'Axes' }, { k: 'arrows', label: 'Arrows on the axes' }, { k: 'numbers', label: 'Numbers' }, { k: 'frame', label: 'Frame' }, { k: 'hand', label: 'Hand-drawn' },
]
/** off unless turned on */
const OPT_IN = new Set<Flag>(['hand', 'arrows'])
/** What a graph shows besides its curves (grid, axes, numbers, the frame), and whether it looks drawn by hand. */
export function GraphLookMenu({ look, onLook }: { look?: GraphLook; onLook: (l: GraphLook | undefined) => void }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    document.addEventListener('pointerdown', down, true); window.addEventListener('keydown', key, true)
    return () => { document.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key, true) }
  }, [open])
  const on = (k: Flag) => (OPT_IN.has(k) ? !!look?.[k] : look?.[k] !== false)
  const tidy = (next: GraphLook) => onLook(Object.keys(next).length ? next : undefined)
  const flip = (k: Flag) => {
    const next: GraphLook = { ...look }
    if (OPT_IN.has(k)) { if (look?.[k]) delete next[k]; else next[k] = true }
    else if (on(k)) next[k] = false; else delete next[k]
    tidy(next)
  }
  const name = (k: 'xName' | 'yName', v: string) => { const next: GraphLook = { ...look }; if (v) next[k] = v; else delete next[k]; tidy(next) }
  const plain = () => onLook({ grid: false, axes: false, numbers: false, frame: false, ...(look?.xName ? { xName: look.xName } : {}), ...(look?.yName ? { yName: look.yName } : {}) })
  return (
    <span className="glook" ref={box}>
      <button className={'icon-btn sm' + (open ? ' on' : '')} aria-expanded={open} aria-haspopup="dialog" title={t('How the graph looks')} aria-label={t('How the graph looks')}
        onClick={() => setOpen(!open)}><Palette size={14} strokeWidth={1.7} /></button>
      {open && (
        <div className="glook-pop" role="dialog" aria-label={t('How the graph looks')}>
          {LOOKS.map((x) => (
            <button key={x.k} className="glook-row" role="switch" aria-checked={on(x.k)} onClick={() => flip(x.k)}>
              <span>{t(x.label)}</span><span className={'glook-sw' + (on(x.k) ? ' on' : '')} aria-hidden />
            </button>
          ))}
          <div className="glook-names" onKeyDown={(e) => e.stopPropagation()}>
            <label><span>{t('x axis name')}</span><input value={look?.xName ?? ''} placeholder="$\sigma$" spellCheck={false} onChange={(e) => name('xName', e.target.value)} /></label>
            <label><span>{t('y axis name')}</span><input value={look?.yName ?? ''} placeholder="$\tau$" spellCheck={false} onChange={(e) => name('yName', e.target.value)} /></label>
          </div>
          <div className="glook-acts">
            <button className="btn ghost sm" onClick={plain}>{t('Only the curves')}</button>
            <button className="btn ghost sm" onClick={() => onLook(undefined)} disabled={!look}>{t('Reset')}</button>
          </div>
        </div>
      )}
    </span>
  )
}
