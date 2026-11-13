// コンポジションの描画エンジン(three.js r180、ビルド不要の ES モジュール)。
// プレビュー(iframe)も書き出し(ヘッドレス Chromium の決定論キャプチャ)もこの 1 本で描く。
//   const eng = new CompEngine(canvas, { mode, apiBase, assetUrl, frameUrl, compLoader })
//   await eng.load(comp); await eng.renderFrame(f)
// 出力は (comp, f) だけで決まる。時計・Math.random は使わない。
import { THREE, Gfx } from './gfx.js'
import { Effects } from './effects.js'
import { Assets, canvasTexture } from './assets.js'
import { CompScene, BLEND_FRAG, MATTE_FRAG, MIX_FRAG, ModelStore } from './scene.js'
import { spriteCanvas } from './particles.js'
import { evalProp, evalVec } from './props.js'

export class CompEngine {
  // opts:
  //   mode       'preview' | 'capture'
  //   apiBase    素材 API の先頭('' = 同じオリジン)
  //   assetUrl   (asset_id, kind: 'image'|'video'|'model') → URL(省略時は apiBase から組む)
  //   frameUrl   (asset_id, n, fps) → 動画の n コマ目の画像の URL(capture 用)
  //   compLoader (comp_id) → Promise<comp>(入れ子)
  //   assetMeta  (asset_id) → Promise<{width,height,...}>
  //   scale      描く解像度の倍率(プレビューを軽くする。既定 1)
  //   onInvalidate  素材が読めたなど、描き直してほしいときに呼ばれる
  constructor(canvas, opts = {}) {
    this.canvas = canvas
    this.opts = opts
    const renderer = new THREE.WebGLRenderer({
      canvas, alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
      preserveDrawingBuffer: true, powerPreference: 'high-performance',
    })
    renderer.setPixelRatio(1)
    renderer.autoClear = false
    renderer.setClearColor(0x000000, 0)
    this.renderer = renderer
    const gfx = new Gfx(renderer)
    const self = this
    const env = (this.env = {
      renderer, gfx, opts,
      mode: opts.mode === 'capture' ? 'capture' : 'preview',
      apiBase: String(opts.apiBase || '').replace(/\/$/, ''),
      rs: opts.scale > 0 ? Math.min(2, opts.scale) : 1,
      playing: false,
      pending: [],
      fontEpoch: 0,
      showGuides: true, // 下絵(guide)レイヤーをプレビューに出すか(comp:guides で切り替える)
      curLayer: null,   // いま描いている・準備しているレイヤー(いちばん上のコンポジションでの id。知らせに添える)
      // 困りごとを呼び出し側へ知らせる(素材が無い・知らない種類・シェーダの失敗)。同じ内容は 1 回だけ、1 秒に 12 件まで
      reported: new Set(), repN: 0, repT: 0, repDropped: 0,
      report(level, message, layerId) {
        const cb = self.opts.onError
        if (!cb) return
        message = String(message).slice(0, 400)
        const lid = layerId === undefined ? env.curLayer : layerId
        const key = `${level}|${lid ?? ''}|${message}`
        if (env.reported.has(key)) return
        if (env.reported.size > 2000) env.reported.clear()
        env.reported.add(key)
        const now = typeof performance !== 'undefined' ? performance.now() : 0
        if (now - env.repT > 1000) {
          if (env.repDropped) { const n = env.repDropped; env.repDropped = 0; try { cb({ level: 'warn', message: `ほかに ${n} 件の知らせを省いた` }) } catch { /* 呼び出し側の失敗は無視 */ } }
          env.repT = now; env.repN = 0
        }
        if (++env.repN > 12) { env.repDropped++; env.reported.delete(key); return }
        const m = { level: level === 'error' ? 'error' : 'warn', message }
        if (lid != null) m.layer_id = String(lid)
        try { cb(m) } catch { /* 呼び出し側の失敗は無視 */ }
      },
      epoch: 0,    // 素材・書体・入れ子が読めるたびに進む(入れ子の絵の使い回しを無効にする)
      drawTick: 0, // 描いたコマの通し番号
      invalidate() { env.epoch++; if (env.mode !== 'capture') self.opts.onInvalidate?.() },
      sprites: new Map(),
      sprite(kind) {
        let t = env.sprites.get(kind)
        if (!t) env.sprites.set(kind, (t = canvasTexture(spriteCanvas(kind))))
        return t
      },
      fonts: new Map(),
      // フォントがまだ読めていなければ読み込む(@font-face の Web フォント用。機械のフォントは即時)
      font(spec, text) {
        if (!document.fonts || !text) return
        const key = spec + '|' + text
        let st = env.fonts.get(key)
        if (st === undefined) {
          let ok = true
          try { ok = document.fonts.check(spec, text) } catch { ok = true }
          if (ok) st = null
          else st = { done: false, p: document.fonts.load(spec, text).then(() => { st.done = true; env.fontEpoch++; env.invalidate() }, () => { st.done = true }) }
          if (env.fonts.size > 2000) env.fonts.clear()
          env.fonts.set(key, st)
        }
        if (st && !st.done) env.pending.push(st.p)
      },
      blendMat: gfx.passMaterial('blend', BLEND_FRAG, { tBase: null, tSrc: null, uOpacity: 1, uMode: 0 }),
      matteMat: gfx.passMaterial('matte', MATTE_FRAG, { tSrc: null, tMatte: null, uMode: 0 }),
      mixMat: gfx.passMaterial('mix', MIX_FRAG, { tA: null, tB: null, tM: null }),
    })
    env.effects = new Effects(gfx)
    env.assets = new Assets(env)
    env.models = new ModelStore(env)
    // 入れ子のコンポジション: comp_id → {id, state, scene}
    env.comps = {
      items: new Map(),
      get(id) {
        const key = String(id)
        let e = this.items.get(key)
        if (!e) {
          e = { id: key, state: 'loading', scene: null, promise: null }
          const load = opts.compLoader || ((cid) => fetch(`${env.apiBase}/api/comps/${cid}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status)))))
          e.promise = Promise.resolve().then(() => load(id)).then(
            (comp) => {
              if (!comp || !comp.data) throw new Error('empty')
              if (typeof comp.data === 'string') comp = { ...comp, data: JSON.parse(comp.data) }
              e.scene = new CompScene(env, { ...comp, id: comp.id ?? id }); e.scene.isChild = true; e.state = 'ready'; env.invalidate()
            }).catch((err) => { e.state = 'error'; console.warn(`[comp-engine] comp ${id} を読めない:`, err); env.report('error', `入れ子のコンポジション ${id} を読めない`, e.layer) })
          e.layer = env.curLayer
          this.items.set(key, e)
        }
        if (e.state === 'loading') env.pending.push(e.promise)
        return e
      },
    }
    this.scene = null
    this.frame = 0
    this.fontFaces = new Set()
    // シェーダを作れなかったとき(three の既定の長いログの代わりに、要点だけ出して知らせる)
    renderer.debug.onShaderError = (gl, program, vs, fs) => {
      const log = (gl.getShaderInfoLog(fs) || gl.getShaderInfoLog(vs) || gl.getProgramInfoLog(program) || '').trim().split('\n')[0]
      console.error('[comp-engine] シェーダを作れない:', log)
      env.report('error', `シェーダを作れない: ${log}`)
    }
  }

  get width() { return this.scene ? this.scene.W : 0 }
  get height() { return this.scene ? this.scene.H : 0 }

  resize() {
    const s = this.scene
    if (!s) return
    const w = Math.round(s.W * this.env.rs), h = Math.round(s.H * this.env.rs)
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.renderer.setSize(w, h, false)
      this.env.gfx.trim()
    }
  }

  // プロジェクトの書体を読み込む。list = [{family, url, weight?, style?}](url の "/..." は apiBase から)
  async loadFonts(list) {
    if (!Array.isArray(list) || typeof FontFace === 'undefined') return
    await Promise.all(list.map(async (ft) => {
      if (!ft || !ft.family || !ft.url) return
      const key = `${ft.family}|${ft.url}|${ft.weight || ''}|${ft.style || ''}`
      if (this.fontFaces.has(key)) return
      this.fontFaces.add(key)
      try {
        const url = typeof ft.url === 'string' && ft.url.startsWith('/') && !ft.url.startsWith('//') ? this.env.apiBase + ft.url : ft.url
        // 別名(aliases: 日本語の書体名・「Noto Sans JP Bold」のような太さつきの名前)でも引けるよう、同じファイルを名前ごとに登録する
        const names = [...new Set([ft.family, ...(Array.isArray(ft.aliases) ? ft.aliases : [])].filter((x) => typeof x === 'string' && x))]
        const desc = { weight: String(ft.weight || 'normal'), style: ft.style || 'normal' }
        const first = await new FontFace(names[0], `url("${url}")`, desc).load()
        document.fonts.add(first)
        for (const fam of names.slice(1)) {
          // 別名の登録に失敗しても、ほかの名前は生かす
          try { document.fonts.add(await new FontFace(fam, `url("${url}")`, desc).load()) } catch (err) { console.warn(`[comp-engine] 書体の別名を登録できない: ${fam}`, err) }
        }
        this.env.fontEpoch++
      } catch (err) { console.warn(`[comp-engine] 書体を読めない: ${ft.family}`, err); this.env.report('error', `書体を読めない: ${ft.family}`, null) }
    }))
    this.env.fonts.clear()
  }

  // comp = {id?, width, height, fps, duration_frames, data}
  async load(comp) {
    this.env.reported.clear()
    this.scene?.dispose()
    this.scene = new CompScene(this.env, normalize(comp))
    this.resize()
    try { if (document.fonts) await document.fonts.ready } catch { /* フォント API なし */ }
  }

  // 文書の差し替え(編集中)。レイヤーのテクスチャは中身が同じなら引き継ぐ
  update(comp) {
    if (!this.scene) { this.scene = new CompScene(this.env, normalize(comp)); this.resize(); return }
    this.scene.setComp(normalize(comp))
    this.resize()
  }

  // f コマ目を描く。capture では必要な素材がそろうまで待ってから描く
  async renderFrame(f) {
    const s = this.scene
    if (!s) return
    f = Number.isFinite(+f) ? +f : 0
    this.frame = f
    const env = this.env
    try {
      if (env.mode === 'capture') {
        // 入れ子を読むと新しい素材が見つかるので、積まれるものが無くなるまで繰り返す
        for (let i = 0; i < 64; i++) {
          env.pending.length = 0
          s.prepare(f, [String(s.comp.id ?? '')])
          if (!env.pending.length) break
          await Promise.all(env.pending.slice())
        }
      } else {
        env.pending.length = 0
        s.prepare(f, [String(s.comp.id ?? '')])
      }
      if (this.scene !== s) return
      this.draw(f)
    } catch (err) {
      console.warn('[comp-engine] renderFrame', err)
      env.report('error', `描画に失敗: ${err && err.message || err}`)
    }
  }
  // 同期で描く(プレビューの再生ループ用)
  draw(f = this.frame) {
    const s = this.scene, g = this.env.gfx
    if (!s) return
    this.frame = f
    this.env.pending.length = 0
    this.env.drawTick++
    g.setScissor(null)
    const acc = s.render(f, [String(s.comp.id ?? '')])
    g.setScissor(null)
    g.copy(acc.texture, null)
    g.release(acc)
    // 入れ子の絵のうち、このコマで使わなかったものを手放す
    for (const e of this.env.comps.items.values()) e.scene?.sweepCache()
    g.gc()
  }

  pick(x, y, f = this.frame) { try { return this.scene ? this.scene.pick(x, y, f) : null } catch { return null } }
  // → {corners: [[x,y]×4](左上・右上・右下・左下、コンポジションの px), anchor: [x,y], three_d}
  layerBounds(id, f = this.frame) { try { return this.scene ? this.scene.bounds(id, f) : null } catch { return null } }

  // ---- 仕様の外の小道具(player.html が使う) ----
  setScale(rs) {
    rs = Math.min(2, Math.max(0.1, rs || 1))
    if (rs === this.env.rs) return
    this.env.rs = rs
    this.resize()
  }
  setPlaying(on) {
    this.env.playing = !!on
    if (!on) this.env.assets.pauseAll()
  }
  // ドラッグ中の仮の値(transform.position / scale / rotation)。value = null でその項目を解除
  setOverride(id, path, value) {
    const key = { 'transform.position': 'position', 'transform.scale': 'scale', 'transform.rotation': 'rotation' }[path]
    if (!this.scene || !key) return
    const o = this.scene.overrides.get(String(id)) || {}
    if (value == null) delete o[key]; else o[key] = value
    if (Object.keys(o).length) this.scene.overrides.set(String(id), o); else this.scene.overrides.delete(String(id))
    this.scene.resetStamps()
  }
  // 下絵(guide)レイヤーをプレビューに出すか
  setGuides(show) { this.env.showGuides = show !== false }
  // レイヤーの定義(編集画面むけ。読むだけ)
  layerDef(id) { return this.scene?.layers.get(String(id))?.def ?? null }
  // いっしょに動かすと二重に動くレイヤー(親・効いているグループが ids に入っているもの)を除く
  dragRoots(ids) {
    const sc = this.scene
    if (!sc) return []
    const set = new Set(ids.map(String))
    return [...set].filter((id) => {
      const L = sc.layers.get(id)
      if (!L || L.def.locked) return false
      for (let p = L.def.parent, n = 0; p != null && n < 32; n++) { if (set.has(String(p))) return false; p = sc.layers.get(String(p))?.def.parent }
      if (L.groups && L.groups.some((G) => set.has(G.id) && sc.active(G, this.frame))) return false
      return true
    })
  }
  clearOverrides() {
    if (!this.scene) return
    this.scene.overrides.clear()
    this.scene.resetStamps()
  }
  // transform の値をそのコマで評価する
  valueAt(id, path, f = this.frame) {
    const L = this.scene?.layers.get(String(id))
    if (!L) return undefined
    let v = L.def
    for (const k of path.split('.')) v = v?.[k]
    const ok = { 'transform.position': 'position', 'transform.scale': 'scale', 'transform.rotation': 'rotation' }[path]
    if (ok) {
      const o = this.scene.overrides.get(String(id))
      if (o && o[ok] != null) return o[ok]
      if (v === undefined) return ok === 'position' ? [this.scene.W / 2, this.scene.H / 2, 0] : ok === 'scale' ? [100, 100, 100] : 0
    }
    // position は {x, y, z} の分け書きもあるので evalVec で読む
    return ok === 'position' ? evalVec(v, f, this.scene.fps) : evalProp(v, f, this.scene.fps)
  }
  isKeyframed(id, path) {
    let v = this.scene?.layers.get(String(id))?.def
    for (const k of path.split('.')) v = v?.[k]
    return !!v && typeof v === 'object' && !Array.isArray(v) && Array.isArray(v.k)
  }
  screenDelta(id, f, dx, dy) { return this.scene ? this.scene.screenDelta(id, f, dx, dy) : [dx, dy, 0] }
  // 入れ子のコンポジションを読み直させる(子を編集したあと)
  invalidateComp(id) {
    const e = this.env.comps.items.get(String(id))
    if (e) { e.scene?.dispose(); this.env.comps.items.delete(String(id)) }
    this.env.epoch++ // この子を含む、ほかの入れ子の絵の使い回しも無効にする
  }

  dispose() {
    this.scene?.dispose()
    this.scene = null
    for (const e of this.env.comps.items.values()) e.scene?.dispose()
    this.env.comps.items.clear()
    this.env.assets.dispose()
    this.env.models.dispose()
    for (const t of this.env.sprites.values()) t.dispose()
    this.env.gfx.dispose()
    this.renderer.dispose()
  }
}

function normalize(comp) {
  let data = comp?.data
  if (typeof data === 'string') { try { data = JSON.parse(data) } catch { data = {} } }
  return { ...comp, width: comp?.width || 1920, height: comp?.height || 1080, fps: comp?.fps || 30, duration_frames: comp?.duration_frames || 1, data: data || { layers: [] } }
}

export { evalProp }
