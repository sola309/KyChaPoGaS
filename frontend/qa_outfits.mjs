// Render each outfit-test puppet (idle + small turn + smile/talk) for a stability review.
import { chromium } from 'playwright-core'
import { writeFileSync } from 'fs'
const EXEC = '/home/kigarashi309/.cache/ms-playwright/chromium-1223/chrome-linux/chrome'
const PIDS = process.argv.slice(2)   // puppet ids to render
const b = await chromium.launch({ executablePath: EXEC, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'] })

async function renderPid(pid) {
  const p = await b.newPage({ viewport: { width: 1320, height: 980 }, deviceScaleFactor: 2 })
  const errs = []; p.on('pageerror', e => errs.push(String(e).slice(0, 140)))
  await p.goto('http://localhost:8002', { waitUntil: 'domcontentloaded' })
  await p.getByText('コンパニオン').click().catch(() => {})
  await p.waitForFunction(() => window.__puppetStage?.sprites?.length > 0, { timeout: 30000 })
  // select the target puppet
  await p.selectOption('select', pid).catch(() => {})
  await p.waitForTimeout(500)
  await p.waitForFunction(() => window.__puppetStage?.sprites?.length > 0, { timeout: 30000 })
  await p.waitForTimeout(1200)
  await p.evaluate(() => window.__puppetStage.app.ticker.stop())
  const meta = await p.evaluate(() => {
    const s = window.__puppetStage
    return { layers: s.sprites.length, name: s.manifest?.name, headR: s.headR,
             sway: s.sprites.filter(e => e.sway).map(e => e.name + ':' + e.sway.type) }
  })
  const shots = {}
  const poses = [
    ['idle', { headTurn: 0, talk: 0, expression: 'neutral' }, 60],
    ['turn', { headTurn: -1, talk: 0, expression: 'neutral' }, 60],
    ['smile', { headTurn: 0.4, talk: 1, expression: 'happy' }, 12.4],
  ]
  for (const [tag, prm, seek] of poses) {
    await p.evaluate(({ prm, seek }) => {
      const s = window.__puppetStage
      s.params = { headNod: 0, ...prm }; s.exprI = 1; s.lastExpr = prm.expression
      s.sTurn = prm.headTurn; s.sTalk = prm.talk; s.clearLook?.()
      for (let k = 0; k < 60; k++) window.__puppetSeek(10 + k * 0.04)
      window.__puppetSeek(seek)
    }, { prm, seek })
    await p.waitForTimeout(40)
    const buf = await p.locator('canvas').first().screenshot()
    shots[tag] = buf
  }
  await p.close()
  return { meta, shots, errs }
}

for (const pid of PIDS) {
  try {
    const r = await renderPid(pid)
    for (const [tag, buf] of Object.entries(r.shots)) writeFileSync(`/tmp/kvtest/r_${pid}_${tag}.png`, buf)
    console.log(JSON.stringify({ pid, ...r.meta, errs: r.errs }))
  } catch (e) {
    console.log(JSON.stringify({ pid, error: String(e).slice(0, 200) }))
  }
}
await b.close()
