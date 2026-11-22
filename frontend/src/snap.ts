import { zoomOf } from './page'

/** Lines a block moved freely on the sheet can snap to: the page's centre, the edges of the writing column, and the
 *  edges and centres of every other block. All in page pixels from the sheet's top-left corner. */
export type SnapLines = { paper: HTMLElement; xs: number[]; ys: number[]; z: number }

export function snapLines(self: Element | null): SnapLines | null {
  const paper = self?.closest<HTMLElement>('.paper')
  if (!paper || !self) return null
  // free blocks are placed from the corner of the layer that holds them (inside the sheet's border)
  const z = zoomOf(paper), pr = (paper.querySelector('.paper-free') ?? paper).getBoundingClientRect()
  const xs = [pr.width / z / 2], ys: number[] = []
  const add = (r: DOMRect, mid: boolean) => {
    const l = (r.left - pr.left) / z, rr = (r.right - pr.left) / z, t = (r.top - pr.top) / z, b = (r.bottom - pr.top) / z
    xs.push(l, rr); ys.push(t, b)
    if (mid) { xs.push((l + rr) / 2); ys.push((t + b) / 2) }
  }
  const doc = paper.querySelector('.doc')
  if (doc) { const r = doc.getBoundingClientRect(); xs.push((r.left - pr.left) / z, (r.right - pr.left) / z) }
  for (const o of paper.querySelectorAll<HTMLElement>('.paper-free > [data-free], .doc [data-cell]')) {
    if (o === self || o.contains(self) || self.contains(o)) continue
    const box = o.querySelector('.pfig-lane, .pfig, .doc-text, .md-ed') ?? o
    const r = box.getBoundingClientRect()
    if (r.width && r.height) add(r, true)
  }
  return { paper, xs, ys, z }
}

/** how near (in screen pixels, whatever the zoom) an edge has to come to snap */
const TH = 7

/** The nearest line within reach for any of a box's edges or its middle; the box moves onto it. */
export function snapBox(s: SnapLines | null, x: number, y: number, w: number, h: number, off = false) {
  let bx = x, by = y, gx: number | null = null, gy: number | null = null
  if (s && !off) {
    const th = TH / s.z
    let best = th
    for (const v of s.xs) for (const o of [0, w / 2, w]) { const d = Math.abs(x + o - v); if (d < best) { best = d; bx = v - o; gx = v } }
    best = th
    for (const v of s.ys) for (const o of [0, h / 2, h]) { const d = Math.abs(y + o - v); if (d < best) { best = d; by = v - o; gy = v } }
  }
  return { x: bx, y: by, gx, gy }
}

/** Shows the lines a moving block snapped to (or hides them). */
export function showGuides(s: SnapLines | null, gx: number | null, gy: number | null) {
  if (!s) return
  for (const [k, v] of [['v', gx], ['h', gy]] as const) {
    let g = s.paper.querySelector<HTMLElement>(`:scope > .snap-g.${k}`)
    if (v == null) { g?.remove(); continue }
    if (!g) { g = document.createElement('div'); g.className = 'snap-g ' + k; g.setAttribute('aria-hidden', 'true'); s.paper.appendChild(g) }
    if (k === 'v') g.style.left = v + 'px'; else g.style.top = v + 'px'
  }
}

/** One edge being dragged (resizing): the nearest line within reach on its axis, or the edge where it is. */
export function snapEdge(s: SnapLines | null, v: number, axis: 'x' | 'y', off = false): { v: number; g: number | null } {
  if (!s || off) return { v, g: null }
  let best = TH / s.z, out = v, g: number | null = null
  for (const l of axis === 'x' ? s.xs : s.ys) { const d = Math.abs(v - l); if (d < best) { best = d; out = l; g = l } }
  return { v: out, g }
}
