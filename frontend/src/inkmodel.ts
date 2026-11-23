import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url'
import { combine, DIGITS, inputs, SYMBOLS, type Ink } from './inkclass'

/* The handwriting models (inkclass.ts) run in the page: onnxruntime-web on WebAssembly, served from this app, so it
   works offline and nothing leaves the computer. Loaded once, on first use (about 16 MB with the runtime). */

type Run = (chars: Ink[]) => Promise<number[][]>
let ready: Promise<Run> | null = null

async function load(): Promise<Run> {
  const ort = await import('onnxruntime-web/wasm')
  ort.env.wasm.wasmPaths = { wasm: new URL(wasmUrl, location.href).href }
  ort.env.wasm.numThreads = 1
  ort.env.logLevel = 'error'
  const open = async (file: string) => {
    const res = await fetch(new URL(`models/${file}`, new URL(import.meta.env.BASE_URL, location.href)))
    if (!res.ok) throw new Error(`could not load ${file}: HTTP ${res.status}`)
    return ort.InferenceSession.create(new Uint8Array(await res.arrayBuffer()), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' })
  }
  const [sym, dig] = await Promise.all([open(SYMBOLS.file), open(DIGITS.file)])
  const run = async (s: typeof sym, name: string, out: string, data: Float32Array, dims: number[]) => {
    const t = new ort.Tensor('float32', data, dims)
    const r = await s.run({ [name]: t })
    const v = (r[out].data as Float32Array).slice()
    t.dispose(); r[out].dispose()
    return v
  }
  return async (chars) => {
    const x = inputs(chars), S = SYMBOLS.size, D = DIGITS.size
    const [p, l] = await Promise.all([
      run(sym, SYMBOLS.input, SYMBOLS.output, x.sym, [chars.length, S, S, 1]),
      run(dig, DIGITS.input, DIGITS.output, x.dig, [chars.length * x.shears, 1, D, D]),
    ])
    return chars.map((_, i) => combine(p, l, i))
  }
}

/** one probability per LABEL for each character; rejects if the models can't run here */
export function classify(chars: Ink[]): Promise<number[][]> {
  ready ??= load().catch((e) => { ready = null; throw e })
  return ready.then((run) => run(chars))
}

/** start loading in the background, so the first character doesn't wait for it */
export function warm() { classify([[[0, 0, 10, 10]]]).catch(() => { /* tidying falls back to shape matching */ }) }
