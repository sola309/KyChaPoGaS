// VRM(人型の 3D モデル)。model レイヤーの source.vrm があるときだけ読まれる(model.js から後読み)。
//   - 読み込み・MToon(アニメ調の影の段・影色・輪郭線)・人型ボーン・表情・揺れ物は @pixiv/three-vrm(MIT。three-vrm.module.min.js を同梱)
//   - ポーズはマネキン(mesh3d.js)と同じ書き方(preset・phase・preset_b・preset_mix・pose・ground)。関節の角度の決まりも同じ
//   - 状態を持たない: (文書, コマ) だけから絵が決まる。揺れ物は毎コマ「warmup 秒前の静止」から回し直す(前に描いたコマの結果を使わない)
//     → どのコマから描き始めても同じ絵(並列の描き出しでも同じ)
import { THREE } from './gfx.js'
import { evalProp, num, vec, toColor, rand01, clamp } from './props.js'
import { mannequinPose, mannequinQuat, mannequinDims, evalTree } from './mesh3d.js'

const D2R = Math.PI / 180
const FLIP = new THREE.Matrix4().makeScale(1, -1, -1)
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const _a = new THREE.Matrix4(), _b = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _qf = new THREE.Quaternion(), _s = new THREE.Vector3(), _v = new THREE.Vector3(), _e = new THREE.Euler()
const ONE = new THREE.Vector3(1, 1, 1)

// マネキンの関節 → VRM の人型ボーン
const MAP = {
  root: 'hips', spine: 'spine', chest: 'chest', neck: 'neck', head: 'head',
  shoulder_l: 'leftUpperArm', elbow_l: 'leftLowerArm', wrist_l: 'leftHand', shoulder_r: 'rightUpperArm', elbow_r: 'rightLowerArm', wrist_r: 'rightHand',
  hip_l: 'leftUpperLeg', knee_l: 'leftLowerLeg', ankle_l: 'leftFoot', hip_r: 'rightUpperLeg', knee_r: 'rightLowerLeg', ankle_r: 'rightFoot',
}
// マネキンの腕は「下ろした形」が基準、VRM は T ポーズ(腕は真横)が基準。その差(z 軸まわり ∓90°)
const REST_L = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2)
const REST_R = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2)
const REST_LI = REST_L.clone().invert(), REST_RI = REST_R.clone().invert()
const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little']
const SEGS = { Thumb: ['Metacarpal', 'Proximal', 'Distal'], other: ['Proximal', 'Intermediate', 'Distal'] }
// 手の形 → 指ごとの [曲げ(度), 開き(度)](親指・人さし指・中指・薬指・小指)
const HANDS = {
  mitt: [[8, 0], [14, 0], [16, 0], [18, 0], [20, 0]],
  open: [[0, -12], [0, -8], [0, 0], [0, 6], [0, 14]],
  fist: [[38, 0], [80, 0], [84, 0], [84, 0], [84, 0]],
  peace: [[42, 0], [0, -10], [0, 7], [84, 0], [84, 0]],
  point: [[42, 0], [0, 0], [84, 0], [84, 0], [84, 0]],
}
// 表情の別名(VRM 0.x の名前・小文字 → three-vrm の名前)
const EXPR_ALIAS = { a: 'aa', i: 'ih', u: 'ou', e: 'ee', o: 'oh', joy: 'happy', sorrow: 'sad', fun: 'relaxed', blink_l: 'blinkLeft', blink_r: 'blinkRight' }

// アニメらしい非対称のまばたき(puppet.js と同じ形): 速く閉じる → 少し保つ → ゆっくり開く
function blinkShape(p) {
  if (p <= 0 || p >= 1) return 0
  if (p < 0.3) { const u = p / 0.3; return u * u }
  if (p < 0.45) return 1
  const u = (p - 0.45) / 0.55
  return 1 - u * u * (3 - 2 * u)
}

export class VrmModel {
  constructor(env, vrm) {
    this.env = env
    this.vrm = vrm
    this.v0 = vrm.meta?.metaVersion === '0'
    const root = (this.root = new THREE.Scene())
    const holder = (this.holder = new THREE.Group())
    holder.matrixAutoUpdate = false
    const stage = (this.stage = new THREE.Group())
    stage.add(vrm.scene); holder.add(stage); root.add(holder)
    this.hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 0)
    this.dir = new THREE.DirectionalLight(0xffffff, 1)
    root.add(this.hemi, this.dir, this.dir.target)
    this.camera = new THREE.PerspectiveCamera()
    this.camera.matrixAutoUpdate = false
    // 見た目の下ごしらえ
    this.outlines = []; this.surfaces = []
    const seen = new Set()
    vrm.scene.traverse((o) => {
      if (!o.isMesh) return
      o.frustumCulled = false // 骨で動かすので、元の箱での切り捨てをしない
      o.castShadow = true; o.receiveShadow = false // 自分の体に落ちる影は使わない(顔が汚れる)。床にだけ落とす
      for (const m of [].concat(o.material || [])) {
        if (seen.has(m)) continue
        seen.add(m)
        if (m.isOutline) this.outlines.push({ m, w: m.outlineWidthFactor, c: m.outlineColorFactor?.clone() })
        else if (m.isMToonMaterial) this.surfaces.push({ m, c: m.shadeColorFactor.clone(), shift: m.shadingShiftFactor, toony: m.shadingToonyFactor })
        if (m.transparent) premulAlpha(m)
      }
    })
    // モデルが輪郭線なしにしている素材(服など)にも、あとから付けられるようにしておく(outline.all。ふだんは隠す)
    const made = new Map()
    vrm.scene.traverse((o) => {
      const m = o.isMesh && !Array.isArray(o.material) ? o.material : null
      if (!m || !m.isMToonMaterial || m.outlineWidthMode !== 'none' || m.transparent) return
      let om = made.get(m)
      if (!om) {
        om = m.clone()
        om.name += ' (Outline+)'
        om.outlineWidthMode = 'worldCoordinates'; om.outlineWidthFactor = 0.001
        om.outlineColorFactor.setRGB(0, 0, 0); om.outlineLightingMixFactor = 0
        om.isOutline = true; om.side = THREE.BackSide; om.visible = false
        made.set(m, om)
        this.outlines.push({ m: om, w: 0.001, c: om.outlineColorFactor.clone(), extra: true })
      }
      o.material = [m, om]
      const n = o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count
      if (!o.geometry.groups.length) { o.geometry.addGroup(0, n, 0); o.geometry.addGroup(0, n, 1) }
    })
    // 大きさと原点(T ポーズのときの箱)
    vrm.scene.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(vrm.scene)
    this.size = box.getSize(new THREE.Vector3()); this.center = box.getCenter(new THREE.Vector3()); this.minY = box.min.y
    // 影を受ける床(source.shadow があるときだけ見せる)
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), premulAlpha(new THREE.ShadowMaterial({ opacity: 0.35, transparent: true, depthWrite: false })))
    this.floor.rotation.x = -Math.PI / 2
    this.floor.position.y = box.min.y
    this.floor.receiveShadow = true; this.floor.visible = false; this.floor.renderOrder = -10
    stage.add(this.floor)
    // 人型ボーン(正規化した骨 = T ポーズで回転なし)
    const hum = vrm.humanoid
    this.bones = {}
    for (const name of Object.keys(hum.humanBones || {})) {
      const n = hum.getNormalizedBoneNode(name)
      if (n) this.bones[name] = { n, p: n.position.clone() }
    }
    this.nroot = hum.normalizedHumanBonesRoot
    this.ankleH = Math.max(0.01, (this.bones.leftFoot ? this.worldY(this.bones.leftFoot.n) : 0.08) - this.minY)
    // 表情の名前(大文字小文字を区別しない)
    this.exprs = new Map()
    const em = vrm.expressionManager
    if (em) for (const k of Object.keys(em.expressionMap)) {
      this.exprs.set(k.toLowerCase(), k)
      const short = k.replace(/^BlendShape\./i, '').toLowerCase() // "BlendShape.JawOpen" は JawOpen でも引ける
      if (!this.exprs.has(short)) this.exprs.set(short, k)
    }
    this.dims = mannequinDims({})
  }
  worldY(n) { n.updateWorldMatrix(true, false); return _v.setFromMatrixPosition(n.matrixWorld).y }
  exprName(k) {
    const l = String(k).toLowerCase()
    return this.exprs.get(l) ?? this.exprs.get(String(EXPR_ALIAS[l] || '').toLowerCase()) ?? null
  }
  // VRM 0.x は読み込み時に全体を y 軸で 180° 回してある。骨の回転は回す前の座標で書くので、x・z を裏返す
  fix(q) { if (this.v0) { q.x = -q.x; q.z = -q.z } return q }
  setBone(name, q) { const b = this.bones[name]; if (b) b.n.quaternion.copy(this.fix(q)) }

  // ポーズ(コマ g)。ev = source.vrm を g で評価したもの
  applyPose(ev) {
    const B = this.bones, H = this.size.y
    for (const k in B) { B[k].n.quaternion.identity(); B[k].n.position.copy(B[k].p) }
    const e = ev.preset === undefined && typeof ev.pose_preset === 'string' ? { ...ev, preset: ev.pose_preset } : ev
    const pose = mannequinPose(e, this.dims)
    // 腕を下ろした形は、服(上着の身ごろ)に腕が埋まりやすい。開きが小さいときだけ少し開く(arm_open 度。0 = マネキンと同じ角度)
    const ao = num(ev.arm_open, 10)
    for (const j in MAP) {
      let a = pose[j]
      if (ao && j.startsWith('shoulder')) a = [a[0], a[1], a[2] + ao * clamp(1 - a[2] / 30, 0, 1)]
      const q = mannequinQuat(j, a, 0)
      if (j.startsWith('shoulder')) q.multiply(j.endsWith('_l') ? REST_L : REST_R)
      else if (j.startsWith('elbow') || j.startsWith('wrist')) { const l = j.endsWith('_l'); q.premultiply(l ? REST_LI : REST_RI).multiply(l ? REST_L : REST_R) }
      this.setBone(MAP[j], q)
    }
    // 指: 手の形(mitt / open / fist / peace / point)か、握りの量(grip_l / grip_r = 0 開く 〜 1 握る)
    for (const side of ['left', 'right']) {
      const sd = side === 'left' ? 1 : -1, sfx = side === 'left' ? '_l' : '_r'
      let shape = HANDS[pose['hand' + sfx]] || HANDS.mitt
      const grip = ev['grip' + sfx]
      if (typeof grip === 'number') { const t = clamp(grip, 0, 1); shape = HANDS.open.map((o, i) => [o[0] + (HANDS.fist[i][0] - o[0]) * t, o[1] * (1 - t)]) }
      FINGERS.forEach((fn, i) => {
        const [curl, spread] = shape[i]
        const segs = fn === 'Thumb' ? SEGS.Thumb : SEGS.other
        segs.forEach((sg, si) => {
          const name = side + fn + sg
          if (!B[name]) return
          if (fn === 'Thumb') _e.set(0, sd * (curl * (si === 0 ? 0.5 : 1) - (si === 0 ? spread : 0)) * D2R, 0)
          else _e.set(0, si === 0 ? sd * spread * D2R : 0, -sd * curl * (si === 2 ? 0.8 : 1) * D2R, 'YZX')
          this.setBone(name, _q.setFromEuler(_e))
        })
      })
    }
    // 人型ボーンの名前でじかに足す回転(度・XYZ。正面 = +z・本人の左 = +x の座標)。プリセットに掛け足す
    if (isObj(ev.bones)) for (const name in ev.bones) {
      const b = B[name], a = ev.bones[name]
      if (!b || !Array.isArray(a)) continue
      b.n.quaternion.multiply(this.fix(_q.setFromEuler(_e.set(num(a[0]) * D2R, num(a[1]) * D2R, num(a[2]) * D2R, 'XYZ'))))
    }
    // 腰の位置(身長に対する割合・y 下)と、足の接地
    const hips = B.hips
    if (hips) {
      const o = pose.offset, sx = this.v0 ? -1 : 1
      hips.n.position.set(hips.p.x + sx * o[0] * H, hips.p.y - o[1] * H, hips.p.z - sx * o[2] * H)
      if (pose.ground && this.nroot) {
        this.nroot.updateMatrixWorld(true)
        _a.copy(this.nroot.matrixWorld).invert()
        let lo = Infinity
        for (const fn of ['leftFoot', 'rightFoot']) {
          if (!B[fn]) continue
          for (const z of [-0.05, 0.13]) lo = Math.min(lo, _v.set(0, -this.ankleH, -sx * z).applyMatrix4(B[fn].n.matrixWorld).applyMatrix4(_a).y)
        }
        const base = B.leftFoot ? B.leftFoot.p.y : 0
        if (isFinite(lo)) { this._g ??= this.restSoleY(); hips.n.position.y -= lo - this._g }
      }
    }
    this.vrm.humanoid.update()
  }
  // 立ち姿(回転なし)のときの足の裏の高さ(正規化した骨の座標)
  restSoleY() {
    const B = this.bones, keep = {}
    for (const k in B) { keep[k] = [B[k].n.quaternion.clone(), B[k].n.position.clone()]; B[k].n.quaternion.identity(); B[k].n.position.copy(B[k].p) }
    this.nroot.updateMatrixWorld(true)
    _a.copy(this.nroot.matrixWorld).invert()
    let lo = Infinity
    for (const fn of ['leftFoot', 'rightFoot']) if (B[fn]) lo = Math.min(lo, _v.set(0, -this.ankleH, 0).applyMatrix4(B[fn].n.matrixWorld).applyMatrix4(_a).y)
    for (const k in B) { B[k].n.quaternion.copy(keep[k][0]); B[k].n.position.copy(keep[k][1]) }
    this.nroot.updateMatrixWorld(true)
    return isFinite(lo) ? lo : 0
  }

  applyExpressions(ev, f, fps) {
    const em = this.vrm.expressionManager
    if (!em) return
    for (const k of new Set(this.exprs.values())) em.setValue(k, 0)
    const ex = isObj(ev.expressions) ? ev.expressions : {}
    let blink = 0
    for (const k in ex) {
      const name = this.exprName(k), w = clamp(num(ex[k], 0), 0, 1)
      if (!name) { this.warn('expr' + k, `VRM: 知らない表情: ${k}`); continue }
      if (name === 'blink') blink = Math.max(blink, w); else em.setValue(name, w)
    }
    const ab = ev.auto_blink
    if (ab) {
      const o = isObj(ab) ? ab : {}
      const iv = Math.max(0.4, num(o.interval, 3.4)), dur = Math.max(0.05, num(o.duration, 0.24)), seed = num(o.seed, 1) | 0
      const t = f / fps, k = Math.floor(t / iv)
      // 区間 k に 1 回。始まりは区間の 15〜85 % のどこか(種で決まる)。puppet と同じ式
      for (const j of [k - 1, k]) {
        if (j < 0) continue
        const t0 = (j + 0.15 + 0.7 * rand01(seed, j, 77)) * iv
        blink = Math.max(blink, blinkShape((t - t0) / dur))
      }
    }
    if (this.exprs.has('blink')) em.setValue('blink', blink)
    em.update()
  }
  warn(key, msg) {
    this.warned ??= new Set()
    if (this.warned.has(key)) return
    this.warned.add(key)
    console.warn('[comp-engine]', msg)
    this.env.report?.('warn', msg)
  }

  // レイヤーの行列(文書の座標)→ three.js の座標。sim = 揺れ物の計算用(メートルのまま・拡大なし)
  // qf・inertia = 揺れ物の計算でだけ使う「振り向きの勢い」の弱め: 向きを、描くコマの向き qf へ寄せる(inertia 1 = そのまま、0 = レイヤーの回転では髪が振られない)
  placeHolder(scene, L, g, k, sim, qf = null, inertia = 1) {
    _a.copy(FLIP).multiply(scene.drawWorld(L, g)).multiply(FLIP)
    if (sim) {
      _a.decompose(_p, _q, _s)
      if (qf && inertia < 1) _q.copy(_q2.copy(qf).slerp(_q, inertia))
      const ks = k * Math.max(1e-6, Math.abs(_s.y))
      this.holder.matrix.compose(_p.multiplyScalar(1 / ks), _q, ONE)
    } else this.holder.matrix.copy(_a.multiply(_b.makeScale(k, k, k)))
    this.holder.matrixWorldNeedsUpdate = true
  }

  // → リニア・乗算済みの RT(呼び出し側が release)
  render(scene, L, f) {
    const env = this.env, g = env.gfx, s = L.def.source || {}, fps = scene.fps
    const vdef = isObj(s.vrm) ? s.vrm : {}
    const vrm = this.vrm
    const hpx = num(evalProp(s.height, f, fps), scene.H * 0.5)
    const k = hpx / Math.max(1e-6, this.size.y)
    const ev = evalTree(vdef, f, fps)
    // 原点: feet(既定。足もと = マネキンと同じ)/ center(箱の中心 = GLB の model と同じ)
    if (ev.origin === 'center') this.stage.position.set(-this.center.x, -this.center.y, -this.center.z)
    else this.stage.position.set(0, -this.minY, 0)
    // 揺れ物: warmup 秒前の静止から、1 コマずつ回し直す
    const sb = vrm.springBoneManager
    const sp = ev.spring === false || ev.spring === 0 ? null : isObj(ev.spring) ? ev.spring : {}
    if (sb) {
      // 揺れ物の調整(モデルの設定に掛ける倍率と、重力の足し)。省略 = モデルの設定のまま
      this.joints ??= [...sb.joints].map((j) => ({ j, s: j.settings.stiffness, d: j.settings.dragForce, g: j.settings.gravityPower, gd: j.settings.gravityDir.clone(), name: String(j.bone?.name || '') }))
      const ks = sp ? Math.max(0, num(sp.stiffness, 1)) : 1, kd = sp ? Math.max(0, num(sp.drag, 1)) : 1, ga = sp ? num(sp.gravity, 0) : 0
      // wind = 重力に足す一定の力(文書の座標 [x, y, z]。x 正 = 画面の右へ、y 正 = 下へ、z 正 = 奥へ。大きさは gravity と同じ単位)。
      // wind_bones = 骨の名前の一部(文字列か、その配列。書くと、その骨だけに風を当てる)。部位ごとに変えるときは wind を [{force: [x, y, z], bones: …}, …] と並べる(当てはまる物を足し合わせる)
      const winds = []
      if (sp && Array.isArray(sp.wind)) {
        const lc = (b) => (b != null ? [].concat(b).map((x) => String(x).toLowerCase()) : null)
        if (sp.wind.some((x) => isObj(x))) { for (const w of sp.wind) if (isObj(w) && Array.isArray(w.force)) winds.push({ f: vec(w.force, 3, 0), b: lc(w.bones) }) }
        else winds.push({ f: vec(sp.wind, 3, 0), b: lc(sp.wind_bones) })
      }
      for (const o of this.joints) {
        o.j.settings.stiffness = o.s * ks; o.j.settings.dragForce = clamp(o.d * kd, 0, 1)
        const gp = Math.max(0, o.g + ga)
        let hit = false
        _v.copy(o.gd).multiplyScalar(gp)
        for (const w of winds) {
          if (w.b && !w.b.some((x) => o.name.toLowerCase().includes(x))) continue
          if (w.f[0] === 0 && w.f[1] === 0 && w.f[2] === 0) continue
          _v.x += w.f[0]; _v.y -= w.f[1]; _v.z -= w.f[2]; hit = true
        }
        if (hit) {
          const l = _v.length()
          o.j.settings.gravityPower = l
          if (l > 1e-9) o.j.settings.gravityDir.copy(_v).multiplyScalar(1 / l); else o.j.settings.gravityDir.copy(o.gd)
        } else { o.j.settings.gravityPower = gp; o.j.settings.gravityDir.copy(o.gd) }
      }
    }
    if (sb && sp) {
      const n = clamp(Math.round(num(sp.warmup, 1) * fps), 0, 600)
      // turn_inertia(0〜1。既定 1): レイヤーの回転(振り向き)が髪を振る強さ。速い振り向きで長い髪が体に巻きつくときに下げる
      const inertia = clamp(num(sp.turn_inertia, 1), 0, 1)
      let qf = null
      if (inertia < 1) { _a.copy(FLIP).multiply(scene.drawWorld(L, f)).multiply(FLIP).decompose(_p, _qf, _s); qf = _qf }
      for (let i = n; i >= 1; i--) {
        const gf = f - i
        this.applyPose(evalTree(vdef, gf, fps))
        this.placeHolder(scene, L, gf, k, true, qf, inertia)
        this.root.updateMatrixWorld(true)
        if (i === n) sb.reset(); else sb.update(1 / fps)
      }
      this.applyPose(ev)
      this.placeHolder(scene, L, f, k, true)
      this.root.updateMatrixWorld(true)
      if (n === 0) sb.reset(); else sb.update(1 / fps)
    } else {
      sb?.reset()
      this.applyPose(ev)
    }
    this.applyExpressions(ev, f, fps)
    this.placeHolder(scene, L, f, k, false)
    // 輪郭線
    const ol = ev.outline
    for (const o of this.outlines) {
      const off = ol === false || ol === 0
      o.m.visible = !off && (!o.extra || (isObj(ol) && !!ol.all))
      o.m.outlineWidthFactor = o.w * (isObj(ol) ? Math.max(0, num(ol.width, 1)) : typeof ol === 'number' ? Math.max(0, ol) : 1)
      if (o.c) { if (isObj(ol) && ol.color != null) { const c = toColor(ol.color); o.m.outlineColorFactor.setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace) } else o.m.outlineColorFactor.copy(o.c) }
    }
    // 影の段(省略 = モデルの設定のまま)。color = 影の色(テクスチャに掛ける)、shift = 影の境目の位置(−1〜1)、toony = 境目の硬さ(0〜1)
    const sd = isObj(ev.shade) ? ev.shade : null
    for (const o of this.surfaces) {
      if (sd && sd.color != null) { const c = toColor(sd.color); o.m.shadeColorFactor.setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace) } else o.m.shadeColorFactor.copy(o.c)
      o.m.shadingShiftFactor = sd ? num(sd.shift, o.shift) : o.shift
      o.m.shadingToonyFactor = sd ? clamp(num(sd.toony, o.toony), 0, 1) : o.toony
    }
    // カメラ(model.js と同じ)
    const cam = scene.camFor(L, f), c = this.camera
    c.fov = (2 * Math.atan(scene.H / 2 / cam.zoom) * 180) / Math.PI
    c.aspect = scene.W / scene.H
    c.near = Math.max(1, cam.zoom * 0.01); c.far = cam.zoom * 100
    c.updateProjectionMatrix()
    c.matrix.copy(FLIP).multiply(cam.world).multiply(FLIP)
    c.matrixWorldNeedsUpdate = true
    // 光。MToon は「主光 1 = テクスチャの色そのまま」。direction は文書の座標で「光の来る方向」
    const li = isObj(s.light) ? evalTree(s.light, f, fps) : {}
    const col = toColor(li.color ?? '#ffffff')
    this.dir.color.setRGB(col[0], col[1], col[2], THREE.SRGBColorSpace)
    // three.js の光は 1/π が掛かるので π を掛けて戻す(実測: 主光 1 のままだとテクスチャの色の 1/π の明るさになる)
    this.dir.intensity = Math.max(0, num(li.intensity, 1)) * Math.PI
    this.hemi.intensity = Math.max(0, num(li.ambient, 0)) * Math.PI
    const d = vec(li.direction ?? [-0.4, -1, -1], 3, 0)
    _v.set(d[0], -d[1], -d[2])
    if (_v.lengthSq() < 1e-9) _v.set(0, 1, 1)
    _v.normalize()
    // 床に落ちる影
    const sh = s.shadow === true ? {} : isObj(s.shadow) ? evalTree(s.shadow, f, fps) : null
    const shadows = !!sh && num(sh.opacity, 0.35) > 0
    this.floor.visible = shadows
    this.dir.castShadow = shadows
    this.root.updateMatrixWorld(true)
    _p.setFromMatrixPosition(this.stage.matrixWorld)
    if (shadows) {
      this.floor.material.opacity = clamp(num(sh.opacity, 0.35), 0, 1)
      const sc = toColor(sh.color ?? '#000000')
      this.floor.material.color.setRGB(sc[0], sc[1], sc[2], THREE.SRGBColorSpace)
      const fs = Math.max(0.1, num(sh.floor_size, 12))
      this.floor.scale.set(fs, fs, 1)
      const sa = Math.max(10, num(sh.area, hpx * 3))
      this.dir.target.position.copy(_p)
      this.dir.position.copy(_p).addScaledVector(_v, sa * 1.5)
      const S = this.dir.shadow, scam = S.camera
      scam.left = scam.bottom = -sa / 2; scam.right = scam.top = sa / 2; scam.near = 1; scam.far = sa * 3.2
      scam.updateProjectionMatrix()
      if (S.mapSize.x !== 2048) { S.mapSize.set(2048, 2048); S.map?.dispose(); S.map = null }
      S.bias = -0.0004; S.normalBias = sa / 700
      S.radius = Math.max(0, num(sh.blur, 3))
    } else {
      this.dir.target.position.set(0, 0, 0)
      this.dir.position.copy(_v).multiplyScalar(cam.zoom * 4)
    }
    this.root.updateMatrixWorld(true)
    const [bw, bh] = scene.bufSize()
    const rt = g.acquire(bw, bh, { float: true, depth: true, samples: 4 })
    g.clear(rt)
    const r = env.renderer, sm0 = r.shadowMap.enabled
    r.shadowMap.enabled = shadows
    try { r.render(this.root, c) } catch (err) {
      console.warn('[comp-engine] vrm', err); env.report?.('error', `VRM を描けない: ${err && err.message || err}`)
      g.release(rt); return null
    } finally { r.shadowMap.enabled = sm0 }
    return rt
  }
  dispose() {
    this.dir.shadow?.map?.dispose()
    this.floor.geometry.dispose(); this.floor.material.dispose()
    this.root.traverse((o) => {
      o.geometry?.dispose?.()
      for (const m of [].concat(o.material || [])) { for (const v of Object.values(m)) v?.isTexture && v.dispose(); m.dispose?.() }
    })
  }
}

// 半透明の面を重ねても、絵のアルファが下がらないようにする(レイヤーは乗算済みの絵として戻すため)
function premulAlpha(m) {
  m.blending = THREE.CustomBlending
  m.blendSrc = THREE.SrcAlphaFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor
  m.blendSrcAlpha = THREE.OneFactor; m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor
  return m
}

// → VrmModel(VRM でなければ例外)
export async function loadVrm(env, url) {
  const [gl, tv] = await Promise.all([import('./GLTFLoader.js'), import('./three-vrm.module.min.js')])
  const loader = new gl.GLTFLoader()
  loader.register((parser) => new tv.VRMLoaderPlugin(parser))
  const gltf = await loader.loadAsync(url)
  const vrm = gltf.userData.vrm
  if (!vrm) throw new Error('VRM の拡張が無い(GLB は source.vrm を書かずに読む)')
  tv.VRMUtils.rotateVRM0(vrm) // VRM 0.x は −z 向き → 正面を +z(手前)に合わせる
  return new VrmModel(env, vrm)
}
