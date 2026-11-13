// 🎞 編集画面のキー操作。window の keydown と、プレビュー(iframe)から届く comp:key の両方がここへ来る。

import { useCompStore } from './store'

export interface KeyLike { key: string; code?: string; ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean }

/** 使ったら true(呼んだ側が preventDefault する)。hasTextSelection = 文字を選んでいる最中(Ctrl+C を横取りしない) */
export function handleCompKey(e: KeyLike, hasTextSelection = false): boolean {
  const st = useCompStore.getState()
  if (!st.comp) return false
  if (document.querySelector('[data-comp-asset-picker],[data-comp-settings-dialog]')) return false
  const ctrl = !!(e.ctrl || e.meta)
  const k = e.key
  const big = e.shift ? 10 : 1
  const stepFrame = (d: number) => { st.setPlaying(false); st.setFrame(st.frame + d * big) }
  const canNudge = st.sel.length > 0 && !st.selKeys.length
  if (ctrl && (k === 'z' || k === 'Z')) { if (e.shift) st.redo(); else st.undo() }
  else if (ctrl && (k === 'y' || k === 'Y')) st.redo()
  else if (ctrl && (k === 'd' || k === 'D')) st.duplicateSelection()
  else if (ctrl && (k === 'c' || k === 'C')) { if (hasTextSelection && !st.sel.length && !st.selKeys.length) return false; st.copySelection() }
  else if (ctrl && (k === 'v' || k === 'V')) st.paste()
  else if (ctrl && (k === 's' || k === 'S')) void st.flush()
  else if (ctrl && (k === 'a' || k === 'A')) st.setSel(st.doc.layers.map(l => l.id))
  else if (ctrl || e.alt) return false
  else if (k === ' ') { if (!st.playing && st.frame >= st.settings.duration_frames - 1) st.setFrame(0); st.setPlaying(!st.playing) }
  else if (k === 'Delete' || k === 'Backspace') st.deleteSelection()
  else if (k === '[') st.setInOutAtPlayhead('in')
  else if (k === ']') st.setInOutAtPlayhead('out')
  // ↑↓ = 選んだレイヤーを 1 px(Shift で 10 px)動かす。←→ は、最後に触ったのがプレビューならレイヤーを動かし、そうでなければコマ送り
  else if (k === 'ArrowUp' || k === 'ArrowDown') { if (!canNudge) return false; st.nudge(0, (k === 'ArrowUp' ? -1 : 1) * big) }
  else if (k === 'ArrowLeft' || k === 'ArrowRight') {
    const d = k === 'ArrowLeft' ? -1 : 1
    if (canNudge && st.focusArea === 'preview') st.nudge(d * big, 0)
    else stepFrame(d)
  }
  else if (k === ',' || k === 'PageUp') stepFrame(-1)
  else if (k === '.' || k === 'PageDown') stepFrame(1)
  else if (k === 'Home') { st.setPlaying(false); st.setFrame(0) }
  else if (k === 'End') { st.setPlaying(false); st.setFrame(st.settings.duration_frames - 1) }
  else if (k === 'k' || k === 'K') st.addTransformKeys()
  else if (k === 'Escape') st.setSel([])
  else return false
  return true
}
