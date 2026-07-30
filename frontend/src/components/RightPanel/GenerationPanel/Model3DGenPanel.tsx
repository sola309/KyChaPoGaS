import { useMemo, useState } from 'react'
import { generationApi, type Asset } from '../../../api/client'
import { useProjectStore } from '../../../store/projectStore'
import { useJobStore } from '../../../store/jobStore'
import { KeyframeGraph, type CamKey } from './KeyframeGraph'

// 画像→3Dモデル(GLB)生成 + カメラワークwebm焼き出し。
//  object: Hunyuan3D-2 メッシュ(切り抜き済み透過画像が最良)
//  relief: MoGe-2 テクスチャ付きレリーフ(一枚絵の中をカメラが飛ぶ3Dフォト)
export function Model3DGenPanel({ assets }: { assets: Asset[] }) {
  const { activeProject } = useProjectStore()
  const { comfyAvailable } = useJobStore()

  const images = useMemo(
    () => assets.filter(a => a.asset_type === 'image' || a.asset_type === 'generated'),
    [assets])
  const models3d = useMemo(() => assets.filter(a => a.asset_type === 'model3d'), [assets])
  const audios = useMemo(() => assets.filter(a => a.asset_type === 'audio'), [assets])

  const [mode, setMode] = useState<'object' | 'relief'>('object')
  const [imageId, setImageId] = useState<number | ''>('')
  const [seed, setSeed] = useState(-1)
  const [withOrbit, setWithOrbit] = useState(true)
  const [preset, setPreset] = useState('orbit')
  const [style, setStyle] = useState('toon')
  const [seconds, setSeconds] = useState(4)
  const [orbitAssetId, setOrbitAssetId] = useState<number | ''>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const orbitSpec = () => ({
    preset: mode === 'relief' ? 'parallax' : preset,
    seconds, fps: 30, width: 1280, height: 720,
    style: mode === 'relief' ? 'standard' : style,
  })

  const handleGenerate = async () => {
    if (!activeProject || imageId === '' || busy) return
    setBusy(true); setError(null)
    try {
      await generationApi.model3d({
        project_id: activeProject.id, mode,
        image_asset_id: Number(imageId), seed,
        ...(withOrbit ? { orbit: orbitSpec() } : {}),
      })
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '生成エラー')
    } finally { setBusy(false) }
  }

  const handleOrbitOnly = async () => {
    if (!activeProject || orbitAssetId === '' || busy) return
    setBusy(true); setError(null)
    try {
      await generationApi.model3dOrbit({
        project_id: activeProject.id, asset_id: Number(orbitAssetId), orbit: orbitSpec(),
      })
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'レンダエラー')
    } finally { setBusy(false) }
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      {!comfyAvailable && (
        <div className="text-[10px] text-amber-400 bg-amber-950/30 border border-amber-800 rounded px-2 py-1.5">
          ComfyUI未接続 — ジョブはキューに入りますが実行されません
        </div>
      )}

      <label className="flex flex-col gap-1">
        <span className="text-[10px] text-zinc-500">生成モード</span>
        <select value={mode} onChange={e => setMode(e.target.value as 'object' | 'relief')}
          className="bg-zinc-800 text-xs text-zinc-200 rounded px-2 py-1.5 outline-none border border-zinc-700">
          <option value="object">オブジェクト3D（Hunyuan3D-2 / キャラ・小物）</option>
          <option value="relief">シーン3D（MoGe-2 / 一枚絵の3Dフォト）</option>
        </select>
      </label>
      <p className="text-[10px] text-zinc-500 -mt-2">
        {mode === 'object'
          ? '透過切り抜き済み画像が最良（✂ 切り抜きを先に）。無地グレーのメッシュになるのでトゥーン調が映えます。'
          : '元絵テクスチャ付きの起伏メッシュ。カメラの平行移動で絵の中に奥行きが生まれます。'}
      </p>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] text-zinc-500">入力画像</span>
        <select value={imageId} onChange={e => setImageId(e.target.value === '' ? '' : Number(e.target.value))}
          className="bg-zinc-800 text-xs text-zinc-200 rounded px-2 py-1.5 outline-none border border-zinc-700">
          <option value="">— 選択 —</option>
          {images.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] text-zinc-500">シード（-1 = ランダム）</span>
        <input type="number" value={seed} onChange={e => setSeed(Number(e.target.value))}
          className="bg-zinc-800 text-xs text-zinc-200 rounded px-2 py-1.5 outline-none border border-zinc-700 w-full" />
      </label>

      <label className="flex items-center gap-2 text-xs text-zinc-300">
        <input type="checkbox" checked={withOrbit} onChange={e => setWithOrbit(e.target.checked)} />
        続けてカメラワークwebm（透過）も焼く
      </label>

      {withOrbit && (
        <div className="flex flex-col gap-2 pl-2 border-l border-zinc-800">
          {mode === 'object' && (
            <div className="flex gap-2">
              <label className="flex flex-col gap-1 flex-1">
                <span className="text-[10px] text-zinc-500">カメラ</span>
                <select value={preset} onChange={e => setPreset(e.target.value)}
                  className="bg-zinc-800 text-xs text-zinc-200 rounded px-2 py-1.5 outline-none border border-zinc-700">
                  <option value="orbit">ターンテーブル</option>
                  <option value="dolly_in">ドリーイン</option>
                  <option value="dolly_out">ドリーアウト</option>
                  <option value="sway">スウェイ</option>
                  <option value="arc_l">アーク（左）</option>
                  <option value="arc_r">アーク（右）</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 flex-1">
                <span className="text-[10px] text-zinc-500">スタイル</span>
                <select value={style} onChange={e => setStyle(e.target.value)}
                  className="bg-zinc-800 text-xs text-zinc-200 rounded px-2 py-1.5 outline-none border border-zinc-700">
                  <option value="toon">トゥーン+輪郭線</option>
                  <option value="standard">スタンダード</option>
                  <option value="wire">ワイヤーフレーム</option>
                </select>
              </label>
            </div>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-zinc-500">長さ（秒）</span>
            <input type="number" value={seconds} min={1} max={20} step={0.5}
              onChange={e => setSeconds(Number(e.target.value))}
              className="bg-zinc-800 text-xs text-zinc-200 rounded px-2 py-1.5 outline-none border border-zinc-700 w-full" />
          </label>
        </div>
      )}

      {error && <p className="text-[10px] text-red-400">{error}</p>}

      <button onClick={handleGenerate} disabled={busy || imageId === ''}
        className="w-full py-2 rounded bg-purple-700 hover:bg-purple-600 text-white text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
        {busy ? '投入中…' : '▶ 3Dモデル生成'}
      </button>

      {models3d.length > 0 && (
        <div className="flex flex-col gap-2 mt-2 pt-2 border-t border-zinc-800">
          <span className="text-[10px] text-zinc-500">既存3Dモデルから別カメラで焼き直し</span>
          <select value={orbitAssetId}
            onChange={e => setOrbitAssetId(e.target.value === '' ? '' : Number(e.target.value))}
            className="bg-zinc-800 text-xs text-zinc-200 rounded px-2 py-1.5 outline-none border border-zinc-700">
            <option value="">— model3d アセット —</option>
            {models3d.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <button onClick={handleOrbitOnly} disabled={busy || orbitAssetId === ''}
            className="w-full py-1.5 rounded bg-zinc-700 hover:bg-zinc-600 text-white text-xs disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
            🎥 カメラワークwebmを生成
          </button>
        </div>
      )}

      {models3d.length > 0 && (
        <AiRenderSection models3d={models3d} images={images} audios={audios} busy={busy} setBusy={setBusy} setError={setError} />
      )}

      <p className="text-[10px] text-zinc-600 mt-1">
        GLBは MADビルダーの scene3d テンプレートでも直接使えます（本物の3Dカメラワーク）。
      </p>
    </div>
  )
}


// 3Dカメラワーク×Wan2.2 Fun Control: 深度レンダをコントロールにAIが原画品質で描く
function AiRenderSection({ models3d, images, audios, busy, setBusy, setError }: {
  models3d: Asset[]; images: Asset[]; audios: Asset[]; busy: boolean
  setBusy: (b: boolean) => void; setError: (e: string | null) => void
}) {
  const { activeProject } = useProjectStore()
  const [modelId, setModelId] = useState<number | ''>('')
  const [refId, setRefId] = useState<number | ''>('')
  const [prompt, setPrompt] = useState('')
  const [camPreset, setCamPreset] = useState('arc_r')
  const [useGraph, setUseGraph] = useState(false)
  const [camKeys, setCamKeys] = useState<CamKey[]>([
    { at: 0, az: -0.5, el: 0.15, dist: 2.4, fov: 38 },
    { at: 1, az: 0.5, el: 0.28, dist: 1.8, fov: 44, ease: 'inOut' },
  ])
  const [beatAudioId, setBeatAudioId] = useState<number | ''>('')
  const [beatRange, setBeatRange] = useState({ start: 0, end: 5 })
  const [beatStyle, setBeatStyle] = useState('punch_in')

  const submit = async () => {
    if (!activeProject || modelId === '' || refId === '' || busy) return
    setBusy(true); setError(null)
    try {
      await generationApi.video3dcam({
        project_id: activeProject.id,
        model_asset_id: Number(modelId), ref_image_asset_id: Number(refId),
        prompt: prompt.trim(),
        camera: useGraph ? (camKeys as unknown as Array<Record<string, number>>) : { preset: camPreset },
      })
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '生成エラー')
    } finally { setBusy(false) }
  }

  return (
    <div className="flex flex-col gap-2 mt-2 pt-2 border-t border-zinc-800">
      <span className="text-[10px] text-purple-400 font-medium">🎬 AIレンダ動画（3Dカメラ×Wan2.2 Fun Control）</span>
      <select value={modelId} onChange={e => setModelId(e.target.value === '' ? '' : Number(e.target.value))}
        className="bg-zinc-800 text-xs text-zinc-200 rounded px-2 py-1.5 outline-none border border-zinc-700">
        <option value="">— 3Dモデル(GLB) —</option>
        {models3d.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
      <select value={refId} onChange={e => setRefId(e.target.value === '' ? '' : Number(e.target.value))}
        className="bg-zinc-800 text-xs text-zinc-200 rounded px-2 py-1.5 outline-none border border-zinc-700">
        <option value="">— 参照画像（画風・キャラ） —</option>
        {images.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
      <select value={camPreset} onChange={e => setCamPreset(e.target.value)}
        className="bg-zinc-800 text-xs text-zinc-200 rounded px-2 py-1.5 outline-none border border-zinc-700">
        <option value="arc_r">アーク（右）</option>
        <option value="arc_l">アーク（左）</option>
        <option value="orbit">ターンテーブル</option>
        <option value="dolly_in">ドリーイン</option>
        <option value="dolly_out">ドリーアウト</option>
        <option value="sway">スウェイ</option>
        <option value="parallax">パララックス（relief向け）</option>
      </select>
      <label className="flex items-center gap-2 text-[11px] text-zinc-300">
        <input type="checkbox" checked={useGraph} onChange={e => setUseGraph(e.target.checked)} />
        🎛 カメラをグラフで編集（キーフレーム）
      </label>
      {useGraph && (
        <div className="flex flex-col gap-2">
          <KeyframeGraph keys={camKeys} onChange={setCamKeys} />
          <div className="flex items-center gap-1 flex-wrap text-[10px]">
            <select value={beatAudioId}
              onChange={e => setBeatAudioId(e.target.value === '' ? '' : Number(e.target.value))}
              className="bg-zinc-800 text-[10px] text-zinc-200 rounded px-1 py-1 border border-zinc-700 max-w-[130px]">
              <option value="">♪ 音源…</option>
              {audios.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <input type="number" value={beatRange.start} step={0.5} title="開始秒"
              onChange={e => setBeatRange(r => ({ ...r, start: Number(e.target.value) }))}
              className="bg-zinc-800 w-14 text-[10px] text-zinc-200 rounded px-1 py-1 border border-zinc-700" />
            <span className="text-zinc-500">→</span>
            <input type="number" value={beatRange.end} step={0.5} title="終了秒"
              onChange={e => setBeatRange(r => ({ ...r, end: Number(e.target.value) }))}
              className="bg-zinc-800 w-14 text-[10px] text-zinc-200 rounded px-1 py-1 border border-zinc-700" />
            <select value={beatStyle} onChange={e => setBeatStyle(e.target.value)}
              className="bg-zinc-800 text-[10px] text-zinc-200 rounded px-1 py-1 border border-zinc-700">
              <option value="punch_in">パンチイン</option>
              <option value="orbit_beat">小節回り込み</option>
              <option value="sway_beat">ビート揺れ</option>
              <option value="riser">ライザー</option>
            </select>
            <button disabled={beatAudioId === ''}
              onClick={async () => {
                if (!activeProject || beatAudioId === '') return
                try {
                  const r = await generationApi.beatCamera({
                    project_id: activeProject.id, audio_asset_id: Number(beatAudioId),
                    start_sec: beatRange.start, end_sec: beatRange.end, style: beatStyle })
                  setCamKeys(r.camera as CamKey[])
                } catch (e: unknown) {
                  setError(e instanceof Error ? e.message : 'ビートカメラ生成エラー')
                }
              }}
              className="px-2 py-1 rounded bg-zinc-700 hover:bg-zinc-600 text-white disabled:opacity-40">
              ♪ ビートから生成
            </button>
          </div>
        </div>
      )}
      <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={2}
        placeholder="anime style, red-haired magical girl with spear, ..."
        className="bg-zinc-800 text-xs text-zinc-100 rounded px-2 py-1.5 resize-none outline-none border border-zinc-700 focus:border-purple-500" />
      <button onClick={submit} disabled={busy || modelId === '' || refId === ''}
        className="w-full py-1.5 rounded bg-purple-800 hover:bg-purple-700 text-white text-xs disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
        🎬 深度→AIレンダ動画を生成（約5秒/81f）
      </button>
    </div>
  )
}
