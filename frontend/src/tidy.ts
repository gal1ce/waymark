import type { Stroke } from './api'
import { LABELS, type Ink } from './inkclass'

/* Tidy handwriting: as each character is finished on a board, a wobbly digit or sign is redrawn as a neat
   handwritten one of the same size, in the same place and ink. All in the page, on the pen-up, with no server.
   Which digit it is comes from two small CNNs (inkclass.ts, inkmodel.ts); straight-line signs (− | / + = ×) from
   their geometry; brackets, and the choice of how to draw the digit (a 7 with or without its bar, …), from the
   $P point-cloud recognizer (Vatavu, Anthony & Wobbrock 2012) against hand-drawn models. If the models can't load,
   $P reads the digits too. A shape it isn't sure of is left exactly as drawn. Nothing is turned into typed text. */

type XY = [number, number]
type Glyph = {
  ch: string
  /** model strokes in a box 1 high (y down) */
  strokes: XY[][]
}

// ---------------------------------------------------------------- the models, drawn as a careful hand would
const L = (...p: XY[]): XY[] => {
  const out: XY[] = []
  for (let i = 0; i + 1 < p.length; i++) {
    const [a, b] = [p[i], p[i + 1]], n = Math.max(2, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * 24))
    for (let k = i ? 1 : 0; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n])
  }
  return out
}
/** an arc of an ellipse, angles in degrees (0 = right, 90 = down) */
const A = (cx: number, cy: number, rx: number, ry: number, t0: number, t1: number): XY[] => {
  const n = Math.max(6, Math.ceil(Math.abs(t1 - t0) / 8)), out: XY[] = []
  for (let k = 0; k <= n; k++) { const t = ((t0 + ((t1 - t0) * k) / n) * Math.PI) / 180; out.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]) }
  return out
}
const Q = (a: XY, c: XY, b: XY): XY[] => {
  const out: XY[] = []
  for (let k = 0; k <= 16; k++) {
    const t = k / 16, u = 1 - t
    out.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]])
  }
  return out
}
const S = (...parts: XY[][]): XY[] => parts.flat()
/** a hand-traced line through these points, its corners rounded off (Chaikin) */
const C = (...p: XY[]): XY[] => {
  let q = p
  for (let k = 0; k < 3; k++) {
    const r: XY[] = [q[0]]
    for (let i = 0; i + 1 < q.length; i++) {
      const [a, b] = [q[i], q[i + 1]]
      r.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]], [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]])
    }
    r.push(q[q.length - 1]); q = r
  }
  return L(...q)
}

const GLYPHS: Glyph[] = [
  { ch: '0', strokes: [A(0.3, 0.5, 0.3, 0.5, -90, 270)] },
  { ch: '0', strokes: [A(0.42, 0.5, 0.42, 0.5, -90, 270)] },
  { ch: '1', strokes: [S(L([0.08, 0.2], [0.3, 0]), L([0.3, 0], [0.3, 1]))] },
  { ch: '1', strokes: [S(L([0.08, 0.2], [0.3, 0]), L([0.3, 0], [0.3, 1])), L([0.04, 1], [0.56, 1])] },
  { ch: '2', strokes: [S(A(0.3, 0.27, 0.27, 0.26, 195, 395), L([0.5, 0.45], [0.02, 1], [0.64, 1]))] },
  // a narrow 2, and one whose foot is a short curl rather than a long bar
  { ch: '2', strokes: [S(A(0.2, 0.2, 0.2, 0.2, 195, 400), Q([0.36, 0.33], [0.2, 0.75], [0.02, 1]), L([0.02, 1], [0.38, 0.98]))] },
  { ch: '2', strokes: [S(A(0.27, 0.25, 0.25, 0.24, 195, 395), Q([0.47, 0.42], [0.3, 0.8], [0.04, 0.98]), Q([0.04, 0.98], [0.2, 0.9], [0.5, 0.97]))] },
  { ch: '3', strokes: [S(A(0.27, 0.25, 0.25, 0.23, 205, 450), A(0.27, 0.73, 0.29, 0.25, -90, 160))] },
  // a 3 whose lower half runs long and low to the right
  { ch: '3', strokes: [C([0, 0.16], [0.04, 0.05], [0.27, 0], [0.53, 0.06], [0.71, 0.21], [0.69, 0.31], [0.57, 0.36], [0.74, 0.44], [1.0, 0.67], [1.19, 0.87], [1.2, 0.96], [1.06, 1], [0.85, 1], [0.59, 0.87])] },
  { ch: '4', strokes: [L([0.45, 0], [0.02, 0.66], [0.68, 0.66]), L([0.48, 0.34], [0.48, 1])] },
  { ch: '4', strokes: [L([0.48, 1], [0.48, 0], [0.02, 0.66], [0.68, 0.66])] },
  { ch: '5', strokes: [S(L([0.1, 0], [0.07, 0.46]), A(0.3, 0.67, 0.28, 0.31, -140, 150)), L([0.1, 0], [0.58, 0])] },
  { ch: '5', strokes: [S(L([0.58, 0], [0.1, 0], [0.07, 0.46]), A(0.3, 0.67, 0.28, 0.31, -140, 150))] },
  { ch: '6', strokes: [S(Q([0.52, 0], [0.04, 0.22], [0.04, 0.72]), A(0.3, 0.73, 0.26, 0.27, 180, -180))] },
  { ch: '7', strokes: [L([0, 0], [0.6, 0], [0.18, 1])] },
  { ch: '7', strokes: [L([0, 0], [0.6, 0], [0.18, 1]), L([0.1, 0.52], [0.56, 0.52])] },
  { ch: '7', strokes: [L([0, 0.14], [0.42, 0], [0.38, 1]), L([0.12, 0.62], [0.7, 0.62])] },
  { ch: '8', strokes: [S(A(0.3, 0.25, 0.22, 0.24, 0, -270), A(0.3, 0.73, 0.28, 0.26, -90, 270), A(0.3, 0.25, 0.22, 0.24, 90, 0))] },
  { ch: '9', strokes: [S(A(0.29, 0.28, 0.27, 0.28, 0, -360), L([0.56, 0.28], [0.52, 1]))] },
  { ch: '(', strokes: [Q([0.36, 0], [-0.08, 0.5], [0.36, 1])] },
  { ch: ')', strokes: [Q([0, 0], [0.44, 0.5], [0, 1])] },
  // look-alikes that are not digits: when one of these fits best, the ink is left as it is
  { ch: '', strokes: [S(L([0.04, 0.5], [0.62, 0.5]), A(0.33, 0.5, 0.29, 0.32, 0, -300))] },                 // e
  { ch: '', strokes: [S(A(0.3, 0.27, 0.26, 0.24, -20, -270), A(0.3, 0.73, 0.26, 0.24, -90, 160))] },       // s
  { ch: '', strokes: [S(A(0.3, 0.5, 0.28, 0.27, -20, 330), L([0.58, 0.25], [0.58, 0.78], [0.66, 0.8]))] }, // a
  { ch: '', strokes: [L([0, 0], [0.2, 1], [0.42, 0.3], [0.62, 1], [0.84, 0])] },                            // w
  { ch: '', strokes: [L([0, 0.5], [0.3, 1], [1, 0])] },                                                     // a tick
  { ch: '', strokes: [L([0.5, 0], [1, 0.9], [0, 0.9], [0.5, 0])] },                                         // a triangle
  { ch: '', strokes: [L([0, 0], [1, 0], [1, 0.8], [0, 0.8], [0, 0])] },                                     // a box
  { ch: '', strokes: [S(L([0.08, 0], [0.08, 1]), A(0.33, 0.74, 0.25, 0.26, 150, -180))] },                 // b
  { ch: '', strokes: [L([0, 0], [0.3, 1], [0.6, 0])] },                                                      // v
  { ch: '', strokes: [L([0, 0], [0.62, 0], [0, 1], [0.62, 1])] },                                            // z
  { ch: '', strokes: [L([0, 0], [0.6, 0.5], [0, 1])] },                                                      // >
]

// ---------------------------------------------------------------- $P
const N = 32
type Pt = { x: number; y: number; s: number }

const pairs = (pts: number[]): XY[] => { const o: XY[] = []; for (let i = 0; i + 1 < pts.length; i += 2) o.push([pts[i], pts[i + 1]]); return o }

/** the strokes as N evenly spaced points, scaled to a unit box and centred on their mean */
function cloud(strokes: XY[][]): Pt[] {
  const all: Pt[] = strokes.flatMap((s, i) => s.map(([x, y]) => ({ x, y, s: i })))
  let len = 0
  for (let i = 1; i < all.length; i++) if (all[i].s === all[i - 1].s) len += Math.hypot(all[i].x - all[i - 1].x, all[i].y - all[i - 1].y)
  const I = len / (N - 1) || 1
  const out: Pt[] = [all[0]]
  let D = 0
  for (let i = 1; i < all.length; i++) {
    if (all[i].s !== all[i - 1].s) continue
    let a = all[i - 1]
    const b = all[i]
    let d = Math.hypot(b.x - a.x, b.y - a.y)
    while (D + d >= I && out.length < N) {
      const t = (I - D) / d, q = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y), s: b.s }
      out.push(q); a = q; d = Math.hypot(b.x - a.x, b.y - a.y); D = 0
    }
    D += d
  }
  while (out.length < N) out.push(all[all.length - 1])
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of out) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y) }
  const k = Math.max(x1 - x0, y1 - y0) || 1
  const cx = out.reduce((s, p) => s + p.x, 0) / N, cy = out.reduce((s, p) => s + p.y, 0) / N
  return out.map((p) => ({ x: (p.x - cx) / k, y: (p.y - cy) / k, s: p.s }))
}

function cloudDistance(a: Pt[], b: Pt[], start: number): number {
  const used = new Array<boolean>(N).fill(false)
  let sum = 0, i = start
  do {
    let min = Infinity, idx = -1
    for (let j = 0; j < N; j++) if (!used[j]) { const d = Math.hypot(a[i].x - b[j].x, a[i].y - b[j].y); if (d < min) { min = d; idx = j } }
    used[idx] = true
    sum += (1 - ((i - start + N) % N) / N) * min
    i = (i + 1) % N
  } while (i !== start)
  return sum
}

function match(a: Pt[], b: Pt[]): number {
  const step = Math.floor(Math.sqrt(N))
  let min = Infinity
  for (let i = 0; i < N; i += step) min = Math.min(min, cloudDistance(a, b, i), cloudDistance(b, a, i))
  return min
}

/** width over height of the middle 80 % of the ink, so a bar that runs on past a 7 doesn't make it look wide */
function spread(c: Pt[]): number {
  const xs = c.map((p) => p.x).sort((a, b) => a - b), ys = c.map((p) => p.y).sort((a, b) => a - b)
  const lo = Math.floor(N * 0.1), hi = Math.ceil(N * 0.9) - 1
  return (xs[hi] - xs[lo]) / Math.max(ys[hi] - ys[lo], 1e-3)
}

const MODELS = GLYPHS.map((g) => { const c = cloud(g.strokes); return { g, c, aspect: spread(c) } })

// ---------------------------------------------------------------- reading a character
type Box = { x: number; y: number; w: number; h: number }
function boxOf(p: XY[]): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of p) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y) }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}
export const strokesBox = (ss: Stroke[]): Box => boxOf(ss.flatMap((s) => pairs(s.pts)))

/** how far a stroke strays from the straight line between its ends, as a share of that line's length */
function bend(p: XY[]): number {
  const [a, b] = [p[0], p[p.length - 1]], len = Math.hypot(b[0] - a[0], b[1] - a[1])
  if (len < 1) return Infinity
  let m = 0
  for (const [x, y] of p) m = Math.max(m, Math.abs((b[0] - a[0]) * (a[1] - y) - (a[0] - x) * (b[1] - a[1])) / len)
  // a line that runs on past its end and comes back isn't straight either
  let walk = 0
  for (let i = 1; i < p.length; i++) walk += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1])
  return Math.max(m / len, (walk / len - 1) / 2)
}

export const MAX_DIST = 1.5   // above this the shape is nobody's digit and stays as drawn (tuned on drawn samples)
const RIVAL = 1.2             // a runner-up this close means it could be either
const ASPECT = 2.0            // how much wider or narrower than the model a character may be
const STRAIGHT = 0.1          // a character-sized stroke this close to its chord is a line (− | /)
const STRAIGHT_LONG = 0.04    // a long one must be nearly straight already: a gentle curve is a drawing, left alone
const LONG = 160
const STRAIGHT_PART = 0.18    // the strokes of + = × may wander a little more

/** glyph: the model to redraw; none for the straight-line signs (− | / = + ×), which are neatened from the user's own lines */
export type Read = { ch: string; d: number; glyph: Glyph | null }

const deg = (a: XY, b: XY) => (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI
/** how far from horizontal (0) a line runs, 0–90 */
const tilt = (a: XY, b: XY) => { const t = Math.abs(deg(a, b)) % 180; return Math.min(t, 180 - t) }
const ends = (p: XY[]): [XY, XY] => [p[0], p[p.length - 1]]
const len = ([a, b]: [XY, XY]) => Math.hypot(b[0] - a[0], b[1] - a[1])

/** where two segments cross, if they do (each may fall a little short) */
function cross([a, b]: [XY, XY], [c, d]: [XY, XY], lo = -0.15, hi = 1.15): XY | null {
  const r = [b[0] - a[0], b[1] - a[1]], q = [d[0] - c[0], d[1] - c[1]], den = r[0] * q[1] - r[1] * q[0]
  if (Math.abs(den) < 1e-6) return null
  const t = ((c[0] - a[0]) * q[1] - (c[1] - a[1]) * q[0]) / den, u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den
  return t > lo && t < hi && u > lo && u < hi ? [a[0] + t * r[0], a[1] + t * r[1]] : null
}

/** A bracket runs up and down all the way: neither end turns off sideways, as the foot of a 2 or the top of a 7 does. */
function bracket(p: XY[]): boolean {
  let total = 0
  const cum = [0]
  for (let i = 1; i < p.length; i++) cum.push((total += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1])))
  const at = (d: number) => p[Math.max(0, cum.findIndex((c) => c >= d))]
  const head = tilt(p[0], at(total * 0.18)), tail = tilt(at(total * 0.82), p[p.length - 1])
  return head > 28 && tail > 28
}

/** two straight strokes: crossed (+ or ×) or one over the other (=) */
function signOf(ps: XY[][]): string | null {
  const [l1, l2] = ps.map(ends)
  const [t1, t2] = [tilt(...l1), tilt(...l2)], [lo, hi] = [Math.min(t1, t2), Math.max(t1, t2)]
  // both leaning: a times sign or an x, whose lines often cross off-centre
  if (lo > 22 && hi < 68 && cross(l1, l2, 0.15, 0.85)) return '×'
  // a + crosses near the middle of both lines; crossing at an end makes a T, ⊥ or ⊢
  if (cross(l1, l2, 0.28, 0.72)) return (lo < 25 && hi > 40) || (hi > 65 && lo < 50) ? '+' : null
  if (cross(l1, l2)) return null
  const flat = tilt(...l1) < 18 && tilt(...l2) < 18
  const xs = (l: [XY, XY]) => [Math.min(l[0][0], l[1][0]), Math.max(l[0][0], l[1][0])]
  const [a, b] = [xs(l1), xs(l2)], overlap = Math.min(a[1], b[1]) - Math.max(a[0], b[0])
  const gap = Math.abs((l1[0][1] + l1[1][1]) / 2 - (l2[0][1] + l2[1][1]) / 2), m = (len(l1) + len(l2)) / 2
  return flat && overlap > 0.4 * Math.min(len(l1), len(l2)) && gap > 0.08 * m && gap < 0.9 * m ? '=' : null
}

/** what the CNNs make of each character: one probability per inkclass LABEL */
export type Classifier = (chars: Ink[]) => Promise<number[][]>

export const P_MIN = 0.9      // the models must be at least this sure (tuned on MathWriting's isolated symbols)
export const P_CERTAIN = 0.97 // this sure, and both models on the same digit: the shape checks are skipped
const P_RATIO = 3             // and like it this much better than the next reading
const PAREN_D = 0.7           // how closely a stroke must follow a bracket model to be one
const AGREE_1 = 1.2           // a 1 drawn with its flag must really look like one: ] ! ∫ λ are upright strokes too
const DECOY = 0.85            // …clearly better
export const BOTH = true     // both models must see the same digit
export const AGREE = 2.2      // and the digit's own shape must not be far off: the models know 15 signs, so a letter reads as some digit

/** What these strokes are, if they are clearly one character; null leaves them alone. */
export async function read(ss: Stroke[], cls?: Classifier): Promise<Read | null> {
  const ps = ss.map((s) => pairs(s.pts)).filter((p) => p.length > 1)
  if (!ps.length || ps.length !== ss.length || ps.length > 3) return null
  const box = boxOf(ps.flat())
  if (Math.max(box.w, box.h) < 10) return null                       // a dot or a tick: nothing to tidy
  if (ps.length === 1 && bend(ps[0]) <= (Math.max(box.w, box.h) > LONG ? STRAIGHT_LONG : STRAIGHT)) return { ch: 'line', d: 0, glyph: null }
  if (ps.length === 2 && ps.every((p) => bend(p) <= STRAIGHT_PART)) {
    const ch = signOf(ps)
    if (ch) return { ch, d: 0, glyph: null }
  }
  // a dot in it (i j ! ÷ ;): not one of ours, and a model would read the rest as a 1
  if (ps.length > 1 && ps.some((p) => { const b = boxOf(p); return Math.max(b.w, b.h) < 0.15 * Math.max(box.w, box.h) })) return null
  const c = cloud(ps)
  if (!cls) return byShape(ps, c)
  let probs: number[]
  try { probs = (await cls([ss.map((s) => s.pts)]))[0] } catch { return byShape(ps, c) }
  const order = probs.slice(0, LABELS.length).map((p, i) => [p, i] as const).sort((a, b) => b[0] - a[0])
  const [[p1, i1], [p2]] = order, ch = LABELS[i1]
  // the models don't know brackets and take them for 1s: a curve that follows a bracket model closely is one
  // (a straight 1 never gets here, it was straightened above)
  const b = byShape(ps, c)
  if (b && (b.ch === '(' || b.ch === ')') && b.d < PAREN_D && (ch === '1' || p1 < P_MIN)) return b
  if (!(p1 >= P_MIN && p1 >= p2 * P_RATIO)) return null
  // a sign the models are sure of but the lines were too loose for the geometry above: still only straightened
  const loose = (k: number) => ps.every((p) => bend(p) <= k)
  if (ch === '−') return ps.length === 1 && loose(0.25) ? { ch: 'line', d: 0, glyph: null } : null
  if (ch === '+' || ch === '=' || ch === '×') return ps.length === 2 && loose(0.3) ? { ch, d: 0, glyph: null } : null
  if (!/[0-9]/.test(ch)) return null
  if (BOTH && probs[LABELS.length] === 0) return null
  // drawn after the model of that digit closest to how it was written
  let glyph: Glyph | null = null, d = Infinity
  for (const m of MODELS) if (m.g.ch === ch) { const x = match(c, m.c); if (x < d) { d = x; glyph = m.g } }
  if (!glyph) return null
  // unless both models are all but certain, the shape must agree too: a letter can look like a digit to them
  if (!(p1 >= P_CERTAIN && probs[LABELS.length] === 1)) {
    if (d > (ch === '1' ? AGREE_1 : AGREE)) return null
    // a letter that looks like a digit (b 6, z 2, v 0, > 7) is left alone when its own shape fits better
    for (const m of MODELS) if (!m.g.ch && match(c, m.c) < d * DECOY) return null
  }
  return { ch, d: 1 - p1, glyph }
}

/** $P alone: the closest model, if it is close and no other character comes near */
function byShape(ps: XY[][], c: Pt[]): Read | null {
  // the closest model of each kind; a bracket that turns off sideways at an end is kept out but still counts as a rival
  const near = new Map<string, { d: number; glyph: Glyph | null }>()
  for (const m of MODELS) {
    if (m.g.strokes.length !== ps.length) continue
    // the proportions must be roughly the model's: a wide loop round some working is not a zero
    const ra = Math.max(spread(c), 0.3), ga = Math.max(m.aspect, 0.3)
    if (Math.max(ra / ga, ga / ra) > ASPECT) continue
    const d = match(c, m.c)
    const k = (m.g.ch === '(' || m.g.ch === ')') && !bracket(ps[0]) ? '?' : m.g.ch
    if (d < (near.get(k)?.d ?? Infinity)) near.set(k, { d, glyph: k === '?' ? null : m.g })
  }
  const [a, b] = [...near.entries()].sort((x, y) => x[1].d - y[1].d)
  if (!a || a[1].d > MAX_DIST || !a[0] || a[0] === '?') return null
  // two different characters fit about as well: rather leave it as written than make it the wrong one
  // (a letter-like look-alike has to come closer: this is maths paper, digits are the likelier reading)
  if (b && b[1].d < a[1].d * (b[0] ? RIVAL : 1.08) && a[1].d > 0.45) return null
  return { ch: a[0], d: a[1].d, glyph: a[1].glyph }
}

// ---------------------------------------------------------------- redrawing it
const uid = () => Math.random().toString(36).slice(2, 10)

/** points along a path `step` px apart. The pen outline thickens where points crowd (it reads that as a slow, heavy
 *  hand), so the step copies the user's own: the neat stroke keeps the weight of the written one. */
function dense(p: XY[], step: number): number[] {
  // evenly spaced along the path: crowded model points would read as a heavy hand just as much as sparse ones as a light one
  const out: number[] = [p[0][0], p[0][1]]
  let carry = 0
  for (let i = 1; i < p.length; i++) {
    const [a, b] = [p[i - 1], p[i]], d = Math.hypot(b[0] - a[0], b[1] - a[1])
    let t = step - carry
    for (; t <= d; t += step) out.push(a[0] + ((b[0] - a[0]) * t) / d, a[1] + ((b[1] - a[1]) * t) / d)
    carry = d - (t - step)
  }
  const [lx, ly] = p[p.length - 1]
  if (Math.hypot(out[out.length - 2] - lx, out[out.length - 1] - ly) > 0.5) out.push(lx, ly)
  return out.map((v) => Math.round(v * 2) / 2)
}

/** The neat version of `ss` read as `r`, the same size, place, colour and pen as the user's. */
export function redraw(ss: Stroke[], r: Read): Stroke[] {
  const ink = { color: ss[0].color, size: ss[0].size }
  let walked = 0, steps = 0
  for (const s of ss) { const p = pairs(s.pts); for (let i = 1; i < p.length; i++) { walked += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]); steps++ } }
  const step = Math.min(30, Math.max(2, walked / Math.max(steps, 1)))
  const out = (lines: XY[][]) => lines.map((l) => ({ id: uid(), ...ink, pts: dense(l, step) }))
  if (!r.glyph) return out(neatLines(ss.map((s) => ends(pairs(s.pts))), r.ch))
  const g = r.glyph, gb = boxOf(g.strokes.flat()), ub = strokesBox(ss)
  const ga = gb.w / gb.h, ua = ub.w / Math.max(ub.h, 1)
  const h = ub.h, w = h * Math.min(ga * 1.3, Math.max(ga / 1.3, ua))
  // line the model's middle up with the middle of what was written (by where the ink is, not its frame)
  const cu = cloudMean(ss.map((s) => pairs(s.pts))), cg = cloudMean(g.strokes)
  const kx = w / (gb.w || 1), ky = h / gb.h
  const x0 = cu[0] - (cg[0] - gb.x) * kx
  return out(g.strokes.map((s) => s.map(([x, y]) => [x0 + (x - gb.x) * kx, ub.y + (y - gb.y) * ky] as XY)))
}

/** The straight signs, put right: a line nearly level or upright becomes exactly so; = gets two level lines of one
 *  length, one above the other; + and × get arms of one length crossing at their middles. */
function neatLines(ls: [XY, XY][], ch: string): XY[][] {
  const mid = (l: [XY, XY]): XY => [(l[0][0] + l[1][0]) / 2, (l[0][1] + l[1][1]) / 2]
  if (ch === 'line') {
    const [a, b] = ls[0], t = tilt(a, b), m = mid(ls[0]), h = len(ls[0]) / 2
    const flip = (l: XY[], back: boolean): XY[][] => [back ? l.reverse() : l]   // keep the way it was drawn
    if (t < 8) return flip([[m[0] - h, m[1]], [m[0] + h, m[1]]], a[0] > b[0])
    if (t > 82) return flip([[m[0], m[1] - h], [m[0], m[1] + h]], a[1] > b[1])
    return [[a, b]]
  }
  if (ch === '=') {
    const x0 = (Math.min(ls[0][0][0], ls[0][1][0]) + Math.min(ls[1][0][0], ls[1][1][0])) / 2
    const x1 = (Math.max(ls[0][0][0], ls[0][1][0]) + Math.max(ls[1][0][0], ls[1][1][0])) / 2
    return ls.map((l) => { const y = mid(l)[1]; return [[x0, y], [x1, y]] as XY[] })
  }
  const c = cross(ls[0], ls[1]) ?? mid(ls[0]), h = (len(ls[0]) + len(ls[1])) / 4
  if (ch === '+') return [[[c[0] - h, c[1]], [c[0] + h, c[1]]], [[c[0], c[1] - h], [c[0], c[1] + h]]]
  // ×: the two strokes leaning as steeply as the user's did on average, mirrored
  const a = ((tilt(...ls[0]) + tilt(...ls[1])) / 2) * (Math.PI / 180), dx = h * Math.cos(a), dy = h * Math.sin(a)
  return [[[c[0] - dx, c[1] - dy], [c[0] + dx, c[1] + dy]], [[c[0] + dx, c[1] - dy], [c[0] - dx, c[1] + dy]]]
}

function cloudMean(strokes: XY[][]): XY {
  // the mean of evenly spaced points: the middle of the ink, whatever the drawing speed was
  const pts: XY[] = []
  for (const s of strokes) for (let i = 1; i < s.length; i++) {
    const [a, b] = [s[i - 1], s[i]], n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1])))
    for (let k = 0; k < n; k++) pts.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n])
  }
  if (!pts.length) return strokes[0][0]
  return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length]
}

/** Does a new stroke belong to the character just written (the bar of a 7, the second line of =)? */
export function joins(prev: Stroke[], next: Stroke): boolean {
  const a = strokesBox(prev), b = strokesBox([next])
  const pad = 0.08 * Math.max(a.w, a.h) + 4
  const flat = a.h < 0.25 * a.w                                       // a − waiting to become =
  const px = pad, py = flat ? 0.6 * a.w : pad
  return b.x < a.x + a.w + px && b.x + b.w > a.x - px && b.y < a.y + a.h + py && b.y + b.h > a.y - py
}

// ---------------------------------------------------------------- the change, shown
/** n evenly spaced points along a stroke */
function along(pts: number[], n: number): XY[] {
  const p = pairs(pts), cum = [0]
  for (let i = 1; i < p.length; i++) cum.push(cum[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]))
  const total = cum[cum.length - 1] || 1, out: XY[] = []
  for (let k = 0, j = 1; k < n; k++) {
    const d = (total * k) / (n - 1)
    while (j < p.length - 1 && cum[j] < d) j++
    const span = cum[j] - cum[j - 1] || 1, t = Math.min(1, Math.max(0, (d - cum[j - 1]) / span))
    out.push(p.length > 1 ? [p[j - 1][0] + t * (p[j][0] - p[j - 1][0]), p[j - 1][1] + t * (p[j][1] - p[j - 1][1])] : p[0])
  }
  return out
}

export type Morph = { from: XY[]; to: XY[]; color: string; size: number }[]

/** Each neat stroke paired with the written stroke it grows out of (nearest first), both as the same number of points,
 *  so the ink can flow from one to the other. */
export function morph(raw: Stroke[], neat: Stroke[]): Morph {
  const M = 48, all = raw.map((s) => along(s.pts, M)), left = [...all]
  const mid = (p: XY[]): XY => [p.reduce((s, q) => s + q[0], 0) / p.length, p.reduce((s, q) => s + q[1], 0) / p.length]
  return neat.map((s) => {
    const to = along(s.pts, M), c = mid(to)
    // nearest unused written stroke; when the neat form has more strokes than were written, they share
    const pool = left.length ? left : all
    let bi = 0, bd = Infinity
    pool.forEach((p, i) => { const m = mid(p), d = Math.hypot(m[0] - c[0], m[1] - c[1]); if (d < bd) { bd = d; bi = i } })
    let from = (left.length ? left.splice(bi, 1)[0] : all[bi]) ?? to
    // run the same way as the neat stroke, or the ink would cross itself on the way
    const same = Math.hypot(from[0][0] - to[0][0], from[0][1] - to[0][1]) + Math.hypot(from[M - 1][0] - to[M - 1][0], from[M - 1][1] - to[M - 1][1])
    const flip = Math.hypot(from[M - 1][0] - to[0][0], from[M - 1][1] - to[0][1]) + Math.hypot(from[0][0] - to[M - 1][0], from[0][1] - to[M - 1][1])
    if (flip < same) from = [...from].reverse()
    return { from, to, color: s.color, size: s.size }
  })
}

/** the morph at t (0 = as written, 1 = neat) as pen points */
export const morphAt = (m: Morph, t: number) =>
  m.map((s) => ({ ...s, pts: s.from.flatMap((a, i) => [a[0] + (s.to[i][0] - a[0]) * t, a[1] + (s.to[i][1] - a[1]) * t]) }))
