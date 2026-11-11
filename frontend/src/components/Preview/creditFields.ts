/**
 * 🔤 字幕の静的な地図(文字の形・屈折の向き・ガラスの色…)を backend から取って覚える(設計書 §4・§8.5)。
 *
 *   POST /api/credits/maps {credit, box, content} → KCM1(gzip。ブラウザが解く)
 *     "KCM1" | uint32 LE 頭書きの長さ N | 頭書き JSON(4 バイトの倍数まで空白詰め)| float32 RGBA の絵 7 枚(T0..T6)
 *   キー = creditLook.mapKey(地図の欄 | 枠 | 画面 | maps_version)。覚えるのは 32 枚まで(最近使った順)。
 *   同じキーの取りに行きは 1 本にまとめる。同時に取りに行くのは 2 本まで(近い字幕から)。
 *   パネルで文字や大きさを変えている間は、クリップごとに 250ms 止まってから取りに行く(打っている途中で何度も作らせない)。
 *   取れるまでは、そのクリップの前の地図をそのまま見せる(位置だけの変更なら、前の地図を枠の px で動かして見せる)。
 *   地図が届いたら subscribeCreditMaps の相手(プレビュー)に知らせて描き直してもらう。
 */
import {
  type CreditV1, type CreditMapsHeader, type CreditMeta,
  mapKey, mapKeyNoPos, geometry, registerCreditMeta,
} from './creditLook'

export interface CreditMaps {
  key: string
  header: CreditMapsHeader
  /** T0..T6(W*H*4 float32、行 0 = 上)。empty なら空 */
  tex: Float32Array[]
  bytes: number
}
/** プレビューが使う地図: 地図 + 枠の px でのずらし(位置だけ変えて新しい地図を待っている間) */
export interface CreditMapsUse { maps: CreditMaps; dx: number; dy: number; stale: boolean }

const MAX_CACHE = 40
// 1344 の地図は 1 枚 ≈ 10〜21MB(実測: 'sola' 10.6MB・C32 20.5MB)。13 枚 × 高画質 1344 と軽量 1280 の両方(≈ 320MB)を
// 覚えておけるように。切り替えるたびに取り直し(サーバーで作り直し)にならないように(2026-11-01 の点検)
const MAX_BYTES = 320 * 1024 * 1024
const MAX_INFLIGHT = 2
const DEBOUNCE_MS = 250
const RETRY_MS = 5000

const cache = new Map<string, CreditMaps>()                 // 最近使った順(後ろほど新しい)
const inflight = new Map<string, Promise<CreditMaps | null>>()
const failed = new Map<string, { at: number; msg: string }>()
interface Want { key: string; body: string; prio: number }
const queue: Want[] = []
let running = 0
const subs = new Set<() => void>()
/** クリップごと: 最後に見せた地図(取れるまでの代わり)と、待っている取りに行き */
const lastByClip = new Map<number, { maps: CreditMaps; credit: CreditV1; noPos: string }>()
const timers = new Map<number, { key: string; t: ReturnType<typeof setTimeout> }>()
const wantByClip = new Map<number, string>()                 // クリップごとに最後に欲しがったキー(失敗の知らせ用)
let lastError = ''

/** 地図が届いた・失敗したときに呼ぶ相手を足す(戻り値で外す) */
export function subscribeCreditMaps(f: () => void): () => void {
  subs.add(f)
  return () => { subs.delete(f) }
}
let version = 0
const notify = () => { version++; for (const f of subs) { try { f() } catch { /* 描き直しの頼みだけ */ } } }
/** 地図が届く・失敗するたびに増える数(useSyncExternalStore 用) */
export const creditMapsVersion = (): number => version
/** 直近の地図の失敗(フォントが無いなど)。'' = なし */
export const creditMapsError = (): string => lastError
/** このクリップの今の字幕の地図の失敗('' = なし) */
export function creditMapsErrorFor(clipId: number): string {
  const k = wantByClip.get(clipId)
  return (k && failed.get(k)?.msg) || ''
}
export const creditMapsBusy = (): number => running + queue.length

/** KCM1 を読む(頭書き + float32 の絵 7 枚。絵は ArrayBuffer をそのまま見る = 写さない) */
export function parseKCM1(buf: ArrayBuffer): { header: CreditMapsHeader; tex: Float32Array[] } {
  const dv = new DataView(buf)
  if (buf.byteLength < 8) throw new Error('地図が短すぎます')
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3))
  if (magic !== 'KCM1') throw new Error(`地図の形式が違います(${magic})`)
  const n = dv.getUint32(4, true)
  if (8 + n > buf.byteLength) throw new Error('地図の頭書きが切れています')
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, n))) as CreditMapsHeader
  const tex: Float32Array[] = []
  if (!header.empty && header.W > 0 && header.H > 0) {
    const per = header.W * header.H * 4
    const names = Array.isArray(header.textures) && header.textures.length ? header.textures.length : 7
    let off = 8 + n
    if (off % 4 !== 0) throw new Error('地図の並びが 4 バイトにそろっていません')
    for (let t = 0; t < names; t++) {
      if (off + per * 4 > buf.byteLength) throw new Error('地図の絵が切れています')
      tex.push(new Float32Array(buf, off, per))
      off += per * 4
    }
    if (tex.length < 7) throw new Error('地図の絵が足りません')
  }
  return { header, tex }
}

function touch(key: string, m: CreditMaps) { cache.delete(key); cache.set(key, m) }
function store(key: string, m: CreditMaps) {
  touch(key, m)
  let bytes = 0
  for (const v of cache.values()) bytes += v.bytes
  while (cache.size > 1 && (cache.size > MAX_CACHE || bytes > MAX_BYTES)) {
    const k0 = cache.keys().next().value as string
    bytes -= cache.get(k0)?.bytes ?? 0
    cache.delete(k0)
  }
}

async function fetchMaps(key: string, body: string): Promise<CreditMaps | null> {
  const r = await fetch('/api/credits/maps', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
  if (!r.ok) {
    let msg = `地図を作れませんでした(${r.status})`
    try { const j = await r.json(); if (typeof j?.detail === 'string') msg = j.detail } catch { /* 本文なし */ }
    throw new Error(msg)
  }
  const buf = await r.arrayBuffer()
  const { header, tex } = parseKCM1(buf)
  return { key, header, tex, bytes: buf.byteLength }
}

function pump() {
  queue.sort((a, b) => a.prio - b.prio)
  while (running < MAX_INFLIGHT && queue.length) {
    const w = queue.shift()!
    if (cache.has(w.key) || inflight.has(w.key)) continue
    running++
    const p = fetchMaps(w.key, w.body)
      .then(m => { if (m) { store(w.key, m); failed.delete(w.key); lastError = '' } return m })
      .catch(e => { const msg = String((e as Error)?.message ?? e); failed.set(w.key, { at: Date.now(), msg }); lastError = msg; return null })
      .finally(() => { running--; inflight.delete(w.key); notify(); pump() })
    inflight.set(w.key, p)
  }
}

function request(key: string, body: string, prio: number) {
  if (cache.has(key) || inflight.has(key)) return
  const f = failed.get(key)
  if (f && Date.now() - f.at < RETRY_MS) return
  const q = queue.find(x => x.key === key)
  if (q) { q.prio = Math.min(q.prio, prio); return }
  queue.push({ key, body, prio })
  pump()
}

const bodyOf = (credit: CreditV1, box: readonly [number, number], content: readonly [number, number]) =>
  JSON.stringify({ credit, box: [box[0], box[1]], content: [content[0], content[1]] })

/**
 * プレビューの 1 コマ: このクリップの地図(無ければ取りに行き、取れるまでは前の地図)。何も無ければ null。
 * clipId はクリップごとの「前の地図」と取りに行きの間引きに使う。debounce = 250ms 止まってから取りに行く(パネルで編集中)
 */
export function creditMapsFor(clipId: number, credit: CreditV1, box: readonly [number, number], content: readonly [number, number],
                              opts: { debounce?: boolean } = {}): CreditMapsUse | null {
  const key = mapKey(credit, box, content)
  wantByClip.set(clipId, key)
  // 今の字幕で地図を作れなかった(大きすぎる・フォントが無い): 前の文字のまま描き続けると、書き出しと食い違う
  // (書き出しはこの字幕を入れられない)。描かずに知らせる(パネル・タイムラインのクリップに ⚠)。5 秒ごとに作り直しを試す
  if (failed.has(key) && !cache.has(key)) {
    request(key, bodyOf(credit, box, content), 0)
    return null
  }
  const hit = cache.get(key)
  if (hit) {
    touch(key, hit)
    lastByClip.set(clipId, { maps: hit, credit, noPos: mapKeyNoPos(credit, box, content) })
    const tm = timers.get(clipId)
    if (tm) { clearTimeout(tm.t); timers.delete(clipId) }
    return { maps: hit, dx: 0, dy: 0, stale: false }
  }
  // 取りに行く(編集中は止まってから)
  const body = bodyOf(credit, box, content)
  const prev = lastByClip.get(clipId)
  if (opts.debounce && prev && !inflight.has(key)) {
    const tm = timers.get(clipId)
    if (!tm || tm.key !== key) {
      if (tm) clearTimeout(tm.t)
      timers.set(clipId, { key, t: setTimeout(() => { timers.delete(clipId); request(key, body, 0) }, DEBOUNCE_MS) })
    }
  } else {
    request(key, body, 0)
  }
  if (!prev) return null
  // 前の地図の枠・画面が今と同じときだけ使う(軽量 ⇔ 高画質を切り替えた直後は描かない)
  const ph = prev.maps.header
  if (ph.box?.[0] !== box[0] || ph.box?.[1] !== box[1]) return null
  let dx = 0, dy = 0
  if (prev.noPos === mapKeyNoPos(credit, box, content)) {
    // 位置だけ変わった: 前の地図を動かす(枠の px に丸める)
    const G = geometry(box, content)
    dx = Math.round((credit.pos[0] - prev.credit.pos[0]) * G.K)
    dy = Math.round((credit.pos[1] - prev.credit.pos[1]) * G.K)
  }
  return { maps: prev.maps, dx, dy, stale: true }
}

/** 消えた字幕クリップの「前の地図」・待ち・失敗の印を捨てる(alive = 今ある字幕クリップの id。大きな地図を握り続けない) */
export function pruneCreditClips(alive: ReadonlySet<number>) {
  for (const id of [...lastByClip.keys()]) if (!alive.has(id)) lastByClip.delete(id)
  for (const id of [...wantByClip.keys()]) if (!alive.has(id)) wantByClip.delete(id)
  for (const [id, tm] of [...timers.entries()]) if (!alive.has(id)) { clearTimeout(tm.t); timers.delete(id) }
}

/** 先に取っておく(近い順に prio を小さく)。覚えている・取りに行っているものは飛ばす */
export function prefetchCreditMaps(list: { credit: CreditV1; box: readonly [number, number]; content: readonly [number, number]; prio: number }[]) {
  for (const w of list) {
    if (!w.credit.name) continue
    request(mapKey(w.credit, w.box, w.content), bodyOf(w.credit, w.box, w.content), 10 + w.prio)
  }
}

/** 覚えている地図(テスト・パネル用。取りに行かない) */
export function peekCreditMaps(credit: CreditV1, box: readonly [number, number], content: readonly [number, number]): CreditMaps | null {
  return cache.get(mapKey(credit, box, content)) ?? null
}
/** クリップの最後に見せた地図(パネルの警告・プレビューの枠用) */
export function lastCreditMaps(clipId: number): CreditMaps | null { return lastByClip.get(clipId)?.maps ?? null }
/** クリップの最後に見せた地図と、その地図を作ったときの字幕(位置の差で枠を動かして見せる用) */
export function lastCreditMapsInfo(clipId: number): { maps: CreditMaps; credit: CreditV1 } | null {
  const v = lastByClip.get(clipId)
  return v ? { maps: v.maps, credit: v.credit } : null
}

/** 地図を直接取る(テスト・debug 用。覚える) */
export async function loadCreditMaps(credit: CreditV1, box: readonly [number, number], content: readonly [number, number]): Promise<CreditMaps | null> {
  const key = mapKey(credit, box, content)
  const hit = cache.get(key)
  if (hit) return hit
  const m = await fetchMaps(key, bodyOf(credit, box, content))
  if (m) store(key, m)
  return m
}
/** KCM1 のバイト列から地図を作る(debug: 書き出し側の地図ファイルをそのまま使う) */
export function mapsFromBytes(buf: ArrayBuffer, key = 'bytes'): CreditMaps {
  const { header, tex } = parseKCM1(buf)
  return { key: header.key || key, header, tex, bytes: buf.byteLength }
}

// ── backend の meta(既定値・範囲・フォント)─────────────────────────────
let metaP: Promise<CreditMeta | null> | null = null
/** GET /api/credits/meta を 1 度だけ読んで creditLook に登録する(失敗したら次に呼ばれたとき読み直す。写しで動く) */
export function loadCreditMeta(): Promise<CreditMeta | null> {
  if (!metaP) {
    metaP = fetch('/api/credits/meta')
      .then(r => (r.ok ? r.json() as Promise<CreditMeta> : Promise.reject(new Error(String(r.status)))))
      .then(m => { registerCreditMeta(m); notify(); return m })
      .catch(() => { metaP = null; return null })
  }
  return metaP
}
