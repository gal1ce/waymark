import { useCallback, useEffect, useRef, useState } from 'react'

/** Wraps an async action: `busy` is true while it runs, repeat clicks are ignored.
 *  Spread `busyProps(busy)` on the button to get the spinner + aria-busy. */
export function useBusy(): [boolean, <T>(fn: () => Promise<T>) => Promise<T | undefined>] {
  const [busy, setBusy] = useState(false)
  const live = useRef(true)
  const running = useRef(false)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  const run = useCallback(async <T,>(fn: () => Promise<T>) => {
    if (running.current) return undefined
    running.current = true; setBusy(true)
    try { return await fn() } finally { running.current = false; if (live.current) setBusy(false) }
  }, [])
  return [busy, run]
}
export const busyProps = (busy: boolean) => ({ 'aria-busy': busy || undefined, disabled: busy || undefined })

/** `[shaking, shake]`: call `shake()` on a rejected input, add `shake` to its className while `shaking`. */
export function useShake(): [boolean, () => void] {
  const [on, setOn] = useState(false)
  const t = useRef<number>(0)
  const shake = useCallback(() => {
    setOn(false)
    requestAnimationFrame(() => setOn(true))
    window.clearTimeout(t.current)
    t.current = window.setTimeout(() => setOn(false), 340)
  }, [])
  useEffect(() => () => window.clearTimeout(t.current), [])
  return [on, shake]
}

/** One-question-at-a-time tests: when the question changes, the current number chip scrolls into view and
 *  the answer box takes focus, so Enter → next question → keep typing. Only with a mouse or trackpad:
 *  on a phone, focusing would pop the keyboard over the question. */
export function useQuestionFocus(root: { current: HTMLElement | null }, cur: number, on: boolean) {
  useEffect(() => {
    const el = root.current
    if (!on || !el) return
    el.querySelector('.q-chip.cur')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    if (!window.matchMedia('(pointer: fine)').matches) return
    if (document.activeElement && document.activeElement !== document.body && !el.contains(document.activeElement)) return
    el.querySelector<HTMLElement>('.q.solo input:not(:disabled), .q.solo textarea:not(:disabled)')?.focus({ preventScroll: true })
  }, [root, cur, on])
}
