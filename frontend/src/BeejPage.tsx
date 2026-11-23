import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, ChevronDown, ExternalLink, RotateCw } from 'lucide-react'
import { api, type BeejChapter, type BeejShort } from './api'
import type { Ctx } from './App'
import { CodeBlock } from './CodeBlock'
import { t } from './i18n'

type Toc = { page: string; num: string; title: string }[]

/** beej.us chapter URL -> the page name the reader takes ('hello-world'), or null for any other link. */
export const beejPage = (href?: string): { page: string; sec?: string } | null => {
  const m = href?.match(/^https?:\/\/beej\.us\/guide\/bgc\/html\/split\/([a-z0-9-]+)\.html(?:#([\w.:-]+))?$/)
  return m ? { page: m[1], sec: m[2] } : null
}

type Block = BeejChapter['blocks'][number]
type Group = { id: string; head: string; blocks: Block[] }
type Mode = 'short' | 'full'

const strip = (h: string) => h.replace(/<[^>]+>/g, ' ')
const words = (s: string) => s.split(/\s+/).filter(Boolean).length
const minutesOf = (n: number) => Math.max(1, Math.round(n / 200))
const blockWords = (b: Block) => words(b.type === 'html' ? strip(b.html) : b.code)

const MODE_KEY = 'ctu.beej.mode'
const readMode = (): Mode => { try { return localStorage.getItem(MODE_KEY) === 'full' ? 'full' : 'short' } catch { return 'short' } }
const saveMode = (m: Mode) => { try { localStorage.setItem(MODE_KEY, m) } catch { /* private mode */ } }

/** The chapter split at each h2, as the backend splits it for the short version (app/beej.py groups()). The h2
    itself is kept apart so the short view can show the heading above the points. */
function groupsOf(blocks: Block[]): Group[] {
  const out: Group[] = [{ id: 'intro', head: '', blocks: [] }]
  blocks.forEach((b, i) => {
    if (b.type === 'code') { out[out.length - 1].blocks.push(b); return }
    let html = i === 0 ? b.html.replace(/^<h1[^]*?<\/h1>\s*/, '') : b.html
    const m = html.match(/^<h2 id="([^"]+)"[^]*?<\/h2>/)
    if (m) { out.push({ id: m[1], head: m[0], blocks: [] }); html = html.slice(m[0].length).trim() }
    if (html) out[out.length - 1].blocks.push({ type: 'html', html })
  })
  return out.filter((g) => g.id !== 'intro' || g.blocks.length)
}

/** `code` in a point becomes <code>; nothing else is markup. */
const inline = (s: string) => s.split(/(`[^`]+`)/g).map((p, i) =>
  p.length > 2 && p.startsWith('`') && p.endsWith('`') ? <code key={i}>{p.slice(1, -1)}</code> : p)

function Blocks({ blocks }: { blocks: Block[] }) {
  return <>{blocks.map((b, i) => b.type === 'code'
    ? <CodeBlock key={i} code={b.code} lang={b.lang} />
    : <div key={i} className="bj-prose" dangerouslySetInnerHTML={{ __html: b.html }} />)}</>
}

/** Beej's Guide to C, read in the app. Three columns on a wide screen: the way around (chapter, its sections,
    previous and next) on the left, the text in the middle, footnotes beside the line that cites them on the right.
    Narrower, the notes fall to the end of the chapter and the sections fold away. */
export default function BeejPage({ page, sec, ctx }: { page: string; sec?: string; ctx: Ctx }) {
  const [ch, setCh] = useState<BeejChapter | null>(null)
  const [err, setErr] = useState('')
  const [toc, setToc] = useState<Toc | null>(null)
  const [on, setOn] = useState('')
  const [hot, setHot] = useState('')
  const [mode, setModeState] = useState<Mode>(readMode)
  const [short, setShort] = useState<BeejShort | null>(null)
  const [shortErr, setShortErr] = useState('')
  const [opened, setOpened] = useState<Set<string>>(new Set())
  const tries = useRef(0)
  const setMode = (m: Mode) => { setModeState(m); saveMode(m) }
  const article = useRef<HTMLElement>(null)
  const side = useRef<HTMLDivElement>(null)
  const lastBeat = useRef(0)

  const load = () => {
    setErr('')
    return api.beejPage(page).then((c) => { setCh(c); ctx.setCrumb(`${c.num} · ${c.title}`) }).catch((e: Error) => setErr(e.message))
  }
  useEffect(() => { setCh(null); setShort(null); setShortErr(''); setOpened(new Set()); tries.current = 0; load() }, [page]) // eslint-disable-line react-hooks/exhaustive-deps

  // the short version: written by the coach the first time, from the cache after that. Sections a busy model
  // turned away are asked for again a little later (twice at most); until then they show Beej's own text.
  const fetchShort = () => {
    setShortErr('')
    api.beejShort(page, ctx.lang).then((r) => {
      setShort(r)
      if (r.missing.length && tries.current < 2) { tries.current++; setTimeout(fetchShort, 15000) }
    }).catch((e: Error) => setShortErr(e.message))
  }
  useEffect(() => {
    if (ch && mode === 'short' && !short && !shortErr) fetchShort()
  }, [ch, mode]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { api.beejContents().then(setToc).catch(() => setToc([])) }, [])

  // land on the asked-for section, or the top of the chapter
  useEffect(() => {
    if (!ch) return
    const el = sec ? document.getElementById(sec) : null
    if (el) el.scrollIntoView({ block: 'start' })
    else article.current?.closest('.main')?.scrollTo({ top: 0 })
  }, [ch, sec])

  // which section is on screen, for the outline; a reading heartbeat now and then
  useEffect(() => {
    const art = article.current, main = art?.closest('.main')
    if (!ch || !art || !main) return
    const hs = [...art.querySelectorAll<HTMLElement>('h2[id], h3[id]')]
    const onScroll = () => {
      let cur = ''
      for (const h of hs) { if (h.getBoundingClientRect().top < 160) cur = h.id; else break }
      setOn(cur)
      const now = Date.now()
      if (now - lastBeat.current > 60000) { lastBeat.current = now; api.heartbeat(true).catch(() => {}) }
    }
    onScroll()
    main.addEventListener('scroll', onScroll, { passive: true })
    return () => main.removeEventListener('scroll', onScroll)
  }, [ch, mode, short, opened])

  // side notes sit level with the line that cites them, pushed down where they would overlap
  useLayoutEffect(() => {
    const art = article.current, col = side.current
    if (!ch || !art || !col) return
    const place = () => {
      if (!col.offsetWidth) return
      const base = col.getBoundingClientRect().top
      let y = 0
      for (const n of col.querySelectorAll<HTMLElement>('[data-note]')) {
        const ref = art.querySelector<HTMLElement>(`#bj-ref-${n.dataset.note}`)
        const top = Math.max(y, ref ? ref.getBoundingClientRect().top - base - 3 : y)
        n.style.top = `${top}px`
        y = top + n.offsetHeight + 16
      }
      col.style.minHeight = `${y}px`
    }
    place()
    const ro = new ResizeObserver(place)
    ro.observe(art); ro.observe(col)
    document.fonts?.ready.then(place).catch(() => {})
    return () => ro.disconnect()
  }, [ch, mode])

  const go = (target: string, anchor?: string) => {
    if (target === page && anchor) document.getElementById(anchor)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    else ctx.go({ kind: 'beej', page: target, sec: anchor })
  }

  // links in the text: other chapters open here; a footnote mark lights its side note, or jumps to the notes below
  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a')
    const href = a?.getAttribute('href') ?? ''
    if (href.startsWith('beej:')) {
      e.preventDefault()
      const [p, anchor] = href.slice(5).split('#')
      go(p, anchor)
    } else if (a?.dataset.fn) {
      e.preventDefault()
      if (side.current?.offsetWidth) setHot(a.dataset.fn)
      else document.getElementById('bj-' + a.dataset.fn)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    } else if (href.startsWith('#')) {
      e.preventDefault()
      document.getElementById(href.slice(1))?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }
  const onOver = (e: React.MouseEvent) => setHot((e.target as HTMLElement).closest<HTMLElement>('a[data-fn]')?.dataset.fn ?? '')

  if (err) return (
    <div className="page narrow">
      <div className="callout err" role="alert">{err}</div>
      <div><button className="btn" onClick={load}>{t('Try again')}</button></div>
    </div>
  )
  if (!ch) return <div className="page narrow"><div className="setup-wait" aria-busy><span className="busy-road wide" aria-hidden /><span>{t('Loading the chapter…')}</span></div></div>

  const named = (p: string | null) => (p && p !== 'index' ? toc?.find((c) => c.page === p) ?? { page: p, num: '', title: p } : null)
  const prev = named(ch.prev), next = named(ch.next)
  const groups = groupsOf(ch.blocks)
  const points = new Map(short?.sections.map((s) => [s.id, s.points]) ?? [])
  const isShort = mode === 'short'
  const shortWords = groups.reduce((n, g) => n + (points.has(g.id) && !opened.has(g.id)
    ? points.get(g.id)!.reduce((k, p) => k + words(p), 0) + g.blocks.reduce((k, b) => k + (b.type === 'code' ? blockWords(b) : 0), 0)
    : g.blocks.reduce((k, b) => k + blockWords(b), 0)), 0)
  const fullWords = ch.blocks.reduce((n, b) => n + blockWords(b), 0)
  const toggle = (id: string) => setOpened((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n })

  return (
    <div className="bj">
      <aside className="bj-rail" aria-label={t("Beej's Guide to C")}>
        <ChapterPicker page={page} toc={toc} pick={(p) => go(p)} />
        <nav className="bj-toc" aria-label={t('In this chapter')}>
          <a href="#" className={'bj-toc-ch' + (on ? '' : ' on')} onClick={(e) => { e.preventDefault(); article.current?.closest('.main')?.scrollTo({ top: 0, behavior: 'smooth' }) }}>
            <span className="n">{ch.num}</span><span>{ch.title}</span>
          </a>
          <ol>
            {ch.sections.map((s) => (
              <li key={s.id} className={s.level > 2 ? 'sub' : undefined}>
                <a href={'#' + s.id} className={on === s.id ? 'on' : undefined} aria-current={on === s.id ? 'location' : undefined}
                  onClick={(e) => { e.preventDefault(); document.getElementById(s.id)?.scrollIntoView({ block: 'start', behavior: 'smooth' }) }}>
                  <span className="n">{s.num}</span><span>{s.title}</span>
                </a>
              </li>
            ))}
          </ol>
        </nav>
        <div className="bj-step">
          {prev && <button onClick={() => go(prev.page)}><ArrowLeft size={14} strokeWidth={1.6} /><span><small>{t('Previous')}</small>{prev.title}</span></button>}
          {next && <button onClick={() => go(next.page)}><span><small>{t('Next')}</small>{next.title}</span><ArrowRight className="fwd" size={14} strokeWidth={1.6} /></button>}
        </div>
      </aside>

      <article className="bj-text" ref={article} onClick={onClick} onMouseOver={onOver} onMouseLeave={() => setHot('')}>
        <header className="bj-head">
          <h1><span className="bj-h1-num">{ch.num}</span>{ch.title}</h1>
          <div className="bj-headrow">
            <p className="bj-meta">
              <span>{t('{n} sections', { n: ch.sections.filter((s) => s.level === 2).length })}</span>
              <span>{t('about {n} min', { n: minutesOf(isShort && short ? shortWords : fullWords) })}</span>
              <a href={ch.source} target="_blank" rel="noreferrer">{t('Read on beej.us')}<ExternalLink size={12} strokeWidth={1.6} /></a>
            </p>
            <div className="seg bj-mode" role="radiogroup" aria-label={t('How much to read')}>
              <button role="radio" aria-checked={isShort} className={isShort ? 'on' : undefined} onClick={() => setMode('short')}
                title={t('The points of each section, written by the coach; the code stays as Beej wrote it')}>{t('Short')}</button>
              <button role="radio" aria-checked={!isShort} className={!isShort ? 'on' : undefined} onClick={() => setMode('full')}
                title={t("Beej's whole text")}>{t('Full')}</button>
            </div>
          </div>
        </header>

        {isShort && !short && !shortErr && (
          <div className="bj-wait" aria-live="polite"><span className="busy-road" aria-hidden />{t('The coach is shortening this chapter. It takes about half a minute, once; the full text is below until then.')}</div>
        )}
        {isShort && shortErr && (
          <div className="callout err bj-wait" role="alert">{shortErr}{' '}
            <button className="btn ghost sm" onClick={fetchShort}><RotateCw size={13} strokeWidth={1.6} />{t('Try again')}</button></div>
        )}

        {!isShort ? <Blocks blocks={groups.flatMap((g): Block[] => (g.head ? [{ type: 'html', html: g.head }, ...g.blocks] : g.blocks))} /> : (
          <div className="bj-short">
            {groups.map((g) => {
              const pts = points.get(g.id)
              const open = opened.has(g.id) || !pts
              const missed = !!short?.missing.includes(g.id)
              return (
                <section key={g.id} className="bj-sec">
                  {g.head && <div className="bj-prose" dangerouslySetInnerHTML={{ __html: g.head }} />}
                  {open ? <Blocks blocks={g.blocks} /> : <>
                    <ul className="bj-points">{pts.map((p, i) => <li key={i}>{inline(p)}</li>)}</ul>
                    <Blocks blocks={g.blocks.filter((b) => b.type === 'code' && !(b.lang !== 'c' && !b.code.trim().includes('\n')
                      && pts.some((p) => p.includes('`' + b.code.trim() + '`'))))} />
                  </>}
                  {pts && (
                    <button className="bj-more" aria-expanded={opened.has(g.id)} onClick={() => toggle(g.id)}>
                      <ChevronDown size={14} strokeWidth={1.6} />{opened.has(g.id) ? t('Back to the points') : t("Read Beej's full section")}
                    </button>
                  )}
                  {missed && <p className="bj-missed">{t("This section couldn't be shortened yet (the model was busy); this is Beej's text.")}</p>}
                </section>
              )
            })}
          </div>
        )}

        {!isShort && ch.notes.length > 0 && (
          <section className="bj-notes" aria-label={t('Footnotes')}>
            <h2>{t('Footnotes')}</h2>
            <ol>
              {ch.notes.map((n) => (
                <li key={n.id} id={'bj-' + n.id}>
                  <span dangerouslySetInnerHTML={{ __html: n.html }} />{' '}
                  <a href={'#bj-ref-' + n.id} className="bj-back" aria-label={t('Back to the text')}><ArrowLeft size={12} strokeWidth={1.6} /></a>
                </li>
              ))}
            </ol>
          </section>
        )}

        <footer className="bj-foot">
          {next && (
            <button className="bj-next" onClick={() => go(next.page)}>
              <span><small>{t('Next chapter')}</small><b><span className="n">{next.num}</span>{next.title}</b></span>
              <ArrowRight size={18} strokeWidth={1.6} />
            </button>
          )}
          {isShort && <p>{t("The points are the coach's reading of Beej's text, not Beej's words; switch to Full for the original.")}</p>}
          <p>{t("From Beej's Guide to C Programming by Brian “Beej Jorgensen” Hall, CC BY-NC-ND 3.0. The text is shown unchanged; it is loaded once from beej.us and kept for reading offline.")}</p>
        </footer>
      </article>

      <div className="bj-side" ref={side} aria-hidden={ch.notes.length && !isShort ? undefined : true}>
        {!isShort && ch.notes.map((n) => (
          <div key={n.id} data-note={n.id} className={'bj-sidenote' + (hot === n.id ? ' hot' : '')}>
            <span className="n">{n.n}</span><span dangerouslySetInnerHTML={{ __html: n.html }} />
          </div>
        ))}
      </div>
    </div>
  )
}

function ChapterPicker({ page, toc, pick }: { page: string; toc: Toc | null; pick: (p: string) => void }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    list.current?.querySelector<HTMLElement>('.on')?.scrollIntoView({ block: 'center' })
    const off = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', off); document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', off); document.removeEventListener('keydown', esc) }
  }, [open])
  return (
    <div className="bj-pick" ref={box}>
      <button className="bj-pick-btn" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((o) => !o)}>
        <span>{t("Beej's Guide to C")}</span><ChevronDown size={14} strokeWidth={1.6} />
      </button>
      {open && (
        <div className="bj-pick-list" role="menu" ref={list}>
          {!toc ? <div className="bj-pick-wait">{t('Loading…')}</div> : toc.map((c) => (
            <button key={c.page} role="menuitem" className={c.page === page ? 'on' : undefined} onClick={() => { setOpen(false); pick(c.page) }}>
              <span className="n">{c.num}</span><span>{c.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
