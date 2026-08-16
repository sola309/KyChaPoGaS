import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, assetsApi } from '../api/client'

/**
 * 📖 キャスト名簿 — 制作バイブルのキャラクター定義を閲覧・編集するパネル。
 *
 * レイアウトは左=キャラ一覧 / 右=選択キャラの詳細(マスター/ディテール)。
 * 参照画像は衣装ごとの可変長リスト(refs)で、増えてもグリッドで並ぶだけなので破綻しない。
 *
 * データ2層: 🌐共通 /projects/0/bible ・ 📁プロジェクト /projects/{id}/bible(同keyは後者優先)
 * refs[].use: primary=生成の第一候補 / alt=構図次第の代替 / view=閲覧専用
 */

interface CastRef { asset: number; label?: string; view?: string; use?: 'primary' | 'alt' | 'view'; notes?: string; caution?: string }
interface Outfit { label?: string; description_en?: string; refs?: CastRef[] }
interface CastEntry { key: string; name: string; reading?: string; role?: string; note?: string; outfits: Record<string, Outfit> }
interface Bible { cast?: CastEntry[]; style_rules?: string[]; usage_guide?: string[]; note?: string }

const USE_STYLE: Record<string, { label: string; cls: string }> = {
  primary: { label: '生成◎', cls: 'bg-emerald-900/80 text-emerald-200 border-emerald-600' },
  alt:     { label: '代替',   cls: 'bg-sky-900/80 text-sky-200 border-sky-700' },
  view:    { label: '閲覧',   cls: 'bg-zinc-800 text-zinc-400 border-zinc-600' },
}

export function CastPanel({ projectId, onClose }: { projectId: number; onClose: () => void }) {
  const [scope, setScope] = useState<'global' | 'project'>('global')
  const [globalBible, setGlobalBible] = useState<Bible>({})
  const [projBible, setProjBible] = useState<Bible>({})
  const [selKey, setSelKey] = useState<string | null>(null)
  const [selOutfit, setSelOutfit] = useState<string | null>(null)
  const [zoom, setZoom] = useState<CastRef | null>(null)    // クリックで拡大表示
  const [msg, setMsg] = useState('')

  useEffect(() => {
    void Promise.all([
      api.get<Bible>('/projects/0/bible').then(r => r.data).catch(() => ({})),
      api.get<Bible>(`/projects/${projectId}/bible`).then(r => r.data).catch(() => ({})),
    ]).then(([g, p]) => { setGlobalBible(g ?? {}); setProjBible(p ?? {}) })
  }, [projectId])

  const bible = scope === 'global' ? globalBible : projBible
  const setBible = scope === 'global' ? setGlobalBible : setProjBible
  const cast = useMemo(() => bible.cast ?? [], [bible])
  const sel = cast.find(c => c.key === selKey) ?? cast[0] ?? null
  const outfitKeys = sel ? Object.keys(sel.outfits) : []
  const curOutfit = sel ? (selOutfit && sel.outfits[selOutfit] ? selOutfit : outfitKeys[0]) : null
  const outfit = sel && curOutfit ? sel.outfits[curOutfit] : null

  const save = async (next: Bible) => {
    const pid = scope === 'global' ? 0 : projectId
    await api.put(`/projects/${pid}/bible`, { ...next, updated: new Date().toISOString().slice(0, 10) })
    setBible(next)
    setMsg('💾 保存しました' + (scope === 'global' ? '(全プロジェクトに反映)' : ''))
  }
  const updateEntry = (key: string, fn: (e: CastEntry) => CastEntry) =>
    void save({ ...bible, cast: cast.map(e => (e.key === key ? fn(e) : e)) })
  const updateOutfit = (fn: (o: Outfit) => Outfit) => {
    if (!sel || !curOutfit) return
    updateEntry(sel.key, e => ({ ...e, outfits: { ...e.outfits, [curOutfit]: fn(e.outfits[curOutfit]) } }))
  }

  const addCharacter = () => {
    const name = window.prompt('キャラクター名')
    if (!name) return
    const key = window.prompt('英字キー(識別子)', name.toLowerCase().replace(/\W+/g, '_'))
    if (!key) return
    void save({ ...bible, cast: [...cast, { key, name, role: '', note: '', outfits: {} }] })
    setSelKey(key)
  }
  const addRef = () => {
    const aid = Number(window.prompt('参照画像のアセットID'))
    if (!(aid > 0)) return
    const label = window.prompt('ラベル(例: 立ち絵(透過) / シート切り出し / 多視点シート)', '立ち絵(透過)') ?? ''
    const use = (window.prompt('用途: 1=生成の第一候補 / 2=構図次第の代替 / 3=閲覧専用', '2') ?? '2').trim()
    updateOutfit(o => ({ ...o, refs: [...(o.refs ?? []),
      { asset: aid, label, use: use === '1' ? 'primary' : use === '3' ? 'view' : 'alt' }] }))
  }

  const overridden = useMemo(() =>
    scope === 'global' ? new Set((projBible.cast ?? []).map(e => e.key)) : new Set<string>(),
  [scope, projBible])

  return createPortal(
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/70 p-2 sm:p-6" onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
           className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-[min(980px,97vw)] h-[min(680px,92vh)] flex flex-col text-xs text-zinc-300 overflow-hidden">

        {/* ヘッダ */}
        <div className="flex items-center gap-3 px-4 py-2.5 border-b border-zinc-800 flex-shrink-0">
          <b className="text-sm">📖 キャスト名簿</b>
          <div className="flex rounded overflow-hidden border border-zinc-700">
            <button onClick={() => setScope('global')}
                    className={`px-2.5 py-1 ${scope === 'global' ? 'bg-indigo-800 text-indigo-100' : 'bg-zinc-800 text-zinc-500 hover:text-zinc-300'}`}
                    title="全プロジェクト共通">🌐 共通</button>
            <button onClick={() => setScope('project')}
                    className={`px-2.5 py-1 ${scope === 'project' ? 'bg-emerald-800 text-emerald-100' : 'bg-zinc-800 text-zinc-500 hover:text-zinc-300'}`}
                    title="このプロジェクト固有(同keyなら共通より優先)">📁 個別</button>
          </div>
          {msg && <span className="text-emerald-400">{msg}</span>}
          <button onClick={onClose} className="ml-auto text-zinc-400 hover:text-zinc-100 text-lg leading-none px-1">✕</button>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* 左: キャラ一覧 */}
          <div className="w-44 flex-shrink-0 border-r border-zinc-800 overflow-y-auto flex flex-col">
            {cast.map(e => {
              const face = Object.values(e.outfits)[0]?.refs?.find(r => r.use === 'primary')?.asset
              return (
                <button key={e.key} onClick={() => { setSelKey(e.key); setSelOutfit(null) }}
                        className={`flex items-center gap-2 px-2.5 py-2 text-left border-b border-zinc-800/50
                          ${sel?.key === e.key ? 'bg-zinc-800 text-zinc-100' : 'hover:bg-zinc-800/40 text-zinc-400'}`}>
                  {face
                    ? <img src={assetsApi.thumbnailUrl(face)} alt="" className="w-9 h-9 object-contain rounded bg-zinc-950 flex-shrink-0" />
                    : <span className="w-9 h-9 rounded bg-zinc-950 flex items-center justify-center text-zinc-700 flex-shrink-0">?</span>}
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{e.name}</span>
                    <span className="block truncate text-[10px] text-zinc-600">
                      {e.role}{overridden.has(e.key) && ' ⚠上書きあり'}
                    </span>
                  </span>
                </button>
              )
            })}
            <button onClick={addCharacter}
                    className="px-2.5 py-2 text-left text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/40">➕ キャラ追加</button>
            {scope === 'project' && cast.length === 0 && (
              <p className="p-2.5 text-zinc-600">個別キャラなし。共通(🌐)はそのまま使えます。上書きは同keyで追加。</p>
            )}
          </div>

          {/* 右: 詳細 */}
          <div className="flex-1 min-w-0 overflow-y-auto p-3 flex flex-col gap-3">
            {!sel && <p className="text-zinc-600">左からキャラクターを選択してください。</p>}
            {sel && (
              <>
                {/* 基本情報 */}
                <div className="flex items-baseline gap-2 flex-wrap">
                  <b className="text-base text-zinc-100">{sel.name}</b>
                  {sel.reading && <span className="text-zinc-500">({sel.reading})</span>}
                  {sel.role && <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">{sel.role}</span>}
                  <button onClick={() => {
                            const name = window.prompt('名前', sel.name); if (name == null) return
                            const reading = window.prompt('読み(任意)', sel.reading ?? '') ?? ''
                            const role = window.prompt('役どころ(任意)', sel.role ?? '') ?? ''
                            updateEntry(sel.key, e => ({ ...e, name: name.trim() || e.name, reading: reading.trim(), role: role.trim() }))
                          }}
                          className="text-zinc-600 hover:text-zinc-300">✏</button>
                  <code className="ml-auto text-zinc-700">{sel.key}</code>
                </div>
                <input defaultValue={sel.note ?? ''} key={sel.key + ':note'}
                       placeholder="メモ(体格・関係性など。例: セルマは紫丁香よりわずかに低い)"
                       onBlur={e => { const v = e.target.value.trim(); if (v !== (sel.note ?? '')) updateEntry(sel.key, x => ({ ...x, note: v })) }}
                       className="bg-zinc-800/60 border border-zinc-800 rounded px-2 py-1 text-zinc-300" />

                {/* 衣装タブ */}
                <div className="flex items-center gap-1 flex-wrap">
                  {outfitKeys.map(ok => (
                    <button key={ok} onClick={() => setSelOutfit(ok)}
                            className={`px-2.5 py-1 rounded-t border-b-2 ${curOutfit === ok
                              ? 'border-amber-400 text-zinc-100 bg-zinc-800/60' : 'border-transparent text-zinc-500 hover:text-zinc-300'}`}>
                      {sel.outfits[ok].label ?? ok}
                    </button>
                  ))}
                  <button onClick={() => {
                            const ok = window.prompt('衣装キー(例: school / mg / casual)'); if (!ok) return
                            const label = window.prompt('表示名', ok) ?? ok
                            updateEntry(sel.key, e => ({ ...e, outfits: { ...e.outfits, [ok]: { label, refs: [] } } }))
                            setSelOutfit(ok)
                          }}
                          className="px-2 py-1 text-zinc-600 hover:text-zinc-300">➕衣装</button>
                </div>

                {outfit && (
                  <>
                    {/* 参照画像グリッド — 増えても折り返すだけ */}
                    <div className="flex flex-wrap gap-2">
                      {(outfit.refs ?? []).map((r, i) => (
                        <div key={i} className="relative group w-[104px] rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden">
                          <button onClick={() => setZoom(r)} className="block w-full">
                            <img src={assetsApi.thumbnailUrl(r.asset)} alt="" className="w-full h-28 object-contain" />
                          </button>
                          <div className="px-1.5 py-1 flex flex-col gap-0.5">
                            <span className={`self-start text-[9px] px-1 rounded border ${USE_STYLE[r.use ?? 'alt'].cls}`}>
                              {USE_STYLE[r.use ?? 'alt'].label}{r.caution && ' ⚠'}
                            </span>
                            <span className="text-[9px] text-zinc-400 truncate" title={`#${r.asset} ${r.label ?? ''} ${r.view ?? ''}`}>
                              {r.label ?? `#${r.asset}`}{r.view ? `・${r.view}` : ''}
                            </span>
                          </div>
                          <div className="absolute top-1 right-1 hidden group-hover:flex gap-0.5">
                            <button title="用途を変更(生成◎→代替→閲覧の順に切替)"
                                    onClick={() => updateOutfit(o => ({ ...o, refs: (o.refs ?? []).map((x, j) => j === i
                                      ? { ...x, use: x.use === 'primary' ? 'alt' : x.use === 'alt' ? 'view' : 'primary' } : x) }))}
                                    className="bg-zinc-800/90 rounded px-1 text-[10px]">🔁</button>
                            <button title="削除"
                                    onClick={() => updateOutfit(o => ({ ...o, refs: (o.refs ?? []).filter((_, j) => j !== i) }))}
                                    className="bg-red-900/90 rounded px-1 text-[10px]">✕</button>
                          </div>
                        </div>
                      ))}
                      <button onClick={addRef}
                              className="w-[104px] h-[152px] rounded-lg border border-dashed border-zinc-700 text-zinc-600 hover:text-zinc-300 hover:border-zinc-500">
                        ➕<br />参照追加
                      </button>
                    </div>

                    {/* 英語記述 */}
                    <div className="flex flex-col gap-1">
                      <span className="text-zinc-500">外見記述(英語・プロンプトの正本)</span>
                      <textarea key={sel.key + ':' + curOutfit} defaultValue={outfit.description_en ?? ''}
                                onBlur={e => { const v = e.target.value.trim()
                                  if (v !== (outfit.description_en ?? '')) updateOutfit(o => ({ ...o, description_en: v })) }}
                                className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-zinc-200 min-h-[7rem] resize-y leading-relaxed" />
                    </div>
                  </>
                )}

                {/* 使い方ガイド */}
                {(bible.usage_guide?.length || globalBible.usage_guide?.length) && (
                  <details className="mt-auto">
                    <summary className="cursor-pointer text-zinc-500 hover:text-zinc-300">📘 リファレンス運用ガイド</summary>
                    <ul className="mt-1.5 flex flex-col gap-1 text-[11px] text-zinc-400 leading-relaxed">
                      {(bible.usage_guide ?? globalBible.usage_guide ?? []).map((s, i) => <li key={i}>{s}</li>)}
                    </ul>
                  </details>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* 拡大プレビュー */}
      {zoom && (
        <div className="fixed inset-0 z-[140] flex items-center justify-center bg-black/80 p-6"
             onClick={e => { e.stopPropagation(); setZoom(null) }}>
          <div className="flex flex-col items-center gap-2 max-w-full max-h-full">
            <img src={assetsApi.fileUrl(zoom.asset)} alt=""
                 className="max-w-[85vw] max-h-[75vh] object-contain rounded bg-zinc-950" />
            <div className="text-xs text-zinc-300 text-center max-w-[70ch]">
              <b>#{zoom.asset}</b> {zoom.label}{zoom.view ? `・${zoom.view}` : ''} — {USE_STYLE[zoom.use ?? 'alt'].label}
              {zoom.notes && <p className="text-zinc-500">{zoom.notes}</p>}
              {zoom.caution && <p className="text-amber-400">⚠ {zoom.caution}</p>}
            </div>
          </div>
        </div>
      )}
    </div>, document.body)
}
