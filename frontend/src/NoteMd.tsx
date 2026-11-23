import { useLayoutEffect, useRef } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { fenceMultiline, MD_CODE } from './codefmt'
import { Bold, Code, Heading2, Italic, List, Quote, Sigma, SquareSigma } from 'lucide-react'
import { t as tr, type Key } from './i18n'
import { rehypeGluePunct, texDelims } from './mathtex'

const REMARK = [remarkGfm, remarkMath]
const REHYPE: never[] = [[rehypeKatex, { throwOnError: false, strict: false }] as never, rehypeGluePunct as never]

/** Markdown with LaTeX: $inline$ and $$display$$, tables, lists, code. */
export function NoteMd({ text, className = '' }: { text: string; className?: string }) {
  return (
    <div className={'note-md ' + className}>
      <Markdown remarkPlugins={REMARK} rehypePlugins={REHYPE}
        components={{ ...MD_CODE, a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>
        {texDelims(fenceMultiline(text))}
      </Markdown>
    </div>
  )
}

type Snip = { label: Key; icon: React.ReactNode; wrap?: [string, string]; line?: string; placeholder?: string }
const SNIPS: Snip[] = [
  { label: 'Bold', icon: <Bold size={14} strokeWidth={1.8} />, wrap: ['**', '**'], placeholder: 'bold' },
  { label: 'Italic', icon: <Italic size={14} strokeWidth={1.8} />, wrap: ['*', '*'], placeholder: 'italic' },
  { label: 'Heading', icon: <Heading2 size={14} strokeWidth={1.8} />, line: '## ' },
  { label: 'List', icon: <List size={14} strokeWidth={1.8} />, line: '- ' },
  { label: 'Quote', icon: <Quote size={14} strokeWidth={1.8} />, line: '> ' },
  { label: 'Inline maths  $…$', icon: <Sigma size={14} strokeWidth={1.8} />, wrap: ['$', '$'], placeholder: 'x^2' },
  { label: 'Display maths  $$…$$', icon: <SquareSigma size={14} strokeWidth={1.8} />, wrap: ['\n$$\n', '\n$$\n'], placeholder: '\\int_0^1 x\\,dx' },
  { label: 'Code', icon: <Code size={14} strokeWidth={1.8} />, wrap: ['`', '`'], placeholder: 'code' },  // several lines: a fenced block
]

/** A plain textarea that grows with its text, with buttons that write the Markdown and LaTeX for you. */
export function MdEditor({ value, onChange, onDone, autoFocus = true, placeholder, compact, bare }: {
  value: string; onChange: (v: string) => void; onDone?: () => void; autoFocus?: boolean; placeholder?: string; compact?: boolean
  /** on a page: the source in the page's own type, the tools floating above */
  bare?: boolean
}) {
  const ta = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
  }, [value])
  const apply = (s: Snip) => {
    const el = ta.current
    if (!el) return
    const a = el.selectionStart, b = el.selectionEnd
    let next = value, ca = a, cb = b
    if (s.label === 'Code' && (value.slice(a, b).includes('\n') || (a === b && (a === 0 || value[a - 1] === '\n')))) {
      const inner = value.slice(a, b) || 'code'
      const before = a > 0 && value[a - 1] !== '\n' ? '\n' : ''
      next = value.slice(0, a) + before + '```\n' + inner + '\n```\n' + value.slice(b)
      ca = a + before.length + 4; cb = ca + inner.length
    } else if (s.wrap) {
      const inner = value.slice(a, b) || s.placeholder || ''
      next = value.slice(0, a) + s.wrap[0] + inner + s.wrap[1] + value.slice(b)
      ca = a + s.wrap[0].length; cb = ca + inner.length
    } else if (s.line) {
      const ls = value.lastIndexOf('\n', a - 1) + 1
      next = value.slice(0, ls) + s.line + value.slice(ls)
      ca = a + s.line.length; cb = b + s.line.length
    }
    onChange(next)
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(ca, cb) })
  }
  return (
    <div className={'md-ed' + (compact ? ' compact' : '') + (bare ? ' bare' : '')} onPointerDown={(e) => e.stopPropagation()}
      onBlur={(e) => { if (bare && onDone && !e.currentTarget.contains(e.relatedTarget as Node | null)) onDone() }}>
      <div className="md-tools" role="toolbar" aria-label={tr('Formatting')}>
        {SNIPS.map((s) => (
          <button key={s.label} type="button" className="icon-btn sm" title={tr(s.label)} aria-label={tr(s.label)}
            onMouseDown={(e) => e.preventDefault()} onClick={() => apply(s)}>{s.icon}</button>
        ))}
        {onDone && !bare && <button type="button" className="btn sm ghost md-done" onMouseDown={(e) => e.preventDefault()} onClick={onDone}>{tr('Done')} <kbd>Esc</kbd></button>}
      </div>
      <textarea ref={ta} className="md-ta" value={value} autoFocus={autoFocus} spellCheck placeholder={placeholder ?? tr('Write here. $x^2$ for maths, $$…$$ for a display line.')}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && onDone) { e.preventDefault(); e.stopPropagation(); onDone() }
          if ((e.ctrlKey || e.metaKey) && e.key === 'b') { e.preventDefault(); apply(SNIPS[0]) }
          if ((e.ctrlKey || e.metaKey) && e.key === 'i') { e.preventDefault(); apply(SNIPS[1]) }
          if ((e.ctrlKey || e.metaKey) && e.key === 'm') { e.preventDefault(); apply(SNIPS[5]) }
          e.stopPropagation()
        }} />
    </div>
  )
}
