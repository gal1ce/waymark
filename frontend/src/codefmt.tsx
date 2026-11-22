import type { ReactNode } from 'react'
import { CodeBlock } from './CodeBlock'

/* Small, dependency-free C/C++ syntax colouring for test code.
   Colours come from the --code-* tokens in index.css. */

const C_TOKEN = new RegExp([
  String.raw`(\/\/[^\n]*|\/\*[\s\S]*?\*\/)`,                       // 1 comment
  String.raw`("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')`,           // 2 string / char
  String.raw`(^[ \t]*#[^\n]*)`,                                     // 3 preprocessor line
  String.raw`\b(0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[uUlLfF]*)\b`, // 4 number
  String.raw`\b(int|char|float|double|void|long|short|unsigned|signed|const|static|struct|union|enum|typedef|size_t|bool|FILE|extern|volatile|register|auto|class|std|string|vector|map|constexpr|uint\d+_t|int\d+_t)\b`, // 5 type
  String.raw`\b(if|else|for|while|do|return|break|continue|switch|case|default|sizeof|goto|NULL|true|false|nullptr|namespace|using|template|typename|public|private|protected|new|delete|this|virtual|override|try|catch|throw|operator|noexcept)\b`, // 6 keyword
  String.raw`\b([A-Za-z_]\w*)(?=\s*\()`,                            // 7 function call
].join('|'), 'gm')
const C_CLASS = ['', 'com', 'str', 'pp', 'num', 'ty', 'kw', 'fn']

/** Works for C and C++ (the extra C++ words never appear in C). */
export function highlightC(code: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  for (const m of code.matchAll(C_TOKEN)) {
    const i = m.index ?? 0
    if (i > last) out.push(code.slice(last, i))
    const g = m.findIndex((v, k) => k > 0 && v !== undefined)
    out.push(<span key={i} className={'tok-' + C_CLASS[g]}>{m[0]}</span>)
    last = i + m[0].length
  }
  if (last < code.length) out.push(code.slice(last))
  return out
}

const PY_TOKEN = new RegExp([
  String.raw`(#[^\n]*)`,                                                       // 1 comment
  String.raw`("""[\s\S]*?"""|'''[\s\S]*?'''|[rbfuRBFU]?"(?:\\.|[^"\\\n])*"|[rbfuRBFU]?'(?:\\.|[^'\\\n])*')`, // 2 string
  String.raw`(@[A-Za-z_][\w.]*)`,                                              // 3 decorator
  String.raw`\b(0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?j?)\b`, // 4 number
  String.raw`\b(int|float|str|bool|list|dict|set|tuple|bytes|None|True|False|self|cls)\b`, // 5 type / constant
  String.raw`\b(def|class|return|if|elif|else|for|while|in|not|and|or|is|import|from|as|with|try|except|finally|raise|pass|break|continue|lambda|yield|global|nonlocal|assert|del|async|await|match|case)\b`, // 6 keyword
  String.raw`\b([A-Za-z_]\w*)(?=\s*\()`,                                       // 7 call
].join('|'), 'gm')

const JS_EXTRA = /\b(function|let|var|const|export|import|from|async|await|of|in|instanceof|typeof|fn|impl|pub|mut|match|loop|struct|trait|use|mod|func|go|chan|defer|interface|package|type)\b/

function paint(code: string, re: RegExp, extraKw?: RegExp): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  for (const m of code.matchAll(re)) {
    const i = m.index ?? 0
    if (i > last) out.push(...plain(code.slice(last, i), last, extraKw))
    const g = m.findIndex((v, k) => k > 0 && v !== undefined)
    out.push(<span key={i} className={'tok-' + C_CLASS[g]}>{m[0]}</span>)
    last = i + m[0].length
  }
  if (last < code.length) out.push(...plain(code.slice(last), last, extraKw))
  return out
}
function plain(s: string, at: number, kw?: RegExp): ReactNode[] {
  if (!kw) return [s]
  const re = new RegExp(kw.source, 'g'), out: ReactNode[] = []
  let last = 0
  for (const m of s.matchAll(re)) {
    const i = m.index ?? 0
    if (i > last) out.push(s.slice(last, i))
    out.push(<span key={'k' + (at + i)} className="tok-kw">{m[0]}</span>)
    last = i + m[0].length
  }
  if (last < s.length) out.push(s.slice(last))
  return out
}

/** Which colouring a block gets: its fence's language, or a guess from the code (Python vs the C family). */
export function codeLang(lang: string, code: string): 'py' | 'c' | 'plain' {
  const l = lang.toLowerCase()
  if (['py', 'python', 'python3'].includes(l)) return 'py'
  if (['c', 'h', 'cpp', 'c++', 'cc', 'hpp', 'js', 'javascript', 'ts', 'typescript', 'tsx', 'jsx', 'java', 'rust', 'rs', 'go', 'cs', 'csharp', 'kotlin', 'swift'].includes(l)) return 'c'
  if (['text', 'txt', 'plain', 'output', 'console'].includes(l)) return 'plain'
  if (/^\s*(def |class |import |from \S+ import |for \S+ in |print\()/m.test(code) || /:\s*$/m.test(code) && !/[{};]\s*$/m.test(code)) return 'py'
  if (/[{};]\s*$/m.test(code) || /#include|\bint main\b|=>|\bconst |\blet /.test(code)) return 'c'
  return 'plain'
}

export function highlightCode(code: string, lang = ''): ReactNode[] {
  const k = codeLang(lang, code)
  return k === 'py' ? paint(code, PY_TOKEN) : k === 'c' ? paint(code, C_TOKEN, JS_EXTRA) : [code]
}

/** A code block in notes and coach replies: monospace, whitespace kept, scrolls sideways instead of wrapping,
 *  coloured with the --code-* tokens, with its language and a copy button above. */
export const MD_CODE = {
  pre: ({ children }: { children?: ReactNode }) => <>{children}</>,
  code: ({ className, children }: { className?: string; children?: ReactNode }) => {
    const src = String(children ?? '')
    const lang = /language-([\w+#-]+)/.exec(className ?? '')?.[1] ?? ''
    if (className?.includes('language-') || src.includes('\n')) return <CodeBlock code={src} lang={lang} />
    return <code className="ic">{children}</code>
  },
}

/** A `single-backtick` span that runs over a line break can't be inline code (Markdown would join its lines):
 *  it is written as a fenced block instead. Fenced blocks already in the text are left alone. */
export function fenceMultiline(md: string): string {
  return md.split(/(^```[\s\S]*?^```[^\n]*$)/m).map((part, i) =>
    i % 2 ? part : part.replace(/(^|[^`])`([^`\s][^`]*\n[^`]*[^`\s])`(?!`)/g, (_, pre: string, body: string) => `${pre}\n\`\`\`\n${body.trim()}\n\`\`\`\n`),
  ).join('')
}
