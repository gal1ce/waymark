import katex from 'katex'
import type { ReactNode } from 'react'

/* Math set with KaTeX. Questions carry LaTeX; older or plain-text math ("12 / (2 + 4) * 3") is
   converted first without changing what it means. A fraction bar regroups an expression, so in pure
   arithmetic "/" only becomes a bar for a lone number fraction like 3/4; next to another × or ÷ it
   stays a ÷ sign, and "12 / (2 + 4) · 3" keeps asking about the order of operations. */

const OPTS = { throwOnError: false, strict: 'ignore', trust: false, output: 'htmlAndMathml' } as const

function tex(src: string, displayMode: boolean): string {
  return katex.renderToString(fixCommands(src), { ...OPTS, displayMode })
}

/* A model sometimes drops a command's backslash ("|f(x) - L| <varepsilon"): KaTeX then sets the letters
   v-a-r-e-p-s-i-l-o-n as variables, on screen and for screen readers. Names that are never a product of
   variables in real math get their backslash back; short ones (pi, to, ln …) are left alone. */
const BARE = /(^|[^\\a-zA-Z])(varepsilon|epsilon|vartheta|theta|lambda|Lambda|alpha|beta|gamma|Gamma|delta|Delta|sigma|Sigma|omega|Omega|varphi|infty|partial|nabla|sqrt(?=\{)|frac(?=\{)|cdot|times|leq|geq|neq|approx|lim(?=_)|sum(?=_)|int(?=_))(?![a-zA-Z])/g
export const fixCommands = (src: string) => src.split(/(\\text\{[^}]*\})/).map((x, i) => (i % 2 ? x : x.replace(BARE, '$1\\$2'))).join('')
/** The same repair for Markdown: only inside $…$ and $$…$$, never in the prose around them. */
export const fixMathInMd = (md: string) => texDelims(md).replace(/\$\$[\s\S]+?\$\$|\$[^$\n]+?\$/g, (m) => fixCommands(m))

/** LaTeX's other delimiters for Markdown, which only knows $…$ and $$…$$: \(x\) → $x$, \[x\] → $$x$$, and a
 *  doubled $\(x\)$ loses the inner pair (KaTeX has no \( command, so it showed the whole formula as red source).
 *  Code (``` blocks and `spans`) is left alone. */
export const texDelims = (md: string) => md.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/).map((part, i) => i % 2 ? part : part
  .replace(/(\$\$?)\s*\\[([]([\s\S]*?)\\[)\]]\s*\1/g, '$1$2$1')
  .replace(/\\\[([\s\S]+?)\\\]/g, (_, x: string) => `$$${x}$$`)
  .replace(/\\\(([^\n]+?)\\\)/g, (_, x: string) => `$${x.trim()}$`)).join('')

/** Plain-text math → LaTeX. Anything that already has a LaTeX command is returned as is. */
function toTex(src: string): string {
  if (/\\[a-zA-Z]/.test(src)) return src
  let s = src
    .replace(/−/g, '-')
    .replace(/<=|≤/g, ' \\le ').replace(/>=|≥/g, ' \\ge ').replace(/!=|≠/g, ' \\ne ')
    .replace(/\s*(?:\*|·)\s*/g, ' \\cdot ').replace(/\s*×\s*/g, ' \\times ').replace(/\s*÷\s*/g, ' \\div ')
  const arithmetic = !/[a-zA-Z]/.test(s.replace(/\\[a-zA-Z]+/g, ''))
  s = fractions(s, arithmetic)
  s = s
    .replace(/sqrt\s*\(([^()]*)\)/g, '\\sqrt{$1}')
    .replace(/\^\(([^()]*)\)/g, '^{$1}')
    .replace(/\^(-?[\w.]+)/g, '^{$1}')
  return s.replace(/\s+/g, ' ').trim()
}

const NUM = /^\d+(\.\d+)?$/
const MULDIV_BEFORE = /([*·×÷/^]|\\cdot|\\div|\\times)\s*$/
const MULDIV_AFTER = /^\s*([*·×÷/^]|\\cdot|\\div|\\times)/

/** a/b → \frac{a}{b} where a and b are single operands (a number, a variable term or a bracket group);
 *  division binds to its neighbours exactly like that, so the meaning is kept. */
function fractions(s: string, arithmetic: boolean): string {
  const keep = arithmetic ? ' \\div ' : '∕'   // placeholder slash, restored at the end
  for (let guard = 0; guard < 30; guard++) {
    const i = s.indexOf('/')
    if (i < 0) break
    const L = operand(s, i, -1)
    const R = operand(s, i, 1)
    let ok = L !== null && R !== null
    if (ok && arithmetic) {
      const before = s.slice(0, L!.at), after = s.slice(R!.at + R!.text.length)
      ok = NUM.test(L!.text) && NUM.test(R!.text) && !MULDIV_BEFORE.test(before) && !MULDIV_AFTER.test(after)
    }
    if (!ok) { s = s.slice(0, i) + keep + s.slice(i + 1); continue }
    s = s.slice(0, L!.at) + '\\frac{' + unwrap(L!.text) + '}{' + unwrap(R!.text) + '}' + s.slice(R!.at + R!.text.length)
  }
  return s.replace(/∕/g, '/')
}

/** The operand next to a slash: a bracket group, or a run of letters/digits (with ^ powers). */
function operand(s: string, slash: number, dir: -1 | 1): { at: number; text: string } | null {
  let j = slash + dir
  while (s[j] === ' ') j += dir
  if (j < 0 || j >= s.length) return null
  const open = dir < 0 ? ')' : '('
  const close = dir < 0 ? '(' : ')'
  let k = j
  if (s[j] === open) {
    let depth = 0
    for (; k >= 0 && k < s.length; k += dir) {
      if (s[k] === open) depth++
      else if (s[k] === close && --depth === 0) break
    }
    if (k < 0 || k >= s.length) return null
    if (dir < 0 && s[k - 1] === '^') return null           // x^(n+1)/2: leave the slash alone
    if (dir > 0 && s[k + 1] === '^') return null           // 3/(x+1)^2: same
  } else {
    const word = /[\w.^]/
    if (!word.test(s[j])) return null
    while (k + dir >= 0 && k + dir < s.length && word.test(s[k + dir])) k += dir
    if (dir > 0 && s[k] === '^' && s[k + 1] === '(') return null
  }
  const [a, b] = dir < 0 ? [k, j] : [j, k]
  return { at: a, text: s.slice(a, b + 1) }
}

const unwrap = (t: string) => (t.startsWith('(') && t.endsWith(')') ? t.slice(1, -1) : t)

/** A formula on its own line. */
export function TexBlock({ src, className = '' }: { src: string; className?: string }) {
  return <div className={'tex-block ' + className} dangerouslySetInnerHTML={{ __html: tex(toTex(src), true) }} />
}

/** Text with inline math between $…$ (or \( … \)); everything else stays plain text.
 *  `big` sets inline math at display size, for answer choices where a tiny fraction is hard to read. */
export function MathText({ text, big = false }: { text: string; big?: boolean }): ReactNode {
  if (!text || !/\$|\\\(/.test(text)) return text
  const out: ReactNode[] = []
  const re = /\$\$([^$]+)\$\$|\$([^$\n]+)\$|\\\((.+?)\\\)/g
  let last = 0
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0
    if (i > last) out.push(text.slice(last, i))
    out.push(<span key={i} className="tex-inline" dangerouslySetInnerHTML={{ __html: tex((big ? '\\displaystyle ' : '') + (m[1] ?? m[2] ?? m[3]), false) }} />)
    last = i + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return <>{out}</>
}

/* Inline maths is its own box, so a line could break between "$5" and the full stop after it and start the next
   line with ". He wants…". A rehype step (after KaTeX) glues punctuation that touches a formula to it: the
   formula plus a following ".,;:!?)" or a leading "(" go into one no-wrap span. */
type HNode = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HNode[] }
const isInlineMath = (n?: HNode) => {
  const c = n?.type === 'element' ? n.properties?.className : undefined
  return Array.isArray(c) && c.includes('katex')
}
function glue(node: HNode) {
  const kids = node.children
  if (!kids) return
  for (let i = 0; i < kids.length; i++) {
    const n = kids[i]
    if (!isInlineMath(n)) { glue(n); continue }
    const group: HNode[] = [n]
    const prev = kids[i - 1], next = kids[i + 1]
    let start = i, end = i
    const lead = prev?.type === 'text' ? /\(+$/.exec(prev.value ?? '') : null
    if (lead) { prev!.value = prev!.value!.slice(0, lead.index); group.unshift({ type: 'text', value: lead[0] }) }
    const trail = next?.type === 'text' ? /^[.,;:!?)\]]+/.exec(next.value ?? '') : null
    if (trail) { next!.value = next!.value!.slice(trail[0].length); group.push({ type: 'text', value: trail[0] }) }
    if (group.length === 1) continue
    if (prev && !prev.value && lead) { start--; }
    if (next && !next.value && trail) { end++ }
    kids.splice(start, end - start + 1, { type: 'element', tagName: 'span', properties: { className: ['nowrap'] }, children: group })
    i = start
  }
}
export const rehypeGluePunct = () => (tree: HNode) => { glue(tree) }
