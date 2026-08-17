import { chromium } from 'playwright-core'
const b = await chromium.launch({ channel: 'chromium', args: ['--autoplay-policy=no-user-gesture-required'] })
const p = await b.newPage({ viewport: { width: 1600, height: 950 } })
p.on('pageerror', e => console.log('PAGEERROR', e.message.slice(0, 70)))
await p.goto('http://localhost:8002/', { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(2500)
await p.getByText('AniPAFE2026 24fps', { exact: true }).first().click()
await p.waitForTimeout(9000)
await p.locator('div[title^="C2:"]').first().click({ button: 'right' })
await p.waitForTimeout(2500)
console.log('audio要素:', await p.locator('.z-\\[150\\] audio').count())
// 再生中に「音源の位置から求めたフレーム」と「表示中のフレーム」の差を測る
const samples = []
for (let i = 0; i < 12; i++) {
  const r = await p.evaluate(() => {
    const els = [...document.querySelectorAll('.z-\\[150\\] audio')]
    const playing = els.filter(e => !e.paused)
    const label = document.querySelector('.z-\\[150\\] .font-mono')?.textContent ?? ''
    const m = label.match(/f(\d+)/)
    return { n: els.length, playing: playing.length,
             t: playing[0]?.currentTime ?? null, shown: m ? Number(m[1]) : null,
             rs: els.map(e => e.readyState) }
  })
  samples.push(r)
  await p.waitForTimeout(280)
}
const ok = samples.filter(s => s.playing > 0 && s.t != null && s.shown != null)
console.log('再生中サンプル:', ok.length, '/', samples.length)
console.log('readyState:', JSON.stringify(samples[samples.length-1].rs))
if (ok.length >= 3) {
  // C2: cutStartFrame=125, fps=24。音源位置→期待フレーム
  const errs = ok.map(s => Math.abs((s.t * 24 - 125) - s.shown))
  console.log('音源位置と表示フレームの差(フレーム):',
    errs.map(e => e.toFixed(2)).join(' '))
  console.log('最大ズレ:', Math.max(...errs).toFixed(2), 'フレーム =',
    (Math.max(...errs) / 24 * 1000).toFixed(1), 'ms')
}
await p.screenshot({ path: process.argv[2] })
await b.close()
