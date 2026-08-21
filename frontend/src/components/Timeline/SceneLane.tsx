import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Asset, Clip, Track } from '../../api/client'
import { assetsApi } from '../../api/client'
import { useTimelineStore } from '../../store/timelineStore'
import { CastPanel } from '../CastPanel'
import { StoryboardPopover } from './StoryboardPopover'
import { EMPTY_BOARD, type Storyboard } from './storyboard'

/**
 * 🏞 シーンレーン — カット割りの上位レイヤー。「同じ場所/空間」を共有するカット群を
 * シーンとしてグループ化し、ロケーションプレート(環境参照画像)を紐づける。
 *
 * データはカット開始ピン(Imageトラックのクリップ)の attrs_json に持つ:
 *   { "scene": { "id": "ruins", "name": "水没廃墟", "color": "#8b5", "plates": [1276] } }
 * バックエンド変更なしでサーバ永続化でき、ピンの移動(=カットの編集)に自動で追従する。
 * 同一シーンの情報は所属ピン全てに複製され、編集時は全ピンへ書き戻す。
 *
 * プレートの使い途: H3 Ref2V再生成時に参照束へ自動添付され、公式ガイドの
 * 「環境を<Subject N>として定義しfully_preservedで保持する」パターン(C6→C7で実証)を
 * カット単位の手作業なしで適用できる。
 */

export interface SceneInfo {
  id: string
  name: string          // 空可 — 「同じシーン」の紐付けだけ先に行い、定義は後から対話で埋める
  color: string
  plates: number[]      // ロケーションプレート(環境参照画像のアセットID)
  notes?: string        // シーンの意図・参照動画・空間設定などの議論メモ(Claudeが読み書きする)
  board?: Storyboard    // 📋 絵コンテ(本文/参照アセット/演出ピン)。Claudeがプロンプトへ起こす
}

export const sceneOfPin = (pin: Clip | undefined): SceneInfo | null => {
  if (!pin?.attrs_json) return null
  try { return (JSON.parse(pin.attrs_json).scene as SceneInfo) ?? null } catch { return null }
}

/** 🎯 カット意図 — ユーザーが「このカットで達成したいこと」を自分の言葉で書く欄。
 *  Claudeがプロンプト設計時に読む一次情報。ピンのattrs_json.intentに保存。 */
export const intentOfPin = (pin: Clip | undefined): string => {
  if (!pin?.attrs_json) return ''
  try { return String(JSON.parse(pin.attrs_json).intent ?? '') } catch { return '' }
}

/** 🎬 参照カットの解釈 — Claudeが参照動画を読み取った結果。ユーザーが訂正できるよう分離して持つ。
 *  intent(ユーザーの意図)とは別欄にする: 混ぜると「誰の言葉か」が分からなくなり訂正もできない。 */
export const readingOfPin = (pin: Clip | undefined): string => {
  if (!pin?.attrs_json) return ''
  try { return String(JSON.parse(pin.attrs_json).ref_reading ?? '') } catch { return '' }
}

/** 🖼 構図アンカー — カットのピンに差し込まれた「そのカットの完成イメージ」。
 *  参照動画から自動抽出したピン画像(frame_<id>_<ms>.png)は基準にならないので除外し、
 *  ユーザーが持ち込んだ画像だけを拾う。Ref2V生成時に<Picture N>として参照束へ渡し、
 *  構図・ルックの基準にする(C33/C35で実証した「シーン再現画1枚+参照動画で動かす」方式)。 */
const AUTO_PIN = /^frame_\d+_\d+ms/
export const anchorOfCut = (pins: Clip[], assets: Asset[]): number | null => {
  const byId = new Map(assets.map(a => [a.id, a]))
  for (const pin of pins) {
    const a = pin.asset_id != null ? byId.get(pin.asset_id) : undefined
    if (a && !AUTO_PIN.test(a.name)) return a.id
  }
  return null
}

/** カット一覧(開始ピンとシーン付き)を導出。CutLaneと同じ2個ペアリング規則。 */
export const deriveCutsWithScene = (tracks: Track[], clips: Clip[], assets: Asset[] = []) => {
  const img = tracks.find(t => t.track_type === 'reference' && t.name === 'Image' && !t.hidden)
  if (!img) return []
  const pins = clips.filter(c => c.track_id === img.id && c.asset_id != null)
    .sort((a, b) => a.start_frame - b.start_frame)
  const out: { idx: number; s: number; e: number; pin: Clip; scene: SceneInfo | null
               intent: string; reading: string; anchor: number | null }[] = []
  for (let i = 0; i + 1 < pins.length; i += 2) {
    out.push({ idx: i / 2 + 1, s: pins[i].start_frame, e: pins[i + 1].start_frame,
               pin: pins[i], scene: sceneOfPin(pins[i]), intent: intentOfPin(pins[i]),
               reading: readingOfPin(pins[i]),
               anchor: anchorOfCut([pins[i], pins[i + 1]], assets) })
  }
  return out
}

const PALETTE = ['#6d9e6b', '#7a86c2', '#b58a5f', '#a06b9e', '#5f9ea0', '#b5a05f', '#9e6b6b', '#6b8a9e']
const slug = () => Math.random().toString(36).slice(2, 8)

interface Props {
  tracks: Track[]
  clips: Clip[]
  assets: Asset[]
  pixelsPerFrame: number
  totalWidth: number
}

export function SceneLane({ tracks, clips, assets, pixelsPerFrame, totalWidth }: Props) {
  const updateClip = useTimelineStore(s => s.updateClip)
  const projectFps = useTimelineStore(s => s.projectFps)
  const currentFrame = useTimelineStore(s => s.currentFrame)
  const [editCut, setEditCut] = useState<number | null>(null)   // 編集中カットのstart frame
  const [nameDraft, setNameDraft] = useState('')
  const [msg, setMsg] = useState('')
  const [castOpen, setCastOpen] = useState(false)

  const cuts = useMemo(() => deriveCutsWithScene(tracks, clips, assets), [tracks, clips, assets])
  // ツールバー等レーン外からも開けるようにする(スマホはレーン内のボタンが小さすぎて押せない)
  const cutsRef = useRef(cuts); cutsRef.current = cuts
  const frameRef = useRef(0); frameRef.current = currentFrame
  useEffect(() => {
    const onOpen = () => {
      const cs = cutsRef.current
      const here = cs.find(c => c.s <= frameRef.current && frameRef.current <= c.e) ?? cs.find(c => c.scene)
      if (here?.scene) setBoardScene(here.scene.id)
      else setMsg('再生ヘッドの位置にシーンがありません')
    }
    window.addEventListener('kychapogas:open-board', onOpen)
    return () => window.removeEventListener('kychapogas:open-board', onOpen)
  }, [])
  const [boardScene, setBoardScene] = useState<string | null>(null)
  const boardPress = useRef<number | null>(null)        // タッチ長押しのタイマー
  const boardLongPressed = useRef(false)               // 長押し成立フラグ(直後のclickを捨てる)   // 📋 絵コンテを開くシーンID

  const scenes = useMemo(() => {
    const m = new Map<string, SceneInfo>()
    for (const c of cuts) if (c.scene) m.set(c.scene.id, c.scene)
    return [...m.values()]
  }, [cuts])
  // 未命名シーンの表示用通し番号(タイムライン上の登場順)
  const sceneSeq = useMemo(() => {
    const m = new Map<string, number>()
    for (const c of cuts) if (c.scene && !m.has(c.scene.id)) m.set(c.scene.id, m.size + 1)
    return m
  }, [cuts])

  const writeScene = async (cutStarts: number[], scene: SceneInfo | null) => {
    for (const c of cuts.filter(x => cutStarts.includes(x.s))) {
      let attrs: Record<string, unknown> = {}
      try { attrs = c.pin.attrs_json ? JSON.parse(c.pin.attrs_json) : {} } catch { /* 壊れは捨てる */ }
      if (scene) attrs.scene = scene
      else delete attrs.scene
      await updateClip(c.pin.id, { attrs_json: Object.keys(attrs).length ? JSON.stringify(attrs) : '' })
    }
  }

  const writeField = async (cut: { pin: Clip }, key: 'intent' | 'ref_reading', val: string) => {
    let attrs: Record<string, unknown> = {}
    try { attrs = cut.pin.attrs_json ? JSON.parse(cut.pin.attrs_json) : {} } catch { /* 壊れは捨てる */ }
    if (val) attrs[key] = val
    else delete attrs[key]
    await updateClip(cut.pin.id, { attrs_json: Object.keys(attrs).length ? JSON.stringify(attrs) : '' })
  }

  /** シーン情報の変更を所属全ピンへ反映 */
  const updateSceneEverywhere = async (updated: SceneInfo) => {
    const members = cuts.filter(c => c.scene?.id === updated.id).map(c => c.s)
    await writeScene(members, updated)
  }

  const editing = editCut != null ? cuts.find(c => c.s === editCut) : undefined
  const projectId = tracks[0]?.project_id

  if (cuts.length === 0) return null
  return (
    <div className="flex flex-shrink-0 border-b border-zinc-800/70" style={{ height: 20 }}>
      {/* 左ヘッダ列 — 他レーン(CutLane等)と同じ w-28 + sticky で桁を揃える */}
      <div className="w-28 flex-shrink-0 border-r border-zinc-800 bg-zinc-950 flex items-center gap-1 px-2 sticky left-0 z-30">
        <span className="text-[9px] text-zinc-500">🏞 {scenes.length}</span>
        {/* スマホ用の確実な入口: 再生ヘッド位置のシーンの絵コンテを開く
            (シーンブロックは高さ14pxで指では狙いにくい) */}
        <button onClick={() => {
                  const here = cuts.find(c => c.s <= currentFrame && currentFrame <= c.e) ?? cuts.find(c => c.scene)
                  if (here?.scene) setBoardScene(here.scene.id)
                  else setMsg('再生ヘッドの位置にシーンがありません')
                }}
                title="📋 絵コンテ(再生ヘッド位置のシーン) — シーンを右クリック/長押しでも開けます"
                className="ml-auto text-[10px] text-zinc-500 hover:text-zinc-100">📋</button>
        <button onClick={() => setCastOpen(true)} title="📖 キャスト名簿(キャラ定義と参照画像 — 共通/プロジェクト別)"
                className="text-[10px] text-zinc-600 hover:text-zinc-200">📖</button>
      </div>
      <div className="relative flex-shrink-0 bg-zinc-950/60" style={{ width: totalWidth }}>
      {cuts.map(c => {
        const w = Math.max(2, (c.e - c.s + 1) * pixelsPerFrame)
        return (
          <button key={c.s}
                  onClick={() => {
                    // 長押しで絵コンテを開いた直後の click は捨てる(離指で両方開くのを防ぐ)
                    if (boardLongPressed.current) { boardLongPressed.current = false; return }
                    setEditCut(c.s); setNameDraft('')
                  }}
                  onContextMenu={ev => {
                    ev.preventDefault()
                    if (c.scene) setBoardScene(c.scene.id)     // 📋 絵コンテ(右クリック)
                  }}
                  onPointerDown={ev => {
                    // スマホには右クリックが無いので長押しでも開く(CutLaneのプレビズと同じ方式)
                    if (ev.pointerType !== 'touch' || !c.scene) return
                    const sid = c.scene.id
                    const x0 = ev.clientX, y0 = ev.clientY
                    boardPress.current = window.setTimeout(() => {
                      boardLongPressed.current = true
                      setBoardScene(sid)
                    }, 500)
                    const cancel = (mv: PointerEvent) => {
                      if (mv.type === 'pointermove' && Math.hypot(mv.clientX - x0, mv.clientY - y0) < 8) return
                      if (boardPress.current) { clearTimeout(boardPress.current); boardPress.current = null }
                      window.removeEventListener('pointermove', cancel)
                      window.removeEventListener('pointerup', cancel)
                    }
                    window.addEventListener('pointermove', cancel)
                    window.addEventListener('pointerup', cancel)
                  }}
                  title={`C${c.idx}` + (c.scene ? ` / シーン: ${c.scene.name || '未定義'}(プレート${c.scene.plates.length})` : ' / シーン未設定')
                         + (c.intent ? `\n🎯 ${c.intent}` : '\n🎯 意図メモなし — クリックで記入')
                         + (c.reading ? `\n🎬 ${c.reading}` : '\n🎬 参照カットの解釈まだ')}
                  className="absolute top-[3px] h-[14px] rounded-sm border overflow-hidden text-left"
                  style={{
                    left: c.s * pixelsPerFrame, width: w,
                    background: c.scene ? c.scene.color + 'cc' : 'transparent',
                    borderColor: c.scene ? c.scene.color : '#3f3f46',
                  }}>
            {c.intent && (
              <span className="absolute bottom-0 left-0.5 w-1 h-1 rounded-full bg-amber-300/90" title="意図メモあり" />
            )}
            {c.reading && (
              <span className="absolute bottom-0 left-2 w-1 h-1 rounded-full bg-sky-300/90" title="参照カットの解釈あり" />
            )}
            {c.anchor && (
              <span className="absolute bottom-0 left-[14px] w-1 h-1 rounded-full bg-emerald-300/90"
                    title="構図アンカーあり(差し込んだ完成イメージを生成の基準に使います)" />
            )}
            {c.scene && w > 30 && (
              <span className="text-[8px] text-white/90 px-1 whitespace-nowrap">
                {c.scene.name || `シーン${sceneSeq.get(c.scene.id) ?? '?'}`}{c.scene.plates.length > 0 && ' 🏞'}
              </span>
            )}
          </button>
        )
      })}

      {castOpen && projectId != null && <CastPanel projectId={projectId} onClose={() => setCastOpen(false)} />}

      {/* 📋 絵コンテ — シーンを右クリックで開く。保存はシーン情報(scene.board)へ */}
      {boardScene && (() => {
        const sc = scenes.find(x => x.id === boardScene)
        if (!sc) return null
        const mine = cuts.filter(c => c.scene?.id === boardScene)
        if (!mine.length) return null
        const range = { s: Math.min(...mine.map(c => c.s)), e: Math.max(...mine.map(c => c.e)) }
        return (
          <StoryboardPopover
            projectId={projectId ?? undefined}
            sceneName={sc.name || `シーン${sceneSeq.get(sc.id) ?? '?'}`}
            sceneRange={range}
            board={sc.board ?? EMPTY_BOARD}
            assets={assets}
            fps={projectFps}
            onChange={bd => void updateSceneEverywhere({ ...sc, board: bd })}
            onClose={() => setBoardScene(null)}
          />
        )
      })()}
      {editing && createPortal(
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60"
             onClick={() => { setEditCut(null); setMsg('') }}>
          <div onClick={e => e.stopPropagation()}
               className="bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl w-[min(420px,92vw)] p-3 flex flex-col gap-2 text-xs text-zinc-300">
            <div className="flex items-center justify-between">
              <b>🏞 C{editing.idx}(f{editing.s}-{editing.e})のシーン</b>
              <button onClick={() => { setEditCut(null); setMsg('') }} className="text-zinc-500 hover:text-zinc-200">✕</button>
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-zinc-500">🎯 このカットの意図(あなたの言葉で — Claudeがプロンプト設計時に読みます)</span>
              <textarea key={editing.s + ':i'} defaultValue={editing.intent}
                        onBlur={e => { const v = e.target.value.trim()
                          if (v !== editing.intent) void writeField(editing, 'intent', v) }}
                        placeholder="例: 赤毛の子のI2V風。撮影処理は参照動画の対角分割を踏襲"
                        className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-200 h-16 resize-y" />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-zinc-500">
                🎬 参照カットの解釈(Claudeが参照動画を読み取った内容 —
                <span className="text-amber-400/80">違っていたら直してください。生成の仕様書になります</span>)
              </span>
              <textarea key={editing.s + ':r'} defaultValue={editing.reading}
                        onBlur={e => { const v = e.target.value.trim()
                          if (v !== editing.reading) void writeField(editing, 'ref_reading', v) }}
                        placeholder="Claudeが未記入。参照動画の構図・カメラ・人物の配置と動きをここに書き出します"
                        className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-200 h-20 resize-y" />
            </div>
            {editing.scene ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded-sm" style={{ background: editing.scene.color }} />
                  <b>{editing.scene.name || `シーン${sceneSeq.get(editing.scene.id) ?? '?'}(未定義)`}</b>
                  <button onClick={() => {
                            const nm = window.prompt('シーン名(空のままでもOK — 後から対話で定義できます)', editing.scene!.name)
                            if (nm != null) void updateSceneEverywhere({ ...editing.scene!, name: nm.trim() })
                          }}
                          className="px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400" title="名前を変更">✏</button>
                  <span className="text-zinc-500">
                    所属 {cuts.filter(x => x.scene?.id === editing.scene!.id).length}カット
                  </span>
                  <button onClick={() => void writeScene([editing.s], null)}
                          className="ml-auto px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400">
                    このカットを外す
                  </button>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-zinc-500">📝 定義メモ(意図・参照動画・空間設定 — Claudeとの議論で更新)</span>
                  <textarea defaultValue={editing.scene.notes ?? ''}
                            onBlur={e => { const v = e.target.value.trim()
                              if (v !== (editing.scene!.notes ?? '')) void updateSceneEverywhere({ ...editing.scene!, notes: v }) }}
                            placeholder="例: C6のT3(job 867)をアンカーにした水没廃墟。逆光+鏡面。参照動画はref_326_10990ms"
                            className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-200 h-14 resize-y" />
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-zinc-500">ロケーションプレート(H3 Ref2V再生成時に参照へ自動添付)</span>
                  <div className="flex gap-1.5 flex-wrap">
                    {editing.scene.plates.map(pid => (
                      <span key={pid} className="relative group">
                        <img src={assetsApi.thumbnailUrl(pid)} alt="" className="w-16 h-9 object-cover rounded border border-zinc-700" />
                        <button onClick={() => void updateSceneEverywhere({ ...editing.scene!, plates: editing.scene!.plates.filter(x => x !== pid) })}
                                className="absolute -top-1 -right-1 hidden group-hover:block bg-red-800 text-white rounded-full w-4 h-4 text-[9px] leading-4">✕</button>
                      </span>
                    ))}
                    <button onClick={() => {
                              const raw = window.prompt('プレートにするアセットID(採用テイクからは🗂で抽出できます)')
                              const pid = Number(raw)
                              if (pid > 0) void updateSceneEverywhere({ ...editing.scene!, plates: [...new Set([...editing.scene!.plates, pid])] })
                            }}
                            className="w-16 h-9 rounded border border-dashed border-zinc-600 text-zinc-500 hover:text-zinc-300">＋</button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {scenes.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <span className="text-zinc-500">既存シーンと同じ場所として紐づける</span>
                    <div className="flex gap-1.5 flex-wrap">
                      {scenes.map(sc => (
                        <button key={sc.id} onClick={() => void writeScene([editing.s], sc)}
                                className="px-2 py-1 rounded border text-white/90"
                                style={{ background: sc.color + 'aa', borderColor: sc.color }}>
                          {sc.name || `シーン${sceneSeq.get(sc.id) ?? '?'}`}
                          {sc.plates.length > 0 && ' 🏞'}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <button onClick={() => {
                          const sc: SceneInfo = { id: slug(), name: '',
                            color: PALETTE[scenes.length % PALETTE.length], plates: [] }
                          void writeScene([editing.s], sc)
                        }}
                        className="px-2 py-1.5 rounded bg-emerald-800 hover:bg-emerald-700 text-emerald-100 text-left">
                  ➕ 新しいシーンとしてグループ化(名前は後でOK)
                </button>
                <div className="flex items-center gap-1.5">
                  <input value={nameDraft} onChange={e => setNameDraft(e.target.value)}
                         placeholder="名前を付けて作る場合はここに(任意)"
                         className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-200" />
                  <button onClick={() => {
                            const name = nameDraft.trim()
                            if (!name) { setMsg('名前なしで作る場合は上のボタンをどうぞ'); return }
                            const sc: SceneInfo = { id: slug(), name,
                              color: PALETTE[scenes.length % PALETTE.length], plates: [] }
                            void writeScene([editing.s], sc)
                          }}
                          className="px-2 py-1 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-200">作成</button>
                </div>
              </div>
            )}
            {msg && <p className="text-amber-400">{msg}</p>}
          </div>
        </div>, document.body)}
      </div>
    </div>
  )
}
