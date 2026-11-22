import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { codeLang, highlightCode } from './codefmt'
import { t } from './i18n'

/** A fenced code block: monospace, kept whitespace, scrolls sideways, coloured by language, with a Copy button. */
export function CodeBlock({ code, lang = '' }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false)
  const text = code.replace(/\n$/, '')
  return (
    <div className="codeblock">
      <div className="cb-head">
        <span className="cb-lang mono">{lang || { py: 'python', c: 'code', plain: 'text' }[codeLang(lang, text)]}</span>
        <button type="button" className="cb-copy" onClick={() => navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200) }).catch(() => {})}
          aria-label={t('Copy code')} title={t('Copy code')}>
          {copied ? <Check size={13} strokeWidth={1.9} /> : <Copy size={13} strokeWidth={1.7} />}{copied ? t('Copied') : t('Copy')}
        </button>
      </div>
      <pre className="cb-pre"><code>{highlightCode(text, lang)}</code></pre>
    </div>
  )
}

/** react-markdown overrides: a fenced block (or any code with a line break) becomes a CodeBlock, the rest stays inline. */
