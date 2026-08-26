#!/usr/bin/env python3
"""生成単位(U番号)をカット開始ピンの attrs_json へ書き込む。

単位はこれまで docs/anipafe2026-prompts-v3/*.txt のヘッダにしか無く、
アプリからは見えなかった。設計の唯一の正はピンの attrs_json という規約
(DesignLinkLane の教訓: docsとattrsに分散して29カットの未反映を見落とした)に
従い、ここへ移す。ピンを動かしても単位が追従する。

  python3 scripts/seed_units.py [--dry]

書き込む形:
  attrs_json.unit = {"id":"U06","mode":"Ref2VA","frames":175,
                     "title":"約束の水面","refs":[3236,...],"cuts":[7]}
単位に属する全カットのピン(開始・終了の両方)へ複製する。
"""
import argparse, importlib.util, json, re, sys, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
API = "http://localhost:8002/api"
PROJECT = 31
STEM_JA = {357: "元音源", 757: "歌唱", 758: "伴奏"}


def api(method, path, body=None):
    r = urllib.request.Request(API + path, method=method,
        data=(json.dumps(body).encode() if body else None),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(r, timeout=30) as f:
        raw = f.read()
    return json.loads(raw) if raw else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    a = ap.parse_args()

    spec = importlib.util.spec_from_file_location("su", ROOT / "scripts/submit_unit.py")
    m = importlib.util.module_from_spec(spec)
    sys.argv = ["x"]
    spec.loader.exec_module(m)
    units = m.parse_units_v3()
    ledp = ROOT / "docs/anipafe2026-ref-audio.json"
    led = json.loads(ledp.read_text()) if ledp.exists() else {}
    packet = m.packet_cuts()

    tracks = api("GET", f"/tracks/?project_id={PROJECT}")
    img = next(t for t in tracks if t["track_type"] == "reference" and t["name"] == "Image")
    pins = sorted([c for c in api("GET", f"/clips/?track_id={img['id']}") if c.get("asset_id")],
                  key=lambda c: c["start_frame"])
    # CutLane と同じ2個ペアリング: C番号 → (開始ピン, 終了ピン)
    pair = {i // 2 + 1: (pins[i], pins[i + 1]) for i in range(0, len(pins) - 1, 2)}

    # UIから読むプロンプト全文。展開後(=H3へ実際に渡る文面)を書き出す。
    # attrs_json に入れるとタイムライン読み込みが数百KB重くなるため別ファイルにし、
    # 単位を開いたときだけ /api/projects/{pid}/unit-prompt/{uid} で取りに来る。
    D = m.build_dict()
    prompts = {}

    n_pin = 0
    edited_units = []   # 手編集ショットとプロンプトがズレている単位
    for uid, u in sorted(units.items()):
        ns = [int(x) for x in re.findall(r"C(\d+)", u["head"].split("(")[0])]
        # ヘッダ "C7 約束の水面 (Ref2VA / ...)" から表題だけ取る
        title = re.sub(r"^(C\d+\+?)+\s*", "", u["head"].split("(")[0]).strip()
        info = {"id": uid, "mode": u["mode"], "frames": u["frames"],
                "title": title, "refs": u["refs"][:9], "cuts": ns}
        # 参照音声(切り出し済みのもの)も載せる。UIで実際に聴いて
        # 「正しい区間を切れているか」を確認できるようにするため。
        auds = []
        for key, v in sorted(led.items()):
            if key.split(":")[0] != uid:
                continue
            auds.append({"asset_id": v["asset_id"], "stem": STEM_JA.get(v["src"], str(v["src"])),
                         "src": v["src"], "start_sec": v["start_sec"], "dur_sec": v["dur_sec"],
                         "role": key.split(":")[1]})
        if auds:
            info["audio"] = auds

        # ショット境界。カット割りとは別のレイヤー — 大半は実測スネア/キックの上に置かれ、
        # 一部はカット境界(物語上の切れ目)。どちらに由来するかをUIで区別できるよう記録する。
        u0 = pair[ns[0]][0]["start_frame"] if ns[0] in pair else 0
        hits = []
        off = 0.0
        for n in ns:
            c = packet.get(n)
            if not c:
                continue
            for kind in ("snare", "kick", "cymbal"):
                hits += [(round(off + t, 3), kind) for t in c["hits"].get(kind, [])]
            off += c["dur"]
        bounds = {}
        off = 0.0
        for n in ns:
            bounds[round(off, 3)] = n
            off += packet[n]["dur"] if n in packet else 0.0

        shots = []
        for mm in re.finditer(r"\[Shot (\d+)\](.{0,140})", u["code"], re.S):
            tm = re.search(r"At 00:(\d+)\.(\d+)", mm.group(2))
            t = (int(tm.group(1)) + float("0." + tm.group(2))) if tm else 0.0
            src, dev = "—", None
            if hits:
                ht, hk = min(hits, key=lambda x: abs(x[0] - t))
                if abs(ht - t) <= 1.5 / 24:          # 1.5フレーム以内なら打点由来と見なす
                    src, dev = hk, round(abs(ht - t), 4)
            # カット境界に一致するものは、打点より物語上の切れ目を優先して表示する
            for bt, bn in bounds.items():
                if abs(bt - t) <= 1.0 / 24:
                    src, dev = f"cut{bn}", round(abs(bt - t), 4)
            shots.append({"i": int(mm.group(1)), "sec": round(t, 3),
                          "frame": u0 + int(round(t * 24)), "src": src, "dev": dev})
        if shots:
            gen = u["frames"] / 24.0
            for i, sh in enumerate(shots):
                nxt = shots[i + 1]["sec"] if i + 1 < len(shots) else gen
                sh["dur"] = round(nxt - sh["sec"], 3)
            info["shots"] = shots

        # UIで手編集したショットは上書きしない(ユーザーの意図が正)。
        # プロンプト由来のショットとズレている場合だけ報告して、書き直しの必要を可視化する。
        prev = {}
        if ns[0] in pair and pair[ns[0]][0].get("attrs_json"):
            try:
                prev = json.loads(pair[ns[0]][0]["attrs_json"]).get("unit") or {}
            except Exception:
                prev = {}
        if prev.get("shots_edited"):
            info["shots"] = prev.get("shots", info.get("shots"))
            info["shots_edited"] = True
            a_ = [s["frame"] for s in (prev.get("shots") or [])]
            b_ = [s["frame"] for s in (shots or [])]
            if a_ != b_:
                edited_units.append((uid, len(a_), len(b_)))
        for n in ns:
            if n not in pair:
                print(f"  ⚠ {uid}: C{n} のピンが無い")
                continue
            for pin in pair[n]:
                attrs = {}
                if pin.get("attrs_json"):
                    try:
                        attrs = json.loads(pin["attrs_json"])
                    except Exception:
                        attrs = {}
                if attrs.get("unit") == info:
                    continue
                attrs["unit"] = info
                n_pin += 1
                if not a.dry:
                    api("PATCH", f"/clips/{pin['id']}",
                        {"attrs_json": json.dumps(attrs, ensure_ascii=False)})
        try:
            expanded = m.expand(u["code"], uid, D)
            prompts[uid] = {"unit": uid, "raw": u["code"], "expanded": expanded,
                            "words": len(expanded.split())}
        except SystemExit as e:
            prompts[uid] = {"unit": uid, "raw": u["code"], "expanded": "",
                            "error": str(e), "words": 0}
        print(f"  {uid} C{ns} {u['mode']} {u['frames']}f 参照{len(info['refs'])}枚  {title[:28]}")

    if not a.dry:
        (ROOT / "docs/anipafe2026-unit-prompts.json").write_text(
            json.dumps(prompts, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n{len(units)}単位 / ピン{n_pin}個へ書き込み{'(dry)' if a.dry else ''} / "
          f"プロンプト全文{len(prompts)}件を書き出し")
    if edited_units:
        print("\n⚠ 手編集ショットがプロンプトと一致していない単位 — プロンプトの書き直しが要る:")
        for uid, mine, doc in edited_units:
            print(f"   {uid}: UI {mine}ショット / プロンプト {doc}ショット")


if __name__ == "__main__":
    main()
