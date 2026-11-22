/* Diagrams written line by line, like the graphs: points in 3D (or 2D), boxes, arrows, lines, filled polygons and
   labels with $maths$, seen from a camera that can be turned. Parsing and projection live here; drawing is Diagram.tsx.

     box (0,0,0) (2,2,2) blue           a cuboid between two corners; hidden edges dashed
     arrow (2,1,1) (3,1,1) blue "$\sigma_{11}$" e
     line (0,0) (1,1) (2,0) dashed      a polyline; a label after it sits at its middle
     poly (0,0,0) (1,0,0) (0,1,0) green a filled polygon
     point (1,1,1) "A" ne               a dot with a label;  text (1,1,1) "note"  is the label alone
     axes (-2,0,0) 1                    x₁ x₂ x₃ arrows from a point (names can follow in quotes)
     a = 2                              a number the other lines can use: (a, 0, a/2)
*/

import { evalNum, type Anchor } from './graph'

export type V3 = [number, number, number]
export type Cam = { az: number; el: number }
/** the default camera: x₁ toward you and to the left, x₂ to the right, x₃ up, seen a little from above */
export const CAM_3D: Cam = { az: 30, el: 22 }
/** straight from above: x to the right, y up, like paper */
export const CAM_FLAT: Cam = { az: -90, el: 90 }

export type Style = { color: string; dashed?: boolean; width: number; fill?: boolean; opaque?: boolean }
export type Prim =
  | { t: 'box'; a: V3; b: V3; s: Style }
  | { t: 'poly'; pts: V3[]; s: Style; label?: Lbl }
  | { t: 'line'; pts: V3[]; s: Style; arrow: boolean; label?: Lbl }
  | { t: 'dot'; p: V3; s: Style; label?: Lbl }
  | { t: 'text'; p: V3; s: Style; label: Lbl }
export type Lbl = { text: string; anchor: Anchor }
export type DiagramLine = { prims: Prim[]; error?: string; def?: string }

const COLORS: Record<string, string> = {
  blue: 'var(--c-blue)', red: 'var(--c-red)', green: 'var(--c-green)', orange: 'var(--c-orange)', purple: 'var(--c-purple)',
  ink: 'var(--c-ink)', black: 'var(--c-ink)', gray: 'var(--t3)', grey: 'var(--t3)',
}
const ANCHORS = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw', 'c'])
const WORDS = new Set(['dashed', 'thin', 'thick', 'fill', 'nofill', 'opaque'])

type Tok = { k: 'pt'; v: string } | { k: 'str'; v: string } | { k: 'word'; v: string } | { k: 'num'; v: string }

function tokens(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === ' ' || c === '\t') { i++; continue }
    if (c === '"') {
      const j = src.indexOf('"', i + 1)
      if (j < 0) throw new Error('A label needs its closing "')
      out.push({ k: 'str', v: src.slice(i + 1, j) }); i = j + 1; continue
    }
    if (c === '(') {
      let d = 0, j = i
      for (; j < src.length; j++) { if (src[j] === '(') d++; else if (src[j] === ')' && --d === 0) break }
      if (j >= src.length) throw new Error('A point needs its closing )')
      out.push({ k: 'pt', v: src.slice(i + 1, j) }); i = j + 1; continue
    }
    const m = /^[^\s"(]+/.exec(src.slice(i))!
    out.push({ k: /^[a-zA-Z_]+$/.test(m[0]) ? 'word' : 'num', v: m[0] }); i += m[0].length
  }
  return out
}

/** splits "a, b, c" at the commas outside brackets */
function commas(s: string): string[] {
  const out: string[] = []
  let d = 0, from = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') d++
    else if (s[i] === ')') d--
    else if (s[i] === ',' && d === 0) { out.push(s.slice(from, i)); from = i + 1 }
  }
  out.push(s.slice(from))
  return out
}

/** Reads every line; `a = 2` lines give numbers to the lines after them. */
export function readDiagram(src: string): DiagramLine[] {
  const vars: Record<string, number> = {}
  return src.split('\n').map((raw): DiagramLine => {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) return { prims: [] }
    try {
      const def = /^([a-zA-Z](?:_[a-zA-Z0-9]+)?)\s*=\s*(.+)$/.exec(line)
      if (def && !/^(box|arrow|line|poly|point|text|axes)\b/.test(line)) {
        vars[def[1]] = evalNum(def[2], vars)
        return { prims: [], def: def[1] }
      }
      return { prims: readOne(line, vars) }
    } catch (e) {
      return { prims: [], error: (e as Error).message }
    }
  })
}

function readOne(line: string, vars: Record<string, number>): Prim[] {
  const toks = tokens(line)
  const cmd = toks.shift()
  if (!cmd || cmd.k !== 'word') throw new Error('Start with what to draw: box, arrow, line, poly, point, text or axes')
  const pts: V3[] = [], strs: string[] = [], nums: number[] = []
  let anchor: Anchor | undefined
  const s: Style = { color: 'var(--c-ink)', width: 1.6 }
  for (const tk of toks) {
    if (tk.k === 'pt') {
      const parts = commas(tk.v)
      if (parts.length < 2 || parts.length > 3) throw new Error('A point is (x, y, z) or (x, y)')
      const v = parts.map((x) => evalNum(x, vars))
      pts.push([v[0], v[1], v[2] ?? 0])
    } else if (tk.k === 'str') strs.push(tk.v)
    else if (tk.k === 'num') nums.push(evalNum(tk.v, vars))
    else if (COLORS[tk.v]) s.color = COLORS[tk.v]
    else if (ANCHORS.has(tk.v) && strs.length) anchor = tk.v as Anchor
    else if (WORDS.has(tk.v)) {
      if (tk.v === 'dashed') s.dashed = true
      else if (tk.v === 'thin') s.width = 1
      else if (tk.v === 'thick') s.width = 2.6
      else if (tk.v === 'fill') s.fill = true
      else if (tk.v === 'nofill') s.fill = false
      else if (tk.v === 'opaque') s.opaque = true
    } else if (tk.v in vars) nums.push(vars[tk.v])
    else throw new Error(`Unknown word “${tk.v}”`)
  }
  const label = (fallback: Anchor): Lbl | undefined => (strs.length ? { text: strs[0], anchor: anchor ?? fallback } : undefined)
  const need = (n: number, what: string) => { if (pts.length < n) throw new Error(what) }
  switch (cmd.v) {
    case 'box': {
      need(2, 'A box takes two opposite corners: box (0,0,0) (2,2,2)')
      if (s.fill === undefined) s.fill = true
      return [{ t: 'box', a: pts[0], b: pts[1], s }]
    }
    case 'arrow': case 'line': {
      need(2, `${cmd.v === 'arrow' ? 'An arrow' : 'A line'} takes at least two points: ${cmd.v} (0,0,0) (1,0,0)`)
      return [{ t: 'line', pts, s, arrow: cmd.v === 'arrow', label: label(cmd.v === 'arrow' ? 'ne' : 'n') }]
    }
    case 'poly': {
      need(3, 'A polygon takes at least three points')
      if (s.fill === undefined) s.fill = true
      return [{ t: 'poly', pts, s, label: label('c') }]
    }
    case 'point': need(1, 'A point needs where: point (1, 2, 0) "A"'); return [{ t: 'dot', p: pts[0], s, label: label('ne') }]
    case 'text': {
      need(1, 'A text needs where: text (1, 2, 0) "words"')
      if (!strs.length) throw new Error('A text needs its words in quotes')
      return [{ t: 'text', p: pts[0], s, label: label('c')! }]
    }
    case 'axes': {
      need(1, 'Axes need where they start: axes (-2, 0, 0) 1')
      const o = pts[0], L = nums[0] ?? 1
      const names = [strs[0] ?? '$x_1$', strs[1] ?? '$x_2$', strs[2] ?? '$x_3$']
      const ax: V3[] = [[L, 0, 0], [0, L, 0], [0, 0, L]]
      const st: Style = { ...s, width: Math.min(s.width, 1.3) }
      return ax.map((d, i) => ({ t: 'line', pts: [o, [o[0] + d[0], o[1] + d[1], o[2] + d[2]]], s: st, arrow: true, label: { text: names[i], anchor: 'c' as Anchor } }))
    }
  }
  throw new Error(`“${cmd.v}” isn't something to draw: box, arrow, line, poly, point, text or axes`)
}

/* ----------------------------------------------------------------- the camera */

const rad = (d: number) => (d * Math.PI) / 180
/** toward the viewer */
export const viewDir = (c: Cam): V3 => [Math.cos(rad(c.az)) * Math.cos(rad(c.el)), Math.sin(rad(c.az)) * Math.cos(rad(c.el)), Math.sin(rad(c.el))]
/** screen x to the right, y up, and depth toward the viewer */
export function project(p: V3, c: Cam): { x: number; y: number; d: number } {
  const a = rad(c.az), e = rad(c.el)
  const x = -p[0] * Math.sin(a) + p[1] * Math.cos(a)
  const toward = p[0] * Math.cos(a) + p[1] * Math.sin(a)
  return { x, y: p[2] * Math.cos(e) - toward * Math.sin(e), d: toward * Math.cos(e) + p[2] * Math.sin(e) }
}

/** the six faces of a box, each with its corners (in order) and the way it faces */
export function boxFaces(a: V3, b: V3): { pts: V3[]; n: V3 }[] {
  const [x0, x1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])]
  const [y0, y1] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])]
  const [z0, z1] = [Math.min(a[2], b[2]), Math.max(a[2], b[2])]
  return [
    { pts: [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], n: [1, 0, 0] },
    { pts: [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], n: [-1, 0, 0] },
    { pts: [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], n: [0, 1, 0] },
    { pts: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], n: [0, -1, 0] },
    { pts: [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], n: [0, 0, 1] },
    { pts: [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]], n: [0, 0, -1] },
  ]
}

/** A worked example: the state of stress on a small cube. */
export const STRESS_CUBE = `# the stress on a small cube: x1 toward you, x2 right, x3 up
box (0,0,0) (3,3,3) blue
# the face facing x1
arrow (3,1.5,1.5) (4.4,1.5,1.5) blue "$\\sigma_{11}$" w
arrow (3,1.5,1.5) (3,2.5,1.5) orange "$\\tau_{12}$" s
arrow (3,1.5,1.5) (3,1.5,2.5) orange "$\\tau_{13}$" w
# the face facing x2
arrow (1.5,3,1.5) (1.5,4.4,1.5) blue "$\\sigma_{22}$" e
arrow (1.5,3,1.5) (2.5,3,1.5) orange "$\\tau_{21}$" s
arrow (1.5,3,1.5) (1.5,3,2.5) orange "$\\tau_{23}$" e
# the face facing x3
arrow (1.5,1.5,3) (1.5,1.5,4.4) blue "$\\sigma_{33}$" n
arrow (1.5,1.5,3) (2.5,1.5,3) orange "$\\tau_{31}$" w
arrow (1.5,1.5,3) (1.5,2.5,3) orange "$\\tau_{32}$" n
axes (4,-3,0) 1.2`

export const DIAGRAM_STARTER = `box (0,0,0) (2,2,2) blue
arrow (1,1,2) (1,1,3) blue "$\\sigma_{33}$" n
axes (3,-2,0) 1`
