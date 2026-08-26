import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Asset, Clip, Track, UnitPrompt } from '../../api/client'
import { assetsApi, projectsApi } from '../../api/client'
import { useTimelineStore } from '../../store/timelineStore'
import { deriveCutsWithScene } from './SceneLane'

/**
 * 🎞 生成単位レーン — カット割り(C番号)の上位にある「1回の生成でどこまで作るか」を描く。
 *
 * H3は1回の生成で1〜3カットをまとめて作ることがある(尺の下限と、カット間を
 * 途切れさせない意図の両方から)。この境界はこれまで docs のプロンプト名にしか無く、
 * アプリからは「どこまでが一息で作られるのか」が見えなかった。
 *
 * データはカットのピンの attrs_json.unit に持つ(SceneLane と同じ規約):
 *   { "unit": {"id":"U06","mode":"Ref2VA","frames":175,"title":"約束の水面",
 *              "refs":[3236,...],"cuts":[7]} }
 * ピンを動かせば単位も追従する。書き込みは scripts/seed_units.py。
 *
 * 帯をクリックすると、その単位についてFIXした内容(カット意図・歌詞・設計リンク)と
 * 現時点で使用予定の参照素材をまとめて開く。
 */

/** 参照音声の切り出し記録。UIで実際に聴いて区間の正しさを確かめるために持つ */
export interface UnitAudio {
  asset_id: number
  stem: string        // 元音源 / 歌唱 / 伴奏
  src: number         // 切り出し元アセットID
  start_sec: number
  dur_sec: number
  role: string        // vocal / inst / full
}

/** ショット境界。カット割りとは別レイヤー — 大半は実測打点の上に置かれる */
export interface UnitShot {
  i: number
  sec: number       // 単位先頭からの相対秒
  frame: number     // タイムライン絶対フレーム
  src: string       // snare / kick / cymbal / cutN(物語上の切れ目) / —
  dev?: number | null   // 打点との誤差(秒)
  dur?: number      // このショットの長さ(秒)
}

export interface UnitInfo {
  id: string
  mode: string
  frames: number
  title: string
  refs: number[]
  cuts: number[]
  audio?: UnitAudio[]
  shots?: UnitShot[]
  /** UIで手編集した印。true なら seed_units.py がショットを上書きしない */
  shots_edited?: boolean
}

export const unitOfPin = (pin: Clip | undefined): UnitInfo | null => {
  if (!pin?.attrs_json) return null
  try { return (JSON.parse(pin.attrs_json).unit as UnitInfo) ?? null } catch { return null }
}

const attrOf = (pin: Clip | undefined, key: string): string => {
  if (!pin?.attrs_json) return ''
  try { return String(JSON.parse(pin.attrs_json)[key] ?? '') } catch { return '' }
}

/** Ref2VA=参照束から起こす / I2VA=先頭フレームから動かす。色で即座に区別する */
const MODE_COLOR: Record<string, string> = { Ref2VA: '#5f8fa0', I2VA: '#a0825f' }

interface Props {
  projectId: number
  tracks: Track[]
  clips: Clip[]
  assets: Asset[]
  pixelsPerFrame: number
  totalWidth: number
}

export function UnitLane({ projectId, tracks, clips, assets, pixelsPerFrame, totalWidth }: Props) {
  const currentFrame = useTimelineStore(s => s.currentFrame)
  const setCurrentFrame = useTimelineStore(s => s.setCurrentFrame)
  const [open, setOpen] = useState<string | null>(null)
  const [prompt, setPrompt] = useState<UnitPrompt | null>(null)
  const [promptErr, setPromptErr] = useState('')
  const [showRaw, setShowRaw] = useState(false)   // 展開後 / 原文(プレースホルダのまま)

  // 単位を開いたときだけプロンプトを取りに行く(全単位ぶんは数百KBあり常時保持しない)
  useEffect(() => {
    setPrompt(null); setPromptErr('')
    if (!open || !projectId) return
    let live = true
    projectsApi.unitPrompt(projectId, open)
      .then(p => { if (live) setPrompt(p) })
      .catch(() => { if (live) setPromptErr('未生成 — scripts/seed_units.py を実行すると出ます') })
    return () => { live = false }
  }, [open, projectId])

  const cuts = useMemo(() => deriveCutsWithScene(tracks, clips, assets), [tracks, clips, assets])

  /** 単位ごとに、属するカットを畳んで1本の帯にする */
  const units = useMemo(() => {
    const m = new Map<string, {
      u: UnitInfo; s: number; e: number
      members: { n: number; s: number; e: number; intent: string; lyrics: string }[]
    }>()
    for (const c of cuts) {
      const u = unitOfPin(c.pin)
      if (!u) continue
      const member = {
        n: c.idx, s: c.s, e: c.e, intent: c.intent,
        lyrics: attrOf(c.pin, 'lyrics') || (() => {
          try { return String(JSON.parse(c.pin.attrs_json ?? '{}')?.scene?.board?.lyrics ?? '') }
          catch { return '' }
        })(),
      }
      const hit = m.get(u.id)
      if (hit) {
        hit.s = Math.min(hit.s, c.s); hit.e = Math.max(hit.e, c.e); hit.members.push(member)
      } else {
        m.set(u.id, { u, s: c.s, e: c.e, members: [member] })
      }
    }
    return [...m.values()].sort((a, b) => a.s - b.s)
  }, [cuts])

  /** 設計リンク: カット意図の本文に現れる他カット番号(DesignLinkLaneと同じ導出) */
  const linksOf = (members: { n: number; intent: string }[]) => {
    const own = new Set(members.map(x => x.n))
    const out = new Set<number>()
    for (const mem of members)
      for (const mm of mem.intent.matchAll(/C(\d+)/g)) {
        const n = Number(mm[1])
        if (!own.has(n) && n >= 1 && n <= cuts.length) out.add(n)
      }
    return [...out].sort((a, b) => a - b)
  }

  const nowId = units.find(x => currentFrame >= x.s && currentFrame <= x.e)?.u.id ?? null
  const cur = open ? units.find(x => x.u.id === open) : null

  return (
    <div className="flex flex-shrink-0 border-b border-zinc-800 bg-zinc-950/60 select-none"
         style={{ height: 26 }}>
      {/* 左ヘッダ列 — 他レーン(CutLane等)と同じ w-28 + sticky で桁を揃える。
          これが無いと帯が112pxずれてカット割りと切れ目が合わず、左パネルの下へ潜る */}
      <div className="w-28 flex-shrink-0 border-r border-zinc-800 bg-zinc-950 px-2
                      flex flex-col justify-center sticky left-0 z-30">
        <span className="text-[10px] text-sky-300 leading-tight">🎞 生成単位</span>
        <span className="text-[9px] text-zinc-600 leading-tight">
          {nowId ?? `${units.length}単位`}
        </span>
      </div>

      <div className="relative flex-1" style={{ width: totalWidth, minWidth: totalWidth }}>
        {units.map(({ u, s, e, members }) => {
          const left = s * pixelsPerFrame
          const width = Math.max(2, (e - s + 1) * pixelsPerFrame)
          const color = MODE_COLOR[u.mode] ?? '#777'
          const active = u.id === nowId
          return (
            <button
              key={u.id}
              onClick={() => { setCurrentFrame(s); setOpen(u.id) }}
              title={`${u.id} ${u.title} / ${u.mode} / ${u.frames}f / C${u.cuts.join('+C')}`}
              className="absolute top-0.5 bottom-0.5 rounded-sm text-[10px] leading-none
                         text-white/90 truncate px-1 border transition-colors"
              style={{
                left, width, background: active ? color : `${color}bb`,
                borderColor: active ? '#fff8' : '#0004',
                // 複数カットをまたぐ単位は縁を太くして「一息で作る範囲」を強調する
                borderWidth: members.length > 1 ? 2 : 1,
              }}
            >
              {width > 34 ? u.id : ''}
            </button>
          )
        })}
      </div>

      {cur && createPortal(
        <div className="fixed inset-0 z-[70] bg-black/60 flex items-center justify-center p-4"
             onClick={() => setOpen(null)}>
          <div className="bg-neutral-900 border border-neutral-700 rounded-lg max-w-3xl w-full
                          max-h-[85vh] overflow-y-auto p-4 text-sm"
               onClick={ev => ev.stopPropagation()}>
            <div className="flex items-center gap-2 mb-3">
              <span className="px-2 py-0.5 rounded text-white text-xs"
                    style={{ background: MODE_COLOR[cur.u.mode] ?? '#777' }}>{cur.u.id}</span>
              <span className="font-medium">{cur.u.title}</span>
              <span className="text-neutral-400 text-xs">
                {cur.u.mode} / {cur.u.frames}f = {(cur.u.frames / 24).toFixed(2)}秒 /
                C{cur.u.cuts.join('+C')}
                {cur.members.length > 1 && ' — 複数カットを一息で生成'}
              </span>
              <button className="ml-auto text-neutral-400 hover:text-white"
                      onClick={() => setOpen(null)}>✕</button>
            </div>

            <div className="text-xs text-neutral-400 mb-1">FIXした内容</div>
            <div className="space-y-2 mb-4">
              {cur.members.map(mem => (
                <div key={mem.n} className="border border-neutral-800 rounded p-2">
                  <div className="flex items-baseline gap-2 mb-1">
                    <span className="text-neutral-300 text-xs">C{mem.n}</span>
                    {mem.lyrics && <span className="text-neutral-400 text-xs">{mem.lyrics}</span>}
                    <button className="ml-auto text-[10px] text-neutral-500 hover:text-neutral-300"
                            onClick={() => { setCurrentFrame(mem.s); setOpen(null) }}>
                      ここへ移動
                    </button>
                  </div>
                  <div className="whitespace-pre-wrap text-neutral-200 text-xs leading-relaxed">
                    {mem.intent || <span className="text-neutral-600">(意図が未記入)</span>}
                  </div>
                </div>
              ))}
            </div>

            {linksOf(cur.members).length > 0 && (
              <div className="mb-4">
                <div className="text-xs text-neutral-400 mb-1">設計リンク</div>
                <div className="flex flex-wrap gap-1">
                  {linksOf(cur.members).map(n => {
                    const t = cuts.find(c => c.idx === n)
                    return (
                      <button key={n}
                        className="px-1.5 py-0.5 rounded bg-neutral-800 hover:bg-neutral-700
                                   text-[11px] text-neutral-300"
                        onClick={() => { if (t) { setCurrentFrame(t.s); setOpen(null) } }}>
                        C{n}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {/* プロンプト全文 — H3へ実際に渡る文面。名簿の展開結果まで見える */}
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs text-neutral-400">プロンプト</span>
              {prompt && (
                <>
                  <span className="text-[10px] text-neutral-600">{prompt.words}語</span>
                  <button
                    className="text-[10px] px-1.5 py-0.5 rounded bg-neutral-800 hover:bg-neutral-700
                               text-neutral-300"
                    onClick={() => setShowRaw(v => !v)}>
                    {showRaw ? '展開後を見る' : '原文(展開前)を見る'}
                  </button>
                  <button
                    className="text-[10px] px-1.5 py-0.5 rounded bg-neutral-800 hover:bg-neutral-700
                               text-neutral-300"
                    onClick={() => navigator.clipboard?.writeText(
                      showRaw ? prompt.raw : prompt.expanded)}>
                    コピー
                  </button>
                </>
              )}
            </div>
            <div className="mb-4">
              {promptErr
                ? <div className="text-neutral-600 text-xs">{promptErr}</div>
                : !prompt
                  ? <div className="text-neutral-600 text-xs">読み込み中…</div>
                  : prompt.error
                    ? <div className="text-red-400 text-xs">{prompt.error}</div>
                    : (
                      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words
                                      bg-neutral-950 border border-neutral-800 rounded p-2
                                      text-[11px] leading-relaxed text-neutral-300 font-mono">
                        {showRaw ? prompt.raw : prompt.expanded}
                      </pre>
                    )}
              {prompt && !showRaw && (
                <div className="text-[10px] text-neutral-600 mt-1">
                  名簿({'{{'}HOMU_ID{'}}'}等)を展開した後の文面 = H3へそのまま渡ります
                </div>
              )}
            </div>

            {/* 参照音源 — H3が実際に「聴く」音。切り出し区間が合っているかを耳で確かめる */}
            <div className="text-xs text-neutral-400 mb-1">参照音源</div>
            {!cur.u.audio?.length
              ? <div className="text-neutral-600 text-xs mb-4">
                  参照音声なし — H3は打点を音として聴かず、本文の秒数だけを読む
                </div>
              : (
                <div className="space-y-2 mb-4">
                  {cur.u.audio.map((a, i) => {
                    const end = a.start_sec + a.dur_sec
                    // 単位の実位置とズレていれば切り出しがずれている
                    const wantSec = cur.s / 24
                    const drift = Math.abs(a.start_sec - wantSec)
                    return (
                      <div key={a.asset_id} className="border border-neutral-800 rounded p-2">
                        <div className="flex items-baseline gap-2 text-xs mb-1">
                          <span className="px-1.5 rounded bg-neutral-800 text-neutral-300">
                            {'<Audio ' + (i + 1) + '>'}
                          </span>
                          <span className="text-neutral-300">{a.stem}ステム #{a.src}</span>
                          <span className="text-neutral-500 font-mono">
                            {a.start_sec.toFixed(3)}s → {end.toFixed(3)}s
                            （{a.dur_sec.toFixed(3)}秒）
                          </span>
                          {drift > 0.05
                            ? <span className="text-red-400">
                                ⚠ 単位の開始 {wantSec.toFixed(3)}s と {drift.toFixed(3)}秒ズレ
                              </span>
                            : <span className="text-emerald-400">✓ 単位の開始と一致</span>}
                        </div>
                        <audio controls preload="none" className="w-full h-8"
                               src={assetsApi.fileUrl(a.asset_id)} />
                      </div>
                    )
                  })}
                </div>
              )}

            <div className="text-xs text-neutral-400 mb-1">
              使用予定の素材 — {cur.u.refs.length}枚
              {cur.u.mode === 'Ref2VA' ? '(最大9枚)' : '(先頭フレーム)'}
            </div>
            {cur.u.refs.length === 0
              ? <div className="text-neutral-600 text-xs">参照なし</div>
              : (
                <div className="flex flex-wrap gap-2">
                  {cur.u.refs.map((id, i) => {
                    const a = assets.find(x => x.id === id)
                    return (
                      <div key={id} className="w-28">
                        <img src={assetsApi.thumbnailUrl(id)} alt={`Picture ${i + 1}`}
                             className="w-28 h-16 object-cover rounded border border-neutral-700
                                        bg-neutral-800" />
                        <div className="text-[10px] text-neutral-500 truncate">
                          {'<Picture ' + (i + 1) + '> #' + id}
                        </div>
                        <div className="text-[10px] text-neutral-600 truncate">
                          {a?.name ?? '(名簿外)'}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
          </div>
        </div>, document.body)}
    </div>
  )
}
