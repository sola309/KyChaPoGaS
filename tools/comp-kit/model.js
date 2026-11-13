// 3D モデル(GLB)。three.js の通常のマテリアルで別の RT に描き、画面大の絵としてレイヤーに戻す。
// GLTFLoader は model レイヤーがあるときだけ読む(import map で 'three' を解決できること)。
import { THREE } from './gfx.js'
import { evalProp, num, vec, toColor } from './props.js'

// コンポジションの座標(y 下・z 奥)⇔ three.js の座標(y 上・z 手前)。x 軸まわりの 180° 回転
const FLIP = new THREE.Matrix4().makeScale(1, -1, -1)
const _a = new THREE.Matrix4(), _b = new THREE.Matrix4()

export class ModelStore {
  constructor(env) {
    this.env = env
    this.items = new Map()
    this.loaderP = null
    this.camera = new THREE.PerspectiveCamera()
    this.camera.matrixAutoUpdate = false
  }
  url(scene, L) {
    const s = L.def.source || {}
    return s.url ? scene.srcUrl(s.url) : s.asset_id != null ? scene.assetUrl(s.asset_id, 'model') : null
  }
  entry(url) {
    let e = this.items.get(url)
    if (!e) {
      e = { state: 'loading', root: null, holder: null, size: null, center: null, promise: null }
      this.loaderP ??= import('./GLTFLoader.js')
      e.promise = this.loaderP.then((mod) => new Promise((res) => {
        new mod.GLTFLoader().load(url, (gltf) => {
          const root = new THREE.Scene()
          const holder = new THREE.Group()
          holder.matrixAutoUpdate = false
          holder.add(gltf.scene)
          root.add(holder)
          const box = new THREE.Box3().setFromObject(gltf.scene)
          e.size = box.getSize(new THREE.Vector3()); e.center = box.getCenter(new THREE.Vector3())
          e.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1)
          e.dir = new THREE.DirectionalLight(0xffffff, 1)
          root.add(e.hemi, e.dir, e.dir.target)
          e.root = root; e.holder = holder; e.state = 'ready'
          res(); this.env.invalidate()
        }, undefined, (err) => { e.state = 'error'; console.warn('[comp-engine] モデルを読めない:', url, err); res() })
      })).catch((err) => { e.state = 'error'; console.warn('[comp-engine] GLTFLoader を読めない:', err) })
      this.items.set(url, e)
    }
    if (e.state === 'loading') this.env.pending.push(e.promise)
    return e
  }
  prepare(scene, L) {
    const url = this.url(scene, L)
    if (url) this.entry(url)
  }
  // → リニア・乗算済みの RT(呼び出し側が release)。まだ読めていなければ null
  render(scene, L, f) {
    const url = this.url(scene, L)
    const e = url && this.entry(url)
    if (!e || e.state !== 'ready') return null
    const env = this.env, g = env.gfx, s = L.def.source || {}
    const cam = scene.camFor(L, f)
    // 高さが source.height(px、既定は画面の半分)になるよう正規化して、中心を原点へ
    const k = num(evalProp(s.height, f, scene.fps), scene.H * 0.5) / Math.max(1e-6, e.size.y)
    _a.makeScale(k, k, k).multiply(_b.makeTranslation(-e.center.x, -e.center.y, -e.center.z))
    e.holder.matrix.copy(FLIP).multiply(scene.drawWorld(L, f)).multiply(FLIP).multiply(_a)
    e.holder.matrixWorldNeedsUpdate = true // matrix を直に書いたので、世界行列の更新を頼む
    const c = this.camera
    c.fov = (2 * Math.atan(scene.H / 2 / cam.zoom) * 180) / Math.PI
    c.aspect = scene.W / scene.H
    c.near = Math.max(1, cam.zoom * 0.01); c.far = cam.zoom * 100
    c.updateProjectionMatrix()
    c.matrix.copy(FLIP).multiply(cam.world).multiply(FLIP)
    c.matrixWorldNeedsUpdate = true
    // 光: 既定は左上手前から。direction はコンポジションの座標で「光の来る方向」
    const li = s.light || {}
    const col = toColor(li.color ?? '#ffffff')
    e.dir.color.setRGB(col[0], col[1], col[2], THREE.SRGBColorSpace)
    e.dir.intensity = num(evalProp(li.intensity, f, scene.fps), 2.5)
    e.hemi.intensity = num(evalProp(li.ambient, f, scene.fps), 1.6)
    const d = vec(evalProp(li.direction, f, scene.fps) ?? [-0.5, -1, -1], 3, 0)
    e.dir.position.set(d[0], -d[1], -d[2]).normalize().multiplyScalar(cam.zoom * 4)
    const [bw, bh] = scene.bufSize()
    const rt = g.acquire(bw, bh, { float: true, depth: true, samples: 4 })
    g.clear(rt)
    try { env.renderer.render(e.root, c) } catch (err) { console.warn('[comp-engine] model', err); g.release(rt); return null }
    return rt
  }
  dispose() {
    for (const e of this.items.values()) {
      e.root?.traverse((o) => {
        o.geometry?.dispose?.()
        for (const m of [].concat(o.material || [])) { for (const v of Object.values(m)) v?.isTexture && v.dispose(); m.dispose?.() }
      })
    }
    this.items.clear()
  }
}
