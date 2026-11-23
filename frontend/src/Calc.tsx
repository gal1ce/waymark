import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useDrag } from './drag'
import { createPortal } from 'react-dom'
import { Calculator as CalcIcon, Delete, GripHorizontal, X } from 'lucide-react'
import { t as tr } from './i18n'

/* A calculator for the study sheets. Exact where it can be: whole numbers of any size and fractions are worked
   with BigInt, so 123456789 × 987654321 and 1/6 − 1/4 come out exactly (as −1/12, the form Khan asks for);
   only √, π and fractional powers fall back to decimals. */

// ------------------------------------------------------------------ numbers
type Num = { n: bigint; d: bigint } | { f: number }
const isQ = (x: Num): x is { n: bigint; d: bigint } => 'n' in x
const babs = (a: bigint) => (a < 0n ? -a : a)
const gcd = (a: bigint, b: bigint): bigint => { a = babs(a); b = babs(b); while (b) [a, b] = [b, a % b]; return a || 1n }
const q = (n: bigint, d: bigint = 1n): Num => {
  if (d === 0n) throw new Error(tr('Division by zero'))
  if (d < 0n) { n = -n; d = -d }
  const g = gcd(n, d)
  return { n: n / g, d: d / g }
}
const toF = (x: Num) => (isQ(x) ? Number(x.n) / Number(x.d) : x.f)
const fl = (f: number): Num => { if (!Number.isFinite(f)) throw new Error(tr('Not a real number')); return { f } }

function op(a: Num, b: Num, o: string): Num {
  if (isQ(a) && isQ(b)) {
    if (o === '+') return q(a.n * b.d + b.n * a.d, a.d * b.d)
    if (o === '-') return q(a.n * b.d - b.n * a.d, a.d * b.d)
    if (o === '*') return q(a.n * b.n, a.d * b.d)
    if (o === '/') return q(a.n * b.d, a.d * b.n)
    if (o === '^' && b.d === 1n && babs(b.n) <= 4096n) {
      const p = babs(b.n)
      const r = q(a.n ** p, a.d ** p)
      return b.n < 0n ? op(q(1n), r, '/') : r
    }
  }
  const x = toF(a), y = toF(b)
  if (o === '/' && y === 0) throw new Error(tr('Division by zero'))
  return fl(o === '+' ? x + y : o === '-' ? x - y : o === '*' ? x * y : o === '/' ? x / y : x ** y)
}

/** √ exact when the fraction is a perfect square (√(9/4) = 3/2), a decimal otherwise. */
function sqrt(a: Num): Num {
  if (isQ(a) && a.n >= 0n) {
    const r = (v: bigint) => { if (v < 2n) return v; let x = BigInt(Math.floor(Math.sqrt(Number(v)))); while (x * x > v) x--; while ((x + 1n) * (x + 1n) <= v) x++; return x }
    const n = r(a.n), d = r(a.d)
    if (n * n === a.n && d * d === a.d) return q(n, d)
  }
  return fl(Math.sqrt(toF(a)))
}

// ------------------------------------------------------------------ parsing
/** + − × ÷ ^ ( ) % √ π, "ans", and 2(3) or 2π as multiplication. */
export function evaluate(src: string, ans: Num | null): Num {
  const s = src.replace(/\s+/g, '').replace(/[×·]/g, '*').replace(/[÷:]/g, '/').replace(/[−–]/g, '-').replace(/,/g, '.').toLowerCase()
  let i = 0
  const peek = () => s[i]
  const fail = (): never => { throw new Error(i >= s.length ? tr('Unfinished expression') : tr('Unexpected “{c}”', { c: s[i] })) }
  const expr = (): Num => {
    let v = term()
    while (peek() === '+' || peek() === '-') { const o = s[i++]; v = op(v, term(), o) }
    return v
  }
  const term = (): Num => {
    let v = unary()
    for (;;) {
      const c = peek()
      if (c === '*' || c === '/') { i++; v = op(v, unary(), c) }
      else if (c === '(' || c === 'π' || c === '√' || (c && /[a-z]/.test(c))) v = op(v, power(), '*')   // 2(3), 2π, 3√2
      else return v
    }
  }
  const unary = (): Num => {
    if (peek() === '-') { i++; return op(q(0n), unary(), '-') }
    if (peek() === '+') { i++; return unary() }
    return power()
  }
  const power = (): Num => {
    let v = atom()
    while (peek() === '%') { i++; v = op(v, q(100n), '/') }
    if (peek() === '^') { i++; return op(v, unary(), '^') }   // right-assoc, and 2^-1 works
    return v
  }
  const atom = (): Num => {
    const c = peek()
    if (c === '(') { i++; const v = expr(); if (peek() !== ')') fail(); i++; return v }
    if (c === '√') { i++; return sqrt(power()) }
    if (c === 'π') { i++; return fl(Math.PI) }
    const w = /^[a-z]+/.exec(s.slice(i))?.[0]
    if (w) {
      i += w.length
      if (w === 'pi') return fl(Math.PI)
      if (w === 'ans') { if (!ans) throw new Error(tr('No earlier answer yet')); return ans }
      if (w === 'sqrt') return sqrt(atom())
      i -= w.length; fail()
    }
    const m = /^(\d+)(?:\.(\d*))?|^\.(\d+)/.exec(s.slice(i))
    if (!m) fail()
    i += m![0].length
    const whole = m![1] ?? '0', frac = m![2] ?? m![3] ?? ''
    return q(BigInt(whole + frac || '0'), 10n ** BigInt(frac.length))
  }
  if (!s) throw new Error(tr('Type a calculation'))
  const v = expr()
  if (i < s.length) fail()
  return v
}

const group = (digits: string) => (digits.length > 4 ? digits.replace(/\B(?=(\d{3})+(?!\d))/g, '\u2009') : digits)
const fmtInt = (n: bigint) => (n < 0n ? '−' : '') + group(babs(n).toString())
const fmtDec = (f: number) => {
  if (Number.isInteger(f) && Math.abs(f) < 1e15) return fmtInt(BigInt(f))
  const t = Math.abs(f) >= 1e15 || (Math.abs(f) < 1e-6 && f !== 0) ? f.toExponential(10).replace(/\.?0+e/, 'e') : String(Number(f.toPrecision(12)))
  return t.replace('-', '−')
}
/** The main result and, for a fraction, its decimal: "−1/12" with "≈ −0.0833333333". */
export function show(v: Num, decimal = false): { main: string; alt?: string } {
  if (!isQ(v)) return { main: fmtDec(v.f) }
  if (v.d === 1n) return { main: fmtInt(v.n) }
  const dec = toF(v)
  const whole = babs(v.n) / v.d
  const mixed = whole > 0n ? `${v.n < 0n ? '−' : ''}${group(whole.toString())} ${group((babs(v.n) % v.d).toString())}/${group(v.d.toString())}` : null
  const exact = Number.isInteger(dec * 1e10) && String(dec).length < 14
  const frac = `${fmtInt(v.n)}/${group(v.d.toString())}`
  // typed with decimals (2.5 × 1.2): the decimal first, the fraction beside it
  if (decimal && exact) return { main: fmtDec(dec), alt: `= ${frac}` }
  return { main: frac, alt: [mixed && `= ${mixed}`, `${exact ? '=' : '≈'} ${fmtDec(dec)}`].filter(Boolean).join('  ') }
}

// ------------------------------------------------------------------ open/closed, shared by every sheet
let open = false
const subs = new Set<() => void>()
const setOpen = (v: boolean) => { open = v; subs.forEach((f) => f()) }
export const toggleCalc = () => setOpen(!open)
const useOpen = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f) } }, () => open)

type Line = { expr: string; out: { main: string; alt?: string } }

/** The toolbar button of a sheet, and the calculator itself while it is open. */
export function CalcTool({ as: As }: { as: (p: { on: boolean; onClick: () => void; label: string; kbd?: string; children: React.ReactNode }) => React.ReactNode }) {
  const on = useOpen()
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (e.ctrlKey || e.metaKey || e.altKey || e.key.toLowerCase() !== 'c' || el?.closest('input, textarea, [contenteditable="true"]')) return
      e.preventDefault(); toggleCalc()
    }
    window.addEventListener('keydown', k)
    return () => { window.removeEventListener('keydown', k); setOpen(false) }
  }, [])
  return <>
    {As({ on, onClick: toggleCalc, label: tr('Calculator'), kbd: 'C', children: <CalcIcon size={16} strokeWidth={1.7} /> })}
    {on && createPortal(<Calculator onClose={() => setOpen(false)} />, document.body)}
  </>
}

const KEYS = ['(', ')', '%', '⌫', '7', '8', '9', '÷', '4', '5', '6', '×', '1', '2', '3', '−', '0', '.', '^', '+', '√', 'π', 'ans', '=']
const POS_KEY = 'ctu.calc.pos'

function Calculator({ onClose }: { onClose: () => void }) {
  const [expr, setExpr] = useState('')
  const [lines, setLines] = useState<Line[]>([])
  const [err, setErr] = useState<string | null>(null)
  const ans = useRef<Num | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const log = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const { pos, start } = useDrag(POS_KEY)

  useEffect(() => { if (window.matchMedia('(pointer: fine)').matches) input.current?.focus() }, [])
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }) }, [lines.length])

  const run = () => {
    if (!expr.trim()) return
    try {
      const v = evaluate(expr, ans.current)
      ans.current = v
      setLines((l) => [...l.slice(-30), { expr, out: show(v, /\d[.,]\d|^[.,]\d/.test(expr)) }]); setExpr(''); setErr(null)
    } catch (e) { setErr((e as Error).message) }
  }
  const press = (k: string) => {
    setErr(null)
    if (k === '=') return run()
    const el = input.current
    const a = el?.selectionStart ?? expr.length, b = el?.selectionEnd ?? expr.length
    if (k === '⌫') {
      const from = a === b ? Math.max(0, a - 1) : a
      setExpr(expr.slice(0, from) + expr.slice(b)); requestAnimationFrame(() => el?.setSelectionRange(from, from)); return
    }
    // an operator right after a result keeps working on it, like a pocket calculator
    const ins = !expr && lines.length && /^[+−×÷^%]$/.test(k) ? 'ans' + k : k === '√' ? '√(' : k
    setExpr(expr.slice(0, a) + ins + expr.slice(b))
    requestAnimationFrame(() => { el?.focus({ preventScroll: true }); el?.setSelectionRange(a + ins.length, a + ins.length) })
  }

  const place = pos && pos.x < window.innerWidth - 120 && pos.y < window.innerHeight - 60 ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' } : undefined

  return (
    <div className="calc" ref={box} role="dialog" aria-label={tr('Calculator')} style={place}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}>
      <div className="calc-head" onPointerDown={(e) => start(e, box.current)}>
        <GripHorizontal size={14} strokeWidth={1.6} className="calc-grip" />
        <span className="calc-t">{tr('Calculator')}</span>
        {lines.length > 0 && <button className="mini" onClick={() => { setLines([]); ans.current = null }}>{tr('Clear')}</button>}
        <button className="icon-btn" onClick={onClose} aria-label={tr('Close')} title={`${tr('Close')}  C`}><X size={15} strokeWidth={1.5} /></button>
      </div>
      <div className="calc-log" ref={log} aria-live="polite">
        {lines.length === 0 && <div className="calc-empty">{tr('Exact with whole numbers and fractions: 1/6 − 1/4 gives −1/12.')}</div>}
        {lines.map((l, i) => (
          <button key={i} className="calc-line" title={tr('Use this result')} onClick={() => press(l.out.main.replace(/ /g, '').replace('−', '-'))}>
            <span className="calc-e mono">{l.expr} =</span>
            <span className="calc-r mono">{l.out.main}</span>
            {l.out.alt && <span className="calc-a mono">{l.out.alt}</span>}
          </button>
        ))}
      </div>
      <form className="calc-in" onSubmit={(e) => { e.preventDefault(); run() }}>
        <input ref={input} className={'input mono' + (err ? ' bad' : '')} value={expr} spellCheck={false} autoComplete="off" inputMode="decimal"
          placeholder="12 × (3 + 4)" aria-label={tr('Calculation')} aria-invalid={!!err}
          onChange={(e) => { setExpr(e.target.value); setErr(null) }} />
      </form>
      {err && <div className="calc-err" role="alert">{err}</div>}
      <div className="calc-keys" onMouseDown={(e) => e.preventDefault()}>
        {KEYS.map((k) => (
          <button key={k} type="button" className={'key' + (/^[0-9.]$/.test(k) ? ' digit' : k === '=' ? ' eq' : '')} onClick={() => press(k)} aria-label={k === '⌫' ? tr('Delete') : k}>
            {k === '⌫' ? <Delete size={16} strokeWidth={1.7} /> : k}
          </button>
        ))}
      </div>
    </div>
  )
}
