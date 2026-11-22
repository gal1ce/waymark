import { useEffect, useRef, useState, type RefObject } from 'react'

/** The app's own scrollbar: a thin thumb laid over the right edge of a scroller (whose native bar is hidden).
 *  It shows while scrolling or when the pointer is near, widens under the pointer, can be dragged, and a click on
 *  the track pages. Put it next to the scroller, inside a positioned parent. */
export function Scrollbar({ target }: { target: RefObject<HTMLElement | null> }) {
  const bar = useRef<HTMLDivElement>(null)
  const [g, setG] = useState<{ top: number; h: number; trackTop: number; trackH: number; right: number } | null>(null)
  const [live, setLive] = useState(false)
  const [near, setNear] = useState(false)
  const [dragging, setDragging] = useState(false)
  const hide = useRef<number | undefined>(undefined)
  const frame = useRef(0)

  useEffect(() => {
    const el = target.current
    if (!el) return
    const measure = () => {
      frame.current = 0
      const parent = bar.current?.parentElement
      if (!parent) return
      const r = el.getBoundingClientRect(), pr = parent.getBoundingClientRect()
      const max = el.scrollHeight - el.clientHeight
      if (max <= 1 || r.height < 40) { setG(null); return }
      const trackTop = r.top - pr.top + 4, trackH = r.height - 8
      const h = Math.max(32, trackH * (el.clientHeight / el.scrollHeight))
      setG({ trackTop, trackH, h, top: trackTop + (el.scrollTop / max) * (trackH - h), right: pr.right - r.right + 2 })
    }
    const queue = () => { if (!frame.current) frame.current = requestAnimationFrame(measure) }
    const onScroll = () => {
      queue()
      setLive(true)
      window.clearTimeout(hide.current)
      hide.current = window.setTimeout(() => setLive(false), 900)
    }
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect()
      setNear(e.clientX > r.right - 18 && e.clientX <= r.right + 2 && e.clientY >= r.top && e.clientY <= r.bottom)
    }
    measure()
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('pointermove', onMove, { passive: true })
    el.addEventListener('pointerleave', () => setNear(false))
    const ro = new ResizeObserver(queue)
    ro.observe(el)
    const mo = new MutationObserver(queue)
    mo.observe(el, { childList: true, subtree: true, characterData: true })
    window.addEventListener('resize', queue)
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('pointermove', onMove)
      ro.disconnect(); mo.disconnect()
      window.removeEventListener('resize', queue)
      cancelAnimationFrame(frame.current); frame.current = 0
      window.clearTimeout(hide.current)
    }
  }, [target])

  const drag = (e: React.PointerEvent) => {
    const el = target.current
    if (!el || !g) return
    e.preventDefault(); e.stopPropagation()
    const y0 = e.clientY, s0 = el.scrollTop
    const k = (el.scrollHeight - el.clientHeight) / Math.max(1, g.trackH - g.h)
    const t = e.currentTarget as HTMLElement
    t.setPointerCapture(e.pointerId)
    setDragging(true)
    const move = (ev: PointerEvent) => { el.scrollTop = s0 + (ev.clientY - y0) * k }
    const up = () => { setDragging(false); t.removeEventListener('pointermove', move); t.removeEventListener('pointerup', up); t.removeEventListener('pointercancel', up) }
    t.addEventListener('pointermove', move)
    t.addEventListener('pointerup', up)
    t.addEventListener('pointercancel', up)
  }
  const page = (e: React.PointerEvent) => {
    const el = target.current
    if (!el || !g || e.target !== e.currentTarget) return
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const below = e.clientY - r.top > g.top - g.trackTop + g.h / 2
    el.scrollBy({ top: (below ? 1 : -1) * el.clientHeight * 0.9, behavior: 'smooth' })
  }

  return (
    <div ref={bar} className={'osb' + (g ? '' : ' none') + (live || near || dragging ? ' show' : '') + (near || dragging ? ' wide' : '')} aria-hidden
      style={g ? { top: g.trackTop, height: g.trackH, right: g.right } : undefined} onPointerDown={page}
      onPointerEnter={() => setNear(true)} onPointerLeave={() => { if (!dragging) setNear(false) }}>
      {g && <div className="osb-thumb" style={{ top: g.top - g.trackTop, height: g.h }} onPointerDown={drag} />}
    </div>
  )
}
