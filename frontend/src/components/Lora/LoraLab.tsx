import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api/client'
import { useUIStore } from '../../store/uiStore'

/**
 * 🧪 LoRA Lab — 学習済みLoRAの出来栄えを自分の目で確かめる場所。
 *  左: LoRA/データセット一覧(学習状況)
 *  中: 生成テスト(LoRA+強度 / 強度スイープ / シード違い連射)
 *  右: ギャラリー(条件バッジ付き、クリックで拡大)
 */

interface LoraFile { name: string; size_mb: number; mtime: string }
interface Dataset { name: string; raw_images: number; prepared: boolean; trained: boolean }
interface GalleryItem {
  job_id: number; status: string; progress: number; error: string | null
  asset_ids: number[]; prompt: string; seed: number | null
  lora: string | null; strength: number | null
}

export function LoraLab() {
  const pushToast = useUIStore(s => s.pushToast)
  const [loras, setLoras] = useState<LoraFile[]>([])
  const [datasets, setDatasets] = useState<Dataset[]>([])
  const [items, setItems] = useState<GalleryItem[]>([])
  const [prompt, setPrompt] = useState('1girl, sakura kyoko, mahou shoujo madoka magica, aoki ume, masterpiece, best quality, solo, red hair, red eyes, long hair, ponytail, casual clothes, smile')
  const [lora, setLora] = useState<string>('')
  const [strength, setStrength] = useState(0.8)
  const [sweep, setSweep] = useState(false)
  const [count, setCount] = useState(1)
  const [size, setSize] = useState('832x1216')
  const [seed, setSeed] = useState('')
  const [busy, setBusy] = useState(false)
  const [lightbox, setLightbox] = useState<number | null>(null)

  const load = useCallback(async () => {
    const r = await api.get('/lora/list')
    setLoras(r.data.loras); setDatasets(r.data.datasets)
    const g = await api.get('/lora/gallery')
    setItems(g.data.items)
  }, [])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const t = setInterval(() => { void load() }, 5000)
    return () => clearInterval(t)
  }, [load])

  async function runTest() {
    setBusy(true)
    try {
      const [w, h] = size.split('x').map(Number)
      await api.post('/lora/test', {
        prompt, width: w, height: h,
        seed: seed ? Number(seed) : -1,
        lora: lora || null, strength, sweep: sweep && !!lora, count,
      })
      pushToast(sweep && lora ? '強度スイープ(5枚)を投入しました' : `${count}枚のテスト生成を投入しました`, 'success')
      void load()
    } catch { pushToast('投入に失敗しました', 'error') } finally { setBusy(false) }
  }

  return (
    <div className="flex-1 flex min-h-0 text-sm">
      {/* 左: LoRA / データセット */}
      <div className="w-72 border-r border-zinc-800 overflow-y-auto p-3 space-y-4">
        <div>
          <div className="text-zinc-300 font-bold mb-2">📦 学習済みLoRA</div>
          {!loras.length && <div className="text-xs text-zinc-500">まだありません(lora-kitで学習)</div>}
          {loras.map(l => (
            <button key={l.name} onClick={() => setLora(l.name)}
              className={`w-full text-left px-2 py-1.5 rounded text-xs mb-1 ${lora === l.name ? 'bg-purple-900/60 text-purple-200' : 'hover:bg-zinc-800 text-zinc-300'}`}>
              <div className="font-mono truncate">{l.name}</div>
              <div className="text-zinc-600">{l.size_mb}MB · {l.mtime.replace('T', ' ')}</div>
            </button>
          ))}
        </div>
        <div>
          <div className="text-zinc-300 font-bold mb-2">🗂 データセット</div>
          {!datasets.length && <div className="text-xs text-zinc-500">datasets/&lt;name&gt;/raw/ に画像を置く</div>}
          {datasets.map(d => (
            <div key={d.name} className="px-2 py-1.5 text-xs text-zinc-400">
              <span className="font-mono text-zinc-300">{d.name}</span> — {d.raw_images}枚
              {d.trained ? <span className="text-emerald-400"> ✓学習済</span>
                : d.prepared ? <span className="text-amber-400"> タグ付済</span>
                : <span className="text-zinc-600"> 未処理</span>}
            </div>
          ))}
          <div className="text-[10px] text-zinc-600 mt-1 leading-relaxed">
            学習はCLI: tools/lora-kit/README.md 参照(またはAIに依頼)
          </div>
        </div>
      </div>

      {/* 中: テスト生成フォーム */}
      <div className="w-96 border-r border-zinc-800 overflow-y-auto p-3 space-y-3">
        <div className="text-zinc-300 font-bold">🎨 生成テスト</div>
        <label className="text-xs text-zinc-400 block">プロンプト
          <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={5}
            className="mt-1 w-full bg-zinc-900 border border-zinc-700 rounded p-2 text-[13px]" />
        </label>
        <div className="text-xs text-zinc-400">
          LoRA: <span className="font-mono text-purple-300">{lora || '(なし — ベースモデル素の出力)'}</span>
          {lora && <button onClick={() => setLora('')} className="ml-2 text-zinc-500 hover:text-red-400">解除</button>}
        </div>
        {lora && !sweep && (
          <label className="text-xs text-zinc-400 flex items-center gap-2">強度
            <input type="range" min={0} max={1.2} step={0.05} value={strength}
              onChange={e => setStrength(Number(e.target.value))} className="flex-1 accent-purple-500" />
            <span className="w-10 text-right">{strength.toFixed(2)}</span>
          </label>
        )}
        {lora && (
          <label className="text-xs text-zinc-400 flex items-center gap-2">
            <input type="checkbox" checked={sweep} onChange={e => setSweep(e.target.checked)} />
            強度スイープ(0 / 0.4 / 0.6 / 0.8 / 1.0 の5枚を同シードで比較)
          </label>
        )}
        <div className="flex gap-2">
          <label className="text-xs text-zinc-400 flex-1">サイズ
            <select value={size} onChange={e => setSize(e.target.value)}
              className="mt-1 w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5">
              {['832x1216', '1216x832', '1024x1024'].map(s => <option key={s}>{s}</option>)}
            </select>
          </label>
          <label className="text-xs text-zinc-400 w-24">シード
            <input value={seed} onChange={e => setSeed(e.target.value)} placeholder="-1"
              className="mt-1 w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5" />
          </label>
          {!sweep && (
            <label className="text-xs text-zinc-400 w-20">枚数
              <select value={count} onChange={e => setCount(Number(e.target.value))}
                className="mt-1 w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5">
                {[1, 2, 3, 4, 6].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          )}
        </div>
        <button onClick={() => void runTest()} disabled={busy}
          className="w-full py-2 rounded bg-purple-700 hover:bg-purple-600 disabled:opacity-40 font-bold">
          {sweep && lora ? '🧪 強度スイープ生成' : '🎨 テスト生成'}
        </button>
        <div className="text-[11px] text-zinc-600 leading-relaxed">
          比較のコツ: 同じシードでLoRAあり/なし(強度0)を並べると効きが分かります。
          キャラの同一性はスイープ0.6〜0.8帯を重点確認。
        </div>
      </div>

      {/* 右: ギャラリー */}
      <div className="flex-1 overflow-y-auto p-3">
        <div className="text-zinc-300 font-bold mb-2">🖼 ギャラリー</div>
        <div className="grid grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3">
          {items.map(it => (
            <div key={it.job_id} className="border border-zinc-800 rounded-lg overflow-hidden bg-zinc-900/60">
              {it.status === 'completed' && it.asset_ids[0] ? (
                <img src={`/api/assets/${it.asset_ids[0]}/thumbnail`} alt=""
                  className="w-full aspect-[2/3] object-cover cursor-zoom-in"
                  onClick={() => setLightbox(it.asset_ids[0])} />
              ) : it.status === 'failed' ? (
                <div className="w-full aspect-[2/3] flex items-center justify-center text-red-400 text-xs p-2">{(it.error || '失敗').slice(0, 80)}</div>
              ) : (
                <div className="w-full aspect-[2/3] flex items-center justify-center text-zinc-500 text-xs animate-pulse">
                  ⏳ {Math.round((it.progress ?? 0) * 100)}%
                </div>
              )}
              <div className="p-1.5 text-[10px] text-zinc-400 leading-relaxed">
                {it.lora
                  ? <span className="text-purple-300">{it.lora.replace('.safetensors', '')} @{it.strength}</span>
                  : <span className="text-zinc-500">base</span>}
                <span className="text-zinc-600"> · seed {it.seed}</span>
                <div className="truncate text-zinc-600">{it.prompt}</div>
              </div>
            </div>
          ))}
        </div>
        {!items.length && <div className="text-xs text-zinc-500">まだ生成がありません</div>}
      </div>

      {lightbox && (
        <div className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center p-6" onClick={() => setLightbox(null)}>
          <img src={`/api/assets/${lightbox}/file`} alt="" className="max-w-full max-h-full object-contain" />
        </div>
      )}
    </div>
  )
}
