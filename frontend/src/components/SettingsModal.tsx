import { useEffect, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useUIStore } from '../store/uiStore'

interface SettingsData {
  settings: Record<string, string>
  llm_providers: string[]
  llm_selected: string
}
interface Engine { name: string; port: number; label: string; for: string[]; running: boolean }
interface EnginesData { engines: Engine[]; gpu?: { used_mb: number; total_mb: number; util: number } }

const LLM_PROVIDERS = [
  { id: 'auto', label: '自動' }, { id: 'local', label: 'ローカル(Ollama)' },
  { id: 'anthropic', label: 'Anthropic' }, { id: 'openai', label: 'OpenAI' }, { id: 'gemini', label: 'Gemini' },
]

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<SettingsData | null>(null)
  const [eng, setEng] = useState<EnginesData | null>(null)
  const [localModels, setLocalModels] = useState<string[]>([])
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  const loadSettings = useCallback(() => {
    fetch('/api/settings/').then(r => r.json()).then(setData).catch(() => {})
  }, [])
  const loadEngines = useCallback(() => {
    fetch('/api/engines/').then(r => r.json()).then(setEng).catch(() => {})
  }, [])
  const loadLocalModels = useCallback(() => {
    fetch('/api/engines/llm-models').then(r => r.json()).then(d => setLocalModels(d.models ?? [])).catch(() => {})
  }, [])
  useEffect(() => { loadSettings(); loadEngines(); loadLocalModels() }, [loadSettings, loadEngines, loadLocalModels])

  const val = (k: string) => draft[k] ?? data?.settings[k] ?? ''
  const set = (k: string, v: string) => setDraft(d => ({ ...d, [k]: v }))

  const save = async () => {
    setSaving(true)
    try {
      const r = await fetch('/api/settings/', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: draft }),
      })
      const d = await r.json()
      setData(d); setDraft({})
      useUIStore.getState().pushToast('設定を保存しました', 'success')
    } catch { useUIStore.getState().pushToast('保存に失敗', 'error') } finally { setSaving(false) }
  }

  const engineAction = async (name: string, action: 'start' | 'stop') => {
    useUIStore.getState().pushToast(`${name} を${action === 'start' ? '起動' : '停止'}中…`, 'info')
    try {
      await fetch(`/api/engines/${name}/${action}`, { method: 'POST' })
      setTimeout(loadEngines, 1500)
    } catch { /* */ }
  }

  const inp = 'bg-zinc-800 text-xs text-zinc-100 rounded px-2 py-1.5 outline-none border border-zinc-700 focus:border-purple-500 w-full'
  const isSecret = (k: string) => /API_KEY/.test(k)

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className="relative w-[92vw] max-w-lg max-h-[88vh] overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-900 p-4"
           onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-bold text-purple-300">設定</h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200">✕</button>
        </div>

        {/* LLM */}
        <section className="mb-4">
          <h3 className="text-[11px] text-zinc-500 uppercase tracking-wider mb-2">AI（LLM）</h3>
          <label className="block mb-2">
            <span className="text-[10px] text-zinc-500">プロバイダ{data && <> — 利用可能: {data.llm_providers.join(', ') || 'なし'} / 選択中: {data.llm_selected}</>}</span>
            <select value={val('LLM_PROVIDER')} onChange={e => set('LLM_PROVIDER', e.target.value)} className={inp}>
              {LLM_PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </label>
          {[['ANTHROPIC_API_KEY', 'Anthropic APIキー'], ['OPENAI_API_KEY', 'OpenAI APIキー'], ['GEMINI_API_KEY', 'Gemini APIキー']].map(([k, lbl]) => (
            <label key={k} className="block mb-2">
              <span className="text-[10px] text-zinc-500">{lbl}{data?.settings[k] === '•••設定済み' && '（設定済み）'}</span>
              <input type={isSecret(k) ? 'password' : 'text'} value={draft[k] ?? ''} placeholder={data?.settings[k] || ''}
                onChange={e => set(k, e.target.value)} className={inp} autoComplete="off" />
            </label>
          ))}
          <div className="grid grid-cols-2 gap-2">
            {[['OPENAI_MODEL', 'OpenAIモデル'], ['GEMINI_MODEL', 'Geminiモデル']].map(([k, lbl]) => (
              <label key={k}><span className="text-[10px] text-zinc-500">{lbl}</span>
                <input value={val(k)} onChange={e => set(k, e.target.value)} className={inp} /></label>
            ))}
          </div>
          <label className="block mt-2">
            <span className="text-[10px] text-zinc-500">ローカルモデル（Ollama・インストール済みから選択）</span>
            {localModels.length > 0 ? (
              <select value={val('OLLAMA_MODEL')} onChange={e => set('OLLAMA_MODEL', e.target.value)} className={inp}>
                {/* current value may omit the :latest tag the registry reports → match loosely */}
                {!localModels.some(m => m.replace(/:latest$/, '') === val('OLLAMA_MODEL').replace(/:latest$/, '')) && val('OLLAMA_MODEL') && (
                  <option value={val('OLLAMA_MODEL')}>{val('OLLAMA_MODEL')}（未DL）</option>
                )}
                {localModels.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            ) : (
              <input value={val('OLLAMA_MODEL')} onChange={e => set('OLLAMA_MODEL', e.target.value)} className={inp}
                placeholder="例: nemotron-nano" />
            )}
          </label>
        </section>

        {/* TTS */}
        <section className="mb-4">
          <h3 className="text-[11px] text-zinc-500 uppercase tracking-wider mb-2">音声（TTS）</h3>
          <div className="grid grid-cols-3 gap-2">
            <label><span className="text-[10px] text-zinc-500">日本語の声(参照名)</span>
              <input value={val('TTS_DEFAULT_VOICE')} onChange={e => set('TTS_DEFAULT_VOICE', e.target.value)} className={inp} /></label>
            <label><span className="text-[10px] text-zinc-500">英語TTS</span>
              <select value={val('EN_TTS_PROVIDER')} onChange={e => set('EN_TTS_PROVIDER', e.target.value)} className={inp}>
                <option value="openai">OpenAI</option><option value="none">なし</option>
              </select></label>
            <label><span className="text-[10px] text-zinc-500">英語の声</span>
              <input value={val('EN_TTS_VOICE')} onChange={e => set('EN_TTS_VOICE', e.target.value)} className={inp} /></label>
          </div>
          <p className="text-[10px] text-zinc-600 mt-1">英語はOpenAI TTSへ、日本語はIrodoriへ自動振り分け（混在文も分割合成）。英語TTSにはOpenAIキーが必要。</p>
        </section>

        <button onClick={save} disabled={saving || !Object.keys(draft).length}
          className="w-full bg-purple-700 hover:bg-purple-600 text-white text-xs rounded py-2 font-medium disabled:opacity-40 mb-4">
          {saving ? '保存中…' : '設定を保存'}
        </button>

        {/* Engines */}
        <section>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-[11px] text-zinc-500 uppercase tracking-wider">ローカルエンジン</h3>
            {eng?.gpu && (
              <span className="text-[10px] text-zinc-500">
                GPU {Math.round(eng.gpu.used_mb / 1024)}/{Math.round(eng.gpu.total_mb / 1024)}GB・{eng.gpu.util}%
              </span>
            )}
          </div>
          <div className="flex flex-col gap-1">
            {eng?.engines.map(e => (
              <div key={e.name} className="flex items-center gap-2 bg-zinc-950 rounded px-2 py-1.5 border border-zinc-800">
                <span className={`w-2 h-2 rounded-full ${e.running ? 'bg-green-500' : 'bg-zinc-600'}`} />
                <span className="text-[11px] text-zinc-300 flex-1 truncate">{e.label}</span>
                <span className="text-[9px] text-zinc-600">{e.for.join('/')}</span>
                <button onClick={() => engineAction(e.name, e.running ? 'stop' : 'start')}
                  className={`text-[10px] px-2 py-0.5 rounded ${e.running ? 'bg-zinc-800 text-zinc-300 hover:bg-red-900' : 'bg-purple-800 text-purple-100 hover:bg-purple-700'}`}>
                  {e.running ? '停止' : '起動'}
                </button>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-zinc-600 mt-1">必要なエンジンだけ起動すればVRAM節約になります（待機中のエンジンは推論時のみGPUを使用）。</p>
        </section>
      </div>
    </div>,
    document.body,
  )
}
