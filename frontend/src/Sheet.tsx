import { t as tr } from './i18n'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ArrowRight, Check, Delete, Eye, FileText, Keyboard, Lightbulb, Lock, PencilLine, PenLine, X, Zap } from 'lucide-react'
import type { Board, DocBlock, PageSetup, Stroke } from './api'
import { DocEditor } from './DocEditor'
import { DocPage } from './DocPage'
import BoardView from './Board'
import { Scrollbar } from './Scrollbar'

/* The study sheet: one question at a time, centred on graph paper, nothing else on screen. Shared by Khan
   practice, the Khan unit test and the end-of-day test. A bar on top (close, where you are, how far along),
   the problem in the publishing serif, the answer line, hint pills, scratch paper and a keypad. */

export function SheetFrame({ title, step, progress, onClose, closeLabel = 'Close', right, children, bar }: {
  title: ReactNode; step?: ReactNode; progress?: number; onClose: () => void; closeLabel?: string; right?: ReactNode
  children: ReactNode; bar?: ReactNode
}) {
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('.scratch-sheet, .ctxmenu, .ask')) return
      const t = e.target as HTMLElement
      if (t.closest('input, textarea')) { t.blur(); return }
      onClose()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  // pick an answer with the number keys, like flash quizzes do
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || !/^[1-9]$/.test(e.key)) return
      if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return
      const ch = document.querySelectorAll<HTMLButtonElement>('.sheet-body .choice:not(:disabled)')
      const b = ch[Number(e.key) - 1]
      if (b) { e.preventDefault(); b.click(); b.focus({ preventScroll: true }) }
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [])
  // on document.body: an animated ancestor (a page entering) would otherwise become the fixed sheet's frame
  return createPortal(
    <div className="sheet" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : tr('Study sheet')}>
      <div className="sheet-top">
        <button className="icon-btn" onClick={onClose} aria-label={closeLabel} title={`${closeLabel}  Esc`}><X size={18} strokeWidth={1.7} /></button>
        <div className="sheet-where"><span className="sheet-t">{title}</span>{step && <span className="sheet-step">{step}</span>}</div>
        <div className="sheet-r">{right}</div>
        {progress != null && <div className="sheet-prog" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}><span style={{ width: `${Math.max(0, Math.min(1, progress)) * 100}%` }} /></div>}
      </div>
      <div className="sheet-body" ref={body}>{children}</div>
      <Scrollbar target={body} />
      {bar}
    </div>,
    document.body,
  )
}

/** Hint 1, Hint 2, then Locked: a hint opens only after the one before it. */
export function HintPills({ taken, total, onTake, onShow, busy, disabled, extra }: {
  taken: number; total: number; onTake: () => void; onShow: (i: number) => void; busy?: boolean; disabled?: boolean; extra?: ReactNode
}) {
  return (
    <div className="pills" role="group" aria-label={tr('Help')}>
      {extra}
      {Array.from({ length: total }, (_, i) => {
        const has = i < taken, next = i === taken
        return (
          <button key={i} className={'pill' + (has ? ' taken' : next ? ' next' : ' locked')} disabled={disabled || busy || (!has && !next)}
            onClick={() => (has ? onShow(i) : onTake())} title={next ? 'A hint before your first answer counts this question as a miss' : undefined}>
            <span className="pill-n">{has ? <Check size={12} strokeWidth={2.4} /> : next ? i + 1 : <Lock size={11} strokeWidth={2} />}</span>
            {has || next ? tr('Hint {n}', { n: i + 1 }) : tr('Locked')}
          </button>
        )
      })}
    </div>
  )
}

/** A tool in the sheet's top bar: scratch paper, the keypad. Icon, a word, and its key. */
export function SheetTool({ on, onClick, label, kbd, children }: { on?: boolean; onClick: () => void; label: string; kbd?: string; children: ReactNode }) {
  return (
    <button className={'sheet-tool' + (on ? ' on' : '')} onClick={onClick} aria-pressed={on} title={kbd ? `${label}  ${kbd}` : label}>
      {children}<span className="st-l">{label}</span>{kbd && <kbd>{kbd}</kbd>}
    </button>
  )
}

/** A round icon pill: scratch paper, keypad. */
export function ToolPill({ on, onClick, label, children }: { on?: boolean; onClick: () => void; label: string; children: ReactNode }) {
  return <button className={'pill round' + (on ? ' on' : '')} onClick={onClick} aria-label={label} aria-pressed={on} title={label}>{children}</button>
}

/** Types into whichever answer box was used last, so React sees an ordinary keystroke. */
function typeInto(el: HTMLInputElement | null, text: string | 'back' | 'left' | 'right') {
  if (!el || el.disabled) return
  el.focus({ preventScroll: true })
  if (text === 'left' || text === 'right') {
    const p = Math.max(0, Math.min(el.value.length, (el.selectionStart ?? 0) + (text === 'left' ? -1 : 1)))
    el.setSelectionRange(p, p); return
  }
  if (text === 'back') { if ((el.selectionStart ?? 0) === (el.selectionEnd ?? 0) && (el.selectionStart ?? 0) > 0) el.setSelectionRange((el.selectionStart ?? 1) - 1, el.selectionEnd ?? 0); document.execCommand('delete'); return }
  document.execCommand('insertText', false, text)
}

const KEYS: [string, string | 'back' | 'left' | 'right'][][] = [
  [['7', '7'], ['8', '8'], ['9', '9'], ['(', '('], [')', ')'], ['⌫', 'back']],
  [['4', '4'], ['5', '5'], ['6', '6'], ['+', '+'], ['−', '-'], ['√', 'sqrt(']],
  [['1', '1'], ['2', '2'], ['3', '3'], ['×', '*'], ['÷', '/'], ['xⁿ', '^']],
  [['0', '0'], ['.', '.'], ['x', 'x'], ['π', 'pi'], ['←', 'left'], ['→', 'right']],
]

/** The on-screen keypad: digits, operations and the symbols that are awkward to type. */
export function Keypad({ scope, onCheck, checkLabel = 'Check' }: { scope: React.RefObject<HTMLElement | null>; onCheck?: () => void; checkLabel?: string }) {
  const last = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    const el = scope.current
    if (!el) return
    const f = (e: FocusEvent) => { if (e.target instanceof HTMLInputElement && e.target.type !== 'checkbox') last.current = e.target }
    el.addEventListener('focusin', f)
    last.current = el.querySelector('input:not(:disabled)')
    return () => el.removeEventListener('focusin', f)
  }, [scope])
  return (
    <div className="keypad" role="group" aria-label={tr('Keypad')} onMouseDown={(e) => e.preventDefault()}>
      {KEYS.flat().map(([l, v]) => (
        <button key={l} className={'key' + (v === 'back' ? ' back' : /^[0-9.]$/.test(v) ? ' digit' : '')} aria-label={v === 'back' ? tr('Delete') : l}
          onClick={() => typeInto(last.current ?? scope.current?.querySelector('input:not(:disabled)') ?? null, v)}>
          {v === 'back' ? <Delete size={16} strokeWidth={1.7} /> : l}
        </button>
      ))}
      {onCheck && <button className="key check" onClick={onCheck}>{checkLabel}</button>}
    </div>
  )
}

const scratchStore = new Map<string, Board>()
const paperStore = new Map<string, { blocks: DocBlock[]; page?: PageSetup; ink?: Stroke[] }>()
type ScratchMode = 'ink' | 'paper'
const MODE_KEY = 'ctu.scratch.mode'
const readMode = (): ScratchMode => { try { return localStorage.getItem(MODE_KEY) === 'paper' ? 'paper' : 'ink' } catch { return 'ink' } }

/** Scratch paper over the question, kept per question until the page is closed. Two kinds, the last one used comes
 *  back: a canvas to write on with the pen, or a sheet of paper (squared by default) to type on, with maths, graphs,
 *  columns and free placement, like a notebook page. */
export function Scratch({ id, onClose, question }: { id: string; onClose: () => void; question: ReactNode }) {
  const [b, setB] = useState<Board>(() => scratchStore.get(id) ?? { items: [], arrows: [], strokes: [] })
  const [paper, setPaper] = useState(() => paperStore.get(id) ?? { blocks: [{ id: 'p1', type: 'text', md: '' } as DocBlock], page: { size: window.innerWidth < 640 ? 'A5' : 'A4', paper: 'grid' } as PageSetup })
  const [mode, setModeS] = useState<ScratchMode>(readMode)
  const [peek, setPeek] = useState(false)
  const setMode = (m: ScratchMode) => { setModeS(m); try { localStorage.setItem(MODE_KEY, m) } catch { /* only a preference */ } }
  const keep = (x: typeof paper) => { setPaper(x); paperStore.set(id, x) }
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Esc first leaves what is open on the paper (a text being written, a dialog, a menu), then the scratch paper
      if (document.querySelector('.scratch-sheet .modal-wrap, .modal-wrap .gx-modal, .look-pop')) return
      const tg = e.target as HTMLElement
      if (tg.closest?.('.scratch-paper textarea, .scratch-paper input')) { e.stopPropagation(); tg.blur(); return }
      e.stopPropagation(); onClose()
    }
    window.addEventListener('keydown', k, true)
    return () => window.removeEventListener('keydown', k, true)
  }, [onClose])
  return (
    <div className="scratch-sheet" role="dialog" aria-label={tr('Scratch paper')}>
      {mode === 'ink'
        ? <BoardView mode="scratch" board={b} onChange={(x) => { setB(x); scratchStore.set(id, x) }} />
        : <div className="scratch-paper">
            <DocPage setup={paper.page} onSetup={(page) => keep({ ...paper, page })} bar={<span className="grow" />}>
              {(sheet) => <DocEditor blocks={paper.blocks} onChange={(blocks) => keep({ ...paper, blocks })} sheet={sheet} ink={paper.ink} onInk={(ink) => keep({ ...paper, ink })} />}
            </DocPage>
          </div>}
      <div className="scratch-top">
        <div className="seg sm scratch-mode" role="radiogroup" aria-label={tr('Kind of scratch paper')}>
          <button role="radio" aria-checked={mode === 'ink'} className={mode === 'ink' ? 'on' : ''} onClick={() => setMode('ink')}><PenLine size={14} strokeWidth={1.7} />{tr('Canvas')}</button>
          <button role="radio" aria-checked={mode === 'paper'} className={mode === 'paper' ? 'on' : ''} onClick={() => setMode('paper')}><FileText size={14} strokeWidth={1.7} />{tr('Paper')}</button>
        </div>
        <span className="grow" />
        <button className={'btn sm pill' + (peek ? ' on' : '')} onClick={() => setPeek((p) => !p)} aria-label={peek ? tr('Hide question') : tr('View question')}>
          <Eye size={14} strokeWidth={1.7} /><span className="lbl">{peek ? tr('Hide question') : tr('View question')}</span></button>
        <button className="btn sm pill" onClick={onClose} aria-label={tr('Back to the answer')}><X size={14} strokeWidth={1.7} /><span className="lbl">{tr('Back to the answer')}</span></button>
      </div>
      {peek && <div className="scratch-peek">{question}</div>}
    </div>
  )
}

/** The answer's verdict, in a bar that rises from the bottom: what happened, and the one key to go on. */
export function VerdictBar({ tone, title, children, xp, action, onAction, secondary }: {
  tone: 'ok' | 'bad' | 'info'; title: ReactNode; children?: ReactNode; xp?: number; action: string; onAction: () => void; secondary?: ReactNode
}) {
  const btn = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (window.matchMedia('(pointer: fine)').matches) btn.current?.focus({ preventScroll: true }) }, [])
  return (
    <div className={'verdict-bar ' + tone} role="status">
      <div className="vb-in">
        <span className="vb-ic">{tone === 'ok' ? <Check size={18} strokeWidth={2.6} /> : tone === 'bad' ? <X size={18} strokeWidth={2.6} /> : <Lightbulb size={17} strokeWidth={2} />}</span>
        <div className="vb-b">
          <div className="vb-t">{title}{xp ? <span className="vb-xp"><Zap size={13} strokeWidth={2} />+{xp}</span> : null}</div>
          {children && <div className="vb-n">{children}</div>}
        </div>
        <div className="vb-acts">
          {secondary}
          <button ref={btn} className={'btn lg ' + (tone === 'ok' ? 'good' : tone === 'bad' ? 'bad' : 'primary')} onClick={onAction}>{action}<kbd>↵</kbd></button>
        </div>
      </div>
    </div>
  )
}

/** Score as a ring with the pass mark notched on it. */
export function ScoreRing({ value, threshold, label }: { value: number; threshold?: number; label: string }) {
  const r = 70, c = 2 * Math.PI * r
  const [shown, setShown] = useState(0)
  useEffect(() => { const t = requestAnimationFrame(() => setShown(value)); return () => cancelAnimationFrame(t) }, [value])
  const pass = threshold == null ? value >= 50 : value >= threshold
  const notch = threshold != null ? (threshold / 100) * 2 * Math.PI - Math.PI / 2 : null
  return (
    <div className={'ring ' + (pass ? 'pass' : 'below')}>
      <svg viewBox="0 0 172 172" width="172" height="172" aria-hidden>
        <circle cx="86" cy="86" r={r} className="ring-bg" />
        <circle cx="86" cy="86" r={r} className="ring-fg" strokeDasharray={c} strokeDashoffset={c * (1 - shown / 100)} transform="rotate(-90 86 86)" />
        {notch != null && <line x1={86 + Math.cos(notch) * (r - 12)} y1={86 + Math.sin(notch) * (r - 12)} x2={86 + Math.cos(notch) * (r + 12)} y2={86 + Math.sin(notch) * (r + 12)} className="ring-notch" />}
      </svg>
      <div className="ring-in"><span className="ring-l">{label}</span><span className="ring-v">{Math.round(value)}%</span></div>
    </div>
  )
}

export function NextArrow() { return <ArrowRight size={16} strokeWidth={1.8} /> }
export const ScratchIcon = () => <PencilLine size={16} strokeWidth={1.7} />
export const KeypadIcon = () => <Keyboard size={16} strokeWidth={1.7} />
