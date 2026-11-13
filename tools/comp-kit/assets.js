// 素材の読み込み(画像・動画・素材の情報)。読み込み中は何も描かず、終わったら invalidate で描き直す。
// capture では pending に積んだ Promise を renderFrame が待つ。
import { THREE } from './gfx.js'

export function canvasTexture(canvas) {
  const t = new THREE.CanvasTexture(canvas)
  setupTex(t, true)
  return t
}
function setupTex(t, mip) {
  t.flipY = false
  t.premultiplyAlpha = true
  t.colorSpace = THREE.NoColorSpace
  t.generateMipmaps = mip
  t.minFilter = mip ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter
  t.magFilter = THREE.LinearFilter
  t.anisotropy = mip ? 4 : 1 // 3D で斜めから見たときの線のちらつきを抑える
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping
  t.needsUpdate = true
}

const MAX_FRAMES = 8 // capture で持っておく動画のコマ数(コマごとに入れ替わるので少なくてよい)

export class Assets {
  constructor(env) {
    this.env = env
    this.images = new Map()
    this.metas = new Map()
    this.videos = new Map()
    this.tick = 0
  }

  // 画像。transient = 動画のコマ(古いものから捨てる)
  image(url, transient = false) {
    let e = this.images.get(url)
    if (!e) {
      e = { state: 'loading', tex: null, w: 0, h: 0, transient, used: 0, promise: null }
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.decoding = 'sync'
      e.promise = new Promise((res) => {
        img.onload = () => {
          const fin = () => {
            e.w = img.naturalWidth; e.h = img.naturalHeight
            e.tex = new THREE.Texture(img)
            setupTex(e.tex, !transient)
            e.state = 'ready'
            res(); this.env.invalidate()
          }
          img.decode ? img.decode().then(fin, fin) : fin()
        }
        img.onerror = () => {
          e.state = 'error'
          console.warn('[comp-engine] 画像を読めない:', url)
          res()
        }
      })
      img.src = url
      this.images.set(url, e)
      if (transient) this.evict()
    }
    e.used = ++this.tick
    if (e.state === 'loading') this.env.pending.push(e.promise)
    return e
  }
  evict() {
    const list = [...this.images.entries()].filter(([, e]) => e.transient)
    if (list.length <= MAX_FRAMES) return
    list.sort((a, b) => a[1].used - b[1].used)
    for (const [url, e] of list.slice(0, list.length - MAX_FRAMES)) {
      if (e.state === 'loading') continue
      e.tex?.dispose()
      this.images.delete(url)
    }
  }

  // 素材の情報(幅・高さ・長さ)
  meta(assetId) {
    let e = this.metas.get(assetId)
    if (!e) {
      e = { state: 'loading', data: null, promise: null }
      const get = this.env.opts.assetMeta || ((id) => fetch(`${this.env.apiBase}/api/assets/${id}`).then((r) => (r.ok ? r.json() : null)))
      e.promise = Promise.resolve().then(() => get(assetId)).then(
        (d) => { e.data = d; e.state = d ? 'ready' : 'error'; this.env.invalidate() },
        () => { e.state = 'error' })
      this.metas.set(assetId, e)
    }
    if (e.state === 'loading') this.env.pending.push(e.promise)
    return e
  }

  // プレビュー用の <video>。レイヤーごとに 1 つ(同じ素材を別の時刻で置けるように)
  video(key, url) {
    let e = this.videos.get(key)
    if (e && e.url !== url) { this.dropVideo(key); e = null }
    if (!e) {
      const v = document.createElement('video')
      v.crossOrigin = 'anonymous'; v.muted = true; v.playsInline = true; v.preload = 'auto'
      v.src = url
      // VideoTexture にしておくと three が大きさの決まっていない動画でも正しく転送する
      const tex = new THREE.VideoTexture(v)
      setupTex(tex, false)
      e = { url, video: v, tex, ready: false, want: -1 }
      const inv = () => { e.ready = v.readyState >= 2; this.env.invalidate() }
      v.addEventListener('loadeddata', inv)
      v.addEventListener('seeked', () => {
        inv()
        // シーク中に次の要求が来ていたら続けて飛ぶ
        if (v.paused && e.want >= 0 && Math.abs(v.currentTime - e.want) > 0.02) v.currentTime = e.want
      })
      v.addEventListener('error', () => console.warn('[comp-engine] 動画を読めない:', url))
      this.videos.set(key, e)
    }
    return e
  }
  // 動画を t 秒に合わせる。再生中は流しっぱなしにして、ずれたときだけ飛ばす
  syncVideo(e, t, playing, rate) {
    const v = e.video
    e.want = t
    if (playing) {
      if (v.playbackRate !== rate && rate > 0.06 && rate <= 16) v.playbackRate = rate
      if (Math.abs(v.currentTime - t) > 0.2) v.currentTime = t
      if (v.paused) v.play().catch(() => {})
    } else {
      if (!v.paused) v.pause()
      if (!v.seeking && Math.abs(v.currentTime - t) > 0.004) v.currentTime = t
    }
    if (v.readyState >= 2) { e.ready = true; e.tex.needsUpdate = true }
  }
  dropVideo(key) {
    const e = this.videos.get(key)
    if (!e) return
    e.video.pause(); e.video.removeAttribute('src'); e.video.load()
    e.tex.dispose()
    this.videos.delete(key)
  }
  pauseAll() { for (const e of this.videos.values()) if (!e.video.paused) e.video.pause() }

  dispose() {
    for (const e of this.images.values()) e.tex?.dispose()
    for (const k of [...this.videos.keys()]) this.dropVideo(k)
    this.images.clear(); this.metas.clear()
  }
}
