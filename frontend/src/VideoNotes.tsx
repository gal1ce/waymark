import { useEffect, useRef, useState, type RefObject } from 'react'
import { Clock, GripHorizontal, PanelRightClose } from 'lucide-react'
import { api, type DocBlock } from './api'
import { t as tr } from './i18n'
import { useDrag } from './drag'

/* Watching a Khan video: its speed (Firefox's own controls have no speed menu) and a notes column beside it. */

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]
const RATE_KEY = 'ctu.video.rate'
export const savedRate = (): number => {
  try { const r = Number(localStorage.getItem(RATE_KEY)); return RATES.includes(r) ? r : 0.75 } catch { return 0.75 }
}

/** Speed buttons; the choice is remembered for the next video. */
export function SpeedPicker({ video }: { video: RefObject<HTMLVideoElement | null> }) {
  const [rate, setRate] = useState(savedRate)
  const pick = (r: number) => {
    setRate(r)
    if (video.current) video.current.playbackRate = r
    try { localStorage.setItem(RATE_KEY, String(r)) } catch { /* only a preference */ }
  }
  // the native controls or a key may change the speed too: follow it
  useEffect(() => {
    const v = video.current
    if (!v) return
    const on = () => setRate(v.playbackRate)
    v.addEventListener('ratechange', on)
    return () => v.removeEventListener('ratechange', on)
  }, [video])
  return (
    <div className="seg sm vid-speed" role="radiogroup" aria-label={tr('Playback speed')}>
      {RATES.map((r) => (
        <button key={r} role="radio" aria-checked={rate === r} className={rate === r ? 'on' : ''} onClick={() => pick(r)}>{r}×</button>
      ))}
    </div>
  )
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

/** Notes for one video, kept as a page in the Notebook ("Video · <title>"), made on the first word typed. */
export function VideoNotes({ title, video }: { title: string; video: RefObject<HTMLVideoElement | null> }) {
  const name = `Video · ${title}`
  const [text, setText] = useState('')
  const [page, setPage] = useState<number | null>(null)
  const [state, setState] = useState<'loading' | 'idle' | 'saving' | 'saved' | 'error'>('loading')
  const ta = useRef<HTMLTextAreaElement>(null)
  const box = useRef<HTMLElement>(null)
  // dragged by its head it floats over the page (the video then takes the whole width); "Dock" puts it back beside it
  const drag = useDrag('ctu.video.notes.pos')
  const floating = drag.pos != null
  const timer = useRef<number | undefined>(undefined)
  const latest = useRef({ text, page })
  latest.current = { text, page }

  useEffect(() => {
    let live = true
    api.notesList().then(async ({ pages }) => {
      const p = pages.find((x) => x.title === name && x.kind === 'doc')
      if (!p) { if (live) setState('idle'); return }
      const full = await api.notesGet(p.id)
      const body = full.body as { blocks?: DocBlock[] }
      const md = (body.blocks ?? []).map((b) => ('md' in b ? b.md : '')).filter(Boolean).join('\n\n')
      if (live) { setPage(p.id); setText(md); setState('idle') }
    }).catch(() => live && setState('idle'))
    return () => { live = false }
  }, [name])

  const save = async () => {
    const { text: md, page: id } = latest.current
    if (!md.trim() && id === null) return
    setState('saving')
    try {
      const body = { blocks: [{ id: 'v1', type: 'text', md } as DocBlock] }
      let pid = id
      if (pid === null) { pid = (await api.notesNew(name, 'doc')).id; setPage(pid); latest.current.page = pid }
      await api.notesSave(pid, { body })
      setState('saved')
    } catch { setState('error') }
  }
  const change = (v: string) => {
    setText(v)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(save, 700)
  }
  // leaving the video saves what is still waiting
  useEffect(() => () => { if (timer.current) { window.clearTimeout(timer.current); void save() } }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  const stamp = () => {
    const el = ta.current, v = video.current
    if (!el || !v) return
    const at = el.selectionStart, s = `[${fmt(v.currentTime)}] `
    const before = text.slice(0, at), pre = before && !before.endsWith('\n') ? '\n' : ''
    change(before + pre + s + text.slice(at))
    requestAnimationFrame(() => { el.focus(); el.selectionStart = el.selectionEnd = at + pre.length + s.length })
  }

  return (
    <aside ref={box} className={'vid-notes' + (floating ? ' float' : '') + (state === 'error' ? ' bad' : '')} aria-label={tr('Video notes')}
      style={floating ? { left: drag.pos!.x, top: drag.pos!.y, maxHeight: `calc(100vh - ${drag.pos!.y + 8}px)` } : undefined}>
      <div className="vid-notes-h" onPointerDown={(e) => drag.start(e, box.current)} title={floating ? undefined : tr('Drag to move the notes over the video')}>
        <GripHorizontal size={14} strokeWidth={1.6} className="calc-grip" aria-hidden />
        <b>{tr('Notes')}</b>
        <span className="vid-notes-st">{state === 'saving' ? tr('Saving…') : state === 'saved' ? tr('Saved to the Notebook') : state === 'error' ? tr('Not saved') : ''}</span>
        <button className="btn ghost sm" onClick={stamp} title={tr('Insert the video time')}><Clock size={13} strokeWidth={1.6} />{tr('Time')}</button>
        {floating && <button className="icon-btn sm" onClick={drag.reset} aria-label={tr('Dock beside the video')} title={tr('Dock beside the video')}><PanelRightClose size={15} strokeWidth={1.6} /></button>}
      </div>
      <textarea ref={ta} className="vid-notes-ta" value={text} disabled={state === 'loading'} onChange={(e) => change(e.target.value)}
        placeholder={tr('Type while you watch. Markdown and $maths$ work; it is kept in the Notebook.')} />
    </aside>
  )
}
