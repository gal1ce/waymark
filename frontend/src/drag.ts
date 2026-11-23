import { useState } from 'react'

/* Moving a floating window by its head: the calculator, the Ask popup, the video notes. The window stays on screen
   (at least its head), and with a `key` the place is remembered for next time. */

export type Pos = { x: number; y: number }

const read = (key?: string): Pos | null => {
  if (!key) return null
  try { return JSON.parse(localStorage.getItem(key) ?? 'null') } catch { return null }
}

export function useDrag(key?: string) {
  const [pos, setPos] = useState<Pos | null>(() => read(key))
  /** onPointerDown of the head; presses on its buttons and fields stay theirs */
  const start = (e: React.PointerEvent, box: HTMLElement | null) => {
    if (!box || e.button !== 0 || (e.target as HTMLElement).closest('button, a, input, textarea, select')) return
    e.preventDefault()
    const r = box.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top
    let last: Pos | null = null
    const move = (ev: PointerEvent) => {
      last = {
        x: Math.max(8, Math.min(window.innerWidth - Math.min(r.width, window.innerWidth - 16) - 8, ev.clientX - dx)),
        y: Math.max(8, Math.min(window.innerHeight - 48, ev.clientY - dy)),
      }
      setPos(last)
    }
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up)
      if (key && last) try { localStorage.setItem(key, JSON.stringify(last)) } catch { /* only a preference */ }
    }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }
  /** forget the place (back to where the window sits by default) */
  const reset = () => { setPos(null); if (key) try { localStorage.removeItem(key) } catch { /* only a preference */ } }
  return { pos, setPos, start, reset }
}
