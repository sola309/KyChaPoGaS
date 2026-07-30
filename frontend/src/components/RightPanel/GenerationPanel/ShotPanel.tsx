import { useEffect, useMemo, useRef, useState } from 'react'
import { assetsApi, assetKind, type Asset } from '../../../api/client'
import { VideoFramePicker } from '../../Timeline/VideoFramePicker'
import { useJobStore } from '../../../store/jobStore'
import { useProjectStore } from '../../../store/projectStore'
import { useTimelineStore } from '../../../store/timelineStore'

// 🎞 ショットパネル — 再生位置を起点にした画像→動画の一連ワークフロー。
//  A) 画像@再生位置: アセット挿入 / t2i / i2i(参照=再生位置のVideoフレーム or アセット)
//     → 「Image」トラック(reference)の再生位置へ配置
//  B) 範囲指定i2v: 開始/終了フレームで長さを規定し、Imageトラック上のキーフレームを検出
//     → 1枚=I2V / 端2枚=FLF2V / 中間あり=VACE を自動選択 → 「Shots」トラックへ配置

const SIZE_PRESETS = [
  { label: '横 1344×768',  w: 1344, h: 768 },
  { label: '縦 832×1216',  w: 832,  h: 1216 },
  { label: '正方 1024',    w: 1024, h: 1024 },
] as const
const VID_PRESETS = [
  { label: '横 832×480(16:9)', w: 832, h: 480 },
  { label: '縦 480×832',       w: 480, h: 832 },
  { label: '正方 640',         w: 640, h: 640 },
] as const

export function ShotPanel({ assets }: { assets: Asset[] }) {
  const { activeProject } = useProjectStore()
  const { generateImage, generateVideoI2V, comfyAvailable, jobs } = useJobStore()
  const { tracks, clips, currentFrame, addTrack, addClip, loadTimeline } = useTimelineStore()
  const fps = activeProject?.fps ?? 30

  const [imgMode, setImgMode] = useState<'asset' | 't2i' | 'i2i' | 'edit' | 'vframe'>('t2i')
  const [assetId, setAssetId] = useState<number | ''>('')
  const [prompt, setPrompt] = useState('')
  const [sizeIdx, setSizeIdx] = useState(0)   // 既定=横16:9系
  const [i2iSrc, setI2iSrc] = useState<'video' | 'asset'>('video')
  const [i2iAssetId, setI2iAssetId] = useState<number | ''>('')
  const [denoise, setDenoise] = useState(0.55)
  const [editModel, setEditModel] = useState('qwen-edit-2511')
  const [editRef2, setEditRef2] = useState<number | ''>('')
  const [editRef3, setEditRef3] = useState<number | ''>('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  // i2v
  const [inFrame, setInFrame] = useState(0)
  const [outFrame, setOutFrame] = useState(0)
  const [vidPrompt, setVidPrompt] = useState('')
  const [vidSizeIdx, setVidSizeIdx] = useState(0)   // 既定=横16:9
  const watchedJobs = useRef<Set<number>>(new Set())

  const imgAssets = useMemo(() => assets.filter(a => assetKind(a) === 'image'), [assets])

  // ジョブ完了 → タイムライン再読込(placeで配置されたクリップを反映)
  useEffect(() => {
    if (!activeProject) return
    for (const j of jobs) {
      if (!watchedJobs.current.has(j.id)) continue
      if (j.status === 'completed' || j.status === 'failed') {
        watchedJobs.current.delete(j.id)
        if (j.status === 'completed') {
          loadTimeline(activeProject.id, fps)
          setMsg('✅ 生成完了 — タイムラインに配置しました')
        } else {
          setMsg('❌ 生成失敗(ジョブログを確認してください)')
        }
      }
    }
  }, [jobs, activeProject, fps, loadTimeline])

  const ensureTrack = async (name: string, type: 'video' | 'reference') => {
    const find = () => useTimelineStore.getState().tracks.find(t => t.name === name && t.track_type === type)
    let t = find()
    if (!t && activeProject) {
      await addTrack(activeProject.id, type, name)
      t = find()
    }
    if (!t) throw new Error(`トラック ${name} を作成できませんでした`)
    return t
  }

  // ── A) 画像@再生位置 ──────────────────────────────────────────
  const placeDur = Math.round(fps)   // 1秒ぶん

  const handleInsertAsset = async () => {
    if (!activeProject || assetId === '') return
    setBusy(true); setMsg('')
    try {
      const tr = await ensureTrack('Image', 'reference')
      await addClip(tr.id, Number(assetId), currentFrame, placeDur)
      setMsg(`✅ 配置しました(frame ${currentFrame})`)
    } catch (e) { setMsg(e instanceof Error ? e.message : 'エラー') } finally { setBusy(false) }
  }

  const handleGenImage = async () => {
    if (!activeProject || !prompt.trim()) return
    setBusy(true); setMsg('')
    try {
      const tr = await ensureTrack('Image', 'reference')
      const sz = SIZE_PRESETS[sizeIdx]
      let initId: number | undefined
      if (imgMode === 'i2i' || imgMode === 'edit') {
        if (i2iSrc === 'video') {
          // 再生位置の直下にあるVideoトラックのクリップからフレームを抽出して参照にする
          const videoTracks = tracks.filter(t => t.track_type === 'video')
          const hit = clips.find(c =>
            videoTracks.some(t => t.id === c.track_id) && c.asset_id != null &&
            currentFrame >= c.start_frame && currentFrame < c.start_frame + c.duration_frames)
          if (!hit) throw new Error('再生位置にVideoクリップがありません')
          const tSec = (currentFrame - hit.start_frame + (hit.asset_in_frame ?? 0)) / fps
          setMsg('📷 フレーム抽出中…')
          const frameAsset = await assetsApi.extractFrame(hit.asset_id!, tSec)
          window.dispatchEvent(new Event('kychapogas:assets-changed'))
          initId = frameAsset.id
        } else {
          if (i2iAssetId === '') throw new Error('参照アセットを選択してください')
          initId = Number(i2iAssetId)
        }
      }
      const isEdit = imgMode === 'edit'
      const refs = isEdit
        ? [initId!, ...[editRef2, editRef3].filter((v): v is number => v !== '')]
        : []
      const job = await generateImage({
        project_id: activeProject.id,
        prompt: prompt.trim(),
        model: isEdit ? editModel : 'waiNSFWIllustrious_v170',
        width: sz.w, height: sz.h, seed: -1,
        ...(isEdit ? { ref_asset_ids: refs } : {}),
        ...(!isEdit && initId ? { init_asset_id: initId, denoise } : {}),
        place: { track_id: tr.id, start_frame: currentFrame, duration_frames: placeDur },
      })
      watchedJobs.current.add(job.id)
      setMsg(`⏳ 生成中(job ${job.id})— 完了すると frame ${currentFrame} に自動配置`)
    } catch (e) { setMsg(e instanceof Error ? e.message : 'エラー') } finally { setBusy(false) }
  }

  const handleInsertVFrame = async (videoAssetId: number, timeSec: number, longEdge?: number) => {
    if (!activeProject) return
    setBusy(true); setMsg('')
    try {
      const tr = await ensureTrack('Image', 'reference')
      setMsg('📷 フレーム抽出中…')
      const frameAsset = await assetsApi.extractFrame(videoAssetId, timeSec, longEdge)
      await addClip(tr.id, frameAsset.id, currentFrame, placeDur)
      window.dispatchEvent(new Event('kychapogas:assets-changed'))
      setMsg(`✅ frame ${currentFrame} に挿入(アセット#${frameAsset.id})— i2i/i2v/編集の参照に使えます`)
    } catch (e) { setMsg(e instanceof Error ? e.message : 'エラー') } finally { setBusy(false) }
  }

  // ── B) 範囲指定 i2v ───────────────────────────────────────────
  const imageTrack = tracks.find(t => t.name === 'Image' && t.track_type === 'reference')
  const rangeKfs = useMemo(() => {
    if (!imageTrack || outFrame <= inFrame) return []
    return clips
      .filter(c => c.track_id === imageTrack.id && c.asset_id != null &&
                   c.start_frame >= inFrame && c.start_frame <= outFrame)
      .sort((a, b) => a.start_frame - b.start_frame)
  }, [clips, imageTrack, inFrame, outFrame])

  const tol = fps / 2
  const hasStart = rangeKfs.length > 0 && rangeKfs[0].start_frame - inFrame <= tol
  const hasEnd = rangeKfs.length > 1 && outFrame - rangeKfs[rangeKfs.length - 1].start_frame <= tol
  const vidModel = rangeKfs.length >= 3 || (rangeKfs.length === 2 && (!hasStart || !hasEnd))
    ? 'wan2.2-vace' : 'wan2.2-flf2v'
  const modeLabel =
    rangeKfs.length === 0 ? '— 範囲内にImageキーフレームなし' :
    rangeKfs.length === 1 ? 'I2V(開始フレームのみ)' :
    vidModel === 'wan2.2-flf2v' ? 'FLF2V(開始+終了フレーム指定)' :
    `VACE(${rangeKfs.length}キーフレームを位置固定)`

  const handleGenVideo = async () => {
    if (!activeProject || rangeKfs.length === 0 || outFrame <= inFrame) return
    setBusy(true); setMsg('')
    try {
      const shots = await ensureTrack('Shots', 'video')
      const sz = VID_PRESETS[vidSizeIdx]
      const job = await generateVideoI2V({
        project_id: activeProject.id,
        keyframes: rangeKfs.map(c => ({ time_sec: (c.start_frame - inFrame) / fps, asset_id: c.asset_id! })),
        duration_sec: (outFrame - inFrame) / fps,
        model: vidModel,
        prompt: vidPrompt.trim(),
        width: sz.w, height: sz.h, seed: -1, use_lightning: true,
        place: { track_id: shots.id, start_frame: inFrame, duration_frames: outFrame - inFrame },
      })
      watchedJobs.current.add(job.id)
      setMsg(`⏳ ${modeLabel} 生成中(job ${job.id})— 完了するとShotsトラックに自動配置`)
    } catch (e) { setMsg(e instanceof Error ? e.message : 'エラー') } finally { setBusy(false) }
  }

  const inputCls = 'bg-zinc-800 text-xs text-zinc-100 rounded px-2 py-1.5 outline-none border border-zinc-700 focus:border-purple-500'
  const btnCls = 'text-xs px-3 py-1.5 rounded bg-purple-700 hover:bg-purple-600 text-white disabled:opacity-40'
  const chipCls = (on: boolean) => `text-[10px] px-2 py-1 rounded ${on ? 'bg-purple-800 text-purple-100' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'}`

  return (
    <div className="flex flex-col gap-4 p-3">
      {!comfyAvailable && (
        <div className="text-[10px] text-amber-400 bg-amber-950/30 border border-amber-800 rounded px-2 py-1.5">
          ComfyUI未接続 — ジョブはキューに入りますが実行されません
        </div>
      )}

      {/* A) 画像@再生位置 */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-zinc-300 font-medium">🖼 画像 @ 再生位置</span>
          <span className="text-[10px] text-amber-400">frame {currentFrame}</span>
        </div>
        <div className="flex gap-1">
          <button className={chipCls(imgMode === 'asset')} onClick={() => setImgMode('asset')}>アセット</button>
          <button className={chipCls(imgMode === 't2i')} onClick={() => setImgMode('t2i')}>t2i</button>
          <button className={chipCls(imgMode === 'i2i')} onClick={() => setImgMode('i2i')}>i2i</button>
          <button className={chipCls(imgMode === 'edit')} onClick={() => setImgMode('edit')}>✏️AI編集</button>
          <button className={chipCls(imgMode === 'vframe')} onClick={() => setImgMode('vframe')}>🎥Vフレーム</button>
        </div>

        {imgMode === 'asset' && (
          <div className="flex gap-2">
            <select value={assetId} onChange={e => setAssetId(e.target.value === '' ? '' : Number(e.target.value))} className={inputCls + ' flex-1'}>
              <option value="">画像アセットを選択…</option>
              {imgAssets.map(a => <option key={a.id} value={a.id}>#{a.id} {a.name}</option>)}
            </select>
            <button onClick={handleInsertAsset} disabled={busy || assetId === ''} className={btnCls}>配置</button>
          </div>
        )}

        {imgMode === 'vframe' && (
          <VideoFramePicker assets={assets} fps={fps} busy={busy} onInsert={handleInsertVFrame} />
        )}

        {imgMode !== 'asset' && imgMode !== 'vframe' && (
          <>
            {(imgMode === 'i2i' || imgMode === 'edit') && (
              <div className="flex flex-col gap-1.5">
                {imgMode === 'edit' && (
                  <select value={editModel} onChange={e => setEditModel(e.target.value)} className={inputCls}>
                    <option value="qwen-edit-2511">Qwen-Edit-2511(推奨・4step)</option>
                    <option value="qwen-edit-2511-fp8">Qwen-Edit-2511 fp8(軽量)</option>
                    <option value="hidream-o1-dev">HiDream-O1 Dev(キャラ参照に強い)</option>
                    <option value="flux2-klein-kv">FLUX.2 klein KV(エフェクト・反復編集)</option>
                  </select>
                )}
                <div className="flex gap-1">
                  <button className={chipCls(i2iSrc === 'video')} onClick={() => setI2iSrc('video')}>{imgMode === 'edit' ? '編集対象' : '参照'}=再生位置のVideoフレーム</button>
                  <button className={chipCls(i2iSrc === 'asset')} onClick={() => setI2iSrc('asset')}>{imgMode === 'edit' ? '編集対象' : '参照'}=アセット</button>
                </div>
                {i2iSrc === 'asset' && (
                  <select value={i2iAssetId} onChange={e => setI2iAssetId(e.target.value === '' ? '' : Number(e.target.value))} className={inputCls}>
                    <option value="">参照アセットを選択…</option>
                    {imgAssets.map(a => <option key={a.id} value={a.id}>#{a.id} {a.name}</option>)}
                  </select>
                )}
                {imgMode === 'i2i' && (
                  <label className="flex items-center gap-2 text-[10px] text-zinc-500">
                    変化量 {denoise.toFixed(2)}
                    <input type="range" min={0.2} max={0.9} step={0.05} value={denoise}
                           onChange={e => setDenoise(Number(e.target.value))} className="flex-1" />
                  </label>
                )}
                {imgMode === 'edit' && (
                  <div className="flex gap-1.5">
                    {[
                      [editRef2, setEditRef2, '追加参照2(任意)'],
                      [editRef3, setEditRef3, '追加参照3(任意)'],
                    ].map(([val, setter, label], i) => (
                      <select key={i} value={val as number | ''} onChange={e => (setter as (v: number | '') => void)(e.target.value === '' ? '' : Number(e.target.value))} className={inputCls + ' flex-1'}>
                        <option value="">{label as string}</option>
                        {imgAssets.map(a => <option key={a.id} value={a.id}>#{a.id} {a.name}</option>)}
                      </select>
                    ))}
                  </div>
                )}
              </div>
            )}
            <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={2}
                      placeholder="プロンプト(masterpiece, anime style, ...)" className={inputCls + ' resize-none'} />
            <div className="flex gap-2">
              <select value={sizeIdx} onChange={e => setSizeIdx(Number(e.target.value))} className={inputCls + ' flex-1'}>
                {SIZE_PRESETS.map((s, i) => <option key={i} value={i}>{s.label}</option>)}
              </select>
              <button onClick={handleGenImage} disabled={busy || !prompt.trim()} className={btnCls}>
                {imgMode === 'edit' ? '✏️編集→配置' : imgMode === 'i2i' ? 'i2i生成→配置' : 't2i生成→配置'}
              </button>
            </div>
          </>
        )}
      </div>

      <div className="border-t border-zinc-800" />

      {/* B) 範囲指定 i2v */}
      <div className="flex flex-col gap-2">
        <span className="text-[11px] text-zinc-300 font-medium">🎬 範囲指定 i2v(Imageトラック参照)</span>
        <div className="flex items-center gap-1.5 text-[10px] text-zinc-400">
          <button onClick={() => setInFrame(currentFrame)} className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700">▶を開始に</button>
          <input type="number" value={inFrame} onChange={e => setInFrame(Number(e.target.value))} className={inputCls + ' w-20'} />
          <span>→</span>
          <input type="number" value={outFrame} onChange={e => setOutFrame(Number(e.target.value))} className={inputCls + ' w-20'} />
          <button onClick={() => setOutFrame(currentFrame)} className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700">▶を終了に</button>
        </div>
        <div className="text-[10px] text-zinc-500">
          長さ {outFrame > inFrame ? ((outFrame - inFrame) / fps).toFixed(2) : '—'} 秒 /
          キーフレーム {rangeKfs.length} 枚 → <span className="text-amber-400">{modeLabel}</span>
        </div>
        {rangeKfs.length > 0 && (
          <div className="flex gap-1 flex-wrap">
            {rangeKfs.map(c => (
              <span key={c.id} className="text-[9px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
                f{c.start_frame} #{c.asset_id}
              </span>
            ))}
          </div>
        )}
        <textarea value={vidPrompt} onChange={e => setVidPrompt(e.target.value)} rows={2}
                  placeholder="モーションプロンプト(camera push-in, hair swaying, ...)" className={inputCls + ' resize-none'} />
        <div className="flex gap-2">
          <select value={vidSizeIdx} onChange={e => setVidSizeIdx(Number(e.target.value))} className={inputCls + ' flex-1'}>
            {VID_PRESETS.map((s, i) => <option key={i} value={i}>{s.label}</option>)}
          </select>
          <button onClick={handleGenVideo} disabled={busy || rangeKfs.length === 0 || outFrame <= inFrame} className={btnCls}>
            ▶ 動画生成→配置
          </button>
        </div>
      </div>

      {msg && <p className="text-[10px] text-zinc-400">{msg}</p>}
    </div>
  )
}
