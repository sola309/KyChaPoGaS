#!/usr/bin/env python
"""player.html と親(編集画面)の間の postMessage の約束を確かめる。

  player_test.py

親のページに iframe で player.html(プレビュー)を置き、マウス・キーを本物と同じように送って、親に届いたメッセージを見る:
  comp:ready / comp:select / comp:edit(移動・拡大・回転・複数選択の移動)/ comp:key / comp:error / comp:guides / comp:overlay
"""
from __future__ import annotations

import asyncio
import json
import math
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import render_test as rt  # noqa: E402

W, H = 640, 360
VW, VH = 800, 500  # iframe の大きさ(コンポジションと違う比にして、置き場所の計算も通す)

COMP = {"id": "ptest", "name": "ptest", "width": W, "height": H, "fps": 30, "duration_frames": 60, "data": {"version": 1, "bg": "#101418", "layers": [
    {"id": "g", "type": "solid", "guide": True, "in": 0, "out": 60, "transform": {"position": [560, 300]}, "source": {"color": "#00ff00", "width": 60, "height": 60}},
    {"id": "bad", "type": "image", "in": 0, "out": 60, "transform": {"position": [60, 300]}, "source": {"url": "/api/assets/999999999/file"}},
    {"id": "fx", "type": "solid", "in": 0, "out": 60, "transform": {"position": [60, 40]}, "source": {"color": "#8040c0", "width": 40, "height": 40},
     "effects": [{"type": "no_such_effect", "params": {}}]},
    {"id": "B", "type": "solid", "in": 0, "out": 60, "transform": {"position": [520, 80]}, "source": {"color": "#40a0ff", "width": 80, "height": 60}},
    {"id": "K", "type": "solid", "in": 0, "out": 60, "transform": {"position": [120, 180], "scale": {"k": [{"f": 0, "v": [100, 100]}, {"f": 30, "v": [50, 50]}]}}, "source": {"color": "#ffd040", "width": 60, "height": 60}},
    {"id": "A", "type": "solid", "in": 0, "out": 60, "transform": {"position": [320, 180]}, "source": {"color": "#e03060", "width": 200, "height": 100}},
]}}

PARENT = """<!doctype html><html><body style="margin:0;background:#333">
<iframe id="f" src="%s" style="position:absolute;left:40px;top:30px;width:%dpx;height:%dpx;border:0"></iframe>
<script>
window.msgs = []
window.addEventListener('message', (ev) => { if (ev.data && typeof ev.data.type === 'string') window.msgs.push(ev.data) })
window.send = (m) => document.getElementById('f').contentWindow.postMessage(m, '*')
</script></body></html>"""


async def run():
    from playwright.async_api import async_playwright
    tmp = Path(tempfile.mkdtemp(prefix="compkit_player_"))
    (tmp / "ptest.json").write_text(json.dumps(COMP), encoding="utf-8")
    rt.EXTRA_DIR = tmp
    srv, base = rt.start_server()
    fails = []

    def ok(name, cond, extra=""):
        print(f"  {'OK ' if cond else 'NG '} {name} {extra if not cond else ''}")
        if not cond:
            fails.append(name)

    s = min(VW / W, VH / H)
    ox, oy = 40 + (VW - W * s) / 2, 30 + (VH - H * s) / 2
    P = lambda x, y: (ox + x * s, oy + y * s)  # noqa: E731  コンポジションの px → 親のページの px

    async with async_playwright() as p:
        browser = await p.chromium.launch(args=rt.CHROME_ARGS)
        page = await browser.new_page(viewport={"width": 900, "height": 600}, device_scale_factor=1)
        page.on("pageerror", lambda e: fails.append(f"pageerror {e}"))
        await page.set_content(PARENT % (f"{base}/preview/ptest.json?scale=1", VW, VH), wait_until="load")
        frame = None
        for _ in range(100):
            frame = next((f for f in page.frames if "/preview/" in f.url), None)
            if frame and await page.evaluate("window.msgs.some(m => m.type === 'comp:ready')"):
                break
            await asyncio.sleep(0.1)
        ok("comp:ready が届く", frame is not None and await page.evaluate("window.msgs.some(m => m.type === 'comp:ready')"))

        async def msgs(clear=True):
            await asyncio.sleep(0.15)
            m = await page.evaluate("window.msgs.slice()")
            if clear:
                await page.evaluate("window.msgs.length = 0")
            return m

        async def drag(a, b, shift=False, steps=6):
            await page.mouse.move(*a)
            await page.mouse.down()
            if shift:
                await page.keyboard.down("Shift")
            for i in range(1, steps + 1):
                await page.mouse.move(a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps)
            await page.mouse.up()
            if shift:
                await page.keyboard.up("Shift")

        last = lambda ms, path, lid=None: next((m for m in reversed(ms) if m["type"] == "comp:edit" and m["path"] == path and (lid is None or m["id"] == lid)), None)  # noqa: E731
        near = lambda a, b, tol=1.5: a is not None and len(a) == len(b) and all(abs(x - y) <= tol for x, y in zip(a, b))  # noqa: E731

        ink = "() => { const c = document.getElementById('overlay'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n }"
        # 重ね描きの canvas は、最初に画素を読んだ時点で GPU → CPU に切り替わる(ヘッドレスではその直前の描き込みが落ちることがある)ので、先に 1 回読んでおく
        await frame.evaluate(ink)
        # ---- 知らせ(素材が無い・知らないエフェクト) ----
        await asyncio.sleep(0.8)
        ms = await msgs()
        errs = [m for m in ms if m["type"] == "comp:error"]
        ok("comp:error: 読めない画像は error + layer_id", any(m["level"] == "error" and m.get("layer_id") == "bad" for m in errs), str(errs))
        ok("comp:error: 知らないエフェクトは warn + layer_id", any(m["level"] == "warn" and "no_such_effect" in m["message"] and m.get("layer_id") == "fx" for m in errs), str(errs))
        await page.evaluate("window.send({type:'comp:seek', frame: 1})")
        await page.evaluate("window.send({type:'comp:seek', frame: 0})")
        ok("comp:error: 同じ知らせは繰り返さない", not [m for m in await msgs() if m["type"] == "comp:error"])

        # ---- クリックで選択 → ドラッグで移動 ----
        await page.mouse.click(*P(320, 180))
        ms = await msgs()
        ok("comp:select [A]", any(m["type"] == "comp:select" and m["ids"] == ["A"] for m in ms), str(ms))
        await drag(P(320, 180), P(370, 210))
        ms = await msgs()
        e = last(ms, "transform.position")
        ok("移動: comp:edit transform.position", e is not None and e["id"] == "A" and e["final"] is True and near(e["value"], [370, 210]), str(e))
        ok("移動: 途中は final:false", any(m["type"] == "comp:edit" and m["final"] is False for m in ms))
        cx, cy = 370, 210

        # ---- 拡大(四隅 = 縦横比を保つ) ----
        await drag(P(cx + 100, cy + 50), P(cx + 150, cy + 75))
        e = last(await msgs(), "transform.scale")
        ok("拡大(右下の隅・比を保つ): [150,150,100](2D は z を動かさない)", e is not None and near(e["value"], [150, 150, 100]) and e["final"] is True, str(e))
        # いまの見た目は 300×150。Shift = 自由(横だけ伸ばす)
        await drag(P(cx + 150, cy + 75), P(cx + 200, cy + 75), shift=True)
        e = last(await msgs(), "transform.scale")
        ok("拡大(隅 + Shift = 自由): [200,150,…]", e is not None and near(e["value"][:2], [200, 150]), str(e))
        # 辺 = 1 軸だけ(上の辺を外へ: 高さ 150 → 225)
        await drag(P(cx, cy - 75), P(cx, cy - 112.5))
        e = last(await msgs(), "transform.scale")
        ok("拡大(上の辺 = 縦だけ): [200,150→225]", e is not None and near(e["value"][:2], [200, 225]), str(e))
        # 左の辺を内へ(幅 400 → 200)
        await drag(P(cx - 200, cy), P(cx - 100, cy))
        e = last(await msgs(), "transform.scale")
        ok("拡大(左の辺 = 横だけ): [100,225]", e is not None and near(e["value"][:2], [100, 225]) and len(e["value"]) == 3, str(e))

        # ---- 回転(上辺の外のつまみ) ----
        top = cy - 112.5
        hy = top - 26 / s
        r = cy - hy
        await drag(P(cx, hy), P(cx + r, cy), steps=12)   # 上 → 右 = 時計回りに 90°
        e = last(await msgs(), "transform.rotation")
        ok("回転: [0,0,90]", e is not None and near(e["value"], [0, 0, 90], 2.0) and e["final"] is True, str(e))
        # 回したあとのつまみは右側。Shift で 15° 刻み(右 → 右下へ 37° ぶん → 90 + 37 = 127 → 120)
        a = math.radians(37)
        await drag(P(cx + r, cy), P(cx + r * math.cos(a), cy + r * math.sin(a)), shift=True, steps=12)
        e = last(await msgs(), "transform.rotation")
        ok("回転 + Shift: 15° 刻み(120)", e is not None and abs(e["value"][2] - 120) < 0.01, str(e))

        # ---- キーフレームつきの値 ----
        await page.mouse.click(*P(120, 180))
        await msgs()
        await drag(P(150, 210), P(180, 240))
        e = last(await msgs(), "transform.scale")
        ok("キーつきの拡大: keyframed + frame(元が 2 個なら 2 個で返す)", e is not None and e.get("keyframed") is True and e.get("frame") == 0 and near(e["value"], [200, 200], 3), str(e))

        # ---- 複数選択の移動 ----
        await page.evaluate("window.send({type:'comp:set', comp: %s})" % json.dumps(COMP))   # 仮の値を消して元へ戻す
        await page.mouse.click(*P(320, 180))
        await page.keyboard.down("Shift")
        await page.mouse.click(*P(520, 80))
        await page.keyboard.up("Shift")
        ms = await msgs()
        ok("Shift + クリックで追加選択", any(m["type"] == "comp:select" and m["ids"] == ["A", "B"] for m in ms), str([m for m in ms if m["type"] == "comp:select"]))
        await drag(P(320, 180), P(300, 200))
        ms = await msgs()
        ea, eb = last(ms, "transform.position", "A"), last(ms, "transform.position", "B")
        ok("複数選択の移動: レイヤーごとに comp:edit", ea is not None and eb is not None and near(ea["value"], [300, 200]) and near(eb["value"], [500, 100]) and ea["final"] and eb["final"], f"{ea} {eb}")
        ok("複数選択の移動: 選択はそのまま", not any(m["type"] == "comp:select" and m["ids"] != ["A", "B"] for m in ms))

        # ---- キー入力 ----
        await page.mouse.click(*P(320, 320))   # 何もない所(選択を外す。フォーカスは iframe の中)
        ms = await msgs()
        ok("何もない所のクリックで選択を外す", any(m["type"] == "comp:select" and m["ids"] == [] for m in ms), str(ms))
        await page.keyboard.press("Delete")
        await page.keyboard.press("Control+z")
        await page.keyboard.press("Shift+ArrowLeft")
        ks = [m for m in await msgs() if m["type"] == "comp:key"]
        ok("comp:key: Delete", any(m["key"] == "Delete" and m["code"] == "Delete" and not m["ctrl"] for m in ks), str(ks))
        ok("comp:key: Ctrl+Z", any(m["key"].lower() == "z" and m["ctrl"] is True and m["code"] == "KeyZ" for m in ks), str(ks))
        ok("comp:key: Shift+←", any(m["key"] == "ArrowLeft" and m["shift"] is True for m in ks), str(ks))
        ok("comp:key: 修飾の旗がそろっている", all(all(k in m for k in ("key", "code", "ctrl", "shift", "alt", "meta")) for m in ks))

        # ---- 下絵の表示・目安 ----
        px = "() => { const c = document.querySelector('canvas'); const g = c.getContext('webgl2') || c.getContext('webgl'); const p = new Uint8Array(4); g.readPixels(Math.round(560 * c.width / %d), c.height - Math.round(300 * c.height / %d), 1, 1, g.RGBA, g.UNSIGNED_BYTE, p); return [...p] }" % (W, H)
        a0 = await frame.evaluate(px)
        await page.evaluate("window.send({type:'comp:guides', show:false})")
        await asyncio.sleep(0.3)
        a1 = await frame.evaluate(px)
        await page.evaluate("window.send({type:'comp:guides', show:true})")
        await asyncio.sleep(0.3)
        a2 = await frame.evaluate(px)
        ok("comp:guides: 下絵が消えて、戻る", a0[1] > 200 and a1[1] < 60 and a2[1] > 200, f"{a0} {a1} {a2}")
        n0 = await frame.evaluate(ink)
        await page.evaluate("window.send({type:'comp:overlay', safe:true, grid:false})")
        await asyncio.sleep(0.2)
        n1 = await frame.evaluate(ink)
        await page.evaluate("window.send({type:'comp:overlay', safe:true, grid:true})")
        await asyncio.sleep(0.2)
        n2 = await frame.evaluate(ink)
        await page.evaluate("window.send({type:'comp:overlay', safe:false, grid:false})")
        await asyncio.sleep(0.2)
        n3 = await frame.evaluate(ink)
        ok("comp:overlay: セーフフレーム・三分割が出て、消える", n0 == 0 and n1 > 1000 and n2 > n1 + 1000 and n3 == 0, f"{n0} {n1} {n2} {n3}")
        await browser.close()
    srv.shutdown()
    print("\n" + ("すべて OK" if not fails else f"NG {len(fails)} 件: {fails}"))
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    asyncio.run(run())
