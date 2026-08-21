import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Asset } from '../../api/client'
import type { BoardAudioSync } from './storyboard'
import { assetsApi, api } from '../../api/client'
import { useTimelineStore } from '../../store/timelineStore'
import { EMPTY_BOARD, ROLE_LABEL, RETENTION_LABEL, boardLimits, fmtTC,
         type BoardAssetRole, type BoardRetention, type Storyboard, renumberTokens, indexMap, AUDIO_SYNC_LABEL } from './storyboard'

/**
 * 📋 絵コンテ — シーン単位で「作りたいもの」を日本語の文書として書く。
 * 本文・参照アセット・演出ピンを1画面に置き、Claude が後で H3 プロンプトへ起こす。
 * 保存はシーン情報(scene.board)の中なのでバックエンド変更は不要。
 */
interface Props {
  projectId?: number
  sceneName: string
  sceneRange: { s: number; e: number }
  board: Storyboard
  assets: Asset[]
  fps: number
  onChange: (b: Storyboard) => void
  onClose: () => void
}

export function StoryboardPopover({ projectId, sceneName, sceneRange, board, assets, fps, onChange, onClose }: Props) {
  const currentFrame = useTimelineStore(s => s.currentFrame)
  const setCurrentFrame = useTimelineStore(s => s.setCurrentFrame)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const caretRef = useRef<number | null>(null)   // 本文の最後のキャレット位置
  const [picking, setPicking] = useState(false)
  const [replaceIdx, setReplaceIdx] = useState<number | null>(null)   // 差し替え対象の行(nullなら末尾に追加)
  const [q, setQ] = useState('')      // アセット検索(名前 / #ID)
  // 取得元: ⭐お気に入り / 📖キャスト名簿 / 全部。素材が増えるほど全部から探すのは辛い
  const [src, setSrc] = useState<'star' | 'cast' | 'all'>('star')
  const [cast, setCast] = useState<Array<{ name: string; outfit: string; assetId: number; label: string }>>([])
  useEffect(() => {
    if (projectId == null) return
    // 名簿は2層(🌐共通 /projects/0 ・📁プロジェクト)。CastPanelと同じく同keyはプロジェクト側を優先。
    void Promise.all([
      api.get('/projects/0/bible').then(r => r.data).catch(() => ({})),
      api.get(`/projects/${projectId}/bible`).then(r => r.data).catch(() => ({})),
    ]).then(([g, pr]) => {
      const byKey = new Map<string, any>()
      for (const c of [...(g?.cast ?? []), ...(pr?.cast ?? [])]) byKey.set(c.key, c)
      const out: typeof cast = []
      for (const c of byKey.values()) {
        const seen = new Set<number>()
        for (const [, o] of Object.entries<any>(c.outfits ?? {}))
          for (const rf of (o.refs ?? []))
            if (typeof rf.asset === 'number' && !seen.has(rf.asset)) {
              seen.add(rf.asset)
              out.push({ name: c.name, outfit: o.label ?? '', assetId: rf.asset, label: rf.label ?? rf.view ?? '' })
            }
        // ref_main は衣装refsに含まれているのが普通。重複させると衣装のラベルが潰れる
        if (typeof c.ref_main === 'number' && !seen.has(c.ref_main))
          out.push({ name: c.name, outfit: '代表', assetId: c.ref_main, label: '代表' })
      }
      setCast(out)
    })
  }, [projectId])

  // 名簿の参照はプロジェクトを跨ぐ(アルティメットまどか等はミドサマ側の素材)。
  // プロジェクトのアセット一覧にしか無いと候補から落ちるので、足りない分だけ個別に取り寄せる。
  const [extra, setExtra] = useState<Asset[]>([])
  const fetched = useRef<Set<number>>(new Set())
  useEffect(() => {
    const have = new Set([...assets.map(a => a.id), ...extra.map(a => a.id)])
    const miss = [...new Set(cast.map(c => c.assetId))].filter(id => !have.has(id) && !fetched.current.has(id))
    if (!miss.length) return
    miss.forEach(id => fetched.current.add(id))
    void Promise.all(miss.map(id => assetsApi.get(id).catch(() => null)))
      .then(got => { const ok = got.filter(Boolean) as Asset[]
                     if (ok.length) setExtra(prev => [...prev, ...ok]) })
  }, [cast, assets, extra])
  // 保存は updateClip がサーバ往復を待つため、propの board は1往復ぶん遅れる。
  // 連続で編集すると古い値を読んで直前の変更が消えるので、開いている間はローカルの下書きが正。
  const [draft, setDraft] = useState<Storyboard>({ ...EMPTY_BOARD, ...board })
  const b = draft
  const flushRef = useRef<{ timer: number | null; pending: Storyboard | null }>({ timer: null, pending: null })
  const flush = () => {
    const f = flushRef.current
    if (f.timer != null) { clearTimeout(f.timer); f.timer = null }
    if (f.pending) { onChange(f.pending); f.pending = null }
  }
  useEffect(() => flush, [])            // 閉じる/アンマウント時に取りこぼさない
  const assetById = useMemo(() => new Map([...assets, ...extra].map(a => [a.id, a])), [assets, extra])
  const kindOf = (id: number): 'image' | 'video' | 'audio' => {
    const a = assetById.get(id)
    if (!a) return 'image'
    if (a.asset_type === 'audio') return 'audio'
    if (a.asset_type === 'image') return 'image'
    return a.duration_sec == null ? 'image' : 'video'
  }
  const { counts, errors } = boardLimits(b, kindOf)

  const set = (patch: Partial<Storyboard>) => {
    const next = { ...b, ...patch }
    setDraft(next)                                    // 表示とロジックは即時に新しい値を見る
    const f = flushRef.current
    f.pending = next
    if (f.timer != null) clearTimeout(f.timer)
    f.timer = window.setTimeout(() => { f.timer = null; flush() }, 400)
  }

  /** 本文へトークンを差し込んだ結果の文字列を返す(状態は書き換えない) */
  const withToken = (token: string) => {
    const ta = taRef.current
    // 本文を一度も触っていないと selectionStart は0。先頭に刺さると驚くので末尾へ追記する。
    if (!ta || caretRef.current == null) return b.text + token
    const s = ta.selectionStart, e = ta.selectionEnd
    requestAnimationFrame(() => {
      ta.focus()
      ta.selectionStart = ta.selectionEnd = s + token.length
      caretRef.current = s + token.length
    })
    return b.text.slice(0, s) + token + b.text.slice(e)
  }

  /** 配列の並びが変わったら本文の番号も同時に直す(番号=接続順。放置するとプロンプトが静かに壊れる) */
  const setAssets = (next: typeof b.assets) =>
    set({ assets: next, text: renumberTokens(b.text, 'アセット', indexMap(b.assets, next, x => x.assetId)) })
  const setPins = (next: typeof b.pins) =>
    set({ pins: next, text: renumberTokens(b.text, 'ピン', indexMap(b.pins, next, x => x.id)) })
  const moveAsset = (i: number, d: -1 | 1) => {
    const j = i + d
    if (j < 0 || j >= b.assets.length) return
    const next = [...b.assets]
    ;[next[i], next[j]] = [next[j], next[i]]
    setAssets(next)
  }

  const addPin = () => {
    const f = Math.min(sceneRange.e, Math.max(sceneRange.s, currentFrame))
    const np = { id: Math.random().toString(36).slice(2, 8), frame: f, isCut: false }
    const pins = [...b.pins, np].sort((x, y) => x.frame - y.frame)
    const idx = pins.findIndex(p => p.id === np.id) + 1
    // 途中に挿すと後続の番号がずれる。目印を先に置いてから既存トークンを振り直し、最後に目印を実番号へ。
    const SENT = '\u0000'
    const text = renumberTokens(withToken(SENT), 'ピン', indexMap(b.pins, pins, x => x.id))
      .replace(SENT, `[ピン${idx}]`)
    set({ pins, text })   // 配列と本文は同時に反映する
  }
  const roleFor = (id: number): BoardAssetRole =>
    kindOf(id) === 'video' ? 'edit_src' : kindOf(id) === 'audio' ? 'audio' : 'design'

  /** 行の素材を別の素材に差し替える。並び順は変わらないので本文の[アセットN]はそのまま使える。 */
  const replaceAsset = (i: number, id: number) => {
    if (b.assets.some((x, j) => j !== i && x.assetId === id)) return   // 同じ素材が2行に並ぶのは無意味
    const cur = b.assets[i]
    const roleOk = kindOf(cur.assetId) === kindOf(id)
    set({ assets: b.assets.map((x, j) => j === i ? { ...x, assetId: id, role: roleOk ? x.role : roleFor(id) } : x) })
  }

  const addAsset = (id: number) => {
    if (b.assets.some(a => a.assetId === id)) return
    const next = [...b.assets, { assetId: id, role: roleFor(id),
                                 retention: 'attribute_transfer' as BoardRetention }]
    set({ assets: next, text: withToken(`[アセット${next.length}]`) })
  }

  const closeAll = () => { flush(); onClose() }
  const dur = sceneRange.e - sceneRange.s + 1
  return createPortal(
    <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/70 p-3"
         onClick={closeAll}>
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-[760px] max-w-full
                      max-h-[92dvh] overflow-y-auto p-4 flex flex-col gap-3"
           onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-white">
            📋 絵コンテ — {sceneName || '(無名シーン)'}
            <span className="text-zinc-500 font-normal ml-2">
              f{sceneRange.s}〜{sceneRange.e}（{(dur / fps).toFixed(1)}秒）
            </span>
          </h2>
          <button onClick={closeAll} className="text-zinc-400 hover:text-zinc-100 text-lg px-2">✕</button>
        </div>

        {/* モード */}
        <div className="flex items-center gap-2 text-xs">
          <span className="text-[10px] text-zinc-500">生成方式</span>
          {(['ref2va', 'fl2va'] as const).map(m => (
            <button key={m} onClick={() => set({ mode: m })}
                    className={`px-2 py-1 rounded border ${b.mode === m
                      ? 'bg-purple-800 border-purple-500 text-purple-100'
                      : 'bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700'}`}>
              {m === 'ref2va' ? 'Ref2VA（参照多数・6セクション）' : 'FL2VA（前後フレーム・3セクション）'}
            </button>
          ))}
          <span className="ml-auto text-[10px] text-zinc-500">
            画像{counts.image} / 動画{counts.video} / 音声{counts.audio}
          </span>
        </div>
        {errors.length > 0 && (
          <div className="text-[10px] text-red-300 bg-red-950/40 border border-red-800 rounded px-2 py-1.5">
            {errors.map((e, i) => <div key={i}>⚠ {e}</div>)}
          </div>
        )}

        {/* 本文 */}
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] text-zinc-500">本文（日本語で自由に。タグは下のボタンで挿入）</span>
            <button onClick={addPin}
                    className="ml-auto text-[10px] px-2 py-0.5 rounded bg-sky-800 hover:bg-sky-700 text-sky-100">
              ＋ピンを打つ（再生ヘッド f{currentFrame}）
            </button>
            <button onClick={() => { setReplaceIdx(null); setPicking(v => !v) }}
                    className="text-[10px] px-2 py-0.5 rounded bg-emerald-800 hover:bg-emerald-700 text-emerald-100">
              ＋アセット
            </button>
          </div>
          <textarea ref={taRef} value={b.text} onChange={e => set({ text: e.target.value })}
                    onSelect={e => { caretRef.current = e.currentTarget.selectionStart }}
                    rows={7}
                    placeholder="例) [ピン1]の時点で[アセット1]を参考にダークオーブが回転しながら、[アセット2]の糸が絡みつく。[ピン2]でまどかが触れ、[ピン3]で消滅する。"
                    className="w-full bg-zinc-950 border border-zinc-700 rounded p-2 text-xs text-zinc-100
                               font-mono leading-relaxed resize-y" />
        </div>

        {/* アセット選択 — 取得元を絞れる(素材は増え続けるので全件から探させない) */}
        {picking && (() => {
          const castIds = new Set(cast.map(c => c.assetId))
          const seenId = new Set(assets.map(a => a.id))
          const base = [...assets, ...extra.filter(a => !seenId.has(a.id))]
            .filter(a => a.asset_type !== 'audio' || b.mode === 'ref2va')
          const pool0 = src === 'star' ? base.filter(a => a.starred)
                      : src === 'cast' ? base.filter(a => castIds.has(a.id))
                      : base
          const s = q.trim().toLowerCase()
          const pool = pool0.filter(a => {
            if (!s) return true
            if (s.startsWith('#')) return String(a.id) === s.slice(1)
            const nm = castIds.has(a.id)
              ? cast.filter(c => c.assetId === a.id).map(c => `${c.name}${c.outfit}${c.label}`).join(' ')
              : ''
            return a.name.toLowerCase().includes(s) || String(a.id).includes(s) || nm.toLowerCase().includes(s)
          }).sort((x, y) => y.id - x.id)
          const nStar = base.filter(a => a.starred).length
          const nCast = base.filter(a => castIds.has(a.id)).length
          return (
            <div className="border border-emerald-800 rounded p-2 bg-zinc-950 flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5">
                {replaceIdx != null && (
                  <span className="text-[10px] text-amber-300 mr-1">[アセット{replaceIdx + 1}]を差し替え</span>
                )}
                {([['star', `⭐ お気に入り (${nStar})`], ['cast', `📖 キャスト名簿 (${nCast})`],
                   ['all', `すべて (${base.length})`]] as const).map(([v, label]) => (
                  <button key={v} onClick={() => setSrc(v)}
                          className={`text-[10px] px-2 py-1 rounded border ${src === v
                            ? 'bg-emerald-800 border-emerald-500 text-emerald-100'
                            : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:bg-zinc-700'}`}>
                    {label}
                  </button>
                ))}
                <button onClick={() => { setPicking(false); setReplaceIdx(null); setQ('') }}
                        className="ml-auto text-[10px] px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300">
                  閉じる
                </button>
              </div>
              <input value={q} onChange={e => setQ(e.target.value)} autoFocus
                     placeholder={src === 'cast' ? 'キャラ名 / 衣装 / 名前 / #ID で絞り込み' : '名前 または #ID で絞り込み'}
                     className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-100" />
              {pool.length === 0 && (
                <span className="text-[10px] text-zinc-500 py-2">
                  {src === 'star' ? '⭐が付いた素材がありません(アセットパネルの★で付けられます)'
                   : src === 'cast' ? 'キャスト名簿に参照画像が登録されていません'
                   : '該当なし'}
                </span>
              )}
              <div className="grid grid-cols-6 gap-1.5 max-h-52 overflow-y-auto">
                {pool.slice(0, 180).map(a => {
                  const c = cast.find(x => x.assetId === a.id)
                  return (
                    <button key={a.id}
                            onClick={() => { if (replaceIdx != null) replaceAsset(replaceIdx, a.id)
                                             else addAsset(a.id)
                                             setPicking(false); setReplaceIdx(null); setQ('') }}
                            className="border border-zinc-700 rounded overflow-hidden hover:border-emerald-400"
                            title={`${a.name}\n#${a.id}${c ? `\n${c.name} / ${c.outfit} ${c.label}` : ''}`}>
                      {a.asset_type === 'audio'
                        ? <div className="h-12 flex items-center justify-center text-[9px] text-zinc-400">♪</div>
                        : <img src={assetsApi.thumbnailUrl(a.id)} alt="" loading="lazy"
                               className="w-full h-12 object-cover" />}
                      <div className="text-[8px] text-zinc-500 truncate px-1">
                        {c ? (c.outfit || c.name) : `#${a.id}`}
                      </div>
                    </button>
                  )
                })}
              </div>
              {pool.length > 180 && (
                <span className="text-[9px] text-zinc-600">
                  {pool.length}件中180件を表示中 — 絞り込みで探してください
                </span>
              )}
            </div>
          )
        })()}

        {/* 参照アセット一覧 */}
        {b.assets.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-zinc-500">参照アセット（順序が意味を持ちます。上から Picture1, 2…）</span>
            {b.assets.map((ba, i) => {
              const a = assetById.get(ba.assetId)
              return (
                <div key={ba.assetId} className="flex items-center gap-2 bg-zinc-950 border border-zinc-800
                                                 rounded px-2 py-1.5 text-[10px]">
                  <div className="flex flex-col">
                    {([[-1, '▲'], [1, '▼']] as const).map(([d, ch]) => (
                      <button key={d} onClick={() => moveAsset(i, d)}
                              disabled={d < 0 ? i === 0 : i === b.assets.length - 1}
                              title={`${d < 0 ? '前' : '後ろ'}へ（Picture番号が入れ替わり、本文の[アセットN]も追従します）`}
                              className="text-[8px] leading-none px-1 py-[1px] rounded text-zinc-400
                                         hover:bg-emerald-900 hover:text-emerald-200 disabled:opacity-20
                                         disabled:hover:bg-transparent">{ch}</button>
                    ))}
                  </div>
                  <span className="text-emerald-300 font-mono w-16">[アセット{i + 1}]</span>
                  <button onClick={() => { setReplaceIdx(i); setPicking(true); setQ('') }}
                          title={`クリックで別の素材に差し替え（[アセット${i + 1}] の番号と本文はそのまま）\n${a?.name ?? ''}`}
                          className="flex items-center gap-2 flex-1 min-w-0 rounded px-1 py-0.5
                                     hover:bg-zinc-800 text-left">
                    {a && a.asset_type !== 'audio' && (
                      <img src={assetsApi.thumbnailUrl(a.id)} alt="" className="w-10 h-6 object-cover rounded" />
                    )}
                    <span className="text-zinc-400 truncate flex-1">{a?.name ?? `#${ba.assetId}`}</span>
                    <span className="text-zinc-600 text-[9px]">⇄</span>
                  </button>
                  <select value={ba.role} className="bg-zinc-800 border border-zinc-700 rounded px-1 py-0.5"
                          onChange={e => set({ assets: b.assets.map((x, j) =>
                            j === i ? { ...x, role: e.target.value as BoardAssetRole } : x) })}>
                    {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                  <select value={ba.retention} className="bg-zinc-800 border border-zinc-700 rounded px-1 py-0.5"
                          onChange={e => set({ assets: b.assets.map((x, j) =>
                            j === i ? { ...x, retention: e.target.value as BoardRetention } : x) })}>
                    {Object.entries(RETENTION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                  <button onClick={() => set({ text: withToken(`[アセット${i + 1}]`) })}
                          title={`本文のカーソル位置へ [アセット${i + 1}] を挿入（同じ素材を何度でも参照できます）`}
                          className="px-1.5 py-0.5 rounded bg-emerald-900 hover:bg-emerald-700
                                     text-emerald-100 font-mono">⏎</button>
                  <button onClick={() => setAssets(b.assets.filter((_, j) => j !== i))}
                          className="px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-red-900">🗑</button>
                </div>
              )
            })}
          </div>
        )}

        {/* ピン一覧 */}
        {b.pins.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-zinc-500">
              演出ピン（秒数の足がかり。「カット境界」にすると [Shot N] の切り替え時刻になります）
            </span>
            {b.pins.map((p, i) => (
              <div key={p.id} className="flex items-center gap-2 bg-zinc-950 border border-zinc-800
                                         rounded px-2 py-1.5 text-[10px]">
                <span className="text-sky-300 font-mono w-12">[ピン{i + 1}]</span>
                <button onClick={() => setCurrentFrame(p.frame)}
                        className="px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700" title="この位置へシーク">👁</button>
                <span className="font-mono text-zinc-400">f{p.frame}</span>
                <span className="font-mono text-zinc-600">
                  シーン内 {fmtTC(p.frame - sceneRange.s, fps)}
                </span>
                {[-1, +1].map(d => (
                  <button key={d} onClick={() => setPins(b.pins.map((x, j) =>
                            j === i ? { ...x, frame: Math.min(sceneRange.e, Math.max(sceneRange.s, x.frame + d)) } : x)
                            .sort((a2, b2) => a2.frame - b2.frame))}
                          className="px-1 py-0.5 rounded bg-zinc-800 hover:bg-sky-900 font-mono">
                    {d > 0 ? '+1' : '−1'}
                  </button>
                ))}
                <input value={p.label ?? ''} placeholder="ラベル(触れる/消滅…)"
                       className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-1.5 py-0.5 text-zinc-200"
                       onChange={e => set({ pins: b.pins.map((x, j) =>
                         j === i ? { ...x, label: e.target.value } : x) })} />
                <label className="flex items-center gap-1 text-zinc-400">
                  <input type="checkbox" checked={p.isCut} className="accent-amber-500"
                         onChange={e => set({ pins: b.pins.map((x, j) =>
                           j === i ? { ...x, isCut: e.target.checked } : x) })} />
                  カット境界
                </label>
                <button onClick={() => setPins(b.pins.filter((_, j) => j !== i))}
                        className="px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-red-900">🗑</button>
              </div>
            ))}
          </div>
        )}

        {/* 音 */}
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-zinc-500">
            環境音・効果音
            <input value={b.soundscape} onChange={e => set({ soundscape: e.target.value })}
                   placeholder="例) 低い部屋鳴り、糸が張る音"
                   className="w-full mt-1 bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100" />
          </label>
          <label className="text-[10px] text-zinc-500">
            劇伴（無しなら空欄）
            <input value={b.music} onChange={e => set({ music: e.target.value })}
                   placeholder="例) 無し / 静かなピアノ"
                   className="w-full mt-1 bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100" />
          </label>
        </div>

        {/* 音声同調 + 歌詞 — H3の <Audio 1> 参照(区間切り出し)とプロンプト文脈に使う */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div className="text-[10px] text-zinc-500">
            音声同調（カット区間を切り出して参照に渡す）
            <div className="flex gap-1 mt-1">
              {(Object.entries(AUDIO_SYNC_LABEL) as [BoardAudioSync, string][]).map(([v, label]) => (
                <button key={v} onClick={() => set({ audioSync: v })}
                        className={`text-[10px] px-2 py-1 rounded border ${(b.audioSync ?? 'none') === v
                          ? 'bg-violet-800 border-violet-500 text-violet-100'
                          : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:bg-zinc-700'}`}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <label className="text-[10px] text-zinc-500">
            歌詞（このシーンに乗る部分。口パクさせるかは本文で指定）
            <input value={b.lyrics ?? ''} onChange={e => set({ lyrics: e.target.value })}
                   placeholder="例) 絶望から罪が生まれた"
                   className="w-full mt-1 bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100" />
          </label>
        </div>

        {/* Claudeが起こしたプロンプト */}
        {b.promptDraft && (
          <details className="border border-zinc-800 rounded bg-zinc-950">
            <summary className="text-[10px] text-zinc-400 px-2 py-1.5 cursor-pointer">
              Claudeが起こしたプロンプト（{b.promptUpdated?.slice(0, 16).replace('T', ' ')}）
            </summary>
            <pre className="text-[9px] text-zinc-400 p-2 whitespace-pre-wrap max-h-52 overflow-y-auto">
              {b.promptDraft}
            </pre>
          </details>
        )}

        <p className="text-[9px] text-zinc-600">
          原文はそのまま保存されます。Claudeがこれを読んでH3のプロンプト（{b.mode === 'ref2va' ? '6' : '3'}セクション）へ起こし、
          結果をここに書き戻します。解釈がずれていたら原文を直してください。
        </p>
      </div>
    </div>,
    document.body,
  )
}
