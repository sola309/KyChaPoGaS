/**
 * 🔤 字幕の debug の口(URL に ?debug=credit を付けたときだけ。ふだんは何もしない)。
 *   window.__kychaCredit.renderCase(dir, inp): 地図(KCM1)と下の絵(PNG)から、プレビューと同じ CreditRenderer で 1 コマ描き、
 *   地図の範囲の RGB(base64)と、範囲の外で変わった画素の数を返す。GL と numpy(書き出しの式)の突き合わせ用
 *   (frontend/qa_credit_gl.mjs)。
 */
import { CREDIT_DEBUG, installCreditDebug } from './creditUi'
import { CreditRenderer } from './creditGL'
import { mapsFromBytes, lastCreditMaps, creditMapsErrorFor } from './creditFields'
import { normalizeCredit, frameScalars, type CreditClipLike } from './creditLook'
import { useTimelineStore } from '../../store/timelineStore'
import { useProjectStore } from '../../store/projectStore'

interface CaseInput { credit: unknown; clip: CreditClipLike; f: number; fps: number }

function b64(u8: Uint8Array): string {
  let s = ''
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000))
  return btoa(s)
}

async function renderCase(base: string, inp: CaseInput) {
  const kcm = await (await fetch(`${base}/maps.kcm`)).arrayBuffer()
  const maps = mapsFromBytes(kcm)
  const blob = await (await fetch(`${base}/picture.png`)).blob()
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
  const [bw, bh] = maps.header.box
  const cv = document.createElement('canvas'); cv.width = bw; cv.height = bh
  const ctx = cv.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bmp, 0, 0)
  const before = ctx.getImageData(0, 0, bw, bh).data
  const credit = normalizeCredit(inp.credit)
  const sc = frameScalars(credit, maps.header, inp.clip, inp.f, inp.fps)
  const R = new CreditRenderer()
  const t0 = performance.now()
  const ok = R.apply(ctx, cv, { x: 0, y: 0, w: bw, h: bh }, { maps, dx: 0, dy: 0, stale: false }, sc, credit.refract, credit.style.sheen)
  const ms = performance.now() - t0
  const after = ctx.getImageData(0, 0, bw, bh).data
  R.dispose()
  const { x0, y0, W, H } = maps.header
  const reg = new Uint8Array(W * H * 3)
  let outside = 0
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const p = (y * bw + x) * 4
      const inR = x >= x0 && x < x0 + W && y >= y0 && y < y0 + H
      if (inR) {
        const q = ((y - y0) * W + (x - x0)) * 3
        reg[q] = after[p]; reg[q + 1] = after[p + 1]; reg[q + 2] = after[p + 2]
      } else if (after[p] !== before[p] || after[p + 1] !== before[p + 1] || after[p + 2] !== before[p + 2]) outside++
    }
  }
  return { ok, ms, W, H, x0, y0, outside, region: b64(reg), scalars: sc }
}

/** プロジェクトを開く(ヘッドレスの確かめ用) */
async function openProject(id: number) {
  const ps = useProjectStore.getState()
  if (!ps.projects.length) await ps.fetchProjects()
  const p = useProjectStore.getState().projects.find(x => x.id === id)
  if (!p) throw new Error('no project ' + id)
  useProjectStore.getState().setActiveProject(p)
  return { id: p.id, fps: p.fps, w: p.width, h: p.height }
}

/** このクリップの地図がプレビューに届いているか(頭書きの要点)・失敗の文 */
function mapsInfo(clipId: number) {
  const m = lastCreditMaps(clipId)
  return { ready: !!m, err: creditMapsErrorFor(clipId), header: m ? { box: m.header.box, x0: m.header.x0, y0: m.header.y0, W: m.header.W, H: m.header.H, ink: m.header.ink_box_box, build_ms: m.header.build_ms } : null }
}

if (CREDIT_DEBUG) installCreditDebug({ renderCase, openProject, mapsInfo, timeline: useTimelineStore, projectStore: useProjectStore })
