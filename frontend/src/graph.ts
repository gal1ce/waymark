/** A small, safe maths parser for the notebook's graphs. It reads what people type into Desmos:
 *    y = 2x^2 - 3      f(x) = sin(x)/x      x = y^2      x^2 + y^2 = 9      y > |x|      (1, 2)
 *    a = 2  (a slider)   y = a x^2  (uses it)   g(x) = f(x) + 1  (uses f)      2^10  (just a value)
 *  Each line becomes closures over x, y, the sliders and the functions; nothing is ever passed to eval. */

type Node =
  | { k: 'num'; v: number }
  | { k: 'id'; name: string }
  | { k: 'neg'; a: Node }
  | { k: 'bin'; op: '+' | '-' | '*' | '/' | '^'; a: Node; b: Node }
  | { k: 'call'; name: string; args: Node[] }
  | { k: 'fact'; a: Node }

const FNS: Record<string, (...a: number[]) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, sec: (x) => 1 / Math.cos(x), csc: (x) => 1 / Math.sin(x), cot: (x) => 1 / Math.tan(x),
  asin: Math.asin, acos: Math.acos, atan: Math.atan, arcsin: Math.asin, arccos: Math.acos, arctan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, exp: Math.exp, ln: Math.log, log: Math.log10, lg: Math.log10, log2: Math.log2,
  floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign, sgn: Math.sign,
  min: Math.min, max: Math.max, mod: (a, b) => ((a % b) + b) % b,
}
const CONSTS: Record<string, number> = { pi: Math.PI, 'π': Math.PI, e: Math.E, tau: 2 * Math.PI, 'τ': 2 * Math.PI }
const BUILTIN = [...Object.keys(FNS), ...Object.keys(CONSTS)]

type Tok = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: string }

function lex(src: string, userFns: Set<string>): Tok[] {
  // spaces separate names ("a sin x" is a times sin x) but are otherwise ignored
  const s = src.replace(/\s+/g, ' ').replace(/[×·]/g, '*').replace(/÷/g, '/').replace(/[−–]/g, '-').replace(/\*\*/g, '^')
  const names = [...BUILTIN, ...userFns].sort((a, b) => b.length - a.length)
  const out: Tok[] = []
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === ' ') { i++; continue }
    if (/[0-9.]/.test(c)) {
      const m = /^\d*\.?\d+(e[+-]?\d+)?|^\d+\.?/.exec(s.slice(i))
      if (!m) throw new Error(`Can't read the number at "${s.slice(i, i + 6)}"`)
      out.push({ t: 'num', v: Number(m[0]) }); i += m[0].length; continue
    }
    if (/[a-zA-Zπτ]/.test(c)) {
      const m = /^[a-zA-Zπτ][a-zA-Z]*/.exec(s.slice(i))![0]
      // a run of letters is known names and single-letter variables: "xsin" → x sin, "2pix" → 2 pi x, "ab" → a b
      let w = m
      while (w) {
        const lw = w.toLowerCase()
        const hit = names.find((n) => lw.startsWith(n.toLowerCase()) && (n.length > 1 || userFns.has(n)))
        if (hit) { out.push({ t: 'id', v: hit }); w = w.slice(hit.length); continue }
        out.push({ t: 'id', v: w[0] === 'π' || w[0] === 'τ' ? w[0] : w[0] }); w = w.slice(1)
      }
      i += m.length; continue
    }
    if (c === '_' && out.length && out[out.length - 1].t === 'id') {   // subscripts: a_1 is one name
      const m = /^_\{?([a-zA-Z0-9]+)\}?/.exec(s.slice(i))
      if (m) { const prev = out.pop() as { t: 'id'; v: string }; out.push({ t: 'id', v: `${prev.v}_${m[1]}` }); i += m[0].length; continue }
    }
    if ('+-*/^(),|!'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue }
    throw new Error(`Unexpected "${c}"`)
  }
  return out
}

function parse(toks: Tok[], userFns: Set<string>): Node {
  let p = 0
  const peek = () => toks[p]
  const isOp = (v: string) => peek()?.t === 'op' && peek()!.v === v
  const eat = (v: string) => { if (!isOp(v)) throw new Error(`Expected "${v}"`); p++ }
  const startsValue = () => { const t = peek(); return !!t && (t.t === 'num' || t.t === 'id' || (t.t === 'op' && (t.v === '(' || t.v === '|'))) }
  let inAbs = 0

  function expr(): Node {
    let a = term()
    while (isOp('+') || isOp('-')) { const op = (toks[p++] as { v: '+' | '-' }).v; a = { k: 'bin', op, a, b: term() } }
    return a
  }
  function term(): Node {
    let a = unary()
    for (;;) {
      if (isOp('*') || isOp('/')) { const op = (toks[p++] as { v: '*' | '/' }).v; a = { k: 'bin', op, a, b: unary() }; continue }
      if (startsValue() && !(isOp('|') && inAbs > 0)) { a = { k: 'bin', op: '*', a, b: power() }; continue }
      return a
    }
  }
  function unary(): Node {
    if (isOp('-')) { p++; return { k: 'neg', a: unary() } }
    if (isOp('+')) { p++; return unary() }
    return power()
  }
  function power(): Node {
    const base = postfix()
    if (isOp('^')) { p++; return { k: 'bin', op: '^', a: base, b: unary() } }
    return base
  }
  function postfix(): Node {
    let a = atom()
    while (isOp('!')) { p++; a = { k: 'fact', a } }
    return a
  }
  function atom(): Node {
    const t = peek()
    if (!t) throw new Error('The expression ends too early')
    if (t.t === 'num') { p++; return { k: 'num', v: t.v } }
    if (t.t === 'op' && t.v === '(') { p++; const a = expr(); eat(')'); return a }
    if (t.t === 'op' && t.v === '|') { p++; inAbs++; const a = expr(); inAbs--; eat('|'); return { k: 'call', name: 'abs', args: [a] } }
    if (t.t === 'id') {
      p++
      if (t.v in CONSTS) return { k: 'num', v: CONSTS[t.v] }
      if (t.v in FNS || userFns.has(t.v)) {
        let pow: Node | null = null
        if (isOp('^')) { p++; pow = postfix() }          // sin^2(x)
        let args: Node[]
        if (isOp('(')) {
          p++; args = [expr()]
          while (isOp(',')) { p++; args.push(expr()) }
          eat(')')
        } else if (t.v in FNS) args = [power()]           // sin x
        else throw new Error(`${t.v} is a function: write ${t.v}(…)`)
        const call: Node = { k: 'call', name: t.v, args }
        return pow ? { k: 'bin', op: '^', a: call, b: pow } : call
      }
      return { k: 'id', name: t.v }
    }
    throw new Error(`Unexpected "${(t as { v: string }).v}"`)
  }
  const n = expr()
  if (p < toks.length) throw new Error(`Unexpected "${(toks[p] as { v: string }).v}"`)
  return n
}

const fact = (n: number) => { if (n < 0 || !Number.isInteger(n)) return NaN; let r = 1; for (let i = 2; i <= n && r < Infinity; i++) r *= i; return r }

/** Names a node reads, other than calls. */
function free(n: Node, out = new Set<string>()): Set<string> {
  switch (n.k) {
    case 'id': out.add(n.name); break
    case 'neg': case 'fact': free(n.a, out); break
    case 'bin': free(n.a, out); free(n.b, out); break
    case 'call': n.args.forEach((a) => free(a, out)); break
  }
  return out
}
function calls(n: Node, out = new Set<string>()): Set<string> {
  switch (n.k) {
    case 'neg': case 'fact': calls(n.a, out); break
    case 'bin': calls(n.a, out); calls(n.b, out); break
    case 'call': out.add(n.name); n.args.forEach((a) => calls(a, out)); break
  }
  return out
}

type Env = { vars: Record<string, number>; fns: Record<string, (...a: number[]) => number> }
type F = (env: Env) => number

function compile(n: Node): F {
  switch (n.k) {
    case 'num': { const v = n.v; return () => v }
    case 'id': { const name = n.name; return (e) => e.vars[name] ?? NaN }
    case 'neg': { const a = compile(n.a); return (e) => -a(e) }
    case 'fact': { const a = compile(n.a); return (e) => fact(a(e)) }
    case 'call': {
      const name = n.name, args = n.args.map(compile)
      const builtin = FNS[name]
      if (builtin && args.length === 1) { const a = args[0]; return (e) => builtin(a(e)) }
      return (e) => { const f = builtin ?? e.fns[name]; return f ? f(...args.map((g) => g(e))) : NaN }
    }
    case 'bin': {
      const a = compile(n.a), b = compile(n.b)
      switch (n.op) {
        case '+': return (e) => a(e) + b(e)
        case '-': return (e) => a(e) - b(e)
        case '*': return (e) => a(e) * b(e)
        case '/': return (e) => a(e) / b(e)
        case '^': return (e) => {
          const u = a(e), v = b(e)
          // odd roots of negatives: (-8)^(1/3) = -2, like a calculator
          if (u < 0 && !Number.isInteger(v)) { const q = 1 / v; if (Math.abs(q - Math.round(q)) < 1e-9 && Math.abs(Math.round(q)) % 2 === 1) return -Math.pow(-u, v) }
          return Math.pow(u, v)
        }
      }
    }
  }
}

export type Rel = '=' | '<' | '>' | '<=' | '>='
/** Where a label sits around its spot (compass points); `c` is centred on the spot and the point itself isn't drawn. */
export type Anchor = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | 'c'
export type Label = { text: string; anchor: Anchor }
export type Plot =
  | { kind: 'fn'; f: (x: number) => number }                         // y = f(x)
  | { kind: 'fny'; f: (y: number) => number }                        // x = g(y), x = 3
  | { kind: 'implicit'; F: (x: number, y: number) => number }        // F(x, y) = 0
  | { kind: 'region'; test: (x: number, y: number) => boolean; edge: Plot | null; strict: boolean }
  | { kind: 'param'; x: (t: number) => number; y: (t: number) => number; t0: number; t1: number }   // (cos t, sin t) {0 < t < pi}
  | { kind: 'segment'; a: [number, number]; b: [number, number]; label?: Label }                    // segment((0, 0), (3, 4))
  | { kind: 'point'; x: number; y: number; label?: Label }
  | { kind: 'slider'; name: string; value: number }
  | { kind: 'value'; value: number }
  | { kind: 'empty' }
  | { kind: 'error'; message: string; missing?: string[] }

export type Line = { expr: string; hidden?: boolean }
export type Read = Plot & { def?: string; what?: string }

const REL_RE = /(<=|>=|≤|≥|<|>|=)/
const normRel = (r: string): Rel => (r === '≤' ? '<=' : r === '≥' ? '>=' : (r as Rel))
const SLIDER_NAME = /^[a-wzA-WZα-ω](_[a-zA-Z0-9]+)?$/       // any single letter but x and y
const FN_DEF = /^([a-wzA-WZ])\(([a-z])\)$/
const ANCHOR = /^(ne|nw|se|sw|n|s|e|w|c)$/

/** A line in its parts: the maths, a restriction at its end in braces ({0 < x < 3}) and a label in quotes after
 *  that ("X", optionally followed by where it sits: n, ne, e, se, s, sw, w, nw, or c for the label alone). */
export function splitLine(src: string): { main: string; cond?: string; label?: Label } {
  let main = src.trim(), cond: string | undefined, label: Label | undefined
  const lm = /"([^"]*)"\s*([a-z]{1,2})?\s*$/.exec(main)
  if (lm && (!lm[2] || ANCHOR.test(lm[2]))) { label = { text: lm[1], anchor: (lm[2] ?? 'ne') as Anchor }; main = main.slice(0, lm.index).trim() }
  const cm = /\{([^{}]*)\}\s*$/.exec(main)
  if (cm) { cond = cm[1]; main = main.slice(0, cm.index).trim() }
  return { main, cond, label }
}

/** Splits at the commas that aren't inside brackets. */
function topSplit(s: string): string[] {
  const out: string[] = []
  let d = 0, from = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '(') d++
    else if (c === ')') d--
    else if (c === ',' && d === 0) { out.push(s.slice(from, i)); from = i + 1 }
  }
  out.push(s.slice(from))
  return out.map((x) => x.trim())
}
/** "(a, b)" as its two halves, when the brackets wrap the whole thing. */
function pairOf(src: string): [string, string] | null {
  const s = src.trim()
  if (!s.startsWith('(') || !s.endsWith(')')) return null
  let d = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') d++
    else if (s[i] === ')' && --d === 0 && i < s.length - 1) return null
  }
  const parts = topSplit(s.slice(1, -1))
  return parts.length === 2 && parts.every(Boolean) ? [parts[0], parts[1]] : null
}
const SEGMENT = /^segment\s*\((.*)\)$/

/** {0 < x < 3, y > 0}: clauses, each a chain of comparisons. */
type Cond = { nodes: Node[]; rels: Rel[] }[]
function parseCond(src: string, userFns: Set<string>): Cond {
  return topSplit(src).map((cl) => {
    const parts = cl.split(REL_RE)
    if (parts.length < 3 || parts.length % 2 === 0 || parts.some((x, i) => i % 2 === 0 && !x.trim())) throw new Error('A restriction compares, like {0 < x < 3}')
    const rels = parts.filter((_, i) => i % 2 === 1).map(normRel)
    if (rels.includes('=')) throw new Error('A restriction uses < or >, not =')
    return { nodes: parts.filter((_, i) => i % 2 === 0).map((x) => parse(lex(x, userFns), userFns)), rels }
  })
}
const cmp = (a: number, b: number, r: Rel) => (r === '<' ? a < b : r === '<=' ? a <= b : r === '>' ? a > b : a >= b)

/** Reads every line of one graph together: sliders and functions defined on one line are used by the others. */
export function readAll(lines: Line[], over: Record<string, number> = {}): Read[] {
  // 1. what each line defines
  const userFns = new Set<string>()
  for (const l of lines) {
    const m = FN_DEF.exec(l.expr.split('=')[0]?.replace(/\s/g, '') ?? '')
    if (m && l.expr.includes('=')) userFns.add(m[1])
  }
  type Pre = ({ lhs?: Node; rhs: Node; rel?: Rel; fnDef?: { name: string; arg: string }; slider?: string; point?: [Node, Node]; seg?: [Node, Node][] }
    & { cond?: Cond; label?: Label }) | { error: string } | { empty: true }
  const pre: Pre[] = lines.map((l): Pre => {
    const { main: s, cond: condSrc, label } = splitLine(l.expr)
    if (!s) return label || condSrc != null ? { error: 'Write the point first: (1, 2) "A"' } : { empty: true }
    try {
      const P = (x: string) => parse(lex(x, userFns), userFns)
      const zero: Node = { k: 'num', v: 0 }
      const cond = condSrc != null ? parseCond(condSrc, userFns) : undefined
      const sg = SEGMENT.exec(s)
      if (sg) {
        const ends = topSplit(sg[1]).map(pairOf)
        if (ends.length !== 2 || !ends[0] || !ends[1]) throw new Error('A segment joins two points: segment((0, 0), (3, 4))')
        return { rhs: zero, seg: ends.map((e) => [P(e![0]), P(e![1])] as [Node, Node]), label, cond }
      }
      const pt = pairOf(s)
      if (pt) return { rhs: zero, point: [P(pt[0]), P(pt[1])], label, cond }
      if (label) throw new Error('Only points and segments take a label: (1, 2) "A"')
      const parts = s.split(REL_RE)
      if (parts.length > 3) throw new Error('Only one = or < per line')
      if (parts.length === 1) return { rhs: parse(lex(s, userFns), userFns), cond }
      const [ls, r, rs] = parts
      const rel = normRel(r)
      const lc = ls.replace(/\s/g, '')
      const fd = FN_DEF.exec(lc)
      if (fd && rel === '=') return { rhs: parse(lex(rs, userFns), userFns), fnDef: { name: fd[1], arg: fd[2] }, cond }
      if (rel === '=' && SLIDER_NAME.test(lc) && lc !== 'e') {
        if (cond) throw new Error('A slider takes no restriction')
        return { rhs: parse(lex(rs, userFns), userFns), slider: lc }
      }
      return { lhs: parse(lex(ls, userFns), userFns), rhs: parse(lex(rs, userFns), userFns), rel, cond }
    } catch (e) {
      return { error: (e as Error).message }
    }
  })

  // 2. sliders: a = 2 (a value), b = 2a (a value from another slider); resolved in passes
  const vars: Record<string, number> = {}
  const sliderLines = new Map<string, number>()
  pre.forEach((p, i) => { if ('slider' in p && p.slider && !(p.slider in sliderLines)) sliderLines.set(p.slider, i) })
  const env: Env = { vars, fns: {} }
  for (let pass = 0; pass < 6; pass++) {
    for (const [name, i] of sliderLines) {
      const p = pre[i] as Extract<Pre, { rhs: Node }>
      const fv = free(p.rhs)
      if ([...fv].every((v) => v in vars && v !== name)) vars[name] = name in over ? over[name] : compile(p.rhs)(env)
    }
  }

  // 3. functions: f(x) = …, may call each other (depth-limited)
  let depth = 0
  pre.forEach((p) => {
    if (!('fnDef' in p) || !p.fnDef) return
    const body = compile(p.rhs), arg = p.fnDef.arg
    env.fns[p.fnDef.name] = (v: number) => {
      if (depth > 40) return NaN
      depth++
      const saved = vars[arg]
      vars[arg] = v
      try { return body(env) } finally { if (saved === undefined) delete vars[arg]; else vars[arg] = saved; depth-- }
    }
  })

  const known = (names: Set<string>, allowed: string[]) => [...names].filter((n) => !allowed.includes(n) && !(n in vars))
  const at = (F: F) => (x: number, y: number) => { vars.x = x; vars.y = y; const r = F(env); return r }
  const atX = (F: F) => (x: number) => { vars.x = x; return F(env) }
  const atY = (F: F) => (y: number) => { vars.y = y; return F(env) }
  const missingErr = (m: string[]): Read => ({ kind: 'error', missing: m, message: m.length === 1 ? `“${m[0]}” isn't defined yet` : `${m.map((x) => `“${x}”`).join(', ')} aren't defined yet` })

  // a restriction: the names it may use, a test of the current x, y (and t), and the range it gives t
  const isT = (n: Node) => n.k === 'id' && n.name === 't'
  const condOf = (c: Cond, allowed: string[]) => {
    const names = new Set<string>()
    c.forEach((cl) => cl.nodes.forEach((n) => free(n, names)))
    const missing = known(names, allowed)
    const fs = c.map((cl) => cl.nodes.map(compile))
    const ok = () => c.every((cl, k) => cl.rels.every((r, i) => cmp(fs[k][i](env), fs[k][i + 1](env), r)))
    let lo: number | undefined, hi: number | undefined
    c.forEach((cl) => cl.rels.forEach((r, i) => {
      const a = cl.nodes[i], b = cl.nodes[i + 1], below = r === '<' || r === '<='
      const constant = (n: Node) => { const f = free(n); return !f.has('t') && !f.has('x') && !f.has('y') }
      if (isT(a) && constant(b)) { const v = compile(b)(env); if (below) hi = Math.min(hi ?? v, v); else lo = Math.max(lo ?? v, v) }
      else if (isT(b) && constant(a)) { const v = compile(a)(env); if (below) lo = Math.max(lo ?? v, v); else hi = Math.min(hi ?? v, v) }
    }))
    return { missing, ok, lo, hi }
  }
  /** The drawing cut to where the restriction holds: outside it the curve is undefined, so it stops there. */
  const mask = (r: Read, ok: () => boolean): Read => {
    switch (r.kind) {
      case 'fn': { const f = r.f; return { ...r, f: (x) => { const y = f(x); if (!Number.isFinite(y)) return NaN; vars.x = x; vars.y = y; return ok() ? y : NaN } } }
      case 'fny': { const f = r.f; return { ...r, f: (y) => { const x = f(y); if (!Number.isFinite(x)) return NaN; vars.x = x; vars.y = y; return ok() ? x : NaN } } }
      case 'implicit': { const F = r.F; return { ...r, F: (x, y) => { const v = F(x, y); vars.x = x; vars.y = y; return ok() ? v : NaN } } }
      case 'region': { const test = r.test; return { ...r, test: (x, y) => { if (!test(x, y)) return false; vars.x = x; vars.y = y; return ok() }, edge: r.edge && (mask(r.edge, ok) as Plot) } }
      case 'param': {
        const X = r.x, Y = r.y
        const okAt = (t: number) => { const x = X(t), y = Y(t); vars.t = t; vars.x = x; vars.y = y; return ok() }
        return { ...r, x: (t) => (okAt(t) ? X(t) : NaN), y: (t) => (okAt(t) ? Y(t) : NaN) }
      }
      default: return r
    }
  }

  // 4. each line on its own
  return pre.map((p): Read => {
    if ('empty' in p) return { kind: 'empty' }
    if ('error' in p) return { kind: 'error', message: p.error }
    const r = one(p)
    if (!p.cond || r.kind === 'error' || r.kind === 'param' || r.kind === 'point' || r.kind === 'segment') return r
    const c = condOf(p.cond, ['x', 'y'])
    if (c.missing.length) return c.missing.includes('t') ? { kind: 'error', message: 'Only a curve written with t, like (cos(t), sin(t)), takes t' } : missingErr(c.missing)
    if (r.kind === 'slider' || r.kind === 'value') return { kind: 'error', message: 'A number takes no restriction' }
    return mask(r, c.ok)
  })

  function one(p: Extract<Pre, { rhs: Node }>): Read {
    const undefFn = [...calls(p.rhs), ...(p.lhs ? calls(p.lhs) : []), ...(p.point ?? []).flatMap((n) => [...calls(n)]), ...(p.seg ?? []).flat().flatMap((n) => [...calls(n)])]
      .filter((c) => !(c in FNS) && !(c in env.fns))
    if (undefFn.length) return { kind: 'error', message: `The function “${undefFn[0]}” isn't defined` }
    if (p.seg) {
      const fv = new Set(p.seg.flat().flatMap((n) => [...free(n)]))
      const m = known(fv, [])
      if (m.length) return fv.has('x') || fv.has('y') || fv.has('t') ? { kind: 'error', message: 'A segment joins two points of numbers' } : missingErr(m)
      if (p.cond) return { kind: 'error', message: 'A segment takes no restriction' }
      const [a, b] = p.seg.map(([x, y]) => [compile(x)(env), compile(y)(env)] as [number, number])
      if (![...a, ...b].every(Number.isFinite)) return { kind: 'error', message: "These ends aren't pairs of real numbers" }
      return { kind: 'segment', a, b, label: p.label, what: 'segment' }
    }
    if (p.point) {
      const fv = new Set([...free(p.point[0]), ...free(p.point[1])])
      if (fv.has('t') && !('t' in vars)) {
        // a parametric curve: (cos(t), sin(t)), t from 0 to 1 unless the restriction says otherwise
        if (p.label) return { kind: 'error', message: 'A curve written with t takes no label' }
        const m = known(fv, ['t'])
        if (m.length) return fv.has('x') || fv.has('y') ? { kind: 'error', message: 'A curve written with t uses t only, not x or y' } : missingErr(m)
        const c = p.cond ? condOf(p.cond, ['t', 'x', 'y']) : null
        if (c?.missing.length) return missingErr(c.missing)
        const X = compile(p.point[0]), Y = compile(p.point[1])
        const t0 = c?.lo ?? 0, t1 = c?.hi ?? 1
        if (!(t1 > t0) || !Number.isFinite(t0) || !Number.isFinite(t1)) return { kind: 'error', message: 't needs a range, like {0 < t < 2pi}' }
        const base: Read = { kind: 'param', x: (t) => { vars.t = t; return X(env) }, y: (t) => { vars.t = t; return Y(env) }, t0, t1, what: 'curve in t' }
        return c ? mask(base, c.ok) : base
      }
      const m = known(fv, [])
      if (m.length) return fv.has('x') || fv.has('y') ? { kind: 'error', message: 'A point takes numbers, not x or y' } : missingErr(m)
      if (p.cond) return { kind: 'error', message: 'A point takes no restriction' }
      const x = compile(p.point[0])(env), y = compile(p.point[1])(env)
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { kind: 'error', message: "This point isn't a pair of real numbers" }
      return { kind: 'point', x, y, label: p.label, what: p.label?.anchor === 'c' ? 'label' : 'point' }
    }
    if (p.slider) {
      const fv = free(p.rhs)
      if (fv.has('x') || fv.has('y')) return { kind: 'error', message: `${p.slider} = … needs a number. For a graph write y = …` }
      const m = known(fv, [])
      if (m.length) return missingErr(m)
      if (sliderLines.get(p.slider) !== pre.indexOf(p)) return { kind: 'error', message: `${p.slider} is already defined above` }
      const value = vars[p.slider]
      return fv.size === 0 ? { kind: 'slider', name: p.slider, value, what: 'slider' } : { kind: 'value', value, def: p.slider, what: 'value' }
    }
    if (p.fnDef) {
      const m = known(free(p.rhs), [p.fnDef.arg])
      if (m.length) return missingErr(m)
      const f = env.fns[p.fnDef.name]
      return p.fnDef.arg === 'x' || p.fnDef.arg === 't'
        ? { kind: 'fn', f, def: p.fnDef.name, what: `function ${p.fnDef.name}` }
        : { kind: 'fn', f, def: p.fnDef.name, what: `function ${p.fnDef.name}` }
    }
    if (!p.lhs) {
      // no relation: y = this, or a value
      const fv = free(p.rhs)
      const m = known(fv, ['x', 'y'])
      if (m.length) return missingErr(m)
      if (fv.has('y')) return { kind: 'error', message: 'Uses y: write it as an equation, like … = 0' }
      const F = compile(p.rhs)
      if (!fv.has('x')) { const v = F(env); return Number.isFinite(v) ? { kind: 'value', value: v, what: 'value' } : { kind: 'error', message: 'Not a real number' } }
      return { kind: 'fn', f: atX(F), what: 'y = …' }
    }
    // a relation
    const lf = free(p.lhs), rf = free(p.rhs)
    const m = known(new Set([...lf, ...rf]), ['x', 'y'])
    if (m.length) return missingErr(m)
    const L = compile(p.lhs), R = compile(p.rhs)
    const isY = p.lhs.k === 'id' && p.lhs.name === 'y' && !rf.has('y')
    const isX = p.lhs.k === 'id' && p.lhs.name === 'x' && !rf.has('x')
    const isYr = p.rhs.k === 'id' && p.rhs.name === 'y' && !lf.has('y')
    if (p.rel === '=') {
      if (isY) return { kind: 'fn', f: atX(R), what: 'y = …' }
      if (isYr) return { kind: 'fn', f: atX(L), what: 'y = …' }
      if (isX) return { kind: 'fny', f: atY(R), what: rf.has('y') ? 'x = …' : 'vertical line' }
      if (![...lf, ...rf].some((v) => v === 'x' || v === 'y')) {
        const a = L(env), b = R(env)
        return { kind: 'error', message: Math.abs(a - b) < 1e-9 ? 'True, but there is nothing to draw' : `False: ${+a.toFixed(6)} ≠ ${+b.toFixed(6)}` }
      }
      return { kind: 'implicit', F: at((e) => L(e) - R(e)), what: 'equation' }
    }
    const strict = p.rel === '<' || p.rel === '>'
    const gt = p.rel === '>' || p.rel === '>='
    const D = at((e) => L(e) - R(e))
    const test = (x: number, y: number) => { const d = D(x, y); return gt ? d > 0 : d < 0 }
    const edge: Plot | null = isY ? { kind: 'fn', f: atX(R) } : isX ? { kind: 'fny', f: atY(R) } : { kind: 'implicit', F: D }
    return { kind: 'region', test, edge, strict, what: 'inequality' }
  }
}

/** A plain number from an expression ("2", "sqrt(2)/2", "pi/4", "a + 1" with `a` given). Throws with a reason when it isn't one. */
export function evalNum(src: string, vars: Record<string, number> = {}): number {
  const n = parse(lex(src, new Set()), new Set())
  const missing = [...free(n)].filter((v) => !(v in vars))
  if (missing.length) throw new Error(`“${missing[0]}” isn't defined`)
  const v = compile(n)({ vars: { ...vars }, fns: {} })
  if (!Number.isFinite(v)) throw new Error(`“${src.trim()}” isn't a real number`)
  return v
}

/** One line on its own (no sliders or functions from other lines). */
export function readPlot(src: string): Read { return readAll([{ expr: src }])[0] }

const TEXFN: Record<string, string> = { sin: '\\sin', cos: '\\cos', tan: '\\tan', sec: '\\sec', csc: '\\csc', cot: '\\cot', sinh: '\\sinh', cosh: '\\cosh',
  tanh: '\\tanh', ln: '\\ln', log: '\\log', exp: '\\exp', min: '\\min', max: '\\max', arcsin: '\\arcsin', arccos: '\\arccos', arctan: '\\arctan',
  asin: '\\arcsin', acos: '\\arccos', atan: '\\arctan' }
const PREC = { '+': 1, '-': 1, '*': 2, '/': 3, '^': 4 } as const
function tex(n: Node, parent = 0): string {
  const wrap = (s: string, p: number) => (p < parent ? `\\left(${s}\\right)` : s)
  switch (n.k) {
    case 'num': {
      const named = Object.entries(CONSTS).find(([, v]) => v === n.v)
      if (named && n.v !== 0) return named[0] === 'e' ? 'e' : named[0].startsWith('t') || named[0] === 'τ' ? '\\tau' : '\\pi'
      return String(n.v)
    }
    case 'id': { const [b, sub] = n.name.split('_'); return sub ? `${b}_{${sub}}` : b }
    case 'neg': return wrap('-' + tex(n.a, 2), 1)
    case 'fact': return tex(n.a, 5) + '!'
    case 'call': {
      if (n.name === 'abs') return `\\left|${tex(n.args[0])}\\right|`
      if (n.name === 'sqrt') return `\\sqrt{${tex(n.args[0])}}`
      if (n.name === 'cbrt') return `\\sqrt[3]{${tex(n.args[0])}}`
      if (n.name === 'floor') return `\\lfloor ${tex(n.args[0])} \\rfloor`
      if (n.name === 'ceil') return `\\lceil ${tex(n.args[0])} \\rceil`
      const f = TEXFN[n.name] ?? (n.name.length === 1 ? n.name : `\\operatorname{${n.name}}`)
      return `${f}\\left(${n.args.map((a) => tex(a)).join(', ')}\\right)`
    }
    case 'bin': {
      if (n.op === '/') return `\\frac{${tex(n.a)}}{${tex(n.b)}}`
      if (n.op === '^') return `{${tex(n.a, 5)}}^{${tex(n.b)}}`
      if (n.op === '*') {
        const a = tex(n.a, 2), b = tex(n.b, 2)
        const dot = /^[0-9.]/.test(b) || (n.b.k === 'neg')
        return wrap(a + (dot ? ' \\cdot ' : ' ') + b, 2)
      }
      return wrap(`${tex(n.a, 1)} ${n.op} ${tex(n.b, n.op === '-' ? 2 : 1)}`, PREC[n.op])
    }
  }
}

/** The line typeset, for showing it as maths while it isn't being edited. null when it doesn't parse. */
const REL_TEX: Record<string, string> = { '=': '=', '<': '<', '>': '>', '<=': '\\le', '>=': '\\ge', '≤': '\\le', '≥': '\\ge' }
export function lineTex(src: string, lines: Line[] = []): string | null {
  const { main: s, cond } = splitLine(src)
  if (!s) return null
  const userFns = new Set<string>()
  for (const l of lines) { const m = FN_DEF.exec(l.expr.split('=')[0]?.replace(/\s/g, '') ?? ''); if (m && l.expr.includes('=')) userFns.add(m[1]) }
  try {
    const T = (x: string) => tex(parse(lex(x, userFns), userFns))
    const pair = (pt: [string, string]) => `\\left(${T(pt[0])}, ${T(pt[1])}\\right)`
    const tail = cond == null ? '' : ' \\left\\{' + topSplit(cond).map((cl) => cl.split(REL_RE).map((x, i) => (i % 2 ? REL_TEX[x] ?? x : T(x))).join(' ')).join(',\\ ') + '\\right\\}'
    const sg = SEGMENT.exec(s)
    if (sg) {
      const ends = topSplit(sg[1]).map(pairOf)
      return ends.length === 2 && ends[0] && ends[1] ? `\\operatorname{segment}\\left(${pair(ends[0])}, ${pair(ends[1])}\\right)` : null
    }
    const pt = pairOf(s)
    if (pt) return pair(pt) + tail
    const parts = s.split(REL_RE)
    const side = (x: string) => {
      const c = x.replace(/\s/g, ''), fd = FN_DEF.exec(c)
      return fd ? `${fd[1]}\\left(${fd[2]}\\right)` : T(x)
    }
    if (parts.length === 1) return side(s) + tail
    if (parts.length !== 3) return null
    return `${side(parts[0])} ${REL_TEX[parts[1]] ?? parts[1]} ${side(parts[2])}` + tail
  } catch { return null }
}

/** A label as HTML: plain text, with $…$ parts set as maths. */
export function labelHtml(text: string, render: (tex: string) => string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return text.split('$').map((part, i) => (i % 2 ? render(part) : esc(part))).join('')
}

/** Grid step for a span: 1, 2 or 5 times a power of ten, about `n` lines across. */
export function niceStep(span: number, n = 8): number {
  const raw = span / n, p = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / p
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p
}

export const fmtTick = (v: number, step: number) => {
  if (Math.abs(v) < step / 1e6) return '0'
  const d = Math.max(0, -Math.floor(Math.log10(step)))
  return v.toFixed(Math.min(d, 6)).replace('-', '−')
}

export const fmtVal = (v: number) => {
  if (!Number.isFinite(v)) return String(v)
  if (Math.abs(v) >= 1e9 || (Math.abs(v) < 1e-5 && v !== 0)) return v.toExponential(4)
  return String(+v.toPrecision(10))
}

export const PLOT_COLORS = ['var(--c-blue)', 'var(--c-red)', 'var(--c-green)', 'var(--c-purple)', 'var(--c-orange)', 'var(--c-ink)']
