import { useCallback, useEffect, useState } from 'react'

export type ThemePref = 'system' | 'light' | 'dark'
const KEY = 'ctu.theme'
const dark = () => matchMedia('(prefers-color-scheme: dark)')

function read(): ThemePref {
  try { const v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : 'system' } catch { return 'system' }
}

function apply(pref: ThemePref) {
  const on = pref === 'dark' || (pref === 'system' && dark().matches)
  document.documentElement.dataset.theme = on ? 'dark' : 'light'
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', on ? '#1a1b1e' : '#f4f7fb')
}

/** System / light / dark, remembered on this computer. System follows the OS setting live. */
export function useTheme(): [ThemePref, (p: ThemePref) => void, 'light' | 'dark'] {
  const [pref, setPref] = useState<ThemePref>(read)
  const [resolved, setResolved] = useState<'light' | 'dark'>(() => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'))
  useEffect(() => {
    apply(pref)
    setResolved(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')
    if (pref !== 'system') return
    const mq = dark()
    const on = () => { apply('system'); setResolved(mq.matches ? 'dark' : 'light') }
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [pref])
  const set = useCallback((p: ThemePref) => {
    try { localStorage.setItem(KEY, p) } catch { /* private mode: still applies for this visit */ }
    // a short cross-fade between the two sheets, skipped when motion is reduced
    const root = document.documentElement
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      root.classList.add('theme-fade')
      window.setTimeout(() => root.classList.remove('theme-fade'), 320)
    }
    setPref(p)
  }, [])
  return [pref, set, resolved]
}

/** Something earned XP: the counter refetches and shows the gain. */
export const bumpXp = () => window.dispatchEvent(new Event('ctu:xp'))

/** Which side the navigation rail and the coach panel sit on, remembered on this computer. */
export type Side = 'left' | 'right'
export type Layout = { nav: Side; coach: Side }
const LAYOUT = 'ctu.layout'
const readLayout = (): Layout => {
  try {
    const v = JSON.parse(localStorage.getItem(LAYOUT) ?? '{}')
    return { nav: v.nav === 'right' ? 'right' : 'left', coach: v.coach === 'left' ? 'left' : 'right' }
  } catch { return { nav: 'left', coach: 'right' } }
}
export function useLayout(): [Layout, (p: Partial<Layout>) => void] {
  const [l, setL] = useState<Layout>(readLayout)
  useEffect(() => {
    const on = () => setL(readLayout())
    window.addEventListener('ctu:layout', on)
    return () => window.removeEventListener('ctu:layout', on)
  }, [])
  const set = useCallback((p: Partial<Layout>) => {
    const next = { ...readLayout(), ...p }
    try { localStorage.setItem(LAYOUT, JSON.stringify(next)) } catch { /* private mode */ }
    setL(next)
    window.dispatchEvent(new Event('ctu:layout'))
  }, [])
  return [l, set]
}

/** The accent colour, picked in Settings. Stored as hex; applied as OKLCH parts that index.css turns into a light-theme
 *  and a dark-theme tone (a deep indigo can't be used as is on graphite). */
export const DEFAULT_ACCENT = '#27294c'
export const ACCENTS: { hex: string; name: string }[] = [
  { hex: '#27294c', name: 'Indigo' },
  { hex: '#3d86d6', name: 'Sky' },
  { hex: '#1f5f5b', name: 'Teal' },
  { hex: '#2f5d3a', name: 'Forest' },
  { hex: '#5b2a4e', name: 'Plum' },
  { hex: '#8a3b1f', name: 'Rust' },
]
const ACCENT = 'ctu.accent'

export function hexToOklch(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 })
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const mm = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.793617785 * mm - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * mm + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * mm - 0.808675766 * s
  return [L, Math.hypot(A, B), ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360]
}

function applyAccent(hex: string) {
  const v = hexToOklch(hex) ?? hexToOklch(DEFAULT_ACCENT)!
  const st = document.documentElement.style
  st.setProperty('--acc-l', v[0].toFixed(3)); st.setProperty('--acc-c', v[1].toFixed(3)); st.setProperty('--acc-h', v[2].toFixed(1))
  // index.html reads this before the first paint, so a picked colour never flashes the default
  try { localStorage.setItem(ACCENT + '.lch', `${v[0].toFixed(3)} ${v[1].toFixed(3)} ${v[2].toFixed(1)}`) } catch { /* private mode */ }
}
const readAccent = () => { try { const v = localStorage.getItem(ACCENT); return v && hexToOklch(v) ? v.toLowerCase() : DEFAULT_ACCENT } catch { return DEFAULT_ACCENT } }

export function useAccent(): [string, (hex: string) => void] {
  const [hex, setHex] = useState(readAccent)
  useEffect(() => { applyAccent(hex) }, [hex])
  const set = useCallback((h: string) => {
    if (!hexToOklch(h)) return
    try { localStorage.setItem(ACCENT, h.toLowerCase()) } catch { /* private mode */ }
    setHex(h.toLowerCase())
  }, [])
  return [hex, set]
}
