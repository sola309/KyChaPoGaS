// Visual QA for the companion rig: drive the live app headlessly, step the
// puppet through expressions/poses via window.__puppetStage + __puppetSeek, and
// screenshot the canvas so we can eyeball the v2 rig (brows, eyelids, gaze, mouth).
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const EXEC = '/home/kigarashi309/.cache/ms-playwright/chromium-1223/chrome-linux/chrome'
const URL = process.env.QA_URL || 'http://localhost:8002'
const OUT = '/tmp/rigqa'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  executablePath: EXEC,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--ignore-gpu-blocklist', '--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
page.on('console', m => { if (m.type() === 'error') console.log('  [page error]', m.text().slice(0, 200)) })

await page.goto(URL, { waitUntil: 'domcontentloaded' })
// open the Companion app
await page.getByText('コンパニオン').click().catch(() => {})
// wait for the puppet to finish loading
await page.waitForFunction(() => {
  const s = window.__puppetStage
  return s && s.sprites && s.sprites.length > 0
}, { timeout: 30000 }).catch(() => console.log('  (puppet load wait timed out)'))
await page.waitForTimeout(1500)
 await page.evaluate(() => window.__puppetStage.app.ticker.stop())

const canvas = page.locator('canvas').first()

async function shot(name, fn) {
  await page.evaluate(fn)
  await page.waitForTimeout(120)
  await canvas.screenshot({ path: `${OUT}/${name}.png` })
  console.log('  saved', name)
}

// neutral, mid-blink, each expression, gaze, talking
await shot('01_neutral',   () => { const s = window.__puppetStage; s.params = { headTurn: 0, headNod: 0, talk: 0, expression: 'neutral' }; s.talkLevel = 0; window.__puppetSeek(1.0) })
await shot('02_blink',     () => { window.__puppetSeek(3.37) })   // mid-blink (period 3.3)
await shot('03_smile',     () => { const s = window.__puppetStage; s.params.expression = 'smile'; s.exprI = 1; window.__puppetSeek(1.5) })
await shot('04_angry',     () => { const s = window.__puppetStage; s.params.expression = 'angry'; s.exprI = 1; window.__puppetSeek(1.5) })
await shot('05_surprised', () => { const s = window.__puppetStage; s.params.expression = 'surprised'; s.exprI = 1; window.__puppetSeek(1.5) })
await shot('06_sad',       () => { const s = window.__puppetStage; s.params.expression = 'sad'; s.exprI = 1; window.__puppetSeek(1.5) })
await shot('07_gaze',      () => { const s = window.__puppetStage; s.params.expression = 'neutral'; s.exprI = 0; s.setLook(0.9, 0.4); for (let k = 0; k < 30; k++) window.__puppetSeek(5 + k * 0.05) })
await shot('08_talk',      () => { const s = window.__puppetStage; s.clearLook(); s.talkLevel = 0.8; s.mouthWide = 0.7; window.__puppetSeek(6.0) })

await browser.close()
console.log('done →', OUT)
