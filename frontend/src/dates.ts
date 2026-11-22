/* Plain dates (YYYY-MM-DD) and times (HH:MM), worked out in UTC so the computer's time zone never shifts a day. */
import { dayName, MONTHS } from './i18n'

export const pad = (n: number) => String(n).padStart(2, '0')
export const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`
export const parts = (s: string) => s.split('-').map(Number)
const utc = (s: string) => { const [y, m, d] = parts(s); return new Date(Date.UTC(y, m - 1, d)) }
export const fromUtc = (d: Date) => iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
export const addDays = (s: string, n: number) => { const d = utc(s); d.setUTCDate(d.getUTCDate() + n); return fromUtc(d) }
/** whole days from a to b */
export const daysBetween = (a: string, b: string) => Math.round((utc(b).getTime() - utc(a).getTime()) / 86400000)
/** Monday = 0 … Sunday = 6 */
export const weekdayMon = (s: string) => (utc(s).getUTCDay() + 6) % 7
/** "22 Kasım 2026" / "November 22, 2026" */
export const longDate = (s: string, withDay = false) => {
  if (!s) return ''
  const [y, m, d] = parts(s)
  const wd = withDay ? (document.documentElement.lang === 'tr' ? `, ${dayLong(s)}` : `${dayLong(s)}, `) : ''
  return document.documentElement.lang === 'tr' ? `${d} ${MONTHS[m - 1]} ${y}${wd}` : `${wd}${MONTHS[m - 1]} ${d}, ${y}`
}
const dayLong = (s: string) => dayName(utc(s).getUTCDay())
export const monthLabel = (ym: string) => { if (!ym) return ''; const [y, m] = parts(ym); return `${MONTHS[m - 1]} ${y}` }

export const toMin = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m }
export const fromMin = (n: number) => { const v = ((n % 1440) + 1440) % 1440; return `${pad(Math.floor(v / 60))}:${pad(v % 60)}` }
