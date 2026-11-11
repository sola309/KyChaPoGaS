// 📚 ライブラリ画面の共通部品: 時間の表示・絞り込み・並べ替え・表示状態の保存。
import type { LibraryChapter, LibraryCut, LibraryItem } from '../../api/library'

/** 時:分:秒+コマ(例 1:02:03+05)。fps は素材の fps */
export function fmtTc(frame: number, fps: number): string {
  const f = Math.max(0, Math.round(frame))
  const r = Math.max(1, Math.round(fps))
  const totalSec = Math.floor(f / r)
  const ff = f - totalSec * r
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}+${String(ff).padStart(2, '0')}`
}

/** 秒数の h:mm:ss(素材の長さの表示) */
export function fmtDur(sec: number | null | undefined): string {
  if (!sec || sec <= 0) return ''
  const t = Math.round(sec)
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = t % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** カットの長さ(秒 + コマ数) */
export function fmtLen(frames: number, fps: number): string {
  const sec = frames / Math.max(1, fps)
  return `${sec < 10 ? sec.toFixed(1) : sec.toFixed(0)}秒 ${frames}f`
}

export const TRANS_LABEL: Record<string, string> = {
  start: '先頭',
  hard: 'カット',
  dissolve: 'ディゾルブ',
  fade_black: '黒フェード',
  fade_white: '白フェード',
  flash_cut: 'フラッシュ',
}

/** カードの小さな印(hard は出さない) */
export const TRANS_BADGE: Record<string, string> = {
  start: '▶',
  dissolve: 'DIS',
  fade_black: '黒',
  fade_white: '白',
  flash_cut: '⚡',
}

/** 密度帯・印の色(入り方ごと) */
export const TRANS_COLOR: Record<string, string> = {
  start: '#a1a1aa',
  hard: '#9c878c',
  dissolve: '#38bdf8',
  fade_black: '#6366f1',
  fade_white: '#fde68a',
  flash_cut: '#f97316',
}

export const TRANS_BADGE_CLASS: Record<string, string> = {
  start: 'bg-zinc-700 text-zinc-200',
  dissolve: 'bg-sky-900/90 text-sky-200',
  fade_black: 'bg-indigo-950/90 text-indigo-200 border border-indigo-700',
  fade_white: 'bg-amber-100/90 text-amber-900',
  flash_cut: 'bg-orange-900/90 text-orange-200',
}

export type SortKey = 'time' | 'length' | 'motion' | 'luma' | 'rating'
export const SORT_LABEL: Record<SortKey, string> = {
  time: '時間順', length: '長さ', motion: '動き', luma: '明るさ', rating: '評価',
}

export interface CutFilters {
  text: string
  tags: string[]            // すべて含む(AND)
  starOnly: boolean
  minRating: number         // 0 = 指定なし
  minSec: number | null
  maxSec: number | null
  dark: boolean
  bright: boolean
  motion: 'all' | 'low' | 'high'
  trans: string             // 'all' または入り方
  chapter: number           // -1 = すべて
}

export const DEFAULT_FILTERS: CutFilters = {
  text: '', tags: [], starOnly: false, minRating: 0, minSec: null, maxSec: null,
  dark: false, bright: false, motion: 'all', trans: 'all', chapter: -1,
}

export interface ViewState {
  filters: CutFilters
  sort: SortKey
  desc: boolean
  scrollTop: number
}

export const DEFAULT_VIEW: ViewState = { filters: DEFAULT_FILTERS, sort: 'time', desc: false, scrollTop: 0 }

export function filtersActive(f: CutFilters): boolean {
  return !!(f.text.trim() || f.tags.length || f.starOnly || f.minRating || f.minSec != null || f.maxSec != null
    || f.dark || f.bright || f.motion !== 'all' || f.trans !== 'all' || f.chapter >= 0)
}

/** 動き 少/多 の境目(全カットの 30 % / 70 % 点) */
export function motionCuts(cuts: LibraryCut[]): { lo: number; hi: number } {
  if (cuts.length === 0) return { lo: 0, hi: 1 }
  const m = cuts.map(c => c.motion).sort((a, b) => a - b)
  const at = (p: number) => m[Math.min(m.length - 1, Math.max(0, Math.floor(p * (m.length - 1))))]
  return { lo: at(0.3), hi: at(0.7) }
}

export function chapterOf(chapters: LibraryChapter[], frame: number): number {
  for (let i = 0; i < chapters.length; i++) {
    if (frame >= chapters[i].start_frame && frame < chapters[i].end_frame) return i
  }
  return -1
}

export function applyFilters(cuts: LibraryCut[], f: CutFilters, fps: number,
                             chapters: LibraryChapter[], mq: { lo: number; hi: number }): LibraryCut[] {
  const q = f.text.trim().toLowerCase()
  const ch = f.chapter >= 0 ? chapters[f.chapter] : undefined
  return cuts.filter(c => {
    if (f.starOnly && !c.starred) return false
    if (f.minRating > 0 && c.rating < f.minRating) return false
    const sec = (c.end - c.start) / Math.max(1, fps)
    if (f.minSec != null && sec < f.minSec) return false
    if (f.maxSec != null && sec > f.maxSec) return false
    if (f.dark || f.bright) {
      // 両方押したら「暗い または 明るい」
      if (!((f.dark && c.dark) || (f.bright && c.bright))) return false
    }
    if (f.motion === 'low' && c.motion > mq.lo) return false
    if (f.motion === 'high' && c.motion < mq.hi) return false
    if (f.trans !== 'all' && c.trans_in !== f.trans) return false
    if (ch && !(c.start < ch.end_frame && c.end > ch.start_frame)) return false
    if (f.tags.length && !f.tags.every(t => c.tags.includes(t))) return false
    if (q) {
      const hay = (c.tags.join(' ') + ' ' + c.note).toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
}

export function sortCuts(cuts: LibraryCut[], key: SortKey, desc: boolean): LibraryCut[] {
  const val = (c: LibraryCut): number =>
    key === 'length' ? c.end - c.start
      : key === 'motion' ? c.motion
        : key === 'luma' ? c.luma
          : key === 'rating' ? c.rating + (c.starred ? 0.5 : 0)
            : c.start
  const sign = desc ? -1 : 1
  // 同じ値は時間順(安定)
  return [...cuts].sort((a, b) => (val(a) - val(b)) * sign || a.start - b.start)
}

// ── 保存(localStorage・失敗しても動く) ─────────────────────────────────
const VIEW_KEY = (assetId: number) => `library.view.${assetId}`
const LAST_KEY = 'library.lastItem'

/** 保存してあった絞り込みを 1 項目ずつ確かめて戻す。型の違う値(手で書き換えた・古い版の形)は既定値にする
 *  (そのまま広げると .trim() / .every() で画面ごと落ち、開くたびに同じ素材で落ち続ける) */
export function sanitizeFilters(raw: unknown): CutFilters {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const d = DEFAULT_FILTERS
  const bool = (k: keyof CutFilters) => (typeof o[k] === 'boolean' ? o[k] as boolean : d[k] as boolean)
  const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
  const motion = o.motion === 'low' || o.motion === 'high' || o.motion === 'all' ? o.motion : d.motion
  const minRating = typeof o.minRating === 'number' && Number.isInteger(o.minRating) && o.minRating >= 0 && o.minRating <= 5
    ? o.minRating : d.minRating
  const chapter = typeof o.chapter === 'number' && Number.isInteger(o.chapter) && o.chapter >= -1 ? o.chapter : d.chapter
  return {
    text: typeof o.text === 'string' ? o.text : d.text,
    tags: Array.isArray(o.tags) ? [...new Set(o.tags.filter((t): t is string => typeof t === 'string' && t !== ''))] : d.tags,
    starOnly: bool('starOnly'),
    minRating,
    minSec: numOrNull(o.minSec),
    maxSec: numOrNull(o.maxSec),
    dark: bool('dark'),
    bright: bool('bright'),
    motion,
    trans: typeof o.trans === 'string' && (o.trans === 'all' || Object.prototype.hasOwnProperty.call(TRANS_LABEL, o.trans)) ? o.trans : d.trans,
    chapter,
  }
}

export function loadView(assetId: number): ViewState {
  try {
    const raw = localStorage.getItem(VIEW_KEY(assetId))
    if (!raw) return DEFAULT_VIEW
    const parsed: unknown = JSON.parse(raw)
    const v = (parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>
    return {
      filters: sanitizeFilters(v.filters),
      sort: (typeof v.sort === 'string' && Object.prototype.hasOwnProperty.call(SORT_LABEL, v.sort)) ? v.sort as SortKey : 'time',
      desc: v.desc === true,
      scrollTop: typeof v.scrollTop === 'number' && Number.isFinite(v.scrollTop) && v.scrollTop >= 0 ? v.scrollTop : 0,
    }
  } catch { return DEFAULT_VIEW }
}

export function saveView(assetId: number, v: ViewState) {
  try { localStorage.setItem(VIEW_KEY(assetId), JSON.stringify(v)) } catch { /* 保存できなくても続ける */ }
}

export function loadLastItem(): number | null {
  try { const v = Number(localStorage.getItem(LAST_KEY)); return Number.isFinite(v) && v > 0 ? v : null } catch { return null }
}

export function saveLastItem(assetId: number) {
  try { localStorage.setItem(LAST_KEY, String(assetId)) } catch { /* ignore */ }
}

// ── ファイル名から「ライブラリに入れる」の初期値を作る ──────────────────
export function guessMeta(name: string, items: LibraryItem[]): { series: string; work: string; part: string } {
  const base = name.replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[【】[\]「」]/g, ' ').replace(/\s+/g, ' ').trim()
  const low = base.toLowerCase()
  const part = /予告|trailer|teaser|\bpv\b|\bcm\b/.test(low) ? '予告'
    : /ノンクレ|\bop\b|\bed\b|opening|ending/.test(low) ? 'OP・ED'
      : /特典|making|メイキング|bonus|extra/.test(low) ? '特典'
        : '本編'
  // 既存のシリーズ名がファイル名に含まれていればそれを使う
  const known = [...new Set(items.map(i => i.series).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .find(s => base.includes(s))
  if (known) {
    const work = base.replace(known, '').replace(/^[\s_\-–・:：]+|[\s_\-–・:：]+$/g, '').trim()
    return { series: known, work: work || base, part }
  }
  // 知らないシリーズは空のまま(入力欄の候補から選ぶか打つ)
  return { series: '', work: base.replace(/_/g, ' '), part }
}
