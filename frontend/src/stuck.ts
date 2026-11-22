import type { Stuck } from './api'
import { t as tr } from './i18n'

/** Sticking points are stored as the app wrote them (English, "Wrong answer · topic", "Answer: x · Correct: y").
    Shown in the interface language, and without repeating the source the line under it already names. */
export const stuckSummary = (s: Pick<Stuck, 'summary' | 'source'>) => {
  const m = /^Wrong answer · (.+)$/.exec(s.summary)
  if (m && s.source === 'wrong_answer') return m[1]
  const u = /^(.+) unit test ([\d.]+)% \(threshold ([\d.]+)%\)$/.exec(s.summary)
  if (u) return tr('{unit} unit test {p}% (threshold {t}%)', { unit: u[1], p: u[2], t: u[3] })
  return s.summary
}
export const stuckDetail = (d: string) => {
  const m = /^Answer: (.*) · Correct: (.*)$/s.exec(d)
  return m ? tr('Your answer: {a} · Correct: {b}', { a: m[1] === '(empty)' ? tr('(empty)') : m[1], b: m[2] }) : d
}
