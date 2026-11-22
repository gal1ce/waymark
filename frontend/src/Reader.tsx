import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { api } from './api'
import { t as tr } from './i18n'

/** Read-only Kintsugi source viewer. Scrolling here counts as reading activity for the monitor. */
export default function Reader({ path, onClose }: { path: string; onClose: () => void }) {
  const [content, setContent] = useState<string | null>(null)
  const last = useRef(0)
  const closeBtn = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null
    closeBtn.current?.focus({ preventScroll: true })
    return () => back?.focus?.({ preventScroll: true })
  }, [])

  useEffect(() => { api.kintsugi(path).then((r) => setContent(r.content)).catch(() => setContent('(could not read file)')) }, [path])
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])

  const onScroll = () => {
    const now = Date.now()
    if (now - last.current > 60000) { last.current = now; api.heartbeat(true, path).catch(() => {}) }
  }

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="reader" role="dialog" aria-modal="true" aria-label={path}>
        <div className="reader-head">
          <span className="p">kintsugi/{path}</span>
          <span className="reader-meta">read only · {content ? content.split('\n').length : 0} lines</span>
          <button ref={closeBtn} className="icon-btn" onClick={onClose} aria-label={tr('Close')} title={`${tr('Close')}  Esc`}><X size={16} strokeWidth={1.5} /></button>
        </div>
        <div className="reader-body" onScroll={onScroll}>
          {content?.split('\n').map((l, i) => <div className="ln" key={i}><span>{i + 1}</span><span>{l || ' '}</span></div>)}
        </div>
      </div>
    </>
  )
}
