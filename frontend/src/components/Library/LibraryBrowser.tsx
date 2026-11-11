// 📚 共有素材ライブラリ: 長尺素材(劇場版など)のカット一覧を見て、選んで、タイムラインに置く画面。
// 全画面の重ね表示(document.body 直下の専用の箱へポータル)。Esc で閉じる。どのプロジェクトからでも開ける。
//
// キー操作はこの画面の中だけで完結させる: 開いている間は window の捕捉段階で受け、
// タイムライン(Space 再生・S 分割・Delete・Ctrl+Z など)やほかの全体ショートカットへ届かせない。
// 入力欄の中のキーはそのまま入力に渡し、外へは専用の箱の listener で止める。
// 貼り付け・コピー・切り取り(paste/copy/cut)も外へ届かせない(ProjectView の「画像を貼るとアセットに追加」が動かないように)。
// 開いたらタイムラインの再生を止める(PreviewPlayer は編集しないので、その「一時停止」ボタンを押す)。
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { LibraryCandidate, LibraryCut, LibraryCuts, LibraryItem, LibraryItemUpdate, LibraryTagCount } from '../../api/library'
import { libraryApi } from '../../api/library'
import { useUIStore } from '../../store/uiStore'
import { CutGrid, type CutGridHandle } from './CutGrid'
import { CutDetail, type CutDetailHandle } from './CutDetail'
import { FilterBar } from './FilterBar'
import { ItemHeader } from './ItemHeader'
import { ItemList } from './ItemList'
import { PlaceBar, type PlaceBarHandle } from './PlaceBar'
import { SourceStrip } from './SourceStrip'
import type { CutFilters, SortKey, ViewState } from './libraryUtils'
import { applyFilters, DEFAULT_VIEW, loadLastItem, loadView, motionCuts, saveLastItem, saveView, sortCuts } from './libraryUtils'
import { LIBRARY_CUTS_MIME } from './dragData'

interface Props {
  projectId: number
  onClose: () => void
}

type Msg = { text: string; kind: 'info' | 'success' | 'error'; action?: { label: string; run: () => void } } | null

/** ライブラリの編集(評価・★・タグ)を元に戻す 1 件。ライブラリの編集はタイムラインの履歴に入らないので、この画面で持つ */
interface LibUndo { label: string; run: () => Promise<void> }
const LIB_UNDO_MAX = 20

/** タイムラインの再生ボタン(PreviewPlayer)が「一時停止」になっているもの = 再生中。この画面の外にあるものだけ */
const PLAYING_BTN = 'button[title="一時停止 (Space)"]'
const timelinePauseButtons = (host: HTMLElement | null): HTMLButtonElement[] =>
  Array.from(document.querySelectorAll<HTMLButtonElement>(PLAYING_BTN)).filter(b => !host || !host.contains(b))


export function LibraryBrowser({ projectId, onClose }: Props) {
  // ── 重ね表示の箱(body 直下)。React はこの箱でイベントを受けるので、ここで外への伝播を止められる
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const d = document.createElement('div')
    d.setAttribute('data-library-host', '')
    document.body.appendChild(d)
    setHost(d)
    return () => { d.remove() }
  }, [])
  useEffect(() => {
    if (!host) return
    const stop = (e: Event) => e.stopPropagation()
    host.addEventListener('keydown', stop)
    host.addEventListener('keyup', stop)
    host.addEventListener('keypress', stop)
    return () => {
      host.removeEventListener('keydown', stop)
      host.removeEventListener('keyup', stop)
      host.removeEventListener('keypress', stop)
    }
  }, [host])

  // 貼り付け・コピー・切り取り: 開いている間は外(ProjectView の画像貼り付け→アセット追加など)へ届かせない。
  // 既定の動き(入力欄への貼り付け・選んだ文字のコピー)はそのまま
  useEffect(() => {
    const stop = (e: Event) => { e.stopPropagation(); e.stopImmediatePropagation() }
    const evs = ['paste', 'copy', 'cut'] as const
    for (const ev of evs) window.addEventListener(ev, stop, true)
    return () => { for (const ev of evs) window.removeEventListener(ev, stop, true) }
  }, [])

  // タイムラインの再生: 開いたら止める(音が重なり、置く位置が動き続けるため)。止められなければ印を出す
  const [timelinePlaying, setTimelinePlaying] = useState(false)
  useEffect(() => {
    if (!host) return
    try { for (const b of timelinePauseButtons(host)) b.click() } catch { /* 止められなくても続ける */ }
    const check = () => setTimelinePlaying(timelinePauseButtons(host).length > 0)
    const t0 = setTimeout(check, 300)
    const t = setInterval(check, 1000)
    return () => { clearTimeout(t0); clearInterval(t) }
  }, [host])

  const rootRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<CutGridHandle>(null)
  const detailRef = useRef<CutDetailHandle>(null)
  const placeRef = useRef<PlaceBarHandle>(null)

  const [items, setItems] = useState<LibraryItem[]>([])
  const [candidates, setCandidates] = useState<LibraryCandidate[]>([])
  const [itemsLoaded, setItemsLoaded] = useState(false)
  const [assetId, setAssetId] = useState<number | null>(null)
  const [data, setData] = useState<LibraryCuts | null>(null)
  const [cutsLoading, setCutsLoading] = useState(false)
  const [view, setView] = useState<ViewState>(DEFAULT_VIEW)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [anchorId, setAnchorId] = useState<number | null>(null)
  const [currentId, setCurrentId] = useState<number | null>(null)
  const [tagSugg, setTagSugg] = useState<LibraryTagCount[]>([])
  const [busy, setBusy] = useState(false)
  const [editSeq, setEditSeq] = useState(0)
  const [msg, setMsg] = useState<Msg>(null)
  const [showItems, setShowItems] = useState(false)     // 狭い画面: 左の列を引き出す
  const [showDetail, setShowDetail] = useState(false)   // 狭い画面: 詳細を引き出す
  const [dragging, setDragging] = useState(false)
  const libUndo = useRef<LibUndo[]>([])
  const escTarget = useRef<(() => void) | null>(null)   // Esc で先に閉じる小窓(タグの一覧など)
  const setEscTarget = useCallback((fn: (() => void) | null) => { escTarget.current = fn }, [])

  const item = items.find(i => i.asset_id === assetId) ?? null

  const flash = useCallback((text: string, kind: 'info' | 'success' | 'error' = 'info',
                             action?: { label: string; run: () => void }) => {
    setMsg({ text, kind, action })
  }, [])
  useEffect(() => {
    if (!msg) return
    const t = setTimeout(() => setMsg(null), msg.action ? 10000 : msg.kind === 'error' ? 7000 : 4000)
    return () => clearTimeout(t)
  }, [msg])

  // ── 素材一覧 ───────────────────────────────────────────────────────────
  const loadItems = useCallback(async (silent = false) => {
    try {
      const r = await libraryApi.items(silent)
      setItems(r.items)
      setCandidates(r.candidates)
      setItemsLoaded(true)
      return r.items
    } catch {
      setItemsLoaded(true)
      return null
    }
  }, [])

  useEffect(() => {
    void loadItems().then(list => {
      if (!list || list.length === 0) return
      const last = loadLastItem()
      const pick = list.find(i => i.asset_id === last) ?? list.find(i => i.analysis_status === 'done') ?? list[0]
      setAssetId(pick.asset_id)
    })
    void libraryApi.tags().then(setTagSugg).catch(() => undefined)
  }, [loadItems])

  // 解析中・順番待ちがある間は 2 秒ごとに読み直す
  const anyRunning = items.some(i => i.analysis_status === 'running' || i.analysis_status === 'queued')
  useEffect(() => {
    if (!anyRunning) return
    const t = setInterval(() => { void loadItems(true) }, 2000)
    return () => clearInterval(t)
  }, [anyRunning, loadItems])

  // ── カット一覧 ─────────────────────────────────────────────────────────
  // 素材をすばやく切り替えると、前の素材の答えが後から届く。いま選んでいる素材の、いちばん新しい
  // 読み込みの答えだけを使う(前は「先に届いた答え」を入れてしまい、解析済みの素材が空のままになった)
  const assetRef = useRef<number | null>(null)
  const reqSeq = useRef(0)
  const appliedSeq = useRef(0)
  useLayoutEffect(() => { assetRef.current = assetId }, [assetId])
  const loadCuts = useCallback(async (id: number): Promise<LibraryCuts | null> => {
    const my = ++reqSeq.current
    setCutsLoading(true)
    try {
      const d = await libraryApi.cuts(id)
      if (id !== assetRef.current || my < appliedSeq.current) return null   // もう別の素材を見ている・古い答え
      appliedSeq.current = my
      setData(d)
      return d
    } catch {
      return null
    } finally {
      if (my === reqSeq.current) setCutsLoading(false)
    }
  }, [])

  // 素材を切り替えたら: 表示状態を戻し、カットを読む
  useEffect(() => {
    if (assetId == null) return
    saveLastItem(assetId)
    setView(loadView(assetId))
    setSelected(new Set())
    setAnchorId(null)
    setCurrentId(null)
    setData(null)
  }, [assetId])

  const status = item?.analysis_status
  const ver = item ? `${item.analysis_version}:${item.cut_count}:${status}` : ''
  useEffect(() => {
    if (assetId == null || !item) return
    if (status !== 'done' && item.cut_count === 0) { setData(null); return }
    void loadCuts(assetId).then(d => {
      if (!d || d.cuts.length === 0) return
      setCurrentId(cur => (cur != null && d.cuts.some(c => c.id === cur)) ? cur : null)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetId, ver])

  const cuts = useMemo(() => (data && data.asset_id === assetId ? data.cuts : []), [data, assetId])
  const fps = data?.fps || item?.fps || 24
  const itemChapters = item?.chapters
  const chapters = useMemo(() => (data?.chapters?.length ? data.chapters : (itemChapters ?? [])), [data, itemChapters])
  const frames = data?.frames || item?.frames || (cuts.length ? cuts[cuts.length - 1].end : 0)
  const mq = useMemo(() => motionCuts(cuts), [cuts])
  const visible = useMemo(
    () => sortCuts(applyFilters(cuts, view.filters, fps, chapters, mq), view.sort, view.desc),
    [cuts, view.filters, view.sort, view.desc, fps, chapters, mq])
  const visibleIds = useMemo(() => new Set(visible.map(c => c.id)), [visible])
  const indexOf = useMemo(() => new Map(visible.map((c, i) => [c.id, i])), [visible])
  const byTime = cuts      // 読み込み時に時間順へ並べてある
  const timeIndex = useMemo(() => new Map(byTime.map((c, i) => [c.id, i])), [byTime])
  const current = currentId != null ? cuts[timeIndex.get(currentId) ?? -1] ?? null : null
  const ti = current ? timeIndex.get(current.id) ?? -1 : -1
  const prevCut = ti > 0 ? byTime[ti - 1] : null
  const nextCut = ti >= 0 && ti < byTime.length - 1 ? byTime[ti + 1] : null
  // 編集・置く・ドラッグの対象 = 選んでいて、いまの絞り込みで見えているカット(時間順)。
  // 隠れたカットは選択に残しておく(絞り込みを戻せばまた対象になる)が、見えない間は触らない
  const selection = useMemo(() => cuts.filter(c => selected.has(c.id) && visibleIds.has(c.id)), [cuts, selected, visibleIds])
  const hiddenSelected = useMemo(() => cuts.reduce((n, c) => n + (selected.has(c.id) && !visibleIds.has(c.id) ? 1 : 0), 0),
    [cuts, selected, visibleIds])

  // 最初のカットを「いま見ているカット」にする(保存したスクロール位置に近いもの)
  useEffect(() => {
    if (currentId == null && visible.length > 0) {
      const first = visible[0]
      setCurrentId(first.id)
      setSelected(new Set([first.id]))
      setAnchorId(first.id)
    }
  }, [visible, currentId])

  // スプライトの版: サーバーが 1 枚ごとの版(作り直すとファイルの時刻で変わる)を返すので ?v= に付ける。
  // つなぐ/分けるの反映待ちの間はサーバーから読み直さないので前の版のまま(各カットは thumb_idx で前の行を指す)。
  // 版が来ない古い応答のときは、解析の版と編集の回数で代用する
  const spriteVersions = data?.spriteVersions
  const dataVersion = data?.version ?? 0
  const sheetVer = useCallback((s: number) => {
    const sv = spriteVersions ?? []
    return sv.length ? `${dataVersion}.${sv[s] ?? 0}` : `${dataVersion}.e${editSeq}`
  }, [spriteVersions, dataVersion, editSeq])

  // ── 表示状態の保存 ─────────────────────────────────────────────────────
  const scrollSave = useRef<ReturnType<typeof setTimeout> | null>(null)
  const viewRef = useRef(view)
  useLayoutEffect(() => { viewRef.current = view }, [view])
  const setFilters = useCallback((f: CutFilters) => {
    setView(v => { const nv = { ...v, filters: f, scrollTop: 0 }; if (assetId != null) saveView(assetId, nv); return nv })
  }, [assetId])
  const setSort = useCallback((sort: SortKey, desc: boolean) => {
    setView(v => { const nv = { ...v, sort, desc }; if (assetId != null) saveView(assetId, nv); return nv })
  }, [assetId])
  const onScrollTop = useCallback((top: number) => {
    if (scrollSave.current) clearTimeout(scrollSave.current)
    scrollSave.current = setTimeout(() => {
      if (assetId != null) saveView(assetId, { ...viewRef.current, scrollTop: top })
    }, 300)
  }, [assetId])

  // 絞り込み・並べ替えを変えたら一覧の先頭から(長さ順なら一番長いカットが見える)。選択はそのまま
  const firstView = useRef(true)
  useEffect(() => {
    if (firstView.current) { firstView.current = false; return }
    gridRef.current?.scrollToTop()
  }, [view.filters, view.sort, view.desc])

  // ── 選択 ───────────────────────────────────────────────────────────────
  // クリックの処理は一覧の版に依らず 1 つ(カードの memo を効かせるため)。最新の一覧はここから読む
  const visibleRef = useRef(visible)
  const anchorRef = useRef(anchorId)
  const selectedRef = useRef(selected)
  useLayoutEffect(() => { visibleRef.current = visible; anchorRef.current = anchorId; selectedRef.current = selected },
    [visible, anchorId, selected])
  const onCardClick = useCallback((cut: LibraryCut, index: number, e: React.MouseEvent) => {
    const vis = visibleRef.current
    const multi = e.ctrlKey || e.metaKey
    if (e.shiftKey && anchorRef.current != null) {
      const a = vis.findIndex(c => c.id === anchorRef.current)
      const [lo, hi] = a < 0 ? [index, index] : [Math.min(a, index), Math.max(a, index)]
      const range = vis.slice(lo, hi + 1).map(c => c.id)
      setSelected(prev => new Set(multi ? [...prev, ...range] : range))
    } else if (multi) {
      const sel = selectedRef.current
      if (sel.has(cut.id)) {
        // 外したカットは「いま見ているカット」にしない: 残っている選択のうち近いものへ移す
        // (前は外したカットのまま残り、キーの評価が外したカットへ付いた)
        const n = new Set(sel)
        n.delete(cut.id)
        setSelected(n)
        let best: LibraryCut | null = null, bd = Infinity
        vis.forEach((c, i) => { if (n.has(c.id) && Math.abs(i - index) < bd) { bd = Math.abs(i - index); best = c } })
        const b = best as LibraryCut | null
        if (b) { setCurrentId(b.id); setAnchorId(b.id) }
        rootRef.current?.focus({ preventScroll: true })
        return
      }
      setSelected(prev => new Set([...prev, cut.id]))
      setAnchorId(cut.id)
    } else {
      setSelected(new Set([cut.id]))
      setAnchorId(cut.id)
    }
    setCurrentId(cut.id)
    rootRef.current?.focus({ preventScroll: true })
  }, [])
  const onCardDoubleClick = useCallback((cut: LibraryCut) => {
    setCurrentId(cut.id)
    setShowDetail(true)
    requestAnimationFrame(() => detailRef.current?.togglePlay())
  }, [])

  const moveCurrent = (delta: number, extend: boolean) => {
    if (visible.length === 0) return
    const i0 = currentId != null ? (indexOf.get(currentId) ?? -1) : -1
    const i = Math.max(0, Math.min(visible.length - 1, i0 < 0 ? 0 : i0 + delta))
    const c = visible[i]
    setCurrentId(c.id)
    if (extend && anchorId != null) {
      const a = indexOf.get(anchorId) ?? i
      setSelected(new Set(visible.slice(Math.min(a, i), Math.max(a, i) + 1).map(x => x.id)))
    } else {
      setSelected(new Set([c.id]))
      setAnchorId(c.id)
    }
    gridRef.current?.scrollToIndex(i)
  }

  const jumpToFrame = useCallback((frame: number) => {
    const vis = visibleRef.current
    if (vis.length === 0) return
    let best = 0, bd = Infinity
    for (let i = 0; i < vis.length; i++) {
      const c = vis[i]
      const d = frame >= c.start && frame < c.end ? -1 : Math.min(Math.abs(c.start - frame), Math.abs(c.end - 1 - frame))
      if (d < bd) { bd = d; best = i; if (d < 0) break }
    }
    const c = vis[best]
    setCurrentId(c.id)
    setSelected(new Set([c.id]))
    setAnchorId(c.id)
    gridRef.current?.scrollToIndex(best)
  }, [])

  // ── カットの編集(画面はすぐ変え、サーバーの答えで上書き。失敗したら読み直す) ──
  const applyLocal = useCallback((ids: number[], fn: (c: LibraryCut) => LibraryCut) => {
    const set = new Set(ids)
    setData(d => d && { ...d, cuts: d.cuts.map(c => set.has(c.id) ? fn(c) : c) })
  }, [])
  const mergeServer = useCallback((changed: LibraryCut[]) => {
    if (changed.length === 0) return
    const m = new Map(changed.map(c => [c.id, c]))
    setData(d => d && { ...d, cuts: d.cuts.map(c => m.get(c.id) ?? c) })
  }, [])
  const reloadCuts = useCallback(async () => { if (assetId != null) await loadCuts(assetId) }, [assetId, loadCuts])

  // キー・詳細の欄・置く・ドラッグはすべて同じ組(selection = 選んでいて見えているカット)に効く。
  // 何も選んでいなければ何もしない(前は「いま見ているカット」へ落ちて、外したカットや隠れたカットに付いた)
  const targets = (): LibraryCut[] => selection
  const needTargets = (ts: LibraryCut[]) => {
    if (ts.length > 0) return true
    flash(hiddenSelected > 0 ? `選んだ ${hiddenSelected} カットはいまの絞り込みで隠れています` : 'カットを選んでください(クリック・Shift で範囲・Ctrl で追加)', 'info')
    return false
  }

  /** 2 カット以上の編集は「元に戻す」を残す(トーストのボタンと、この画面の中の Ctrl+Z) */
  const pushLibUndo = (u: LibUndo) => {
    libUndo.current = [...libUndo.current.slice(-(LIB_UNDO_MAX - 1)), u]
  }
  const undoLib = async () => {
    const u = libUndo.current.pop()
    if (!u) { flash('この画面で元に戻せる操作はありません(タイムラインの元に戻すは画面を閉じてから)', 'info'); return }
    if (busy) { libUndo.current.push(u); flash('つなぐ・分けるの反映を待っています…', 'info'); return }
    setMsg(null)
    try {
      await u.run()
      flash(`元に戻しました: ${u.label}`, 'success')
    } catch {
      flash('元に戻せませんでした。読み直します', 'error')
      await reloadCuts()
    }
  }
  /** ids を前の値の組ごとにまとめる(bulk は 1 回に 1 つの値しか付けられないため) */
  const groupBy = <K,>(ts: LibraryCut[], key: (c: LibraryCut) => K): Map<K, number[]> => {
    const m = new Map<K, number[]>()
    for (const c of ts) { const k = key(c); const a = m.get(k); if (a) a.push(c.id); else m.set(k, [c.id]) }
    return m
  }

  const runEdit = async (ids: number[], local: (c: LibraryCut) => LibraryCut,
                         call: () => Promise<LibraryCut[]>, done?: string, undo?: LibUndo) => {
    if (ids.length === 0) return
    if (busy) { flash('つなぐ・分けるの反映を待っています…', 'info'); return }
    applyLocal(ids, local)
    try {
      mergeServer(await call())
      if (undo) {
        pushLibUndo(undo)
        flash(done ?? undo.label, 'success', { label: '元に戻す', run: () => void undoLib() })
      } else if (done) flash(done, 'success')
    } catch {
      flash('保存できませんでした。読み直します', 'error')
      await reloadCuts()
    }
  }

  const rate = (n: number) => {
    const ts = targets()
    if (!needTargets(ts)) return
    const ids = ts.map(c => c.id)
    const before = groupBy(ts, c => c.rating)
    const label = `${ids.length} カットを評価 ${n} に`
    void runEdit(ids, c => ({ ...c, rating: n }),
      () => ids.length === 1 ? libraryApi.updateCut(ids[0], { rating: n }) : libraryApi.bulk({ ids, rating: n }),
      ids.length > 1 ? `${ids.length} カットを評価 ${n} にしました` : undefined,
      ids.length > 1 ? {
        label,
        run: async () => {
          for (const [r, g] of before) {
            applyLocal(g, c => ({ ...c, rating: r }))
            mergeServer(await libraryApi.bulk({ ids: g, rating: r }))
          }
        },
      } : undefined)
  }
  const toggleStar = () => {
    const ts = targets()
    if (!needTargets(ts)) return
    const ids = ts.map(c => c.id)
    const v = !ts.every(c => c.starred)
    const before = groupBy(ts, c => c.starred)
    void runEdit(ids, c => ({ ...c, starred: v }),
      () => ids.length === 1 ? libraryApi.updateCut(ids[0], { starred: v }) : libraryApi.bulk({ ids, starred: v }),
      ids.length > 1 ? `${ids.length} カットを${v ? '★ にしました' : '★ から外しました'}` : undefined,
      ids.length > 1 ? {
        label: `${ids.length} カットの ★`,
        run: async () => {
          for (const [st, g] of before) {
            applyLocal(g, c => ({ ...c, starred: st }))
            mergeServer(await libraryApi.bulk({ ids: g, starred: st }))
          }
        },
      } : undefined)
  }
  const addTag = (tag: string) => {
    const ts = targets()
    if (!needTargets(ts)) return
    const ids = ts.map(c => c.id)
    const added = ts.filter(c => !c.tags.includes(tag)).map(c => c.id)   // 元に戻すときに外す分
    void runEdit(ids, c => (c.tags.includes(tag) ? c : { ...c, tags: [...c.tags, tag] }),
      () => ids.length === 1 ? libraryApi.updateCut(ids[0], { tags: [...new Set([...ts[0].tags, tag])] })
        : libraryApi.bulk({ ids, add_tags: [tag] }),
      ids.length > 1 ? `${ids.length} カットに「${tag}」を付けました` : undefined,
      ids.length > 1 && added.length > 0 ? {
        label: `「${tag}」を付けた ${added.length} カット`,
        run: async () => {
          applyLocal(added, c => ({ ...c, tags: c.tags.filter(t => t !== tag) }))
          mergeServer(await libraryApi.bulk({ ids: added, remove_tags: [tag] }))
        },
      } : undefined)
    setTagSugg(s => s.some(t => t.tag === tag) ? s.map(t => t.tag === tag ? { ...t, count: t.count + ids.length } : t)
      : [...s, { tag, count: ids.length }])
  }
  const removeTag = (tag: string) => {
    const ts = targets()
    if (!needTargets(ts)) return
    const ids = ts.filter(c => c.tags.includes(tag)).map(c => c.id)
    void runEdit(ids, c => ({ ...c, tags: c.tags.filter(t => t !== tag) }),
      () => ids.length === 1 ? libraryApi.updateCut(ids[0], { tags: ts.find(c => c.id === ids[0])!.tags.filter(t => t !== tag) })
        : libraryApi.bulk({ ids, remove_tags: [tag] }),
      ids.length > 1 ? `${ids.length} カットから「${tag}」を外しました` : undefined,
      ids.length > 1 ? {
        label: `「${tag}」を外した ${ids.length} カット`,
        run: async () => {
          applyLocal(ids, c => (c.tags.includes(tag) ? c : { ...c, tags: [...c.tags, tag] }))
          mergeServer(await libraryApi.bulk({ ids, add_tags: [tag] }))
        },
      } : undefined)
  }
  const setNote = (note: string) => {
    if (!current) return
    const id = current.id
    void runEdit([id], c => ({ ...c, note }), () => libraryApi.updateCut(id, { note }))
  }

  // つなぐ/分けるはサーバーでスプライトを作り直すので数秒かかる。先に画面の一覧だけ直しておき
  // (idx は振り直し、サムネイルは作り直しが届くまで前の行を指す)、答えが来たら読み直す
  const renumberLocal = (list: LibraryCut[]) =>
    list.sort((a, b) => a.start - b.start).map((c, i) => ({ ...c, thumb_idx: c.thumb_idx ?? c.idx, idx: i }))
  const merge = async (dir: 'prev' | 'next') => {
    if (!current || busy) return
    const other = dir === 'prev' ? prevCut : nextCut
    if (!other) return
    const ids = dir === 'prev' ? [other.id, current.id] : [current.id, other.id]
    const keepStart = Math.min(other.start, current.start)
    const keepId = dir === 'prev' ? other.id : current.id
    const newEnd = Math.max(other.end, current.end)
    setBusy(true)
    setData(d => d && {
      ...d,
      cuts: renumberLocal(d.cuts.filter(c => !ids.includes(c.id) || c.id === keepId)
        .map(c => c.id === keepId ? { ...c, end: newEnd, edited: true } : c)),
    })
    setCurrentId(keepId); setSelected(new Set([keepId])); setAnchorId(keepId)
    const forAsset = assetId
    try {
      await libraryApi.merge(ids)
      const d = forAsset != null ? await loadCuts(forAsset) : null
      setEditSeq(n => n + 1)
      // 待っている間に別の素材へ切り替えていたら、選択はいじらない(d は null)
      const c = d && assetRef.current === forAsset ? d.cuts.find(x => x.start === keepStart) : undefined
      if (c) { setCurrentId(c.id); setSelected(new Set([c.id])); setAnchorId(c.id) }
      flash(`#${Math.min(other.idx, current.idx) + 1} と #${Math.max(other.idx, current.idx) + 1} をつなぎました`, 'success')
      void loadItems(true)
    } catch {
      flash('つなげませんでした', 'error')
      await reloadCuts()
    } finally { setBusy(false) }
  }
  const split = async (at: number) => {
    if (!current || busy) return
    if (!(at > current.start && at < current.end)) return
    const keepStart = current.start
    const cur = current
    setBusy(true)
    setData(d => d && {
      ...d,
      cuts: renumberLocal(d.cuts.flatMap(c => c.id !== cur.id ? [c] : [
        { ...c, end: at, edited: true },
        { ...c, id: -cur.id, start: at, trans_in: 'hard', trans_frames: 0, edited: true },
      ])),
    })
    const forAsset = assetId
    try {
      await libraryApi.split(current.id, at)
      const d = forAsset != null ? await loadCuts(forAsset) : null
      setEditSeq(n => n + 1)
      const c = d && assetRef.current === forAsset ? d.cuts.find(x => x.start === keepStart) : undefined
      if (c) { setCurrentId(c.id); setSelected(new Set([c.id])); setAnchorId(c.id) }
      flash(`#${current.idx + 1} を 2 つに分けました`, 'success')
      void loadItems(true)
    } catch {
      flash('分けられませんでした', 'error')
      await reloadCuts()
    } finally { setBusy(false) }
  }

  // ── 素材の操作 ─────────────────────────────────────────────────────────
  const saveItem = async (patch: LibraryItemUpdate) => {
    if (!item) return
    setItems(list => list.map(i => i.asset_id === item.asset_id ? { ...i, ...patch, tags: patch.tags ?? i.tags } as LibraryItem : i))
    try {
      const upd = await libraryApi.updateItem(item.asset_id, patch)
      if (upd.asset_id) setItems(list => list.map(i => i.asset_id === upd.asset_id ? { ...i, ...upd, name: upd.name || i.name } : i))
    } catch { void loadItems(true) }
  }
  const analyze = async (id: number) => {
    try {
      await libraryApi.analyze(id)
      flash('カットの解析を始めました(終わると自動で一覧が出ます)', 'info')
    } catch { /* トースト済み */ }
    void loadItems(true)
  }
  const register = async (c: LibraryCandidate, meta: { series: string; work: string; part: string; move: boolean }) => {
    try {
      const it = await libraryApi.register({ asset_id: c.asset_id, series: meta.series, work: meta.work, part: meta.part, move: meta.move })
      await loadItems(true)
      setAssetId(it.asset_id || c.asset_id)
      window.dispatchEvent(new Event('kychapogas:assets-changed'))
      flash(`「${meta.work}」をライブラリに入れました`, 'success')
    } catch { /* トースト済み */ }
  }
  const unregister = async () => {
    if (!item) return
    try {
      await libraryApi.unregister(item.asset_id)
      const list = await loadItems(true)
      setAssetId(list && list.length ? list[0].asset_id : null)
      flash('ライブラリから外しました(素材とファイルは残っています)', 'info')
    } catch { /* トースト済み */ }
  }

  // ── ドラッグでタイムラインへ(つかんだら画面を透かして下のトラックへ落とせるように) ──
  const onCardDragStart = useCallback((cut: LibraryCut, e: React.DragEvent) => {
    if (assetId == null) return
    const sel = selected.has(cut.id) && selection.some(c => c.id === cut.id) ? selection : [cut]
    e.dataTransfer.setData(LIBRARY_CUTS_MIME, JSON.stringify({
      assetId, fps, cuts: sel.map(c => ({ id: c.id, idx: c.idx, start: c.start, end: c.end })),
    }))
    e.dataTransfer.effectAllowed = 'copy'
    // 描画の後で透かす(すぐ透かすとドラッグの絵まで消える)
    setTimeout(() => setDragging(true), 0)
  }, [assetId, fps, selected, selection])
  const onCardDragEnd = useCallback(() => setDragging(false), [])
  useEffect(() => {
    if (!dragging) return
    const end = () => setDragging(false)
    window.addEventListener('drop', end, true)
    window.addEventListener('dragend', end, true)
    return () => { window.removeEventListener('drop', end, true); window.removeEventListener('dragend', end, true) }
  }, [dragging])

  // ── キー操作 ───────────────────────────────────────────────────────────
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined)
  const onKeyLatest = (e: KeyboardEvent) => {
    const ctrl = e.ctrlKey || e.metaKey
    const k = e.key
    const handled = () => e.preventDefault()
    if (k === 'Escape') {
      handled()
      // 開いている小窓 → たくさん置く前の確かめ → 画面、の順に閉じる
      const close = escTarget.current
      if (close) { escTarget.current = null; close(); return }
      if (placeRef.current?.cancelPending()) return
      onClose()
      return
    }
    if (ctrl && (k === 'a' || k === 'A')) {
      handled()
      setSelected(new Set(visible.map(c => c.id)))
      return
    }
    // Ctrl+Z: この画面での評価・★・タグのまとめ編集を元に戻す(タイムラインの履歴には届かせない)
    if (ctrl && !e.shiftKey && !e.altKey && (k === 'z' || k === 'Z')) { handled(); void undoLib(); return }
    if (ctrl || e.altKey) { if (k === 'z' || k === 'Z' || k === 'y' || k === 'Y') handled(); return }
    const cols = gridRef.current?.cols() ?? 1
    switch (k) {
      case 'ArrowLeft': handled(); moveCurrent(-1, e.shiftKey); return
      case 'ArrowRight': handled(); moveCurrent(1, e.shiftKey); return
      case 'ArrowUp': handled(); moveCurrent(-cols, e.shiftKey); return
      case 'ArrowDown': handled(); moveCurrent(cols, e.shiftKey); return
      case 'Home': handled(); moveCurrent(-1e9, e.shiftKey); return
      case 'End': handled(); moveCurrent(1e9, e.shiftKey); return
      case ' ': handled(); detailRef.current?.togglePlay(); return
      case 'Enter': handled(); void placeRef.current?.place(); return
      case 'f': case 'F': handled(); toggleStar(); return
      case 't': case 'T':
        handled()
        setShowDetail(true)
        if (detailRef.current) detailRef.current.focusTag()
        else requestAnimationFrame(() => detailRef.current?.focusTag())
        return
      case 'Delete': case 'Backspace': handled(); return
    }
    if (/^[0-5]$/.test(k)) { handled(); rate(Number(k)); return }
  }
  useLayoutEffect(() => { keyRef.current = onKeyLatest })

  useEffect(() => {
    const isText = (t: HTMLElement) => t.isContentEditable || t.tagName === 'TEXTAREA'
      || (t.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button', 'submit', 'color', 'file'].includes((t as HTMLInputElement).type))
    const NAV = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'])
    // Enter / Space で押せる部品(フォーカスがあるときはその部品の動きを優先する)
    const isActivatable = (t: HTMLElement) => t.tagName === 'BUTTON' || t.tagName === 'SUMMARY'
      || (t.tagName === 'A' && t.hasAttribute('href')) || t.getAttribute('role') === 'button'
      || (t.tagName === 'INPUT' && ['checkbox', 'radio', 'button', 'submit', 'reset'].includes((t as HTMLInputElement).type))
    const onKey = (e: KeyboardEvent) => {
      const root = rootRef.current
      const t = e.target as HTMLElement | null
      const inside = !!(root && t && t instanceof Node && root.contains(t))
      if (inside && t) {
        // 入力欄: そのまま入力へ(Esc は入力をやめるだけ)。外への伝播は箱の listener が止める
        if (isText(t) || t.tagName === 'SELECT') {
          if (e.type === 'keydown' && e.key === 'Escape') {
            e.preventDefault(); e.stopPropagation()
            t.blur(); root!.focus({ preventScroll: true })
          }
          return
        }
        // つまみ・チェック: 矢印などはその部品へ、ほかはこの画面のキー
        if (t.tagName === 'INPUT' && NAV.has(e.key)) return
        // フォーカスのあるボタン・チェック(Tab で移ったとき): Enter / Space はその部品を押す
        // (前は Enter が「置く」、Space が再生に取られた)。外への伝播は箱の listener が止める
        if ((e.key === 'Enter' || e.key === ' ') && !e.ctrlKey && !e.metaKey && !e.altKey && isActivatable(t)) return
      }
      e.stopPropagation()
      e.stopImmediatePropagation()
      if (e.type === 'keydown') keyRef.current(e)
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKey, true)
    window.addEventListener('keypress', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKey, true)
      window.removeEventListener('keypress', onKey, true)
    }
  }, [])

  // 開いたらこの画面へフォーカス(タイムラインにフォーカスが残らないように)
  useEffect(() => {
    if (!host) return
    const prev = document.activeElement as HTMLElement | null
    requestAnimationFrame(() => rootRef.current?.focus({ preventScroll: true }))
    return () => { try { prev?.focus?.({ preventScroll: true }) } catch { /* ignore */ } }
  }, [host])

  // 他の画面からのトースト(通信エラーなど)はこの画面の下に隠れるので、ここにも映す
  const toasts = useUIStore(s => s.toasts)

  if (!host) return null

  const placeTargets = selection

  return createPortal(
    <div ref={rootRef} tabIndex={-1} data-library-browser
         onClick={e => {
           // マウスで押したボタンにはフォーカスを残さない(残すと次の Enter / Space がそのボタンを押してしまう)。
           // キーで押したとき(detail = 0)はそのまま
           if (e.detail === 0) return
           const b = (e.target as HTMLElement).closest('button')
           if (b && document.activeElement === b) rootRef.current?.focus({ preventScroll: true })
         }}
         className={`fixed inset-0 z-[150] bg-zinc-950 flex flex-col outline-none text-zinc-200 transition-opacity ${
           dragging ? 'opacity-20 pointer-events-none' : ''}`}>
      {/* 見出し */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 bg-zinc-900 flex-shrink-0">
        <button onClick={() => setShowItems(v => !v)} className="md:hidden flex-shrink-0 whitespace-nowrap text-xs px-2 py-1 rounded bg-zinc-800 text-zinc-200"
                title="素材の一覧">☰ 素材</button>
        <span className="text-sm font-bold text-zinc-100 whitespace-nowrap flex-shrink-0">📚<span className="max-sm:hidden"> 共有素材ライブラリ</span></span>
        {item && <span className="text-xs text-zinc-400 truncate min-w-0">{item.series} / {item.work}{item.part !== '本編' ? `(${item.part})` : ''}</span>}
        <span className="ml-auto hidden lg:inline text-[10px] text-zinc-600 whitespace-nowrap">
          ←→↑↓ 移動 · Shift 範囲 · Space 再生 · 1〜5 評価 · 0 消す · F ★ · T タグ · Enter 置く · Esc 閉じる
        </span>
        <button onClick={() => setShowDetail(v => !v)} className="lg:hidden ml-auto flex-shrink-0 whitespace-nowrap text-xs px-2 py-1 rounded bg-zinc-800 text-zinc-200">詳細</button>
        <button onClick={onClose} className="text-zinc-400 hover:text-zinc-100 text-lg leading-none px-2" title="閉じる(Esc)" data-lib-close>✕</button>
      </div>

      <div className="flex-1 min-h-0 flex relative">
        {/* 左: 素材 */}
        <aside className={`w-60 max-w-[85vw] flex-shrink-0 border-r border-zinc-800 bg-zinc-900 min-h-0 flex-col md:flex md:static md:z-auto md:shadow-none ${
          showItems ? 'flex absolute inset-y-0 left-0 z-30 shadow-2xl' : 'hidden'}`}>
          {!itemsLoaded ? <p className="text-[11px] text-zinc-500 p-3">読み込み中…</p> : (
            <ItemList items={items} candidates={candidates} currentId={assetId}
                      onSelect={id => { setAssetId(id); setShowItems(false) }}
                      onAnalyze={id => void analyze(id)} onRegister={register} />
          )}
        </aside>

        {/* 中: 見出し・帯・絞り込み・一覧・置く */}
        <main className="flex-1 min-w-0 flex flex-col min-h-0">
          {item ? (
            <>
              <ItemHeader item={item} onSave={p => void saveItem(p)} onUnregister={() => void unregister()} />
              {cuts.length > 0 && (
                <SourceStrip cuts={cuts} visibleIds={visibleIds} frames={frames} fps={fps} chapters={chapters}
                             currentStart={current?.start ?? null} chapterFilter={view.filters.chapter}
                             onJump={jumpToFrame}
                             onChapter={i => jumpToFrame(chapters[i]?.start_frame ?? 0)} />
              )}
              {cuts.length > 0 && (
                <FilterBar filters={view.filters} sort={view.sort} desc={view.desc} cuts={cuts} chapters={chapters}
                           shown={visible.length} total={cuts.length} onFilters={setFilters} onSort={setSort}
                           onEscapeTarget={setEscTarget} />
              )}
              {cuts.length > 0 ? (
                <CutGrid ref={gridRef} assetId={item.asset_id} cuts={visible} fps={fps} sheetVer={sheetVer}
                         selected={selected} currentId={currentId} initialScrollTop={view.scrollTop}
                         onCardClick={onCardClick} onCardDoubleClick={onCardDoubleClick}
                         onCardDragStart={onCardDragStart} onCardDragEnd={onCardDragEnd}
                         onScrollTop={onScrollTop} />
              ) : (
                <EmptyState item={item} loading={cutsLoading} onAnalyze={() => void analyze(item.asset_id)}
                            onReload={() => void loadCuts(item.asset_id)} />
              )}
              {cuts.length > 0 && (
                <PlaceBar ref={placeRef} projectId={projectId} srcFps={fps}
                          cuts={placeTargets} hiddenSelected={hiddenSelected} timelinePlaying={timelinePlaying}
                          onMessage={flash} disabled={busy} />
              )}
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-xs text-zinc-500 p-6 text-center">
              {itemsLoaded ? '左の一覧から素材を選んでください。長い動画は「ライブラリに入れる」で入れられます。' : '読み込み中…'}
            </div>
          )}
        </main>

        {/* 右: 詳細 */}
        {item && cuts.length > 0 && (
          <section className={`w-[340px] max-w-[92vw] flex-shrink-0 border-l border-zinc-800 bg-zinc-900 min-h-0 flex-col lg:flex lg:static lg:z-auto lg:shadow-none ${
            showDetail ? 'flex absolute inset-y-0 right-0 z-30 shadow-2xl' : 'hidden'}`}>
            {showDetail && (
              <button onClick={() => setShowDetail(false)} className="lg:hidden self-end text-xs px-2 py-1 text-zinc-400">✕ 詳細を閉じる</button>
            )}
            <CutDetail ref={detailRef} assetId={item.asset_id} hasProxy={item.has_proxy} fps={fps}
                       cut={current} prev={prevCut} next={nextCut} selection={selection}
                       tagSuggestions={tagSugg} busy={busy}
                       onRate={rate} onStar={toggleStar} onAddTag={addTag} onRemoveTag={removeTag}
                       onNote={setNote} onMerge={d => void merge(d)} onSplit={at => void split(at)} />
          </section>
        )}
      </div>

      {/* お知らせ(この画面の分と、ほかからのトースト) */}
      <div className="pointer-events-none absolute bottom-24 right-4 z-40 flex flex-col gap-1.5 items-end">
        {toasts.slice(-3).map(t => (
          <div key={t.id} className="flex items-center gap-2 bg-zinc-900 border border-zinc-700 rounded px-3 py-1.5 shadow-lg text-xs text-zinc-200 max-w-sm">
            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: t.color }} />
            <span className="truncate">{t.text}</span>
          </div>
        ))}
        {msg && (
          <div data-lib-msg={msg.kind}
               className={`rounded px-3 py-1.5 shadow-lg text-xs max-w-md border flex items-center gap-2 ${
                 msg.action ? 'pointer-events-auto' : ''} ${
                 msg.kind === 'error' ? 'bg-red-950 border-red-800 text-red-100'
                   : msg.kind === 'success' ? 'bg-emerald-950 border-emerald-800 text-emerald-100'
                     : 'bg-zinc-900 border-zinc-700 text-zinc-200'}`}>
            <span>{msg.text}</span>
            {msg.action && (
              <button onClick={() => { const a = msg.action; setMsg(null); a?.run() }} data-lib-msg-action
                      className="flex-shrink-0 px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-100 border border-zinc-600 whitespace-nowrap">
                {msg.action.label} <span className="text-[10px] text-zinc-400">Ctrl+Z</span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>,
    host)
}

function EmptyState({ item, loading, onAnalyze, onReload }: {
  item: LibraryItem; loading: boolean; onAnalyze: () => void; onReload: () => void
}) {
  const st = item.analysis_status
  // 解析済みでカットがあるのに一覧が空 = 読み込みがまだ・失敗した。解析しなおし(数分かかる)は勧めない
  const analysed = st === 'done' && item.cut_count > 0
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 text-xs text-zinc-400 p-6 text-center" data-lib-empty={st}>
      {loading ? <span>カットを読み込み中…</span>
        : analysed ? (
          <>
            <span>{item.cut_count.toLocaleString()} カットを読み込めませんでした</span>
            <button onClick={onReload} className="px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-100" data-lib-reload>
              読み直す
            </button>
          </>
        )
        : st === 'running' ? (
          <>
            <span>カットを解析しています… {Math.round(item.analysis_progress * 100)}%</span>
            <span className="w-64 max-w-full h-1.5 rounded-full bg-zinc-800 overflow-hidden">
              <span className="block h-full bg-purple-500" style={{ width: `${Math.round(item.analysis_progress * 100)}%` }} />
            </span>
          </>
        ) : st === 'queued' ? <span>解析の順番を待っています…</span>
          : (
            <>
              <span>{st === 'error' ? `解析に失敗しました: ${item.analysis_error || '不明'}` : st === 'interrupted' ? '解析が途中で止まりました' : 'まだカットを解析していません'}</span>
              <button onClick={onAnalyze} className="px-3 py-1.5 rounded bg-purple-800 hover:bg-purple-700 text-purple-50">
                {st === 'none' ? 'カットを解析' : '解析しなおす'}
              </button>
            </>
          )}
    </div>
  )
}
