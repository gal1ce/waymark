/* Reading one handwritten character with two small CNNs (public/models, see NOTICE.md): a symbol model for 0-9 + ÷ = × −
   and an MNIST digit model that helps decide which digit. The strokes are drawn into the models' own image format
   (light ink on black, cropped square with a margin; MNIST centred by mass), as in CalcInk (MIT), from which the
   rasteriser and the way the two are combined are adapted. Pure: inkmodel.ts runs the models in the page, the
   evaluation script runs the same code in node. */

export const LABELS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '+', '÷', '=', '×', '−'] as const
export type Label = (typeof LABELS)[number]

export const SYMBOLS = { file: 'symbols-cnn.onnx', input: 'input', output: 'probs', size: 64, margin: 0.15, width: 4.6 } as const
export const DIGITS = { file: 'digits-mnist.onnx', input: 'image', output: 'logits', size: 28, margin: 0.2, width: 1.6 } as const
const ALPHA = 0.6                  // weight of the symbol model against MNIST for digits (picked by CalcInk on real handwriting)
const TEMPERATURE = 2              // the symbol model is overconfident on hands it hasn't seen
const SHEARS = [-0.2, 0, 0.2]      // MNIST sees three slants of the digit, averaged

/** strokes as flat [x, y, x, y, …] */
export type Ink = number[][]

export function rasterize(strokes: Ink, out: Float32Array, o: { size: number; margin: number; width: number; mass?: boolean }) {
  const { size, margin, width } = o
  out.fill(0)
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of strokes) for (let i = 0; i + 1 < p.length; i += 2) {
    x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1])
  }
  if (!Number.isFinite(x0)) return
  const span = size / (1 + 2 * margin), extent = Math.max(x1 - x0, y1 - y0)
  const k = extent > 1e-6 ? Math.max(0, span - width) / extent : 0
  let ox = size / 2 - ((x0 + x1) / 2) * k, oy = size / 2 - ((y0 + y1) / 2) * k
  if (o.mass) {
    draw(strokes, out, size, k, ox, oy, width / 2)
    let m = 0, mx = 0, my = 0
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { const v = out[y * size + x]; m += v; mx += v * (x + 0.5); my += v * (y + 0.5) }
    if (m > 0) { ox += size / 2 - mx / m; oy += size / 2 - my / m }
    out.fill(0)
  }
  draw(strokes, out, size, k, ox, oy, width / 2)
}

function draw(strokes: Ink, img: Float32Array, size: number, k: number, ox: number, oy: number, r: number) {
  for (const p of strokes) {
    const n = p.length >> 1
    if (n === 1) capsule(img, size, p[0] * k + ox, p[1] * k + oy, p[0] * k + ox, p[1] * k + oy, r)
    for (let i = 1; i < n; i++) capsule(img, size, p[2 * i - 2] * k + ox, p[2 * i - 1] * k + oy, p[2 * i] * k + ox, p[2 * i + 1] * k + oy, r)
  }
}

function capsule(img: Float32Array, size: number, ax: number, ay: number, bx: number, by: number, r: number) {
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r - 1)), x1 = Math.min(size - 1, Math.ceil(Math.max(ax, bx) + r + 1))
  const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r - 1)), y1 = Math.min(size - 1, Math.ceil(Math.max(ay, by) + r + 1))
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const px = x + 0.5, py = y + 0.5
    let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0
    t = t < 0 ? 0 : t > 1 ? 1 : t
    const v = r + 0.5 - Math.hypot(ax + t * dx - px, ay + t * dy - py)
    if (v > 0) { const i = y * size + x, c = v >= 1 ? 1 : v; if (c > img[i]) img[i] = c }
  }
}

const shear = (s: Ink, k: number): Ink => s.map((p) => p.map((v, i) => (i % 2 ? v : v + k * p[i + 1])))

/** the two model inputs for a batch of characters */
export function inputs(chars: Ink[]) {
  const S = SYMBOLS.size ** 2, D = DIGITS.size ** 2
  const sym = new Float32Array(chars.length * S), dig = new Float32Array(chars.length * SHEARS.length * D)
  chars.forEach((c, i) => {
    rasterize(c, sym.subarray(i * S, (i + 1) * S), SYMBOLS)
    SHEARS.forEach((k, j) => rasterize(k ? shear(c, k) : c, dig.subarray((i * SHEARS.length + j) * D, (i * SHEARS.length + j + 1) * D), { ...DIGITS, mass: true }))
  })
  return { sym, dig, shears: SHEARS.length }
}

/** the models' outputs for character i: one probability per LABEL, then 1 if both models' best digit is the same, else 0 */
export function combine(sym: Float32Array, logits: Float32Array, i: number): number[] {
  const L = LABELS.length
  let p = Array.from(sym.subarray(i * L, (i + 1) * L), (v) => Math.pow(Math.max(v, 1e-12), 1 / TEMPERATURE))
  const z = p.reduce((a, b) => a + b, 0)
  p = p.map((v) => v / z)
  // MNIST, averaged over the slants (log-softmax), decides between the digits within the symbol model's digit share
  const avg = new Array<number>(10).fill(0)
  for (let r = i * SHEARS.length; r < (i + 1) * SHEARS.length; r++) {
    const row = logits.subarray(r * 10, r * 10 + 10), m = Math.max(...row)
    const lz = m + Math.log(row.reduce((a, v) => a + Math.exp(v - m), 0))
    for (let d = 0; d < 10; d++) avg[d] += (row[d] - lz) / SHEARS.length
  }
  const mass = p.slice(0, 10).reduce((a, b) => a + b, 0)
  if (mass <= 0) return p
  const top = Math.max(...avg), e = avg.map((v) => Math.exp(v - top)), ze = e.reduce((a, b) => a + b, 0)
  const pm = e.map((v) => v / ze)
  const mix = p.slice(0, 10).map((v, d) => Math.pow(v / mass + 1e-6, ALPHA) * Math.pow(pm[d] + 1e-6, 1 - ALPHA))
  const zm = mix.reduce((a, b) => a + b, 0)
  for (let d = 0; d < 10; d++) p[d] = (mass * mix[d]) / zm
  // both models on the same digit? (a letter tends to split them: one sees a 6, the other a 5)
  const argmax = (a: number[]) => a.indexOf(Math.max(...a))
  p.push(argmax(Array.from(sym.subarray(i * L, i * L + 10))) === argmax(pm) ? 1 : 0)
  return p
}
