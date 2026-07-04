// モーションQA: 首振り+ボブ中の「髪根本 vs 顔」の追従誤差を頂点座標で実測。
// 誤差 = |Δ(髪root頂点) - Δ(顔頂点)| / フレーム。ピン修正後は ≈0 が合格。
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'
const EXEC = '/home/kigarashi309/.cache/ms-playwright/chromium-1223/chrome-linux/chrome'
const URL = (process.env.QA_URL || 'http://localhost:8002') + '/?puppet=' + (process.argv[2] || 'kyoko_v3') + (process.argv[3] === 'noyaw' ? '&noyaw=1' : '')
const OUT = '/tmp/rigqa_motion'
mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch({ executablePath: EXEC,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 900, height: 1100 } })
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.getByRole('button', { name: '🎭 コンパニオン' }).click().catch(() => {})
let loaded = false
for (let i = 0; i < 40 && !loaded; i++) {
  loaded = await page.evaluate(() => !!(window.__puppetStage && window.__puppetStage.sprites && window.__puppetStage.sprites.length > 0)).catch(() => false)
  if (!loaded) await page.waitForTimeout(2000)
}
if (!loaded) { console.error('load failed'); process.exit(1) }
await page.waitForTimeout(1200)
await page.evaluate(() => window.__puppetStage.app.ticker.stop())

const canvas = page.locator('canvas').first()
const N = 60, FPS = 30
const rows = []
for (let i = 0; i < N; i++) {
  const t = i / FPS
  const m = await page.evaluate((tt) => {
    const s = window.__puppetStage
    // 激しめの首振り+ボブ+発話
    const noyaw = location.search.includes('noyaw')
    s.params = { headTurn: noyaw ? 0 : Math.sin(tt * 3.2), headNod: 0.5 * Math.sin(tt * 2.1), talk: 1, expression: 'smile' }
    s.talkLevel = 0.5 + 0.4 * Math.sin(tt * 8)
    window.__puppetSeek(1 + tt)
    const pick = (pred) => s.sprites.find(pred)
    const fh = pick(e => e.name === 'front hair')
    const face = pick(e => e.name === 'face')
    const out = {}
    if (fh?.mesh && face?.mesh) {
      // 同一基準点比較: 顔row0中央頂点のbase Xを、髪row0で線形補間して評価
      // 両メッシュが厳密に共有する基準点 = row0 col0 (同一base座標、補間誤差なし)
      out.face = [face.mesh.geom.positions[0], face.mesh.geom.positions[1]]
      out.hair = [fh.mesh.geom.positions[0], fh.mesh.geom.positions[1]]
    }
    return out
  }, t)
  rows.push(m)
  if (i % 10 === 0) await canvas.screenshot({ path: `${OUT}/m${String(i).padStart(2, '0')}.png` })
}
let maxDiv = 0, sum = 0, n = 0
for (let i = 1; i < rows.length; i++) {
  const a = rows[i], b = rows[i - 1]
  if (!a.hair || !a.face || !b.hair || !b.face) continue
  const dh = [a.hair[0] - b.hair[0], a.hair[1] - b.hair[1]]
  const df = [a.face[0] - b.face[0], a.face[1] - b.face[1]]
  const div = Math.hypot(dh[0] - df[0], dh[1] - df[1])
  maxDiv = Math.max(maxDiv, div); sum += div; n++
}
console.log(`hair-root vs face divergence: max=${maxDiv.toFixed(2)}px mean=${(sum / n).toFixed(2)}px over ${n} frames`)
await browser.close()
