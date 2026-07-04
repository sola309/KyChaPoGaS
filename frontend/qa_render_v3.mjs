// v3 rig QA: 口形素・描きまぶた・深度パララックスヨー・髪慣性
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'
const EXEC = '/home/kigarashi309/.cache/ms-playwright/chromium-1223/chrome-linux/chrome'
const URL = (process.env.QA_URL || 'http://localhost:8002') + '/?puppet=recipe_kyoko'
const OUT = '/tmp/rigqa3'
mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch({ executablePath: EXEC,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
page.on('console', m => { if (m.type() === 'error') console.log('  [page error]', m.text().slice(0, 200)) })
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.getByRole('button', { name: '🎭 コンパニオン' }).click().catch(() => {})
let loaded = false
for (let i = 0; i < 40 && !loaded; i++) {
  loaded = await page.evaluate(() => !!(window.__puppetStage && window.__puppetStage.sprites && window.__puppetStage.sprites.length > 0)).catch(() => false)
  if (!loaded) { console.log('  waiting…', i); await page.waitForTimeout(2000)
    if (i === 6) await page.getByRole('button', { name: '🎭 コンパニオン' }).click().catch(() => {}) }
}
if (!loaded) { console.log('LOAD FAILED'); process.exit(1) }
await page.waitForTimeout(1500)
await page.evaluate(() => window.__puppetStage.app.ticker.stop())
const canvas = page.locator('canvas').first()
async function shot(name, fn) {
  await page.evaluate(fn); await page.waitForTimeout(100)
  await canvas.screenshot({ path: `${OUT}/${name}.png` })
  console.log('  saved', name)
}
const converge = (from, n = 20) => { for (let k = 0; k < n; k++) window.__puppetSeek(from + k * 0.033) }
await shot('01_neutral', () => { const s = window.__puppetStage; s.params = { headTurn: 0, headNod: 0, talk: 0, expression: 'neutral' }; s.talkLevel = 0;
  ((from, n = 20) => { for (let k = 0; k < n; k++) window.__puppetSeek(from + k * 0.033) })(1.0) })
await shot('02_viseme_a', () => { const s = window.__puppetStage; s.talkLevel = 0.85; s.mouthWide = 0.7; ((from, n = 20) => { for (let k = 0; k < n; k++) window.__puppetSeek(from + k * 0.033) })(2.0) })
await shot('03_viseme_i', () => { const s = window.__puppetStage; s.talkLevel = 0.4; s.mouthWide = 0.9; ((from, n = 20) => { for (let k = 0; k < n; k++) window.__puppetSeek(from + k * 0.033) })(3.0) })
await shot('04_viseme_u', () => { const s = window.__puppetStage; s.talkLevel = 0.28; s.mouthWide = 0.1; ((from, n = 20) => { for (let k = 0; k < n; k++) window.__puppetSeek(from + k * 0.033) })(4.0) })
await shot('05_viseme_o', () => { const s = window.__puppetStage; s.talkLevel = 0.5; s.mouthWide = 0.2; ((from, n = 20) => { for (let k = 0; k < n; k++) window.__puppetSeek(from + k * 0.033) })(5.0) })
await shot('06_eyes_closed', () => { const s = window.__puppetStage; s.talkLevel = 0; ((from, n = 20) => { for (let k = 0; k < n; k++) window.__puppetSeek(from + k * 0.033) })(3.28) })
await shot('07_yaw_right', () => { const s = window.__puppetStage; s.params.headTurn = 1; ((from, n = 20) => { for (let k = 0; k < n; k++) window.__puppetSeek(from + k * 0.033) })(7.0, 40) })
await shot('08_yaw_left', () => { const s = window.__puppetStage; s.params.headTurn = -1; ((from, n = 20) => { for (let k = 0; k < n; k++) window.__puppetSeek(from + k * 0.033) })(9.0, 40) })
await browser.close()
console.log('done →', OUT)
