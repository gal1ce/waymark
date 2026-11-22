import { useEffect, useLayoutEffect, useRef, useState } from 'react'

const DELAY = 500   // first tooltip waits, so passing the cursor over things stays quiet
const SKIP = 300    // after one closes, the next opens instantly within this window
const GAP = 8

type State = { text: string; x: number; y: number; below: boolean; instant: boolean } | null

/** One app-wide tooltip. Any element with `title` gets it; the native title is parked in
 *  `data-tip` while hovered so the browser's own tooltip doesn't double up. */
export default function Tip() {
  const [tip, setTip] = useState<State>(null)
  const el = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let target: HTMLElement | null = null
    let timer = 0
    let closedAt = 0
    let shown = false

    const restore = (t: HTMLElement | null) => {
      if (t?.dataset.tip == null) return
      t.setAttribute('title', t.dataset.tip); delete t.dataset.tip
      if (t.dataset.tipLabel != null) { t.removeAttribute('aria-label'); delete t.dataset.tipLabel }
    }
    const hide = () => {
      window.clearTimeout(timer)
      if (shown) closedAt = performance.now()
      shown = false
      restore(target); target = null
      setTip(null)
    }
    const place = (t: HTMLElement, instant: boolean) => {
      const text = t.dataset.tip
      if (!text) return
      const r = t.getBoundingClientRect()
      const below = r.top < 48
      setTip({ text, x: r.left + r.width / 2, y: below ? r.bottom + GAP : r.top - GAP, below, instant })
      shown = true
    }
    const enter = (t: HTMLElement) => {
      if (t === target) return
      const wasShown = shown
      hide()
      const title = t.getAttribute('title')
      if (!title) return
      target = t
      t.dataset.tip = title
      t.removeAttribute('title')
      // an icon-only control named by its title keeps that name while the title is parked
      if (!t.hasAttribute('aria-label') && !t.textContent?.trim()) { t.setAttribute('aria-label', title); t.dataset.tipLabel = '' }
      const quick = wasShown || performance.now() - closedAt < SKIP
      if (quick) place(t, true)
      else timer = window.setTimeout(() => target === t && place(t, false), DELAY)
    }

    const over = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return
      const t = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('[title], [data-tip]')
      if (t) enter(t)
      else if (target) hide()
    }
    const focus = (e: FocusEvent) => {
      const t = e.target as HTMLElement
      if (t.matches?.(':focus-visible') && (t.hasAttribute('title') || t.dataset.tip)) enter(t)
    }
    const blur = (e: FocusEvent) => { if (e.target === target) hide() }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && target) hide() }

    document.addEventListener('pointerover', over)
    document.addEventListener('pointerdown', hide, true)
    document.addEventListener('focusin', focus)
    document.addEventListener('focusout', blur)
    document.addEventListener('keydown', key)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('blur', hide)
    return () => {
      hide()
      document.removeEventListener('pointerover', over)
      document.removeEventListener('pointerdown', hide, true)
      document.removeEventListener('focusin', focus)
      document.removeEventListener('focusout', blur)
      document.removeEventListener('keydown', key)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('blur', hide)
    }
  }, [])

  // clamp horizontally once the real width is known, and point the scale origin at the target
  const [shift, setShift] = useState(0)
  useLayoutEffect(() => {
    const n = el.current
    if (!tip || !n) { setShift(0); return }
    const w = n.offsetWidth
    const left = Math.min(Math.max(8, tip.x - w / 2), window.innerWidth - w - 8)
    setShift(left - (tip.x - w / 2))
  }, [tip])

  if (!tip) return null
  return (
    <div ref={el} role="tooltip" className={'tip' + (tip.instant ? ' instant' : '')}
      style={{
        left: tip.x, top: tip.y,
        translate: `calc(-50% + ${shift}px) ${tip.below ? '0' : '-100%'}`,
        ['--o' as string]: `calc(50% - ${shift}px) ${tip.below ? '0%' : '100%'}`,
      }}>
      {tip.text}
    </div>
  )
}
