// パペット(manifest v2 + レイヤーPNG) → Anime2.5DRig互換PSD 書き出し。
//
// 本家の命名規約・層順(sample.psd実測: back hair→…→front hair, 差分は最上段)に
// 合わせる。READMEの推奨に従い neck は topwear に統合(境目破綻の回避)。
// 閉じ目・閉じ口差分は同梱しない → 本家アプリ側の汎用差分フォールバックに任せる。
//
// usage: node export_psd.mjs --puppet <puppet_dir> --out <out.psd>

import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { writePsdBuffer } = require('ag-psd')
const { PNG } = require('pngjs')

const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k)
  return i >= 0 ? process.argv[i + 1] : d
}
const PUPPET = arg('puppet'); const OUT = arg('out')
if (!PUPPET || !OUT) { console.error('need --puppet and --out'); process.exit(2) }

const manifest = JSON.parse(readFileSync(join(PUPPET, 'manifest.json'), 'utf8'))
const [W, H] = manifest.canvas

const readPng = (file) => PNG.sync.read(readFileSync(join(PUPPET, file)))

// 全キャンバスRGBAへ正規化(レイヤーPNGは全キャンバスの想定だが保険で配置)
function fullCanvas(png) {
  if (png.width === W && png.height === H) return png.data
  const out = Buffer.alloc(W * H * 4)
  const w = Math.min(png.width, W), h = Math.min(png.height, H)
  for (let y = 0; y < h; y++)
    png.data.copy(out, y * W * 4, y * png.width * 4, y * png.width * 4 + w * 4)
  return out
}

// αコンポジット (dst over) — neck を topwear の下に敷いて統合するため
function compositeUnder(topData, underData) {
  const out = Buffer.from(underData)
  for (let i = 0; i < out.length; i += 4) {
    const ta = topData[i + 3] / 255
    if (ta === 0) continue
    const ua = out[i + 3] / 255
    const oa = ta + ua * (1 - ta)
    for (let c = 0; c < 3; c++)
      out[i + c] = oa > 0 ? Math.round((topData[i + c] * ta + out[i + c] * ua * (1 - ta)) / oa) : 0
    out[i + 3] = Math.round(oa * 255)
  }
  return out
}

// 本家の名前へマッピング(それ以外は素通し=位置から追従扱いになる)
const RENAME = { mouth: 'mouth_open' }
// sample.psd実測の層順(下→上)。無いものは飛ばし、リスト外は元のz順で後段に挿入
const ORDER = ['back hair', 'handwear', 'bottomwear', 'topwear', 'ears', 'face',
               'nose', 'mouth_open', 'eyewhite', 'eyelash', 'irides', 'eyebrow',
               'front hair']

const layersByName = {}
for (const l of [...manifest.layers].sort((a, b) => a.z - b.z)) {
  const name = RENAME[l.name] ?? l.name
  layersByName[name] = layersByName[name] || []
  layersByName[name].push(l)
}

// neck→topwear統合(README推奨: 一体型のほうが境目が破綻しない)
let neckData = null
if (layersByName['neck']) {
  neckData = fullCanvas(readPng(layersByName['neck'][0].file))
  delete layersByName['neck']
}

const children = []
const used = new Set()
function pushLayer(name, ls) {
  used.add(name)
  for (const l of ls) {
    let data = fullCanvas(readPng(l.file))
    if (name === 'topwear' && neckData) {
      data = compositeUnder(data, neckData)   // topwearが上、neckが下
      neckData = null
    }
    children.push({ name, imageData: { width: W, height: H, data: new Uint8ClampedArray(data) } })
  }
}
for (const name of ORDER) if (layersByName[name]) pushLayer(name, layersByName[name])
// neckがあってtopwearが無い場合はneck単体をtopwearとして出す
if (neckData) children.splice(1, 0, { name: 'topwear',
  imageData: { width: W, height: H, data: new Uint8ClampedArray(neckData) } })
// リスト外レイヤー(髪飾り等)は最上段の手前に
for (const [name, ls] of Object.entries(layersByName))
  if (!used.has(name)) pushLayer(name, ls)

const buf = writePsdBuffer({ width: W, height: H, children })
writeFileSync(OUT, buf)
console.log(`wrote ${OUT}: ${children.length} layers [${children.map(c => c.name).join(', ')}] ${W}x${H}`)
