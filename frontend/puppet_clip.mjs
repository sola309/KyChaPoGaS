// puppet_clip — コンパニオンを透過webm素材として書き出す(MAD/動画用)。
// usage: node puppet_clip.mjs <puppetId> <motion:idle|talk|nod> <durationSec> <fps> <outDir>
// 透過PNG連番を吐く(webm化は呼び出し側のffmpegで)。
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const [pid = 'recipe_kyoko', motion = 'idle', durS = '4', fpsS = '30', OUT = '/tmp/puppet_clip'] = process.argv.slice(2)
const dur = parseFloat(durS), fps = parseInt(fpsS)
const EXEC = '/home/kigarashi309/.cache/ms-playwright/chromium-1223/chrome-linux/chrome'
const URL = (process.env.QA_URL || 'http://localhost:8002') + `/?puppet=${pid}`
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({ executablePath: EXEC,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 900, height: 1100 } })
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.getByRole('button', { name: '🎭 コンパニオン' }).click().catch(() => {})
let loaded = false
for (let i = 0; i < 40 && !loaded; i++) {
  loaded = await page.evaluate(() => !!(window.__puppetStage && window.__puppetStage.sprites && window.__puppetStage.sprites.length > 0)).catch(() => false)
  if (!loaded) await page.waitForTimeout(2000)
}
if (!loaded) { console.error('puppet load failed'); process.exit(1) }
await page.waitForTimeout(1200)
await page.evaluate(() => window.__puppetStage.app.ticker.stop())

// モーションプリセット: 各フレームでパラメータを純関数的に与える(平滑は内部状態が担う)
const MOTIONS = {
  idle: (t) => ({ talk: 0, turn: 0.25 * Math.sin(t * 0.45), nod: 0.12 * Math.sin(t * 0.3 + 1), expr: 'neutral', level: 0 }),
  talk: (t) => ({ talk: 1, turn: 0.15 * Math.sin(t * 0.6), nod: 0.08 * Math.sin(t * 0.9),
                  expr: t % 6 < 3 ? 'smile' : 'neutral',
                  level: Math.max(0, 0.45 + 0.4 * Math.sin(t * 7.3) + 0.25 * Math.sin(t * 13.1)),
                  wide: 0.5 + 0.45 * Math.sin(t * 2.1) }),
  nod: (t) => ({ talk: 0, turn: 0, nod: Math.sin(t * 2.2) * 0.7, expr: 'smile', level: 0 }),
}
const fn = (MOTIONS[motion] || MOTIONS.idle).toString()

const n = Math.round(dur * fps)
// 内部平滑状態を落ち着かせるプリロール
await page.evaluate(`(() => { const f = ${fn}; for (let k = 0; k < 45; k++) {
  const s = window.__puppetStage, p = f(k / 45)
  s.params = { headTurn: p.turn, headNod: p.nod, talk: p.talk, expression: p.expr }
  s.talkLevel = p.level ?? 0; if (p.wide !== undefined) s.mouthWide = p.wide
  window.__puppetSeek(k / 45) } })()`)
for (let i = 0; i < n; i++) {
  const t = i / fps
  await page.evaluate(`(() => { const f = ${fn}; const p = f(${t})
    const s = window.__puppetStage
    s.params = { headTurn: p.turn, headNod: p.nod, talk: p.talk, expression: p.expr }
    s.talkLevel = p.level ?? 0; if (p.wide !== undefined) s.mouthWide = p.wide
    window.__puppetSeek(1.0 + ${t}) })()`)
  // WebGLから直接抽出(真の透過)。canvas要素のスクショはページ背景が焼き込まれる。
  const b64 = await page.evaluate(async () => {
    const s = window.__puppetStage
    return await s.app.renderer.extract.base64({ target: s.app.stage, format: 'png' })
  })
  const { writeFileSync } = await import('node:fs')
  writeFileSync(`${OUT}/f${String(i).padStart(5, '0')}.png`, Buffer.from(b64.split(',')[1], 'base64'))
  if (i % 30 === 0) console.log(`frame ${i}/${n}`)
}
await browser.close()
console.log('done', n, 'frames →', OUT)
