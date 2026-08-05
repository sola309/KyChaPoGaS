import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Asset } from '../../api/client'
import { assetsApi, assetKind } from '../../api/client'
import { RefImagePicker } from '../RefImagePicker'
import { useJobStore } from '../../store/jobStore'
import { useTimelineStore } from '../../store/timelineStore'

// 🎬 選択キーフレーム→i2v — Imageトラック上で2枚以上のRefクリップを選択すると
// ツールバーに現れる。キーフレーム=各クリップの左端(打点)。
// 範囲は自動: 最初の打点→最後の打点。2枚=FLF2V / 3枚以上=VACE。
// 連続ショットは境界の1枚を次ショットの開始として共有する運用。

const VID_PRESETS = [
  { label: '横 1280×720(推奨)', w: 1280, h: 720 },
  { label: '縦 720×1280',       w: 720, h: 1280 },
  { label: '横 832×480(高速)',  w: 832, h: 480 },
  { label: '縦 480×832(高速)',  w: 480, h: 832 },
  { label: '正方 640',          w: 640, h: 640 },
] as const

// H3ネイティブ: 短辺768・上限768×1344・32の倍数
const H3_PRESETS = [
  { label: '横 1344×768(ネイティブ推奨)', w: 1344, h: 768 },
  { label: '縦 768×1344(ネイティブ推奨)', w: 768, h: 1344 },
  { label: '横 1152×640(高速)',           w: 1152, h: 640 },
  { label: '縦 640×1152(高速)',           w: 640, h: 1152 },
  { label: '正方 960',                    w: 960, h: 960 },
] as const

export function I2VSelPopover({ projectId, fps, assets }: { projectId: number; fps: number; assets: Asset[] }) {
  const { generateVideoI2V, jobs } = useJobStore()
  const { refSel, clearRefSel, clips, tracks, addTrack, loadTimeline } = useTimelineStore()
  const [open, setOpen] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [sizeIdx, setSizeIdx] = useState(0)   // 既定=横1280×720
  const [frames, setFrames] = useState(81)    // Wanフレーム数(16fps, 4n+1)
  const [engine, setEngine] = useState<'wan' | 'h3' | 'h3ref'>('wan')
  const [h3Steps, setH3Steps] = useState(15)
  const [h3EasyCache, setH3EasyCache] = useState(true)
  // Ref2V詳細オプション
  const [refAudioId, setRefAudioId] = useState<number | ''>('')     // 参照音声(歌唱リップシンク)
  const [refAudioSeg, setRefAudioSeg] = useState(true)              // 範囲セグメントを切り出して使用
  const [refImgIds, setRefImgIds] = useState<number[]>([])          // 参照画像(≤9, サムネ選択)
  const [refImgSize, setRefImgSize] = useState<'match' | 'max'>('match')
  const [refScheduler, setRefScheduler] = useState<'beta' | 'normal' | 'simple'>('beta')
  const snapH3 = (n: number) => { const m = Math.max(124, Math.min(362, n)); return Math.min(362, m + (5 - (m % 17)) % 17) }   // 訓練域124-362
  const [msg, setMsg] = useState('')
  const snap4n1 = (n: number) => Math.max(5, Math.round((n - 1) / 4) * 4 + 1)
  const watched = useRef<Set<number>>(new Set())

  const [batchPerCut, setBatchPerCut] = useState(true)
  // 選択ピンから「完全なカットペア」を導出(カット一括生成用)。
  // Imageトラック全ピンのペアリングのうち、開始/終了ピン両方が選択されているもの。
  const selectedCuts = useMemo(() => {
    const imgTrack = tracks.find(t => t.track_type === 'reference' && t.name === 'Image' && !t.hidden)
    if (!imgTrack) return []
    const pins = clips
      .filter(c => c.track_id === imgTrack.id && c.asset_id != null)
      .sort((a, b) => a.start_frame - b.start_frame)
    const sel = new Set(refSel)
    const cuts: { s: number; e: number }[] = []
    for (let i = 0; i + 1 < pins.length; i += 2) {
      if (sel.has(pins[i].id) && sel.has(pins[i + 1].id)) {
        cuts.push({ s: pins[i].start_frame, e: pins[i + 1].start_frame })
      }
    }
    return cuts
  }, [tracks, clips, refSel])

  // 選択クリップ→打点順(start_frame昇順)。同一フレームは後勝ちで重複排除。
  const kfs = useMemo(() => {
    const sel = refSel
      .map(id => clips.find(c => c.id === id))
      .filter((c): c is NonNullable<typeof c> => !!c && c.asset_id != null)
      .sort((a, b) => a.start_frame - b.start_frame)
    const seen = new Set<number>()
    return sel.filter(c => (seen.has(c.start_frame) ? false : (seen.add(c.start_frame), true)))
  }, [refSel, clips])

  useEffect(() => {
    for (const j of jobs) {
      if (!watched.current.has(j.id)) continue
      if (j.status === 'completed' || j.status === 'failed') {
        watched.current.delete(j.id)
        if (j.status === 'completed') {
          loadTimeline(projectId, fps)
          setMsg('✅ 完了 — Shotsトラックに配置しました')
        } else setMsg('❌ 失敗(ジョブログ参照)')
      }
    }
  }, [jobs, projectId, fps, loadTimeline])

  const first = kfs[0], last = kfs[kfs.length - 1]
  const spanSec = kfs.length >= 2 ? (last.start_frame - first.start_frame) / fps : 0
  useEffect(() => {
    if (kfs.length >= 2) setFrames(snap4n1(Math.round(spanSec * 16)))
  }, [kfs.length, first?.start_frame, last?.start_frame])

  if (kfs.length < 2) return null

  const useH3 = engine === 'h3' || engine === 'h3ref'
  const genFps = useH3 ? 24 : 16
  const snapFn = useH3 ? snapH3 : snap4n1
  const durSec = snapFn(frames) / genFps   // 実出力の長さ
  const model = engine === 'h3ref' ? 'minimax-h3-ref' : engine === 'h3' ? 'minimax-h3'
    : kfs.length >= 3 ? 'wan2.2-vace' : 'wan2.2-flf2v'
  const modeLabel = engine === 'h3ref'
    ? `H3 Ref2V(範囲下のVideoを参照・参照画像${refImgIds.length}枚)`
    : engine === 'h3'
    ? `H3 音声付き(開始→終了${kfs.length > 2 ? `・中間${kfs.length - 2}枚は無視` : ''})`
    : kfs.length >= 3 ? `VACE(中間${kfs.length - 2}枚を位置固定)` : 'FLF2V(開始→終了)'

  // h3ref: 指定フレームの下にあるVideo素材(参照動画の切り出し元)
  const findVideoClipAt = (frame: number) => {
    const vts = tracks
      .filter(t => t.track_type === 'video' && t.name !== 'Shots' && !t.hidden)
      .sort((a, b) => a.order - b.order)
    for (const t of vts) {
      const c = clips.find(c => c.track_id === t.id && c.asset_id != null &&
        c.start_frame <= frame && frame < c.start_frame + c.duration_frames)
      if (c) return c
    }
    return null
  }
  const refSourceClip = engine === 'h3ref' ? findVideoClipAt(first.start_frame) : null

  // 1カットぶんのRef2V参照(動画/音声)を切り出す。終端はフレーム包含で厳密
  // (秒指定だけだと隣カットの1フレームが混入し得るため end_sec を渡す)。
  const extractRefsForCut = async (sFrame: number, eFrame: number, outDurSec: number) => {
    let refVideoIds: number[] | undefined
    let refAudioIds: number[] | undefined
    const vc = findVideoClipAt(sFrame)
    if (vc) {
      const vStart = (sFrame - vc.start_frame + vc.asset_in_frame) / fps
      const vEnd = (eFrame - vc.start_frame + vc.asset_in_frame) / fps
      const seg = await assetsApi.extractClip(vc.asset_id!, vStart, vEnd - vStart + 1 / fps, vEnd)
      refVideoIds = [seg.id]
    }
    if (refAudioId !== '') {
      if (refAudioSeg) {
        const st = useTimelineStore.getState()
        const audClip = clips.find(c => c.asset_id === refAudioId &&
          st.tracks.find(t => t.id === c.track_id)?.track_type === 'audio' &&
          c.start_frame <= sFrame && sFrame < c.start_frame + c.duration_frames)
        const aStart = audClip
          ? (sFrame - audClip.start_frame + audClip.asset_in_frame) / fps
          : sFrame / fps
        const aseg = await assetsApi.extractClip(refAudioId, aStart, outDurSec)
        refAudioIds = [aseg.id]
      } else {
        refAudioIds = [refAudioId]
      }
    }
    return { refVideoIds, refAudioIds }
  }

  const handleGen = async () => {
    setMsg('')
    try {
      let shots = useTimelineStore.getState().tracks.find(t => t.name === 'Shots' && t.track_type === 'video')
      if (!shots) {
        await addTrack(projectId, 'video', 'Shots')
        shots = useTimelineStore.getState().tracks.find(t => t.name === 'Shots' && t.track_type === 'video')
      }
      if (!shots) throw new Error('Shotsトラックを作成できませんでした')

      // ── カットごとの一括Ref2V ──────────────────────────────────────
      if (engine === 'h3ref' && batchPerCut && selectedCuts.length >= 2) {
        const presets = H3_PRESETS
        const sz = presets[sizeIdx] ?? presets[0]
        const kfSpecs = refImgIds.slice(0, 9).map(id => ({ time_sec: 0, asset_id: id }))
        let n = 0
        for (const cut of selectedCuts) {
          n += 1
          setMsg(`✂️ (${n}/${selectedCuts.length}) 参照を切り出し中… C f${cut.s}-${cut.e}`)
          const outDur = snapH3(Math.round((cut.e - cut.s + 1) / fps * 24)) / 24
          const refs = await extractRefsForCut(cut.s, cut.e, outDur)
          const job = await generateVideoI2V({
            project_id: projectId,
            keyframes: kfSpecs,
            duration_sec: outDur,
            model: 'minimax-h3-ref', prompt: prompt.trim(),
            width: sz.w, height: sz.h, seed: -1, use_lightning: true,
            steps: h3Steps, easycache: h3EasyCache,
            ref_video_asset_ids: refs.refVideoIds,
            ref_audio_asset_ids: refs.refAudioIds,
            scheduler: refScheduler, ref_image_size: refImgSize,
            // 生成はH3の最短長(5.2s〜)になるが、配置はカット長でトリム(先頭から使用)
            place: { track_id: shots.id, start_frame: cut.s,
                     duration_frames: cut.e - cut.s + 1 },
          })
          watched.current.add(job.id)
        }
        window.dispatchEvent(new Event('kychapogas:assets-changed'))
        setMsg(`⏳ ${selectedCuts.length}本のRef2Vをキュー投入 — 完了ごとにShotsへカット長で自動配置`)
        return
      }
      const presets = useH3 ? H3_PRESETS : VID_PRESETS
      const sz = presets[sizeIdx] ?? presets[0]
      // タイムライン上の相対位置を保ったまま、出力長へスケール
      const scale = spanSec > 0 ? durSec / spanSec : 1
      // Ref2V: ピンは範囲/参照動画の指定にのみ使い、参照画像は視覚選択したもの(≤9)を使う
      // (ピンは参照動画由来のフレームなので<Picture>に流用しない)
      const useKfs = engine === 'h3ref' ? [] : engine === 'h3' && kfs.length > 2 ? [kfs[0], kfs[kfs.length - 1]] : kfs

      // h3ref: 範囲(最初→最後の打点・包含)の参照動画/音声をフレーム厳密に切り出す
      let refVideoIds: number[] | undefined
      let refAudioIds: number[] | undefined
      if (engine === 'h3ref') {
        setMsg('✂️ 参照を切り出し中…')
        const refs = await extractRefsForCut(first.start_frame, last.start_frame, durSec)
        refVideoIds = refs.refVideoIds
        refAudioIds = refs.refAudioIds
        window.dispatchEvent(new Event('kychapogas:assets-changed'))
      }

      const kfSpecs = useKfs.map(c => ({ time_sec: (c.start_frame - first.start_frame) / fps * scale, asset_id: c.asset_id! }))
      if (engine === 'h3ref') kfSpecs.push(...refImgIds.slice(0, 9).map(id => ({ time_sec: 0, asset_id: id })))
      const job = await generateVideoI2V({
        project_id: projectId,
        keyframes: kfSpecs,
        duration_sec: durSec,
        model, prompt: prompt.trim(),
        width: sz.w, height: sz.h, seed: -1, use_lightning: true,
        ...(useH3 ? { steps: h3Steps, easycache: h3EasyCache } : {}),
        ...(engine === 'h3ref' ? {
          ref_video_asset_ids: refVideoIds,
          ref_audio_asset_ids: refAudioIds,
          scheduler: refScheduler,
          ref_image_size: refImgSize,
        } : {}),
        place: { track_id: shots.id, start_frame: first.start_frame,
                 duration_frames: Math.round(durSec * fps) },
      })
      watched.current.add(job.id)
      setMsg(`⏳ ${modeLabel} 生成中(job ${job.id})`)
    } catch (e) { setMsg(e instanceof Error ? e.message : 'エラー') }
  }

  const inputCls = 'bg-zinc-800 text-xs text-zinc-100 rounded px-2 py-1 outline-none border border-zinc-700 focus:border-purple-500'

  return (
    <span className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        className={`text-[11px] px-2 py-0.5 rounded border ${
          open ? 'bg-amber-900/60 text-amber-200 border-amber-600'
               : 'bg-amber-950/60 text-amber-300 border-amber-700 hover:bg-amber-900/60'
        }`}
        title="選択したキーフレーム画像から動画を生成(打点=各画像の左端)"
      >🎬 選択KF→i2v ({kfs.length})</button>

      {open && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-2 sm:p-6"
             onClick={() => setOpen(false)}>
        <div onClick={e => e.stopPropagation()}
             className="w-[min(560px,94vw)] max-h-[92vh] overflow-y-auto p-4 rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-sm text-zinc-200">🎬 選択KF→i2v</span>
            <button onClick={() => setOpen(false)} className="text-zinc-400 hover:text-zinc-100 text-lg leading-none px-2">✕</button>
          </div>
          <div className="text-[10px] text-zinc-400">
            {kfs.map((c, i) => {
              const a = assets.find(x => x.id === c.asset_id)
              return <div key={c.id}>{i + 1}. f{c.start_frame} — {a?.name ?? `#${c.asset_id}`}</div>
            })}
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-zinc-500">
            <span>エンジン</span>
            <button onClick={() => { setEngine('wan'); setSizeIdx(0) }}
                    className={`px-2 py-1 rounded ${engine === 'wan' ? 'bg-purple-800 text-purple-100' : 'bg-zinc-800 hover:bg-zinc-700'}`}>Wan2.2</button>
            <button onClick={() => { setEngine('h3'); setSizeIdx(0) }}
                    className={`px-2 py-1 rounded ${engine === 'h3' ? 'bg-purple-800 text-purple-100' : 'bg-zinc-800 hover:bg-zinc-700'}`}>H3 音声付き</button>
            <button onClick={() => { setEngine('h3ref'); setSizeIdx(0) }}
                    className={`px-2 py-1 rounded ${engine === 'h3ref' ? 'bg-purple-800 text-purple-100' : 'bg-zinc-800 hover:bg-zinc-700'}`}>🎭Ref2V</button>
            {useH3 && (
              <>
                <label className="flex items-center gap-1 ml-auto">steps
                  <input type="number" min={8} max={40} value={h3Steps}
                         onChange={e => setH3Steps(Math.max(8, Math.min(40, Number(e.target.value))))}
                         className={inputCls + ' w-14'} />
                </label>
                <label className="flex items-center gap-1 cursor-pointer"
                       title="約1.5〜2倍高速化(わずかな甘さ)。最終品質重視ならOFF">
                  <input type="checkbox" checked={h3EasyCache} onChange={e => setH3EasyCache(e.target.checked)} />⚡
                </label>
              </>
            )}
          </div>
          {engine === 'h3ref' && (
            <>
              <p className="text-[9px] text-zinc-500">
                範囲(最初→最後の打点)の下のVideoを&lt;Video 1&gt;、下で選んだ参照画像(≤9枚)を&lt;Picture 1..&gt;として参照します。
                ピンは範囲指定のみに使用(参照動画由来のフレームのため)。
                「Recreate the camera work of &lt;Video 1&gt;, the girl is &lt;Picture 1&gt;…」のように指名すると効きます。
                {refSourceClip ? '' : ' ⚠ 範囲の下にVideo素材が見つかりません。'}
              </p>
              <RefImagePicker assets={assets} selected={refImgIds} onChange={setRefImgIds} />
              {selectedCuts.length >= 2 && (
                <label className="flex items-center gap-1.5 text-[10px] text-amber-300 cursor-pointer bg-amber-950/40 border border-amber-800 rounded px-2 py-1">
                  <input type="checkbox" checked={batchPerCut} onChange={e => setBatchPerCut(e.target.checked)} />
                  🎬 選択カットごとに一括生成({selectedCuts.length}本) — 各カットの参照動画/歌唱を自動切り出し→順次生成→カット長で自動配置
                </label>
              )}
              <div className="flex items-center gap-1.5 text-[10px] text-zinc-500 flex-wrap">
                <span>🎤参照音声</span>
                <select value={refAudioId} onChange={e => setRefAudioId(e.target.value === '' ? '' : Number(e.target.value))}
                        className={inputCls + ' flex-1 min-w-32'}>
                  <option value="">なし(音はプロンプト任せ)</option>
                  {assets.filter(a => assetKind(a) === 'audio')
                    .sort((a, b) => (a.name.includes('歌唱') ? -1 : 0) - (b.name.includes('歌唱') ? -1 : 0))
                    .map(a => <option key={a.id} value={a.id}>#{a.id} {a.name}</option>)}
                </select>
                <label className="flex items-center gap-1 cursor-pointer"
                       title="範囲に対応する区間だけを切り出して渡す(リップシンク用)。OFFで音源全体">
                  <input type="checkbox" checked={refAudioSeg} onChange={e => setRefAudioSeg(e.target.checked)} />
                  範囲切り出し
                </label>
              </div>
              {refAudioId !== '' && (
                <p className="text-[9px] text-zinc-600">
                  💡 歌唱リップシンク: 「(歌唱)」分離アセット推奨(未分離ならアセット⋯→🎤歌唱を分離)。
                  プロンプトは「Use &lt;Audio 1&gt; exactly as it is as the final audio track. S1 sings along to &lt;Audio 1&gt;, lips precisely synced」型が公式規範。
                  声質だけ借りて別歌詞なら「S1 uses the voice timbre from &lt;Audio 1&gt;」+&lt;d&gt;歌詞&lt;/d&gt;。
                  出力音声は生成し直されるので同期ガイド専用 — 最終音はタイムラインのAudio(原曲)が優先されます。
                </p>
              )}
              <div className="flex items-center gap-1.5 text-[10px] text-zinc-500 flex-wrap">
                <select value={refImgSize} onChange={e => setRefImgSize(e.target.value as 'match' | 'max')} className={inputCls}
                        title="match=速度優先 / max=同一性優先(2048短辺)">
                  <option value="match">match</option>
                  <option value="max">max(同一性)</option>
                </select>
                <select value={refScheduler} onChange={e => setRefScheduler(e.target.value as 'beta' | 'normal' | 'simple')} className={inputCls}
                        title="参照が多いときはbeta/normalが安定(公式Tips)">
                  <option value="beta">beta</option>
                  <option value="normal">normal</option>
                  <option value="simple">simple</option>
                </select>
              </div>
            </>
          )}
          <div className="flex items-center gap-1.5 text-[10px] text-zinc-500">
            <span>フレーム数</span>
            <input type="number" step={useH3 ? 17 : 4} min={5} value={frames}
                   onChange={e => setFrames(snapFn(Number(e.target.value)))}
                   className={inputCls + ' w-20'} />
            {(useH3 ? [124, 226, 362] : [41, 81, 121]).map(n => (
              <button key={n} onClick={() => setFrames(n)}
                      className={`px-1.5 py-0.5 rounded ${frames === n ? 'bg-purple-800 text-purple-100' : 'bg-zinc-800 hover:bg-zinc-700'}`}>{n}</button>
            ))}
            <span className="ml-auto">= {durSec.toFixed(2)}秒({genFps}fps) → <span className="text-amber-400">{modeLabel}</span></span>
          </div>
          <p className="text-[9px] text-zinc-600">タイムライン上のKF間隔({spanSec.toFixed(2)}秒)と違う場合、動きは出力長に合わせて伸縮します。{useH3 ? 'H3: 24fps・訓練域124〜362(5.2〜15.1秒)・音声同時生成(プロンプトに音の指示可)。推奨124。' : '推奨81(4n+1)。'}</p>
          <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={2}
                    placeholder={engine === 'h3ref'
                      ? '例: Recreate the same camera work as <Video 1>, but the singer is the girl in <Picture 1>'
                      : 'モーションプロンプト'} className={inputCls + ' resize-none'} />
          <div className="flex gap-2">
            <select value={sizeIdx} onChange={e => setSizeIdx(Number(e.target.value))} className={inputCls + ' flex-1'}>
              {(useH3 ? H3_PRESETS : VID_PRESETS).map((s, i) => <option key={i} value={i}>{s.label}</option>)}
            </select>
            <button onClick={handleGen}
                    disabled={engine === 'h3ref' && (!refSourceClip || !prompt.trim() || refImgIds.length === 0)}
                    title={engine === 'h3ref' && refImgIds.length === 0 ? '参照画像を1枚以上選択してください' : undefined}
                    className="text-xs px-3 py-1.5 rounded bg-purple-700 hover:bg-purple-600 text-white disabled:opacity-40">▶ 生成</button>
          </div>
          <button onClick={() => { clearRefSel(); setOpen(false) }}
                  className="text-[10px] text-zinc-500 hover:text-zinc-300 self-start">選択解除</button>
          {msg && <p className="text-[10px] text-zinc-400">{msg}</p>}
        </div>
        </div>,
        document.body
      )}
    </span>
  )
}
