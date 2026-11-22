import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { GenLive } from './api'
import { t as tr, tx } from './i18n'

const PHASE: Record<GenLive['phase'], string> = {
  preparing: 'Preparing', writing: 'Writing questions', checking: 'Checking', ready: 'Ready', failed: 'Failed',
}
const START: GenLive = { phase: 'preparing', model: null, chars: 0, log: [] }

/** Live narration of test generation, fed by `ctu:test-progress` events from the app's stream.
 *  Shows steps, the model, and each question's topic as it's written; never question text or answers.
 *  `compact` is the chat version: the test's link in the header and only the latest few steps. */
export function GenLog({ id, init, compact = false }: { id: number; init?: GenLive | null; compact?: boolean }) {
  const [lv, setLv] = useState<GenLive>(init ?? START)
  const [at, setAt] = useState(() => performance.now())
  const [clock, setClock] = useState(() => performance.now())
  const live = lv.phase === 'preparing' || lv.phase === 'writing' || lv.phase === 'checking'

  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<GenLive & { id: number }>).detail
      if (d?.id === id) { setLv(d); setAt(performance.now()) }
    }
    window.addEventListener('ctu:test-progress', on)
    return () => window.removeEventListener('ctu:test-progress', on)
  }, [id])
  useEffect(() => {
    if (!live) return
    const i = window.setInterval(() => setClock(performance.now()), 100)
    return () => window.clearInterval(i)
  }, [live])

  // follow the newest step as it's written, unless the reader has scrolled away from the end of the log
  const list = useRef<HTMLOListElement>(null)
  const seen = useRef(lv.log.length)
  useLayoutEffect(() => {
    const ol = list.current
    if (!ol || compact || lv.log.length <= seen.current) { seen.current = lv.log.length; return }
    seen.current = lv.log.length
    const items = ol.querySelectorAll('li')
    const prev = items[items.length - 2]
    if (prev && prev.getBoundingClientRect().top > window.innerHeight + 40) return
    items[items.length - 1]?.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }, [lv.log.length, compact])

  const elapsed = (lv.elapsed ?? 0) + (live ? Math.max(0, clock - at) / 1000 : 0)
  const TAIL = 4
  const log = compact ? lv.log.slice(-TAIL) : lv.log
  const hidden = lv.log.length - log.length
  return (
    <section className={'card gen' + (live ? ' live' : '') + (compact ? ' compact' : '')} aria-live="polite" aria-busy={live}>
      <div className="gen-head">
        {live ? <span className="busy-road" aria-hidden /> : <span className={'dot ' + (lv.phase === 'failed' ? 'neg' : 'pos')} aria-hidden />}
        {compact && <a className="gen-title" href={`#/test/${id}`}>{tr('Practice test #{n}', { n: id })}</a>}
        <b>{tx(PHASE[lv.phase])}</b>
        {lv.model && <span className="gen-model">{lv.model}</span>}
        <span className="gen-meter">{elapsed.toFixed(1)} s{!compact && lv.chars > 0 && <> · {lv.chars.toLocaleString('en-US')} chars</>}</span>
      </div>
      {(log.length > 0 || lv.phase === 'writing') && (
        <ol className="gen-log" ref={list}>
          {hidden > 0 && <li className="k-more"><span className="gen-t" /><span>{hidden} earlier step{hidden > 1 ? 's' : ''}</span></li>}
          {log.map((l, i) => (
            <li key={hidden + i} className={'k-' + l.kind}><span className="gen-t">{l.t.toFixed(1)}</span>
              {l.kind === 'q' && !compact ? <span className="gen-q"><span className="gen-qn">{log.slice(0, i + 1).filter((x) => x.kind === 'q').length}</span>{l.text}</span> : <span>{l.text}</span>}</li>
          ))}
          {lv.phase === 'writing' && <li className="k-now"><span className="gen-t" /><span>writing<span className="caret" /></span></li>}
        </ol>
      )}
    </section>
  )
}
