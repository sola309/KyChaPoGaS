// Layer outliner — shows the video layer stack front→back so the compositing
// structure is legible at a glance. Click a layer to select its clip at the
// playhead; the 👁 toggle hides a layer in the PREVIEW only (declutter / lighten
// while editing — the render always includes it). Mirrors the compositor order
// (higher track.order = drawn later = frontmost).

import { useTimelineStore } from '../../store/timelineStore'
import { parseTransform } from '../Preview/transformEval'
import type { Asset } from '../../api/client'

interface Props { assets: Asset[] }

function transformBadge(raw: string): string | null {
  const d = parseTransform(raw)
  if (!d) return null
  if ((d.keyframes?.length ?? 0) > 0 || d.shake) return 'アニメ'
  const moved = (d.scale != null && d.scale !== 1) || d.x || d.y || d.rotation
  return moved ? '変形' : null
}

export function LayerPanel({ assets }: Props) {
  const { tracks, clips, currentFrame, selectedClipId, setSelectedClipId,
          previewHidden, toggleTrackHidden } = useTimelineStore()

  // front → back = descending order (compositor draws ascending, last = front)
  const layers = tracks.filter(t => t.track_type === 'video').sort((a, b) => b.order - a.order)

  if (!layers.length) {
    return <div className="p-4 text-[11px] text-zinc-600">映像トラックがありません。</div>
  }

  return (
    <div className="h-full overflow-y-auto p-2 space-y-1">
      <div className="text-[10px] text-zinc-600 px-1 pb-1">前面 ↑ ／ 背面 ↓（上のレイヤーが手前）</div>
      {layers.map((tr, i) => {
        const clip = clips.filter(c => c.track_id === tr.id)
          .find(c => c.start_frame <= currentFrame && c.start_frame + c.duration_frames > currentFrame)
        const asset = clip?.asset_id != null ? assets.find(a => a.id === clip.asset_id) : null
        const selected = clip && clip.id === selectedClipId
        const hidden = previewHidden.includes(tr.id)
        const badge = clip ? transformBadge(clip.transform_json ?? '') : null
        const op = clip?.opacity ?? 1
        return (
          <div
            key={tr.id}
            onClick={() => clip && setSelectedClipId(clip.id)}
            className={`flex items-center gap-2 rounded px-2 py-1.5 cursor-pointer border ${
              selected ? 'bg-purple-900/40 border-purple-700'
                : 'bg-zinc-800/40 border-transparent hover:bg-zinc-800'
            } ${hidden ? 'opacity-45' : ''}`}
          >
            {/* preview-visibility eye */}
            <button
              onClick={e => { e.stopPropagation(); toggleTrackHidden(tr.id) }}
              className="text-xs w-4 flex-shrink-0 text-zinc-400 hover:text-white"
              title={hidden ? 'プレビューに表示（書き出しは常に含む）' : 'プレビューで非表示（書き出しは含む）'}
            >{hidden ? '🚫' : '👁'}</button>
            {/* front-index */}
            <span className="text-[9px] text-zinc-600 w-4 text-center flex-shrink-0">{i + 1}</span>
            {/* thumbnail */}
            <div className="w-10 h-6 rounded bg-zinc-900 overflow-hidden flex-shrink-0 flex items-center justify-center">
              {asset && (asset.asset_type === 'image' || (asset.asset_type === 'generated' && asset.duration_sec == null))
                ? <img src={`/api/assets/${asset.id}/file`} className="w-full h-full object-cover" alt="" />
                : <span className="text-[8px] text-zinc-600">{asset ? '動画' : '—'}</span>}
            </div>
            {/* name + meta */}
            <div className="flex-1 min-w-0">
              <div className="text-[11px] text-zinc-200 truncate leading-tight">{tr.name}</div>
              <div className="text-[9px] text-zinc-500 truncate leading-tight">
                {clip ? (asset?.name ?? 'クリップ') : '空'}
              </div>
            </div>
            {/* badges */}
            <div className="flex flex-col items-end gap-0.5 flex-shrink-0">
              {badge && <span className="text-[8px] px-1 rounded bg-amber-900/60 text-amber-300">{badge}</span>}
              {op < 1 && <span className="text-[8px] text-zinc-500">{Math.round(op * 100)}%</span>}
              {clip?.blend && clip.blend !== 'normal' && (
                <span className="text-[8px] text-sky-400">{clip.blend}</span>
              )}
            </div>
          </div>
        )
      })}
      <p className="text-[9px] text-zinc-600 px-1 pt-1 leading-tight">
        👁 はプレビュー表示の切替（重い層を隠して軽量化）。書き出しには影響しません。
      </p>
    </div>
  )
}
