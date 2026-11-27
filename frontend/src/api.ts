import { dayName, dayShort, fmtDay, MONTHS, tx, unit } from './i18n'
/** url: a link; repo: a path in the study repo; kintsugi: a file in the reader; ref: a named source without a link */
export type Resource = { label: string; kind: 'url' | 'repo' | 'kintsugi' | 'ref'; href?: string; path?: string }
/** a chapter of Beej's Guide to C, cleaned for the in-app reader (backend app/beej.py) */
export type BeejChapter = {
  page: string; num: string; title: string; source: string; prev: string | null; next: string | null
  blocks: ({ type: 'html'; html: string } | { type: 'code'; lang: string; code: string })[]
  sections: { id: string; num: string; title: string; level: number }[]
  notes: { id: string; n: string; html: string }[]
}
export type BeejShort = { sections: { id: string; points: string[] }[]; missing: string[] }
export type Compile = { type: 'compile_ok' | 'compile_fail'; ts: string; data: { file: string; stderr: string } } | null
export type Task = {
  id: number; date: string; block_id: number; title: string; detail: string; kind: string; learning: number
  resources: Resource[]; files: string[]; est_min: number; status: 'todo' | 'doing' | 'done'
  spent_sec_live: number; started_at: string | null; compile: Compile; files_exist: Record<string, boolean>
  score: { value: number; max: number; threshold: number | null; passed: number | null } | null
  meta: Record<string, unknown>
}
export type Block = { id: number; start: string; end: string; kind: string; title: string; tasks: Task[] }
export type Stuck = { id: number; ts: string; task_id: number | null; source: string; summary: string; detail: string; resolved: number }
export type Day = {
  date: string; status: 'active' | 'locked' | 'past' | 'closed' | 'off'; weekday: string; week: number; exists: boolean
  version?: string; title?: string; adapt_note?: string; summary?: string; blocks?: Block[]; stuck?: Stuck[]
  test?: { id: number; status: string; score: number | null; max: number | null; source: string } | null
  progress?: { done: number; total: number; est_done_min: number; est_total_min: number; spent_sec: number }
  now?: string; current?: Task | null
  /** a locked day of a custom plan: what each block will work on (no task texts; can still change) */
  outline?: OutlineBlock[] | null
  /** a one-off study day the user added on a day off: the study weekday (0 = Monday) whose blocks it copies */
  extra?: { like: number; removable: boolean }
  /** a day off of a custom plan that can still take study: the study weekdays whose blocks it could copy */
  can_add?: number[]
}
export type OutlineBlock = { start: string; end: string; kind: string; track: string; unit: string | null
  session?: number; sessions?: number; check: boolean; review: boolean }
export type Overview = {
  today: string; now: string; start_date: string
  weeks: { week: number; start: string; days: { date: string; short: string; status: string; version?: string }[] }[]
}
export type Warning = { message: string; ts: string }
/** key: 'ctu' (the built-in CTU plan), 'custom' (an approved plan of the user's own) or null (not set up yet) */
export type PlanInfo = { key: 'ctu' | 'custom' | null; ready: boolean; label: string; modules: string[] }
export type Meta = { has_api_key: boolean; coach_name?: string; coach_avatar?: string | null; model: string; repo: string; start_date: string; today: string; now: string; warnings?: Record<string, Warning>; fake_clock?: boolean
  plan: PlanInfo; ai_primary: string | null }
export type CloseItem = { key: string; ok: boolean; label: string; optional?: boolean }
export type CloseJob = { pending: string[]; errors: Record<string, string>; attempts: number; last_try: string | null }
export type Health = {
  api_key: boolean; fake_clock: boolean; now: string
  paths: Record<string, { path: string; ok: boolean }>
  watcher: { state: string; since: string | null; detail: string }; sandbox: boolean
  last_backup: { path: string; ts: string } | null; backups: number
  close_jobs: Record<string, CloseJob>
  runway: { c_days: number | null; kintsugi_days: number | null; khan_units_left: number; horizon: number; tracks?: { key: string; label: string; units: number; left: number }[] }
  schema_version: number; warnings: Record<string, Warning>
  external_writes: { ts: string; file: string; action: string }[]
  phases: Phase[]
}
export type Phase = { key: string; track: string; label: string; what: string; roadmap: string; approved: boolean }
export type Question = { id: string; type: 'mcq' | 'output' | 'short'; topic: string; prompt: string; math?: string; code?: string; choices?: string[]; answer_format?: string }
/** What test generation is doing right now (no question text or answers). */
export type GenLive = {
  phase: 'preparing' | 'writing' | 'checking' | 'ready' | 'failed'; model: string | null; chars: number; elapsed?: number
  log: { t: number; text: string; kind: 'step' | 'q' | 'warn' | 'err' | 'done' }[]
}
export type TestResult = { id: string; given: string; correct: boolean; answer: string; explanation: string; topic: string; note?: string; void?: boolean; void_why?: string }
export type Test = {
  id: number; date: string; kind: 'eod' | 'c_quiz' | 'unit_quiz' | 'practice'; status: string; source: string; questions: Question[]
  live?: GenLive
  cancelled?: number
  used_sec?: number
  practice?: { topics: string; count: number; asked: number | null; level: 'easy' | 'medium' | 'hard' | null; level_why: string | null; follow_of: number | null; from_task?: boolean }
  answers: Record<string, string>; results: TestResult[]; score: number | null; max: number | null
  time_limit_min: number; remaining_sec?: number; threshold: string; error?: string | null; started_at?: string | null
}
export type ChatMsg = { id: number; ts: string; role: 'user' | 'assistant'; display: string }
export type Convo = { id: number; date: string; title: string; created_at: string; updated_at: string; count: number }
export type MemoryNote = { id: number; text: string; created_at: string; updated_at: string }
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type ReplyLanguage = 'auto' | 'tr' | 'en'
export type CoachSettings = { name: string; personality: string; verbosity: number; effort: Effort; model: string; language: ReplyLanguage; memory: MemoryNote[]; verbosity_labels: Record<string, string>; effort_labels: Record<Effort, string>; language_labels: Record<ReplyLanguage, string>; model_active: string; provider: string }
export type StreamEv =
  | { type: 'start'; convo_id: number; user_id: number }
  | { type: 'status'; phase: 'thinking' | 'tool' | 'running'; tool?: string; label?: string }
  | { type: 'test'; id: number; live: GenLive | null }
  | { type: 'delta'; text: string }
  | { type: 'replace'; text: string }
  | { type: 'done'; reply: string; id: number; convo_id: number }
  | { type: 'error'; message: string }
/** exam: asked from a graded test that is open; the server answers closed book (rules and formulas, not answers) */
export type ChatBody = { text: string; convo_id?: number | null; new?: boolean; exam?: boolean }

export type Dashboard = {
  streak: number; best_streak: number; week: number; week_minutes: number; week_target_min: number
  khan_passed: number; khan_total: number; khan_current: KhanUnit | null
  beej_done: number; beej_total: number; stuck: (Stuck & { date: string })[]
  tracks: { key: string; label: string; passed: number; total: number; current: string | null }[]
  last_test: { id: number; date: string; score: number; max: number } | null
  /** this week, Monday first: minutes studied and planned */
  week_days: { date: string; minutes: number; planned: number; study: boolean }[]
  /** exam dates of the plan's tracks from today on, nearest first */
  exams: { key: string; label: string; date: string; days: number }[]
}
export type ActivityDay = { date: string; minutes: number; done: number; commits: number; compiles: number; level: number; status: 'off' | 'future' | 'closed' | 'active' | 'past' | 'none' }
export type Activity = { start: string; today: string; days: ActivityDay[] }
export type CalDay = {
  date: string; weekday: string; status: 'off' | 'locked' | 'active' | 'closed' | 'past' | 'before'; exists: boolean
  version: string | null; total: number; done: number; minutes: number; kinds: string[]; week: number | null
  test: { score: number; max: number } | null; stuck: number
}
/** deadline: the day the user has to be ready by; end: the day the last unit is projected to end (custom plans) */
export type Calendar = { month: string; today: string; start: string; days: CalDay[]; deadline?: string | null; end?: string | null; exams?: Record<string, string> }
export type TrackStatus = 'passed' | 'current' | 'tried' | 'todo' | 'done' | 'doing' | 'planned' | 'removed'
export type KhanUnit = { idx: number; name: string; status: TrackStatus; best: number | null; tries: number }
export type Score = { id: number; ts: string; date: string; kind: string; item: string; value: number; max: number; threshold: number | null; passed: number | null }
export type ThresholdRow = { key: string; label: string; threshold: number; max: number; unit: string; count: number; last: number | null; passed: number; failed: number; note?: string }
export type Progress = {
  khan: KhanUnit[]
  beej: { n: number; title: string; status: TrackStatus; tasks: number; done: number }[]
  kintsugi: { idx: number; name: string; files: string[]; status: TrackStatus; tasks: number; done: number }[]
  scores: Score[]
  tests: { id: number; date: string; kind: string; score: number; max: number; source: string }[]
  stuck_weeks: { week: number; opened: number; resolved: number; sources: Record<string, number> }[]
  stuck_open: number
  thresholds: ThresholdRow[]
  tracks: PlanProgress[]
  topics: TopicRow[]
}
export type TopicRow = {
  topic: string; right: number; total: number; stuck_open: number; trend: 'up' | 'down' | 'flat' | null
  attempts: { date: string; test_id: number; kind: string; right: number; total: number }[]
  miss: { date: string; test_id: number; prompt: string; given: string; answer: string } | null
  notes: { id: number; title: string }[]
}
export type PlanProgress = { key: string; label: string; units: { idx: number; name: string; status: TrackStatus; removed?: boolean; best: number | null; max: number | null }[] }
export type HistItem = {
  ts: string; date: string; kind: 'commit' | 'done' | 'compile' | 'score' | 'test_submitted' | 'day_closed' | 'stuck'; title: string
  hash?: string; files?: number; add?: number; del?: number; spent_min?: number; unit?: string; percent?: number; passed?: boolean
  test_id?: number; score?: number; max?: number; ok?: number; fail?: number; last_ok?: boolean; source?: string; resolved?: boolean; auto?: boolean
}
export type History = { days: { date: string; weekday: string; minutes: number; items: HistItem[] }[]; next_before: string | null }
/** The local account: who this install belongs to. github: 'on' shows the GitHub profile, 'off' the local one, null not asked yet. */
export type Me = { name: string; photo: string | null; preset: string; github: 'on' | 'off' | null; created_at: string
  /** what the computer calls its user (full name, else login): offered when no name is given */
  system_name?: string }
export type Profile = {
  me: Me
  github_offer: { login: string } | null
  github: { login: string; name: string | null; avatar_url: string; html_url: string; public_repos: number; created_at: string } | null
  goals: Goal[]
  week: number; start: string; today: string
  totals: { minutes: number; closed_days: number; tasks_done: number; tests: number; test_correct: number; test_total: number; commits: number; streak: number; best_streak: number }
  roadmap: { label: string; start: string; end: string; items: string[]; current: boolean }[]
  thresholds: Record<string, { label: string; threshold: number; unit?: string; max?: number }>
}

export type Goal = { label: string; target: string; note: string }

// A plan of the user's own (onboarding): the answers, the model's checked draft, the approved plan
export type PlanBlock = { start: string; end: string; kind: string; title: string }
/** skip: taken out of the plan by the user (kept in the list, so it can be put back) */
export type PlanUnit = { title: string; objective: string; practice: string; sessions: number; resources: { label: string; href: string }[]; skip?: boolean }
export type PlanTrack = { key: string; label: string; goal: string; units: PlanUnit[]; deadline?: string }
export type Milestone = { label?: string; start: string; end: string; items: string[]; current?: boolean }
export type DraftPlan = {
  label: string; summary: string; start_date: string; study_weekdays: number[]; week: PlanBlock[][]; tracks: PlanTrack[]
  goals: Goal[]; roadmap: Milestone[]; thresholds: Record<string, { label: string; threshold: number; max?: number; unit?: string }>
  track_ends?: Record<string, string>
  answers?: Partial<Answers>
  /** the deadline (the answers', or one named in a change request) and the day the units end, worked out by the app */
  deadline?: string | null; end_date?: string | null
}
export type Answers = {
  field: string; level: string; goal: string; deadline: string; background: string; focus: string; sources: string
  weekdays: number[]; day_start: string; day_end: string; hours: number; start_date: string
  language: ReplyLanguage; code: boolean; plan_text: string; plan_file: string
}
export type Onboarding = {
  status: 'idle' | 'drafting' | 'ready' | 'failed'; plan: PlanInfo['key']; has_api_key: boolean
  /** while drafting: how far the model is (read off its stream); elapsed seconds on the server's own clock */
  progress?: { phase: 'thinking' | 'writing' | 'checking'; elapsed: number; chars: number; units: number; tracks: string[]; searches?: number }
  answers?: Partial<Answers>; draft?: { plan: DraftPlan; notes: string[]; at: string } | null; error?: string | null; change?: string
  started?: string
}
export type PlanView = DraftPlan & { projected_end?: string | null; key: PlanInfo['key']; ready: boolean; engine: string | null; modules: string[]
  approved_at: string | null; plan_md: string | null; progress: PlanProgress[] }
export type AiKey = { index: number; hint: string; ok: boolean | null; reason: string; resting: boolean }
export type AiProvider = {
  id: string; label: string; note: string; keys_url: string; needs_key: boolean; env: string; ready: boolean; primary: boolean
  keys: AiKey[]; models: { main: string; chat: string }; default_models: { main: string; chat: string }; base: string
  /** 'cli': a subscription reached through the vendor's program (command); on/installed are null for the others */
  kind: 'anthropic' | 'openai' | 'cli'; command: string; on: boolean | null; installed: boolean | null
  /** the thinking effort for tests and plans ('' = each task's own) and the levels this provider takes (none: it sends no effort) */
  effort: Effort | ''; effort_levels: Effort[]
  /** a subscription: may it search the web (plan drafts, the coach chat); null for the others */
  web: boolean | null
}
export type AiModel = { id: string; name: string; context: number; free: boolean; price: string; chat: boolean; created: number }
export type AiView = { providers: AiProvider[]; fallback: boolean; local_url: string; local_on: boolean; primary: string | null; env_file: string }
export type AiPut = { order?: string[]; fallback?: boolean; models?: Record<string, Partial<{ main: string; chat: string }>>; effort?: Record<string, Effort | ''>; web?: Record<string, boolean>; local_url?: string; local_on?: boolean
  cli_on?: Record<string, boolean> }

// Khan content (Kolibri): unit outline, videos, exercises in Perseus format, the in-app unit test
export type KhanProgress = { m: number; n: number; last: number[]; mastered: boolean; mastered_at?: string | null }
export type KhanItem = { id: string; kind: 'video' | 'exercise'; title: string; ready: boolean; duration?: number | null
  supported?: number; total?: number; kolibri?: string } & Partial<KhanProgress>
export type KhanStatus = { installed: boolean; channel: boolean; home: string; server: boolean; server_url: string
  downloading: number | null; queued: number[]; errors: Record<string, string>; setup: string }
export type KhanOutline = {
  unit: { idx: number; name: string; course: string; href: string }
  lessons: { id: string; title: string; items: KhanItem[] }[]
  status: KhanStatus
  counts: { videos: number; videos_ready: number; exercises: number; exercises_ready: number; mastered: number; video_min: number }
  downloading: boolean; error: string | null
}
export type KhanVideo = { id: string; title: string; description: string; duration: number | null; src: string; poster: string | null
  subtitles: { lang: string; label: string; src: string }[] }
export type PWidget = { type: string } & Record<string, unknown>
export type PContent = { content: string; widgets: Record<string, PWidget>; graphie: string[] }
export type PAnswer = string | number | number[]
export type PAnswers = Record<string, PAnswer>
export type PFeedback = { correct: boolean; widgets: Record<string, { correct: boolean; message: string; right?: number[] }> }
/** The right answer per widget, as markdown: a list for a choose-all question (one entry per right choice). */
export type PSolution = Record<string, string | string[]>
export type KhanQuestion = { exercise_id: string; item_id: string; title: string; question: PContent; hints_total: number
  hints: PContent[]; counted: boolean; progress: KhanProgress }
export type KhanCheck = PFeedback & { progress: KhanProgress; solution: PSolution | null }
export type KhanTest = {
  id: number; date: string; task_id: number; status: 'in_progress' | 'submitted'; score: number | null; threshold: number
  unit: { idx: number; name: string; course: string }
  questions: { key: string; exercise: string; question?: PContent; hints?: PContent[]; missing?: boolean }[]
  answers: Record<string, PAnswers>
  results: Record<string, PFeedback & { solution: PSolution }> | null
}

// XP: derived on the server from recorded work (tasks, Khan answers, tests, closed days)
export type XpGain = { ts: string; date: string; xp: number; label: string; kind: 'task' | 'khan' | 'mastery' | 'test' | 'unit' | 'day' }
export type Xp = { total: number; today: number; level: number; into: number; span: number; week: { date: string; xp: number }[]; recent: XpGain[] }

// Notebook: the user's own pages. A document is blocks top to bottom; a canvas page is one board.
// Notifications: what the app told you, kept on the server
export type Tone = 'info' | 'ok' | 'warn' | 'err'
export type Notice = { id: number; ts: string; kind: string; tone: Tone; title: string; body: string; link: string | null
  source: 'app' | 'client'; items: string[]; read: boolean }

export type GraphFn = { expr: string; color?: string; hidden?: boolean; min?: number; max?: number }
export type GraphView = { x0: number; x1: number; y0: number; y1: number }
/** How a graph is drawn. Everything is on unless turned off; `hand` draws it as if by hand. */
export type GraphLook = { grid?: boolean; axes?: boolean; numbers?: boolean; frame?: boolean; hand?: boolean
  /** arrowheads at the positive ends of the axes, and the axes' names ($…$ is maths) */
  arrows?: boolean; xName?: string; yName?: string }
export type CanvasItem = { id: string; x: number; y: number; w: number; h: number } & (
  | { type: 'text'; md: string; tone?: string }
  | { type: 'graph'; fns: GraphFn[]; view?: GraphView }
  | { type: 'image'; src: string; caption?: string })
export type End = { item: string } | { x: number; y: number }
export type Arrow = { id: string; from: End; to: End; label?: string; color?: string; bend?: number }
export type Stroke = { id: string; pts: number[]; color: string; size: number }
export type Board = { items: CanvasItem[]; arrows: Arrow[]; strokes: Stroke[] }
/** How a block is laid out on a page. In the flow (the default) blocks follow each other down the sheet; blocks next to each
 *  other that share a `row` sit side by side as columns, `span` being each one's share of the width (1 by default).
 *  A block with `free` is taken out of the flow and sits where it was put on the sheet (page pixels from the sheet's
 *  top-left corner; `w` its width, `h` its height where it has one). */
export type BlockLayout = { row?: string; span?: number; free?: FreePos }
/** `wrap: true` = the writing makes room for it (flows beside it, or under it); otherwise it sits in front and nothing on the page moves */
export type FreePos = { x: number; y: number; w: number; h?: number; wrap?: boolean }
export type DocBlock = { id: string } & BlockLayout & (
  | ({ type: 'text'; md: string } & TextStyle)
  | ({ type: 'graph'; fns: GraphFn[]; view?: GraphView; look?: GraphLook } & FigBox)
  | ({ type: 'image'; src: string; caption?: string; fit?: Fit } & FigBox)
  /** a drawing written line by line (diagramcore.ts), seen from `cam` (azimuth and elevation in degrees) */
  | ({ type: 'diagram'; src: string; cam?: { az: number; el: number } } & FigBox)
  | ({ type: 'canvas'; height?: number } & Board))
/** Where a picture or graph sits on a page: its size in page pixels, and either a preset alignment or a left offset
 *  (`x`, from the left edge of the text column) after it was dragged sideways. No height on a picture = its own proportions. */
export type FigBox = { width?: number; height?: number; x?: number; align?: Align }
export type Align = 'left' | 'center' | 'right'
/** How a picture fills a frame whose proportions differ from its own. */
export type Fit = 'cover' | 'contain' | 'fill'
export type PageSize = 'A5' | 'A4' | 'A3' | 'A2' | 'A1' | 'Letter' | 'Legal'
export type PageFont = 'serif' | 'sans' | 'hand' | 'print'
export type PaperKind = 'plain' | 'grid' | 'dots'
/** `cols`: the page as a grid of that many columns (the blocks fill it left to right, line by line) */
export type PageSetup = { size: PageSize; landscape?: boolean; font?: PageFont; paper?: PaperKind; cols?: number
  /** a thin line under every heading */
  rules?: boolean }
/** a text's own look; what isn't set comes from the page */
export type TextStyle = { font?: PageFont; size?: TextSize; talign?: TextAlign; tone?: TextTone }
/** the ink a text is written in: the page's, a quieter grey (notes, captions) or the accent */
export type TextTone = 'muted' | 'accent'
export type TextSize = 's' | 'l' | 'xl'
export type TextAlign = 'center' | 'right' | 'justify'
export type PageBody = { blocks: DocBlock[]; page?: PageSetup; ink?: Stroke[] } | { canvas: Board }
export type NotePage = { id: number; title: string; kind: 'doc' | 'canvas'; topic: string; created_at: string; updated_at: string; preview?: string }
export type NotePageFull = NotePage & { body: PageBody }

export class ApiError extends Error {}

/** The packaged program's update state (backend/app/updates.py). */
export type UpdateJob = { phase: 'idle' | 'downloading' | 'installing' | 'restarting' | 'failed'; done?: number; total?: number; error?: string | null; version?: string }
export type UpdateInfo = {
  current: string; packaged: boolean; enabled: boolean; available: boolean; show: boolean; checked?: string; error?: string
  /** set when GitHub's rate limit stopped the check: when it lifts, HH:MM */
  retry_at?: string
  latest: { version: string; notes: string; page: string; published: string } | null
  asset?: { name: string; size: number; url: string } | null; self_update?: boolean; reason?: string | null; job: UpdateJob
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  // X-CTU: the server refuses state changes without it, so other web pages can't drive the API
  const r = await fetch('/api' + path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json', 'x-ctu': '1' } : { 'x-ctu': '1' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new ApiError((data as { error?: string; detail?: string }).error ?? (data as { detail?: string }).detail ?? `HTTP ${r.status}`)
  return data as T
}

export const api = {
  dashboard: () => req<Dashboard>('GET', '/dashboard'),
  activity: () => req<Activity>('GET', '/activity'),
  calendar: (month: string) => req<Calendar>('GET', `/calendar/${month}`),
  progress: () => req<Progress>('GET', '/progress'),
  history: (before?: string) => req<History>('GET', `/history?days=30${before ? `&before=${before}` : ''}`),
  profile: () => req<Profile>('GET', '/profile'),
  saveGoals: (goals: Goal[]) => req<{ goals: Goal[] }>('PUT', '/goals', { goals }),
  meta: () => req<Meta>('GET', '/meta'),
  update: (fresh = false) => req<UpdateInfo>('GET', `/update${fresh ? '?fresh=1' : ''}`),
  updateApply: () => req<UpdateJob>('POST', '/update/apply'),
  updateLater: (version: string) => req<{ ok: boolean }>('POST', '/update/later', { version }),
  updateSkip: (version: string) => req<{ ok: boolean }>('POST', '/update/skip', { version }),
  updateSettings: (enabled: boolean) => req<UpdateInfo>('PUT', '/update/settings', { enabled }),
  overview: () => req<Overview>('GET', '/overview'),
  today: () => req<Day>('GET', '/today'),
  day: (ds: string) => req<Day>('GET', `/day/${ds}`),
  task: (id: number, action: 'start' | 'pause' | 'done' | 'reopen') =>
    req<{ ok?: boolean; warnings?: string[] }>('POST', `/tasks/${id}/${action}`),
  score: (id: number, percent: number) => req<{ passed: boolean; message: string }>('POST', `/tasks/${id}/score`, { percent }),
  stuck: (summary: string, task_id?: number) => req<{ id: number }>('POST', '/stuck', { summary, task_id }),
  resolve: (id: number) => req('POST', `/stuck/${id}/resolve`),
  heartbeat: (input: boolean, kintsugi_file = '') => req('POST', '/heartbeat', { input, kintsugi_file }),
  close: (ds: string, confirm = false) => req('POST', `/day/${ds}/close`, { confirm }),
  closeCheck: (ds: string) => req<{ checklist: CloseItem[]; job: CloseJob | null }>('GET', `/day/${ds}/close`),
  notes: (ds: string, text: string) => req('PUT', `/day/${ds}/notes`, { text }),
  compile: (id: number) => req<{ results: { file: string; ok: boolean; stderr: string }[] }>('POST', `/tasks/${id}/compile`),
  health: () => req<Health>('GET', '/health'),
  retryCloses: () => req<Health>('POST', '/health/retry'),
  setPhase: (key: string, on: boolean) => req<{ phases: Phase[] }>(on ? 'POST' : 'DELETE', `/phases/${key}/approve`),
  dismissWarning: (key: string) => req<{ warnings: Record<string, Warning> }>('DELETE', `/health/warnings/${encodeURIComponent(key)}`),
  chat: () => req<ChatMsg[]>('GET', '/chat'),
  send: (body: ChatBody) => req<{ reply: string; convo_id: number }>('POST', '/chat', body),
  delMsg: (id: number) => req('DELETE', `/chat/${id}`),
  convos: () => req<{ convos: Convo[]; default: number | null; today: string }>('GET', '/convos'),
  convo: (id: number) => req<Convo & { messages: ChatMsg[] }>('GET', `/convos/${id}`),
  renameConvo: (id: number, title: string) => req<Convo>('PATCH', `/convos/${id}`, { title }),
  delConvo: (id: number) => req('DELETE', `/convos/${id}`),
  coach: () => req<CoachSettings>('GET', '/coach'),
  saveCoach: (s: { name: string; personality: string; verbosity: number; effort: Effort; model: string; language: ReplyLanguage }) => req<CoachSettings>('PUT', '/coach', s),
  addNote: (text: string) => req<CoachSettings>('POST', '/coach/memory', { text }),
  editNote: (id: number, text: string) => req<CoachSettings>('PUT', `/coach/memory/${id}`, { text }),
  delNote: (id: number) => req<CoachSettings>('DELETE', `/coach/memory/${id}`),
  plan: () => req<PlanView>('GET', '/plan'),
  onboarding: () => req<Onboarding>('GET', '/onboarding'),
  draftPlan: (answers: Answers) => req<Onboarding>('POST', '/onboarding/draft', { answers }),
  setExams: (dates: Record<string, string>) => req<{ notes: string[]; changed: string[] }>('PUT', '/plan/exams', { dates }),
  setDraftUnit: (track: string, unit: number, on: boolean) => req<Onboarding>('PUT', '/onboarding/unit', { track, unit, on }),
  startNow: () => req<{ start_date: string; replanned: string[] }>('POST', '/plan/start-now'),
  setPlanUnit: (track: string, unit: number, on: boolean) => req<{ changed: boolean; replanned: string[] }>('PUT', '/plan/unit', { track, unit, on }),
  addExtraDay: (ds: string, like: number) => req<{ date: string; like: number; replanned: string[] }>('POST', `/day/${ds}/extra`, { like }),
  removeExtraDay: (ds: string) => req<{ date: string; replanned: string[] }>('DELETE', `/day/${ds}/extra`),
  changeDraft: (change: string) => req<Onboarding>('POST', '/onboarding/change', { change }),
  discardDraft: () => req<Onboarding>('POST', '/onboarding/discard'),
  approvePlan: () => req<Onboarding>('POST', '/onboarding/approve', { confirm: true }),
  ai: () => req<AiView>('GET', '/ai'),
  aiPut: (b: AiPut) => req<AiView>('PUT', '/ai', b),
  aiAddKey: (pid: string, key: string) => req<AiView & { models_found: string[] }>('POST', `/ai/${pid}/keys`, { key }),
  aiRemoveKey: (pid: string, i: number) => req<AiView>('DELETE', `/ai/${pid}/keys/${i}`),
  aiModels: (pid: string, fresh = false) => req<{ models: AiModel[] }>('GET', `/ai/${pid}/models${fresh ? '?fresh=1' : ''}`),
  aiTest: (pid: string) => req<AiView & { model: string; results: { index: number; hint: string; ok: boolean; reason: string }[] }>('POST', `/ai/${pid}/test`, {}),
  genTest: (kind: 'eod' | 'c_quiz' | 'unit_quiz', task_id?: number) => req<{ id: number }>('POST', '/tests/generate', { kind, task_id }),
  explainNow: (taskId: number) => req<{ ok: boolean; explain_early: number }>('POST', `/tasks/${taskId}/explain-now`),
  lesson: (taskId: number) => req<{ lesson: string }>('POST', `/tasks/${taskId}/lesson`),
  practiceSet: (taskId: number) => req<{ id: number; existing: boolean }>('POST', `/tasks/${taskId}/practice`),
  retryTest: (id: number) => req<{ id: number }>('POST', `/tests/${id}/retry`),
  tests: () => req<{ id: number; date: string; kind: string; status: string; cancelled?: number; used_sec?: number; score: number | null; max: number | null }[]>('GET', '/tests'),
  test: (id: number) => req<Test>('GET', `/tests/${id}`),
  startTest: (id: number) => req<Test>('POST', `/tests/${id}/start`),
  saveAnswers: (id: number, answers: Record<string, string>) => req('PUT', `/tests/${id}/answers`, { answers }),
  submit: (id: number, answers: Record<string, string>) => req<Test>('POST', `/tests/${id}/submit`, { answers }),
  voidQuestion: (id: number, qid: string, why: string) => req<Test>('POST', `/tests/${id}/questions/${qid}/void`, { why }),
  exitTest: (id: number, answers: Record<string, string>) => req<Test>('POST', `/tests/${id}/exit`, { answers }),
  kintsugi: (path: string) => req<{ path: string; content: string }>('GET', `/kintsugi/file?path=${encodeURIComponent(path)}`),
  open: (path: string) => req<{ opened: string; exists: boolean }>('POST', '/open', { path }),
  beejPage: (page: string) => req<BeejChapter>('GET', `/beej/page/${encodeURIComponent(page)}`),
  beejShort: (page: string, lang: string) => req<BeejShort>('POST', `/beej/page/${encodeURIComponent(page)}/short?lang=${lang}`, {}),
  beejContents: () => req<{ page: string; num: string; title: string }[]>('GET', '/beej/contents'),
  khanStatus: () => req<KhanStatus>('GET', '/khan/status'),
  khanUnit: (idx: number) => req<KhanOutline>('GET', `/khan/unit/${idx}`),
  khanDownload: (idx: number) => req<KhanStatus>('POST', `/khan/unit/${idx}/download`),
  khanVideo: (id: string) => req<KhanVideo>('GET', `/khan/video/${id}`),
  khanExercise: (id: string) => req<KhanQuestion>('GET', `/khan/exercise/${id}`),
  khanCheck: (id: string, item_id: string, answers: PAnswers) => req<KhanCheck>('POST', `/khan/exercise/${id}/check`, { item_id, answers }),
  khanHint: (id: string, item_id: string) => req<{ hints: PContent[]; hints_total: number }>('POST', `/khan/exercise/${id}/hint`, { item_id }),
  khanReveal: (id: string, item_id: string) => req<{ hints: PContent[]; solution: PSolution; progress: KhanProgress }>('POST', `/khan/exercise/${id}/reveal`, { item_id }),
  khanStartTest: (task_id: number) => req<{ id: number }>('POST', '/khan/tests', { task_id }),
  khanTest: (id: number) => req<KhanTest>('GET', `/khan/tests/${id}`),
  khanSaveTest: (id: number, answers: Record<string, PAnswers>) => req('PUT', `/khan/tests/${id}/answers`, { answers }),
  xp: () => req<Xp>('GET', '/xp'),
  notices: () => req<{ notices: Notice[]; unread: number }>('GET', '/notices'),
  noticeAdd: (n: { title: string; body?: string; tone?: Tone; link?: string | null }) => req<Notice>('POST', '/notices', n),
  noticesRead: (id?: number) => req('POST', id ? `/notices/${id}/read` : '/notices/read'),
  noticesDelete: (id?: number) => req('DELETE', id ? `/notices/${id}` : '/notices'),
  notesList: () => req<{ pages: NotePage[] }>('GET', '/notes'),
  notesNew: (title: string, kind: 'doc' | 'canvas') => req<NotePageFull>('POST', '/notes', { title, kind }),
  notesGet: (id: number) => req<NotePageFull>('GET', `/notes/${id}`),
  notesSave: (id: number, patch: { title?: string; body?: PageBody; topic?: string }) => req<NotePage>('PUT', `/notes/${id}`, patch),
  /** pages about a topic; without one, the topics a page can be about */
  notesAbout: (topic = '') => req<{ pages: NotePage[]; choices: string[] }>('GET', `/notes/about?topic=${encodeURIComponent(topic)}`),
  notesDelete: (id: number) => req('DELETE', `/notes/${id}`),
  /** Uploads an image file; returns the URL it's served at. */
  notesUpload: async (file: Blob) => {
    const r = await fetch('/api/notes-assets', { method: 'POST', headers: { 'content-type': file.type, 'x-ctu': '1' }, body: file })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) throw new ApiError((data as { error?: string }).error ?? `HTTP ${r.status}`)
    return `/api/notes-assets/${(data as { name: string }).name}`
  },
  coachAvatar: async (file: Blob) => {
    const r = await fetch('/api/coach/avatar', { method: 'POST', headers: { 'content-type': file.type, 'x-ctu': '1' }, body: file })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) throw new ApiError((data as { error?: string }).error ?? `HTTP ${r.status}`)
    return (data as { coach_avatar: string | null }).coach_avatar
  },
  coachAvatarDelete: () => req<{ coach_avatar: null }>('DELETE', '/coach/avatar'),
  me: () => req<Me>('GET', '/me'),
  meName: (name: string) => req<Me>('PUT', '/me', { name }),
  meGithub: (github: 'on' | 'off') => req<Me>('PUT', '/me/github', { github }),
  mePhoto: async (file: Blob) => {
    const r = await fetch('/api/me/photo', { method: 'POST', headers: { 'content-type': file.type, 'x-ctu': '1' }, body: file })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) throw new ApiError((data as { error?: string }).error ?? `HTTP ${r.status}`)
    return data as Me
  },
  mePhotoDelete: () => req<Me>('DELETE', '/me/photo'),
  /** The whole install as one zip file, saved through the browser's download. */
  backupExport: async () => {
    const r = await fetch('/api/backup/export', { method: 'POST', headers: { 'x-ctu': '1' } })
    if (!r.ok) { const data = await r.json().catch(() => ({})); throw new ApiError((data as { error?: string }).error ?? `HTTP ${r.status}`) }
    const name = /filename="?([^";]+)"?/.exec(r.headers.get('content-disposition') ?? '')?.[1] ?? 'waymark-backup.zip'
    const url = URL.createObjectURL(await r.blob())
    const a = document.createElement('a')
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    return name
  },
  backupRestore: async (file: File) => {
    const r = await fetch('/api/backup/restore', { method: 'POST', headers: { 'content-type': 'application/zip', 'x-ctu': '1' }, body: file })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) throw new ApiError((data as { error?: string }).error ?? `HTTP ${r.status}`)
    return data as { created: string | null; kept: string }
  },
  /** The plan and everything done under it go; the account and settings stay. A backup file is written first. */
  startOver: () => req<{ kept: string }>('POST', '/account/start-over', { confirm: true }),
  /** Everything this install recorded goes (keys: the AI keys in .env too). */
  deleteAccount: (keys: boolean) => req<{ keys_removed: number }>('POST', '/account/delete', { confirm: true, keys }),
  khanSubmitTest: (id: number, answers: Record<string, PAnswers>) => req<{ test: KhanTest; passed: boolean; message: string }>('POST', `/khan/tests/${id}/submit`, { answers }),
}

/** Streams one coach turn (SSE over POST). Falls back to the plain endpoint if streaming isn't available
 *  before anything arrived. Resolves with the final reply. */
export async function streamChat(body: ChatBody, on: (ev: StreamEv) => void, signal?: AbortSignal): Promise<{ reply: string; convo_id: number }> {
  let got = false
  let r: Response
  try {
    r = await fetch('/api/chat/stream', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ctu': '1' }, body: JSON.stringify(body), signal })
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    const x = await api.send(body)
    on({ type: 'done', reply: x.reply, id: 0, convo_id: x.convo_id })
    return x
  }
  if (!r.ok) {
    const data = await r.json().catch(() => ({}))
    throw new ApiError((data as { error?: string; detail?: string }).error ?? (data as { detail?: string }).detail ?? `HTTP ${r.status}`)
  }
  if (!r.body || !(r.headers.get('content-type') ?? '').includes('event-stream')) {
    const x = await api.send(body)
    on({ type: 'done', reply: x.reply, id: 0, convo_id: x.convo_id })
    return x
  }
  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let buf = '', result: { reply: string; convo_id: number } | null = null, err: string | null = null
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i: number
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2)
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue
        try {
          const ev = JSON.parse(line.slice(5).trim()) as StreamEv
          got = true
          if (ev.type === 'done') result = { reply: ev.reply, convo_id: ev.convo_id }
          if (ev.type === 'error') err = ev.message
          on(ev)
        } catch { /* partial or bad line */ }
      }
    }
  }
  if (err) throw new ApiError(err)
  if (!result) throw new ApiError(got ? 'The stream ended without a reply.' : 'No reply from the coach.')
  return result
}

export const fmtDur = (sec: number) => {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}
export const fmtMin = (min: number) => { const u = unit(); return min >= 60 ? `${Math.floor(min / 60)} ${u.h} ${min % 60 ? `${min % 60} ${u.m}` : ''}`.trim() : `${min} ${u.m}` }
export { MONTHS }
/** Weeks are counted from 0 inside the app. The built-in CTU plan names its first week "Week 0" (its notes do);
    every other plan starts at Week 1, as people count. */
let weekBase = 1
export const setWeekBase = (plan: string | null | undefined) => { weekBase = plan === 'ctu' ? 0 : 1 }
export const weekNo = (w: number) => w + weekBase
/** A locked day opens as a preview (its outline) in a plan of the user's own, up to three weeks ahead (tracks.OUTLINE_DAYS). */
export const canPeek = (planKey: string | null | undefined, today: string, d: string) =>
  planKey === 'custom' && d > today && d <= addDays(today, 21)
export const fmtDate = (ds: string) => { const [, m, d] = ds.split('-').map(Number); return fmtDay(m, d) }
export const toMin = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m }
export const fmtHours = (min: number) => { const u = unit(); return min < 60 ? `${min} ${u.m}` : `${(min / 60).toFixed(min % 60 ? 1 : 0)} ${u.h}` }
export const addDays = (ds: string, n: number) => { const d = new Date(ds + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10) }

/** Block titles stored before the English switch, mapped for display. */
const BLOCK_EN: Record<string, string> = {
  'Matematik': 'Math', 'Matematik II': 'Math II', 'İngilizce': 'English', 'Öğle arası': 'Lunch', 'Mola': 'Break',
  'Gün sonu testi + kapanış': 'End-of-day test + close',
}
export const blockTitle = (t: string) => tx(BLOCK_EN[t] ?? t)
/** Weekday name from the date itself, so rows stored in Turkish still read in English. */
export const weekday = (ds: string, short = false) => { const i = new Date(ds + 'T12:00:00').getDay(); return short ? dayShort(i) : dayName(i) }
