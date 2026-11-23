import katex from 'katex'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkMath from 'remark-math'
import type { PAnswer, PAnswers, PContent, PFeedback, PWidget } from './api'
import { Select } from './controls'
import { t as tr } from './i18n'

/* Khan exercise items (Perseus): markdown with $TeX$, pictures and widget placeholders like
   [[☃ numeric-input 1]]. The server already removed every answer; this only shows the question
   and collects what's typed or picked. */

// Khan's TeX colour commands (\blue{x}, \greenD{y}, ...). Values from Khan's palette.
const PALETTE: Record<string, string> = {
  blue: '#11accd', teal: '#01a995', green: '#1fab54', gold: '#e07d10', red: '#e84d39', maroon: '#ca337c',
  purple: '#9059ff', pink: '#e94d9b', gray: '#888d93', mint: '#78c9a0', orange: '#ff9c39',
}
const SHADES: Record<string, string[]> = {
  blue: ['#ccfaff', '#80f6ff', '#63d9ea', '#11accd', '#0c7f99'], teal: ['#94fff5', '#26edd5', '#01d1c1', '#01a995', '#208170'],
  green: ['#b6ffb0', '#8af281', '#74cf70', '#1fab54', '#0d923f'], gold: ['#ffd0a9', '#ffbb71', '#ff9c39', '#e07d10', '#a75a05'],
  red: ['#fca9a9', '#ff8482', '#f9685d', '#e84d39', '#bc2612'], maroon: ['#ffbde0', '#ff92c6', '#ed5fa6', '#ca337c', '#9e034e'],
  purple: ['#ddd7ff', '#c6b9fc', '#aa87ff', '#9059ff', '#7854ab'], gray: ['#f6f7f7', '#d6d8da', '#babec2', '#888d93', '#626569'],
}
// In a KaTeX macro body "#1" is the argument, so a literal "#" in a colour has to be written "##".
const color = (hex: string) => `\\textcolor{${hex.replace('#', '##')}}{#1}`
const KHAN_MACROS: Record<string, string> = (() => {
  const m: Record<string, string> = { '\\kaBlue': color('#5f9bd0'), '\\kaGreen': color('#71b307') }
  for (const [k, v] of Object.entries(PALETTE)) m['\\' + k] = color(v)
  for (const [k, vs] of Object.entries(SHADES)) vs.forEach((v, i) => { m[`\\${k}${'ABCDE'[i]}`] = color(v) })
  return m
})()
const KATEX = { macros: KHAN_MACROS, throwOnError: false, strict: 'ignore' as const }
const REHYPE = [[rehypeKatex, KATEX]] as const

/** Khan's TeX that KaTeX won't take as written: worked solutions put {align} inside $…$, which KaTeX only allows in
 *  display mode (the whole formula then showed as red source), so use the inline-safe {aligned}/{gathered}; and some
 *  items carry their row breaks double-escaped (\\\\ for \\), which would add empty rows. */
const fixTex = (s: string) => s
  .replace(/\\(begin|end)\{(align|alignat|gather)\*?\}/g, (_, be: string, env: string) => `\\${be}{${env === 'gather' ? 'gathered' : env + 'ed'}}`)
  .replace(/\\{4}/g, '\\\\')

const tex = (src: string, display = false) => katex.renderToString(fixTex(src), { ...KATEX, macros: { ...KHAN_MACROS }, displayMode: display })

/** Widget placeholders become links the renderer swaps for inputs; that keeps them inline in a sentence. */
const prepare = (s: string) => fixTex(s)
  // Khan writes "###Heading"; CommonMark needs the space
  .replace(/^(#{1,6})(?=[^\s#])/gm, '$1 ')
  // Khan writes "** bold **"; its renderer allows the inner spaces, CommonMark doesn't
  .replace(/\*\*[ \t]+([^*\n]+?)[ \t]*\*\*|\*\*([^*\n]+?)[ \t]+\*\*/g, (_, a?: string, b?: string) => `**${(a ?? b ?? '').trim()}**`)
  .replace(/\[\[☃ ([a-z-]+ \d+)\]\]/g, (_, n: string) => `[​](#w/${encodeURIComponent(n)})`)

type Ctx = {
  part: PContent
  answers: PAnswers
  set: (name: string, v: PAnswer) => void
  disabled?: boolean
  feedback?: PFeedback | null
}

export function PerseusView(props: Ctx & { className?: string }) {
  return <div className={'perseus ' + (props.className ?? '')}><Md text={props.part.content} ctx={props} /></div>
}

/* The markdown renderer's components must keep the same identity between renders: new functions
   would be new component types, so React would rebuild every input on each keystroke and the
   answer box would lose focus. They read the current question through context instead. */
const PCtx = createContext<Ctx | null>(null)

function MdLink({ href, children }: { href?: string; children?: ReactNode }) {
  const ctx = useContext(PCtx)!
  if (href?.startsWith('#w/')) return <Widget name={decodeURIComponent(href.slice(3))} ctx={ctx} />
  return <a href={href} target="_blank" rel="noreferrer">{children}</a>
}
function MdImg({ src, alt }: { src?: string | Blob; alt?: string }) {
  const ctx = useContext(PCtx)!
  return <Picture src={String(src ?? '')} alt={alt ?? ''} graphie={ctx.part.graphie.includes(String(src))} />
}
const BLOCK = { a: MdLink, img: MdImg, p: ({ children }: { children?: ReactNode }) => <div className="p">{children}</div> }
const INLINE = { ...BLOCK, p: ({ children }: { children?: ReactNode }) => <span className="p-inline">{children}</span> }
const REMARK = [remarkMath]

function Md({ text, ctx, inline }: { text: string; ctx: Ctx; inline?: boolean }) {
  return (
    <PCtx.Provider value={ctx}>
      <Markdown remarkPlugins={REMARK} rehypePlugins={REHYPE as never} components={inline ? INLINE : BLOCK}>{prepare(text)}</Markdown>
    </PCtx.Provider>
  )
}

function Widget({ name, ctx }: { name: string; ctx: Ctx }) {
  const w = ctx.part.widgets[name]
  if (!w) return null
  const fb = ctx.feedback?.widgets[name]
  const state = fb ? (fb.correct ? ' ok' : ' bad') : ''
  const v = ctx.answers[name]
  switch (w.type) {
    case 'numeric-input':
    case 'input-number':
      return (
        <span className={'pw-field' + state}>
          {typeof w.label === 'string' && w.label && <span className="pw-label">{w.label}</span>}
          <input className={'input mono pw-num' + (w.size === 'small' ? ' sm' : '')} value={String(v ?? '')} disabled={ctx.disabled}
            inputMode="text" autoComplete="off" spellCheck={false} aria-label={tr('Answer')}
            placeholder={(w.forms as string[] | undefined)?.length ? (w.forms as string[]).join(' / ') : ''}
            onChange={(e) => ctx.set(name, e.target.value)} />
          {fb?.message && <Msg text={fb.message} ctx={ctx} />}
        </span>
      )
    case 'expression':
      return <ExpressionInput name={name} ctx={ctx} cls={state} />
    case 'radio':
      return <Radio name={name} w={w} ctx={ctx} cls={state} />
    case 'dropdown': {
      const ch = w.choices as { i: number; content: string }[]
      return (
        <span className={'pw-field' + state}>
          <Select className="pw-select" label={String(w.placeholder || 'Choose')} placeholder={String(w.placeholder || 'Choose')} disabled={ctx.disabled}
            value={v === undefined || v === '' ? null : Number(v)} onChange={(x) => ctx.set(name, x)}
            options={ch.map((c) => ({ value: c.i, label: c.content.replace(/\$/g, ''), text: c.content.replace(/\$/g, '') }))} />
        </span>
      )
    }
    case 'image':
      return (
        <span className="pw-image">
          {w.title ? <span className="pw-caption">{String(w.title)}</span> : null}
          <Picture src={String(w.url)} alt={String(w.alt ?? '')} graphie={ctx.part.graphie.includes(String(w.url))}
            width={w.width as number | undefined} />
          {w.caption ? <span className="pw-caption"><Md text={String(w.caption)} ctx={ctx} inline /></span> : null}
        </span>
      )
    case 'definition':
      return <Definition prompt={String(w.prompt)} text={String(w.text)} ctx={ctx} />
    case 'explanation':
      return (
        <details className="pw-explain">
          <summary>{String(w.show)}</summary>
          <Md text={String(w.text)} ctx={ctx} />
        </details>
      )
    default:
      return null
  }
}

function Msg({ text, ctx }: { text: string; ctx: Ctx }) {
  return <span className="pw-msg"><Md text={text} ctx={{ ...ctx, part: { ...ctx.part, widgets: {} } }} inline /></span>
}

function Definition({ prompt, text, ctx }: { prompt: string; text: string; ctx: Ctx }) {
  const [open, setOpen] = useState(false)
  return (
    <span className="pw-def">
      <button type="button" className="linkish" onClick={() => setOpen((o) => !o)}>{prompt}</button>
      {open && <span className="pw-def-box"><Md text={text} ctx={ctx} inline /></span>}
    </span>
  )
}

/** Plain typing like 3x^2 + sqrt(x)/2 <= 5, with the maths shown back as it will be read. */
function ExpressionInput({ name, ctx, cls }: { name: string; ctx: Ctx; cls: string }) {
  const v = String(ctx.answers[name] ?? '')
  const fb = ctx.feedback?.widgets[name]
  return (
    <span className={'pw-field pw-expr' + cls}>
      <input className="input mono" value={v} disabled={ctx.disabled} autoComplete="off" spellCheck={false}
        aria-label={tr('Expression')} placeholder={tr('e.g. 3x^2+1, sqrt(x), y<=2x')}
        onChange={(e) => ctx.set(name, e.target.value)} />
      {v.trim() && <span className="pw-preview" aria-hidden dangerouslySetInnerHTML={{ __html: tex(asciiToTex(v)) }} />}
      {fb?.message && <Msg text={fb.message} ctx={ctx} />}
    </span>
  )
}

function asciiToTex(s: string): string {
  let t = s.replace(/<=|≤/g, ' \\le ').replace(/>=|≥/g, ' \\ge ').replace(/!=|≠/g, ' \\ne ').replace(/\*/g, ' \\cdot ')
  for (let k = 0; k < 6; k++) t = t.replace(/sqrt\(([^()]*)\)/g, '\\sqrt{$1}')
  t = t.replace(/\bpi\b/g, '\\pi ').replace(/\^\(([^()]*)\)/g, '^{$1}')
  // a/b with simple operands → fraction
  t = t.replace(/(\([^()]*\)|[\w.]+)\s*\/\s*(\([^()]*\)|[\w.]+)/g, (_, a: string, b: string) =>
    `\\frac{${a.replace(/^\((.*)\)$/, '$1')}}{${b.replace(/^\((.*)\)$/, '$1')}}`)
  return t
}

function Radio({ name, w, ctx, cls }: { name: string; w: PWidget; ctx: Ctx; cls: string }) {
  const ch = w.choices as { i: number; content: string }[]
  const multiple = !!w.multiple
  const picked = new Set((ctx.answers[name] as number[] | undefined) ?? [])
  const fb = ctx.feedback?.widgets[name]
  const toggle = (i: number) => {
    if (ctx.disabled) return
    const next = multiple ? new Set(picked) : new Set<number>()
    if (multiple && picked.has(i)) next.delete(i)
    else next.add(i)
    ctx.set(name, [...next])
  }
  return (
    <span className={'pw-radio' + cls} role={multiple ? 'group' : 'radiogroup'}>
      {multiple && <span className="pw-hint">{typeof w.count === 'number' ? tr('Choose {n} answers', { n: w.count }) : tr('Choose all that apply')}</span>}
      {ch.map((c) => (
        <button type="button" key={c.i} className={'choice' + (picked.has(c.i) ? ' on' : '')} disabled={ctx.disabled}
          role={multiple ? 'checkbox' : 'radio'} aria-checked={picked.has(c.i)} onClick={() => toggle(c.i)}>
          <span className={'o' + (multiple ? ' sq' : '')} />
          <span className="pw-choice-t"><Md text={c.content} ctx={ctx} inline /></span>
        </button>
      ))}
      {fb?.message && <Msg text={fb.message} ctx={ctx} />}
    </span>
  )
}

type Label = { left: number; top: number; align: string; math: boolean; content: string }
const ALIGN: Record<string, string> = {
  center: '-50%,-50%', above: '-50%,-100%', below: '-50%,0', left: '-100%,-50%', right: '0,-50%',
  'above left': '-100%,-100%', 'above right': '0,-100%', 'below left': '-100%,0', 'below right': '0,0',
}
const labelCache = new Map<string, Promise<Label[]>>()
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
/** A text label: escaped, with any $…$ inside set as maths. */
const labelHtml = (s: string) => s.split(/\$([^$]+)\$/).map((part, i) => (i % 2 ? tex(part) : esc(part))).join('')

/** Khan's "graphie" pictures are an svg plus labels placed in graph coordinates; the server turns those into percentages. */
function Picture({ src, alt, graphie, width }: { src: string; alt: string; graphie: boolean; width?: number }) {
  const [labels, setLabels] = useState<Label[]>([])
  useEffect(() => {
    if (!graphie) return
    const url = src.replace('/api/khan/img/', '/api/khan/graphie/').replace(/\.svg$/, '')
    if (!labelCache.has(url)) labelCache.set(url, fetch(url).then((r) => (r.ok ? r.json() : { labels: [] })).then((d) => d.labels ?? []).catch(() => []))
    let live = true
    labelCache.get(url)!.then((l) => { if (live) setLabels(l) })
    return () => { live = false }
  }, [src, graphie])
  return (
    <span className="pw-pic" style={width ? { maxWidth: width } : undefined}>
      <img src={src} alt={alt} loading="lazy" />
      {labels.map((l, i) => (
        <span key={i} className="pw-lab" style={{ left: `${l.left}%`, top: `${l.top}%`, transform: `translate(${ALIGN[l.align] ?? ALIGN.center})` }}
          dangerouslySetInnerHTML={{ __html: l.math ? tex(l.content) : labelHtml(l.content) }} />
      ))}
    </span>
  )
}

/** Hints and worked solutions: same renderer, nothing to type. */
export function PerseusStatic({ part }: { part: PContent }) {
  return <PerseusView part={part} answers={{}} set={() => {}} disabled />
}

/** The right answer(s) for a question, as one line. */
export function Solution({ sol, inline }: { sol: Record<string, string>; inline?: boolean }): ReactNode {
  const vals = Object.values(sol).filter(Boolean)
  if (!vals.length) return null
  const empty = { part: { content: '', widgets: {}, graphie: [] }, answers: {}, set: () => {} }
  const body = vals.map((v, i) => <span key={i} className="pw-sol-v">{i > 0 && <span className="pw-sol-sep">, </span>}<Md text={v} ctx={empty} inline /></span>)
  if (inline) return <>{body}</>
  return <div className="pw-solution"><span className="form-l">{tr('Answer')}</span>{body}</div>
}
