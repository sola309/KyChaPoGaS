// 🎞 右の欄のほかのタブ: プリセット / コンポジションの設定 / JSON。

import { useMemo, useState } from 'react'
import type { CompDoc, Layer, PresetDesc } from './types'
import { updateLayers, validateDoc } from './docOps'
import { useCompStore } from './store'
import { LAYER_PRESETS, TEXT_PRESETS, applySchemaPreset, type BuiltinPreset, type PresetCtx } from './presets'
import { ColorField, NumField, Row, Section, btnCls, inputCls } from './fields'
import { groupBy } from './schema'

// ── プリセット ──────────────────────────────────────────────────────────────

type AnyPreset = { id: string; label: string; group: string; run: (l: Layer, c: PresetCtx) => Layer }

const fromSchema = (list: PresetDesc[]): AnyPreset[] =>
  list.filter(p => p.apply).map(p => ({ id: p.id, label: p.label ?? p.id, group: p.group ?? 'そのほか', run: (l, c) => applySchemaPreset(l, p, c) }))
const fromBuiltin = (list: BuiltinPreset[]): AnyPreset[] => list.map(b => ({ id: b.id, label: b.label, group: b.group, run: b.apply }))
const grouped = (list: AnyPreset[]) => groupBy(list.map(p => [p.id, p] as [string, AnyPreset]), p => p.group)

export function PresetsTab() {
  const sel = useCompStore(s => s.sel)
  const schema = useCompStore(s => s.schema)
  const width = useCompStore(s => s.settings.width)
  const hasText = useCompStore(s => s.sel.some(id => s.doc.layers.find(l => l.id === id)?.type === 'text'))
  const [len, setLen] = useState(15)
  const [dist, setDist] = useState(() => Math.round(width / 4))
  const [fromPlayhead, setFromPlayhead] = useState(false)
  const engineLayer = useMemo(() => grouped(fromSchema(schema.presets.layer)), [schema.presets.layer])
  const engineText = useMemo(() => grouped(fromSchema(schema.presets.text)), [schema.presets.text])
  const builtinLayer = useMemo(() => grouped(fromBuiltin(LAYER_PRESETS)), [])
  const builtinText = useMemo(() => fromBuiltin(TEXT_PRESETS), [])

  const run = (p: AnyPreset, onlyText = false) => {
    const s = useCompStore.getState()
    if (!s.sel.length) return
    const ctx: PresetCtx = { frame: s.frame, len: Math.max(1, Math.round(len)), dist, settings: s.settings, fromPlayhead }
    s.apply(d => updateLayers(d, s.sel, l => (l.locked || (onlyText && l.type !== 'text') ? l : p.run(l, ctx))))
  }
  const buttons = (items: [string, AnyPreset][], disabled: boolean, onlyText = false) => (
    <div className="flex flex-wrap gap-1">
      {items.map(([, p]) => <button key={p.id} data-preset={p.id} className={btnCls} disabled={disabled} onClick={() => run(p, onlyText)}>{p.label}</button>)}
    </div>
  )

  return (
    <div className="flex-1 overflow-y-auto" onPointerDownCapture={() => useCompStore.getState().setFocusArea('panel')}>
      {!sel.length && <div className="p-3 text-[11px] text-amber-300/80 border-b border-zinc-800">レイヤーを選んでください。</div>}
      {engineLayer.length > 0 && (<>
        <div className="px-2 py-1.5 text-[10px] text-zinc-400 border-b border-zinc-800 leading-relaxed bg-zinc-900/60">
          <b className="text-zinc-200">エンジンのプリセット</b> — 登場・退場・エフェクトの組・複製を足します(「プロパティ」で直せます)。
          <label className="flex items-center gap-1 mt-1" title="キーフレームつきのプリセット(下から飛び込む・ゆっくり流れる など)の時刻の起点">
            <input type="checkbox" checked={fromPlayhead} onChange={e => setFromPlayhead(e.target.checked)} data-preset-from-playhead />
            キーの時刻を再生位置から数える(切 = レイヤーの頭から)
          </label>
        </div>
        {engineLayer.map(([g, items]) => <Section key={`e:${g}`} title={g || 'そのほか'}>{buttons(items, !sel.length)}</Section>)}
        {engineText.map(([g, items]) => <Section key={`et:${g}`} title={`テキスト: ${g || 'そのほか'}`}>{buttons(items, !hasText, true)}</Section>)}
      </>)}
      <div className="px-2 py-1.5 text-[10px] text-zinc-400 border-y border-zinc-800 leading-relaxed bg-zinc-900/60">
        <b className="text-zinc-200">キーフレームを書くプリセット</b> — 選んだレイヤーの変形に、<b className="text-zinc-200">再生位置から</b>ふつうのキーを書きます。
        <div className="flex items-center gap-2 mt-1">
          <span>長さ</span><NumField value={len} min={1} step={1} onChange={setLen} prefix="f" />
          <span>距離</span><NumField value={dist} min={0} step={5} onChange={setDist} prefix="px" className="w-[72px]" />
        </div>
      </div>
      {builtinLayer.map(([g, items]) => <Section key={g} title={g || 'アニメーション'}>{buttons(items, !sel.length)}</Section>)}
      <Section title="テキスト: 1 文字ずつ">
        {buttons(builtinText.map(p => [p.id, p] as [string, AnyPreset]), !hasText, true)}
        {!hasText && <div className="text-[10px] text-zinc-600">テキストのレイヤーを選ぶと使えます。細かい値は「プロパティ → 中身 → 文字ごとアニメ」で。</div>}
      </Section>
    </div>
  )
}

// ── コンポジションの設定 ──────────────────────────────────────────────────────

export function SettingsTab() {
  const settings = useCompStore(s => s.settings)
  const bg = useCompStore(s => s.doc.bg)
  const comp = useCompStore(s => s.comp)
  const setSettings = useCompStore(s => s.setSettings)
  const rename = useCompStore(s => s.rename)
  const end = useCompStore(s => s.endCoalesce)
  const [name, setName] = useState<string | null>(null)     // 入力中だけ持つ
  return (
    <div className="flex-1 overflow-y-auto">
      <Section title="コンポジションの設定">
        <Row label="名前">
          <input className={`${inputCls} flex-1`} value={name ?? comp?.name ?? ''} onChange={e => setName(e.target.value)}
                 onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                 onBlur={() => { if (name != null) void rename(name); setName(null) }} />
        </Row>
        <Row label="大きさ(px)">
          <NumField prefix="W" value={settings.width} min={2} max={8192} step={2} onEnd={end} onChange={v => setSettings({ width: v })} />
          <NumField prefix="H" value={settings.height} min={2} max={8192} step={2} onEnd={end} onChange={v => setSettings({ height: v })} />
        </Row>
        <Row label="fps">
          <NumField value={settings.fps} min={1} max={120} step={1} onEnd={end} onChange={v => setSettings({ fps: v })} />
        </Row>
        <Row label="長さ(コマ)">
          <NumField value={settings.duration_frames} min={1} max={100000} step={1} onEnd={end} onChange={v => setSettings({ duration_frames: v })} />
          <span className="text-[10px] text-zinc-500">{(settings.duration_frames / settings.fps).toFixed(2)} 秒</span>
        </Row>
        <Row label="背景" title="チェックなし = 透明(アルファつきで描き出す)">
          <ColorField value={bg ?? null} nullable fallback="#000000" onChange={v => setSettings({}, v)} onEnd={end} />
          {bg == null && <span className="text-[10px] text-zinc-500">透明</span>}
        </Row>
      </Section>
      {comp && (
        <div className="px-3 py-2 text-[10px] text-zinc-500 leading-relaxed">
          id {comp.id} / 版 r{comp.rev}(描き出し済みは r{comp.rendered_rev || '—'})<br />
          大きさ・fps・長さを変えると、すでにあるレイヤーの位置やキーの時刻はそのままです。
        </div>
      )}
    </div>
  )
}

// ── JSON ────────────────────────────────────────────────────────────────────

export function JsonTab() {
  const doc = useCompStore(s => s.doc)
  const commit = useCompStore(s => s.commit)
  const text = useMemo(() => JSON.stringify(doc, null, 1), [doc])
  const [draft, setDraft] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const dirty = draft != null && draft !== text

  const check = (src: string): { doc?: CompDoc; err?: string } => {
    try {
      const v = JSON.parse(src)
      const bad = validateDoc(v)
      return bad ? { err: bad } : { doc: v as CompDoc }
    } catch (e) {
      const msg = (e as Error).message
      const m = /position (\d+)/.exec(msg)
      if (m) {
        const pos = +m[1]
        const line = src.slice(0, pos).split('\n').length
        return { err: `JSON の書き方の誤り(${line} 行目あたり): ${msg}` }
      }
      return { err: `JSON の書き方の誤り: ${msg}` }
    }
  }
  const apply = () => {
    if (draft == null) return
    const r = check(draft)
    if (r.err || !r.doc) { setErr(r.err ?? '不明な誤り'); return }
    setErr(null)
    commit(r.doc)
    setDraft(null)
  }
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-2 py-1 flex items-center gap-2 border-b border-zinc-800 flex-shrink-0">
        <span className="text-[10px] text-zinc-500 flex-1">文書(data)そのもの。直して「適用」で反映(取り消せます)</span>
        <button className={btnCls} disabled={!dirty} onClick={() => { setDraft(null); setErr(null) }}>戻す</button>
        <button className={`${btnCls} ${dirty ? 'border-purple-500 text-purple-200' : ''}`} disabled={!dirty} onClick={apply} data-json-apply>適用</button>
      </div>
      {err && <div className="px-2 py-1 text-[11px] text-red-300 bg-red-950/60 border-b border-red-900 flex-shrink-0" data-json-error>⚠ {err}</div>}
      <textarea
        data-json-text
        spellCheck={false}
        className="flex-1 min-h-0 w-full bg-zinc-950 text-zinc-200 text-[11px] font-mono p-2 outline-none resize-none"
        value={draft ?? text}
        onChange={e => { setDraft(e.target.value); if (err) setErr(check(e.target.value).err ?? null) }}
        onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); apply() } }}
      />
    </div>
  )
}
