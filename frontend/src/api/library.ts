// 📚 共有素材ライブラリ(長尺素材のカット一覧)の API。
// client.ts の axios インスタンス(baseURL=/api・失敗時のトースト)をそのまま使い、
// ここではライブラリの型と呼び出しだけを持つ(client.ts は編集しない)。
import type { AxiosRequestConfig } from 'axios'
import { api } from './client'
import type { Clip } from './client'

export const LIBRARY_PARTS = ['本編', '予告', '特典', 'OP・ED', 'その他'] as const
export type LibraryPart = typeof LIBRARY_PARTS[number]

export const TRANS_KINDS = ['start', 'hard', 'dissolve', 'fade_black', 'fade_white', 'flash_cut'] as const
export type TransKind = typeof TRANS_KINDS[number]

export type AnalysisStatus = 'none' | 'queued' | 'running' | 'done' | 'error' | 'interrupted'

export interface LibraryChapter {
  title: string
  start_frame: number
  end_frame: number
}

export interface LibraryItem {
  asset_id: number
  series: string
  work: string
  part: LibraryPart | string
  sort_order: number
  year: number | null
  tags: string[]
  note: string
  rating: number
  starred: boolean
  chapters: LibraryChapter[]
  analysis_status: AnalysisStatus
  analysis_progress: number
  analysis_error: string
  analysis_version: number
  analyzed_at: string | null
  cut_count: number
  fps: number
  frames: number
  // 素材(asset)の情報
  name: string
  duration_sec: number | null
  width: number | null
  height: number | null
  project_id: number | null
  has_proxy: boolean
  file_exists: boolean
  queue_position: number | null
}

/** ライブラリに入っていない長い動画(10 分以上)。「ライブラリに入れる」の候補 */
export interface LibraryCandidate {
  asset_id: number
  name: string
  duration_sec: number | null
  width: number | null
  height: number | null
  project_id: number | null
  project_name: string
  has_proxy: boolean
  /** サーバーがファイル名から作った下書き */
  suggest: { series: string; work: string; part: string } | null
}

export interface LibraryCut {
  id: number
  idx: number
  start: number          // 素材のフレーム(素材の fps)
  end: number            // 含まない
  trans_in: TransKind | string
  trans_frames: number
  luma: number
  motion: number
  sat: number
  hue: number | null
  dark: boolean
  bright: boolean
  tags: string[]
  rating: number
  starred: boolean
  note: string
  edited: boolean
  thumb_ver: number
  /** 画面だけの値: つなぐ/分けるの直後、サーバーがスプライトを作り直すまでは前の行を指す */
  thumb_idx?: number
}

export interface LibraryCuts {
  asset_id: number
  fps: number
  frames: number
  chapters: LibraryChapter[]
  version: number
  /** スプライト 1 枚ごとの版(作り直すと変わる)。キャッシュよけの ?v= に使う */
  spriteVersions: number[]
  cuts: LibraryCut[]
}

export interface LibraryItemCreate {
  asset_id: number
  series: string
  work: string
  part: string
  sort_order?: number
  year?: number | null
  tags?: string[]
  move?: boolean
}

export interface LibraryItemUpdate {
  series?: string
  work?: string
  part?: string
  sort_order?: number
  year?: number | null
  tags?: string[]
  note?: string
  rating?: number
  starred?: boolean
}

export interface LibraryCutUpdate {
  tags?: string[]
  rating?: number
  starred?: boolean
  note?: string
}

export interface LibraryBulkUpdate {
  ids: number[]
  add_tags?: string[]
  remove_tags?: string[]
  rating?: number
  starred?: boolean
}

export interface LibraryTagCount { tag: string; count: number }

export interface LibraryPlaceRequest {
  project_id: number
  track_id: number
  start_frame: number
  cut_ids: number[]
  gap_frames?: number
  /** true: cut_ids の順のまま並べる(画面は時間順に並べた計画を送る) */
  keep_order?: boolean
}

// ── 応答の取り込み ───────────────────────────────────────────────────────
// バックエンドは *_json の文字列で持つ列がある。どちらの形で来ても配列/オブジェクトに揃える。
type Raw = Record<string, unknown>

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d)

function jsonList<T>(v: unknown, fallback: unknown): T[] {
  if (Array.isArray(v)) return v as T[]
  if (typeof fallback === 'string' && fallback) {
    try { const p = JSON.parse(fallback); return Array.isArray(p) ? p as T[] : [] } catch { return [] }
  }
  if (Array.isArray(fallback)) return fallback as T[]
  return []
}

function normChapter(c: Raw): LibraryChapter {
  return {
    title: str(c.title),
    start_frame: num(c.start_frame ?? c.start),
    end_frame: num(c.end_frame ?? c.end),
  }
}

function normItem(r: Raw): LibraryItem {
  const asset = (r.asset && typeof r.asset === 'object' ? r.asset : {}) as Raw
  const pick = (k: string) => (r[k] !== undefined ? r[k] : asset[k])
  return {
    asset_id: num(r.asset_id ?? asset.id),
    series: str(r.series),
    work: str(r.work),
    part: str(r.part, '本編'),
    sort_order: num(r.sort_order),
    year: typeof r.year === 'number' ? r.year : null,
    tags: jsonList<string>(r.tags, r.tags_json),
    note: str(r.note),
    rating: num(r.rating),
    starred: !!r.starred,
    chapters: jsonList<Raw>(r.chapters, r.chapters_json).map(normChapter),
    analysis_status: str(r.analysis_status, 'none') as AnalysisStatus,
    analysis_progress: num(r.analysis_progress),
    analysis_error: str(r.analysis_error),
    analysis_version: num(r.analysis_version),
    analyzed_at: typeof r.analyzed_at === 'string' ? r.analyzed_at : null,
    cut_count: num(r.cut_count),
    fps: num(r.fps),
    frames: num(r.frames),
    name: str(pick('name') ?? pick('asset_name')),
    duration_sec: typeof pick('duration_sec') === 'number' ? pick('duration_sec') as number
      : typeof pick('duration') === 'number' ? pick('duration') as number : null,
    width: typeof pick('width') === 'number' ? pick('width') as number : null,
    height: typeof pick('height') === 'number' ? pick('height') as number : null,
    project_id: typeof pick('project_id') === 'number' ? pick('project_id') as number : null,
    has_proxy: !!(pick('has_proxy') ?? pick('proxy') ?? pick('proxy_path')),
    file_exists: pick('file_exists') !== false,
    queue_position: typeof r.queue_position === 'number' ? r.queue_position : null,
  }
}

function normCandidate(r: Raw): LibraryCandidate {
  const asset = (r.asset && typeof r.asset === 'object' ? r.asset : {}) as Raw
  const pick = (k: string) => (r[k] !== undefined ? r[k] : asset[k])
  return {
    asset_id: num(r.asset_id ?? r.id ?? asset.id),
    name: str(pick('name')),
    duration_sec: typeof pick('duration_sec') === 'number' ? pick('duration_sec') as number
      : typeof pick('duration') === 'number' ? pick('duration') as number : null,
    width: typeof pick('width') === 'number' ? pick('width') as number : null,
    height: typeof pick('height') === 'number' ? pick('height') as number : null,
    project_id: typeof pick('project_id') === 'number' ? pick('project_id') as number : null,
    project_name: str(pick('project_name')),
    has_proxy: !!(pick('has_proxy') ?? pick('proxy') ?? pick('proxy_path')),
    suggest: r.suggest && typeof r.suggest === 'object'
      ? { series: str((r.suggest as Raw).series), work: str((r.suggest as Raw).work), part: str((r.suggest as Raw).part) }
      : null,
  }
}

export function normCut(r: Raw): LibraryCut {
  return {
    id: num(r.id),
    idx: num(r.idx),
    start: num(r.start ?? r.start_frame),
    end: num(r.end ?? r.end_frame),
    trans_in: str(r.trans_in, 'hard'),
    trans_frames: num(r.trans_frames),
    luma: num(r.luma),
    motion: num(r.motion),
    sat: num(r.sat),
    hue: typeof r.hue === 'number' ? r.hue : null,
    dark: !!r.dark,
    bright: !!r.bright,
    tags: jsonList<string>(r.tags, r.tags_json),
    rating: num(r.rating),
    starred: !!r.starred,
    note: str(r.note),
    edited: !!r.edited,
    thumb_ver: num(r.thumb_ver),
  }
}

function normCuts(r: Raw, assetId: number): LibraryCuts {
  const sp = (r.sprites && typeof r.sprites === 'object' ? r.sprites : {}) as Raw
  return {
    asset_id: assetId,
    fps: num(r.fps, 24) || 24,
    frames: num(r.frames),
    chapters: jsonList<Raw>(r.chapters, r.chapters_json).map(normChapter),
    version: num(r.version ?? r.analysis_version),
    spriteVersions: Array.isArray(sp.versions) ? (sp.versions as unknown[]).map(v => num(v)) : [],
    cuts: (Array.isArray(r.cuts) ? r.cuts as Raw[] : []).map(normCut).sort((a, b) => a.start - b.start),
  }
}

/** 変更系の応答から変わったカットを取り出す({cuts:[...]} / [...] / {cut:{...}} / {...} のどれでも) */
function cutsOf(d: unknown): LibraryCut[] {
  if (Array.isArray(d)) return (d as Raw[]).map(normCut)
  const o = (d ?? {}) as Raw
  if (Array.isArray(o.cuts)) return (o.cuts as Raw[]).map(normCut)
  if (Array.isArray(o.changed)) return (o.changed as Raw[]).map(normCut)
  if (o.cut && typeof o.cut === 'object') return [normCut(o.cut as Raw)]
  if (typeof o.id === 'number') return [normCut(o)]
  return []
}

/** 失敗してもトーストを出さない(定期の読み直しなど) */
const SILENT = { __silent: true } as AxiosRequestConfig

export const libraryApi = {
  items: (silent = false) =>
    api.get<Raw>('/library/items', silent ? SILENT : undefined).then(r => {
      const d = r.data ?? {}
      const items = (Array.isArray(d) ? d : Array.isArray(d.items) ? d.items : []) as Raw[]
      const cands = (Array.isArray(d.candidates) ? d.candidates : []) as Raw[]
      return { items: items.map(normItem), candidates: cands.map(normCandidate) }
    }),
  register: (data: LibraryItemCreate) =>
    api.post<Raw>('/library/items', data).then(r => normItem((r.data?.item ?? r.data) as Raw)),
  updateItem: (assetId: number, data: LibraryItemUpdate) =>
    api.patch<Raw>(`/library/items/${assetId}`, data).then(r => normItem((r.data?.item ?? r.data) as Raw)),
  unregister: (assetId: number) => api.delete(`/library/items/${assetId}`),
  analyze: (assetId: number) =>
    api.post<Raw>(`/library/items/${assetId}/analyze`).then(r => r.data),
  cuts: (assetId: number) =>
    api.get<Raw>(`/library/items/${assetId}/cuts`).then(r => normCuts(r.data ?? {}, assetId)),
  /** スプライト(1 枚に 50 カット・1 カット 1 行に 頭/中/尻 の 3 コマ) */
  spriteUrl: (assetId: number, sheet: number, ver: number | string) =>
    `/api/library/items/${assetId}/sprites/${sheet}.jpg?v=${ver}`,
  updateCut: (id: number, data: LibraryCutUpdate) =>
    api.patch<Raw>(`/library/cuts/${id}`, data).then(r => cutsOf(r.data)),
  bulk: (data: LibraryBulkUpdate) =>
    api.post<Raw>('/library/cuts/bulk', data).then(r => cutsOf(r.data)),
  merge: (ids: number[]) =>
    api.post<Raw>('/library/cuts/merge', { ids }).then(r => cutsOf(r.data)),
  split: (id: number, at: number) =>
    api.post<Raw>(`/library/cuts/${id}/split`, { at }).then(r => cutsOf(r.data)),
  tags: () =>
    api.get<LibraryTagCount[] | { tags: LibraryTagCount[] }>('/library/tags', SILENT).then(r =>
      Array.isArray(r.data) ? r.data : (r.data?.tags ?? [])),
  /** サーバー側でまとめて置く(1 回の書き込み)。画面は返ってきたクリップをストアへ足し、
   *  元に戻す 1 回分の履歴を自分で積む(placeCuts.ts)。silent: 失敗のトーストを出さない(呼び出し側で出す) */
  place: (data: LibraryPlaceRequest, silent = false) =>
    api.post<{ clips: Clip[] } | Clip[]>('/library/place', data, silent ? SILENT : undefined).then(r =>
      Array.isArray(r.data) ? r.data : (r.data?.clips ?? [])),
  /** クリップを 1 本消す(トーストなし。まとめて消すときに 1 本ずつ失敗を数えるため) */
  deleteClipQuiet: (id: number) => api.delete(`/clips/${id}`, SILENT),
}

/** 失敗した応答の detail を日本語の 1 文に(文字列 / {error} / FastAPI の検証エラーの配列) */
export function errorText(e: unknown, fallback: string): string {
  const r = (e as { response?: { status?: number; data?: { detail?: unknown } } })?.response
  const d = r?.data?.detail
  if (typeof d === 'string' && d) return d
  if (d && typeof d === 'object' && !Array.isArray(d) && typeof (d as Raw).error === 'string') return (d as Raw).error as string
  if (Array.isArray(d) && d.length && typeof (d[0] as Raw)?.msg === 'string') return `${fallback}(${(d[0] as Raw).msg})`
  return fallback
}

/** 失敗した応答の HTTP の番号(通信できなかったときは 0) */
export function errorStatus(e: unknown): number {
  return (e as { response?: { status?: number } })?.response?.status ?? 0
}
