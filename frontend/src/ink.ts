import { getStroke } from 'perfect-freehand'
import type { Stroke } from './api'

/** the pen colours on a page; `ink` follows the theme (dark on light paper, light on dark) */
export const PAGE_INKS = ['ink', 'blue', 'red', 'green'] as const
export const PAGE_SIZES_PX = [2, 3.5, 6] as const

/** Freehand ink as a filled outline (perfect-freehand), so a line has a pen's weight, not a uniform stroke. */
export function strokePath(pts: number[], size: number): string {
  const p: [number, number][] = []
  for (let i = 0; i + 1 < pts.length; i += 2) p.push([pts[i], pts[i + 1]])
  if (p.length === 1) p.push([p[0][0] + 0.1, p[0][1] + 0.1])
  const o = getStroke(p, { size: size * 1.6, thinning: 0.45, smoothing: 0.6, streamline: 0.45, simulatePressure: true })
  if (!o.length) return ''
  let d = `M${o[0][0].toFixed(1)} ${o[0][1].toFixed(1)}Q`
  for (let i = 0; i < o.length; i++) {
    const [x0, y0] = o[i], [x1, y1] = o[(i + 1) % o.length]
    d += `${x0.toFixed(1)} ${y0.toFixed(1)} ${((x0 + x1) / 2).toFixed(1)} ${((y0 + y1) / 2).toFixed(1)} `
  }
  return d + 'Z'
}


/** How far down the ink reaches, so the sheet grows to hold it. */
export function inkBottom(strokes: Stroke[]): number {
  let m = 0
  for (const s of strokes) for (let i = 1; i < s.pts.length; i += 2) m = Math.max(m, s.pts[i] + s.size)
  return m
}
