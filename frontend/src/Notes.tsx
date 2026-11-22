import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowLeft, ChevronRight, FileText, Plus, Search, Trash2, Workflow, X,
} from 'lucide-react'
import { api, fmtDate, type NotePage, type NotePageFull, type PageBody } from './api'
import { DocEditor } from './DocEditor'
import { DocPage } from './DocPage'
import type { Ctx } from './App'
import BoardView from './Board'
import { t } from './i18n'

export function ago(ts: string): string {
  const s = (Date.now() - new Date(ts).getTime()) / 1000
  if (s < 60) return t('just now')
  if (s < 3600) return t('{n} min ago', { n: Math.floor(s / 60) })
  if (s < 86400) return t('{n} h ago', { n: Math.floor(s / 3600) })
  if (s < 2 * 86400) return t('yesterday')
  if (s < 7 * 86400) return t('{n} days ago', { n: Math.floor(s / 86400) })
  return fmtDate(ts.slice(0, 10))
}

/** A page nobody wrote anything on: no title of its own and nothing in it. Leaving one deletes it. */
export function isBlank(p: { title: string; body: PageBody }): boolean {
  const t = p.title.trim()
  if (t && t !== 'Untitled') return false
  if ('canvas' in p.body) return !p.body.canvas.items.length && !p.body.canvas.strokes.length && !p.body.canvas.arrows.length
  return p.body.blocks.every((b) => b.type === 'text' && !b.md.trim())
}

/** The notebook: a list of pages, or one page open. */
export default function Notes({ id, ctx }: { id?: number; ctx: Ctx }) {
  return id ? <PageEditor key={id} id={id} ctx={ctx} /> : <NotesList ctx={ctx} />
}

function NotesList({ ctx }: { ctx: Ctx }) {
  const [pages, setPages] = useState<NotePage[] | null>(null)
  const [q, setQ] = useState('')
  // ctx is a new object on every clock tick: depend on the stable functions, or this refetches every second
  const { notify, run, go } = ctx
  useEffect(() => { api.notesList().then((r) => setPages(r.pages)).catch((e) => { notify(String(e.message ?? e), 'err'); setPages([]) }) }, [notify])
  const make = async (kind: 'doc' | 'canvas') => {
    const p = await run(api.notesNew('', kind))
    if (p) go({ kind: 'notes', id: p.id })
  }
  const shown = (pages ?? []).filter((p) => !q.trim() || (p.title + ' ' + (p.preview ?? '')).toLowerCase().includes(q.trim().toLowerCase()))
  return (
    <div className="page narrow notes-page">
      <div className="head">
        <div className="head-l">
          <h1 className="title">{t('Notebook')}</h1>
          <div className="sub">{t('Your own pages: maths in LaTeX, graphs, pictures, and arrows that tie examples together.')}</div>
        </div>
        <div className="head-r notes-new">
          <button className="btn" onClick={() => make('canvas')}><Workflow size={15} strokeWidth={1.7} />{t('New canvas')}</button>
          <button className="btn primary" onClick={() => make('doc')}><Plus size={15} strokeWidth={1.8} />{t('New page')}</button>
        </div>
      </div>

      {pages && pages.length === 0 && (
        <div className="notes-start">
          <button className="start-card" onClick={() => make('doc')}>
            <span className="start-ic"><FileText size={22} strokeWidth={1.6} /></span>
            <span className="start-t">{t('A page')}</span>
            <span className="start-n">{t('Reads top to bottom, like paper. Text with LaTeX maths, graphs, pictures, and boards you can draw on.')}</span>
          </button>
          <button className="start-card" onClick={() => make('canvas')}>
            <span className="start-ic"><Workflow size={22} strokeWidth={1.6} /></span>
            <span className="start-t">{t('A canvas')}</span>
            <span className="start-n">{t('One big sheet. Put cards and graphs anywhere, join them with arrows, write over them with the pen.')}</span>
          </button>
        </div>
      )}

      {pages && pages.length > 0 && (
        <section className="notes-list">
          <label className="search">
            <Search size={15} strokeWidth={1.7} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search your pages')} aria-label={t('Search pages')} />
            {q && <button className="icon-btn sm" onClick={() => setQ('')} aria-label={t('Clear search')}><X size={13} strokeWidth={1.8} /></button>}
          </label>
          <ul className="lesson-list">
            {shown.map((p) => (
              <li key={p.id}>
                <button className="lesson" onClick={() => go({ kind: 'notes', id: p.id })}>
                  <span className={'lesson-ic k-' + p.kind}>{p.kind === 'doc' ? <FileText size={19} strokeWidth={1.6} /> : <Workflow size={19} strokeWidth={1.6} />}</span>
                  <span className="lesson-b">
                    <span className="lesson-t">{p.title === 'Untitled' ? t('Untitled') : p.title}</span>
                    <span className="lesson-n">{p.kind === 'doc' ? t('Page') : t('Canvas')} · {t('edited {when}', { when: ago(p.updated_at) })}{p.preview ? ` · ${p.preview}` : ''}</span>
                  </span>
                  <ChevronRight size={18} strokeWidth={1.6} className="lesson-go" />
                </button>
              </li>
            ))}
            {shown.length === 0 && <li className="empty pad">{t('Nothing matches “{q}”.', { q })}</li>}
          </ul>
        </section>
      )}
    </div>
  )
}

type Save = 'saved' | 'saving' | 'pending' | 'error'

function PageEditor({ id, ctx }: { id: number; ctx: Ctx }) {
  const [page, setPage] = useState<NotePageFull | null>(null)
  const [save, setSave] = useState<Save>('saved')
  const pending = useRef<{ title?: string; body?: PageBody; topic?: string }>({})
  const timer = useRef<number | undefined>(undefined)
  const latest = useRef<NotePageFull | null>(null)
  useEffect(() => { latest.current = page }, [page])
  const { setCrumb, notify, go, confirm } = ctx

  useEffect(() => {
    api.notesGet(id).then((p) => { setPage(p); setCrumb(p.title === 'Untitled' ? t('New page') : p.title) })
      .catch((e) => { notify(e.message, 'err'); go({ kind: 'notes' }) })
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current)
    const patch = pending.current
    if (patch.title === undefined && !patch.body && patch.topic === undefined) return
    pending.current = {}
    setSave('saving')
    try { await api.notesSave(id, patch); setSave((s) => (s === 'saving' ? 'saved' : s)) }
    catch (e) { setSave('error'); notify(t('The page wasn\'t saved: {e}', { e: (e as Error).message }), 'err'); pending.current = { ...patch, ...pending.current } }
  }, [id, notify])
  const queue = useCallback((patch: { title?: string; body?: PageBody; topic?: string }) => {
    pending.current = { ...pending.current, ...patch }
    setSave('pending')
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(flush, 700)
  }, [flush])
  // leaving: an untouched new page goes away, anything else is saved
  useEffect(() => () => {
    const p = latest.current
    if (p && isBlank(p)) { window.clearTimeout(timer.current); pending.current = {}; api.notesDelete(id).catch(() => {}); return }
    flush()
  }, [flush, id])
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (pending.current.title !== undefined || pending.current.body || pending.current.topic !== undefined) { flush(); e.preventDefault() } }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [flush])

  if (!page) return <div className="page narrow" />
  const setBody = (body: PageBody) => { setPage({ ...page, body }); queue({ body }) }
  const setTitle = (title: string) => { setPage({ ...page, title }); setCrumb(title || t('New page')); queue({ title }) }
  const topic = <TopicField value={page.topic ?? ''} onChange={(v) => { setPage({ ...page, topic: v }); queue({ topic: v }) }} />
  const del = async () => {
    const blank = isBlank(page)
    if (!blank && !await confirm({ title: t('Delete this page?'), body: t('“{t}” and everything on it will be gone. This can\'t be undone.', { t: page.title }), action: t('Delete page'), danger: true })) return
    window.clearTimeout(timer.current); pending.current = {}
    if (await ctx.run(api.notesDelete(id))) { if (!blank) notify(t('Page deleted')); go({ kind: 'notes' }) }
  }
  const title = page.title === 'Untitled' ? '' : page.title
  const stateLabel = { saved: t('Saved'), saving: t('Saving…'), pending: t('Editing'), error: t('Not saved') }[save]

  if ('canvas' in page.body) {
    return (
      <div className="note-canvas-page">
        <div className="note-bar">
          <button className="btn ghost sm" onClick={() => go({ kind: 'notes' })}><ArrowLeft size={15} strokeWidth={1.7} />{t('Notebook')}</button>
          <input className="note-title inline" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('Untitled canvas')} aria-label={t('Canvas title')} maxLength={200} />
          {topic}
          <span className={'save-state ' + save} role="status">{stateLabel}</span>
          <button className="icon-btn sm" onClick={del} aria-label={t('Delete canvas')} title={t('Delete canvas')}><Trash2 size={15} strokeWidth={1.7} /></button>
        </div>
        <BoardView mode="page" board={page.body.canvas} onChange={(c) => setBody({ canvas: c })} />
      </div>
    )
  }
  const body = page.body
  const blocks = body.blocks
  const words = blocks.reduce((a, b) => a + (b.type === 'text' ? (b.md.match(/\S+/g)?.length ?? 0) : 0), 0)
  return (
    <DocPage key={page.id} title={title} setTitle={setTitle} blank={isBlank(page)} created={page.created_at} words={words}
      setup={body.page} onSetup={(pg) => setBody({ ...body, page: pg })}
      bar={<>
        <button className="btn ghost sm" onClick={() => go({ kind: 'notes' })}><ArrowLeft size={15} strokeWidth={1.7} />{t('Notebook')}</button>
        {topic}
        <span className="grow" />
        <span className={'save-state ' + save} role="status">{stateLabel}</span>
        <button className="icon-btn sm" onClick={del} aria-label={t('Delete page')} title={t('Delete page')}><Trash2 size={15} strokeWidth={1.7} /></button>
      </>}>
      {(sheet) => <DocEditor blocks={blocks} onChange={(b) => setBody({ ...body, blocks: b })} ctx={ctx} sheet={sheet}
        ink={body.ink} onInk={(ink) => setBody({ ...body, ink: ink.length ? ink : undefined })} />}
    </DocPage>
  )
}



/** What the page is about: a unit or a test topic. The day page's tasks and Progress link to pages by it. */
function TopicField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [choices, setChoices] = useState<string[]>([])
  useEffect(() => { api.notesAbout().then((r) => setChoices(r.choices)).catch(() => {}) }, [])
  return (
    <label className="note-topic" title={t('Name the unit or topic this page is about: the day page and Progress then link to it')}>
      <span className="t3 small">{t('Topic')}</span>
      <input className="input sm" list="note-topics" value={value} maxLength={120} placeholder={t('e.g. a unit of your plan')}
        onChange={(e) => onChange(e.target.value)} />
      <datalist id="note-topics">{choices.map((c) => <option key={c} value={c} />)}</datalist>
    </label>
  )
}
