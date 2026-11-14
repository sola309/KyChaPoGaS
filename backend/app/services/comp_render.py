"""コンポジションの描き出し(docs/composition-design.md)。

tools/comp-kit/player.html を capture モードで開き、既存の決定論キャプチャ
(motion_graphics.render_html_to_video)で 1 コマずつ撮って動画素材にする。
プレビュー(編集画面の iframe)と同じエンジンなので見た目がずれない。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
import threading
from datetime import datetime
from pathlib import Path

import imageio_ffmpeg
from sqlmodel import Session, select

from app.db.database import engine
from app.models import Asset, Clip, Job
from app.models.composition import Composition

log = logging.getLogger("comp_render")

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
REPO = Path(__file__).resolve().parents[3]
COMP_KIT = REPO / "tools" / "comp-kit"
MG_LIBS = REPO / "tools" / "mg-libs"
DATA = Path(__file__).resolve().parents[2] / "data"
GENERATED_DIR = DATA / "generated"
PROXIES_DIR = DATA / "proxies"
VFRAME_DIR = DATA / "comp_cache" / "vframes"
# キャプチャのページ(about:blank 起点)がこのバックエンドへ素材を取りに来る宛先
API_BASE = os.getenv("COMP_API_BASE", "http://127.0.0.1:8002")
BOOT_MARK = "/*__COMP_BOOT__*/"
VCHUNK = 48        # 動画のコマはこの数ずつまとめて切り出す


def comp_dict(c: Composition) -> dict:
    try:
        data = json.loads(c.data_json or "{}")
    except Exception:
        data = {}
    data.setdefault("version", 1)
    data.setdefault("layers", [])
    return {
        "id": c.id, "project_id": c.project_id, "name": c.name,
        "width": c.width, "height": c.height, "fps": c.fps,
        "duration_frames": c.duration_frames, "data": data,
        "rev": c.rev, "rendered_rev": c.rendered_rev,
        "rendered_asset_id": c.rendered_asset_id,
        "stale": c.rendered_rev != c.rev,
        "updated_at": c.updated_at.isoformat() if c.updated_at else None,
        "created_at": c.created_at.isoformat() if c.created_at else None,
    }


def player_html(comp: dict, mode: str, api_base: str = "", frame: int | None = None) -> str:
    src = (COMP_KIT / "player.html").read_text(encoding="utf-8")
    base = api_base.rstrip("/")
    boot = {"comp": comp, "mode": mode, "apiBase": base,
            "engineBase": "/api/comps/engine/"}
    boot["fonts"] = [{"family": f["family"], "weight": f["weight"], "aliases": f.get("aliases", []),
                      "url": f"{base}/api/comps/fonts/{f['file']}"} for f in list_fonts()]
    if frame is not None:
        boot["frame"] = frame
    js = "window.__COMP_BOOT = " + json.dumps(boot, ensure_ascii=False).replace("</", "<\\/") + ";"
    if BOOT_MARK not in src:
        raise RuntimeError("player.html に /*__COMP_BOOT__*/ がありません")
    return src.replace(BOOT_MARK, js, 1)


FONT_DIRS = [DATA / "fonts", REPO / "tools" / "mad-kit" / "fonts"]
_font_cache: dict[str, tuple[float, dict]] = {}


def list_fonts() -> list[dict]:
    """エンジンに読ませる追加フォント(data/fonts と mad-kit の同梱分)。family は字体ファイルの名前から。"""
    out = []
    for d in FONT_DIRS:
        if not d.is_dir():
            continue
        for f in sorted(d.iterdir()):
            if f.suffix.lower() not in (".ttf", ".otf", ".woff2", ".woff", ".ttc"):
                continue
            mt = f.stat().st_mtime
            hit = _font_cache.get(str(f))
            if not hit or hit[0] != mt:
                fam, style = f.stem, ""
                try:
                    from PIL import ImageFont
                    fam, style = ImageFont.truetype(str(f), 20).getname()
                except Exception:
                    pass
                st = (style or "").lower()
                w = next((v for k, v in (("thin", 100), ("extralight", 200), ("light", 300), ("medium", 500),
                                         ("semibold", 600), ("demibold", 600), ("extrabold", 800), ("heavy", 900),
                                         ("black", 900), ("bold", 700)) if k in st.replace(" ", "")), 400)
                aliases: list[str] = []
                try:
                    from fontTools.ttLib import TTFont
                    tt = TTFont(str(f), fontNumber=0, lazy=True)
                    for rec in tt["name"].names:
                        if rec.nameID in (1, 16):
                            n = rec.toUnicode().strip()
                            if n and n != fam and n not in aliases:
                                aliases.append(n)
                    tt.close()
                except Exception:
                    pass
                hit = (mt, {"family": fam, "weight": w, "style": style, "file": f.name, "aliases": aliases})
                _font_cache[str(f)] = hit
            out.append(dict(hit[1]))
    return out


def font_file(name: str) -> Path | None:
    for d in FONT_DIRS:
        p = (d / name).resolve()
        if d.is_dir() and d.resolve() in p.parents and p.is_file():
            return p
    return None


def remap_refs(data: dict, asset_fn=None, comp_fn=None) -> dict:
    """文書の中の素材 id・コンポジション id を写像した写しを返す(書き出し・取り込み用)。"""
    d = json.loads(json.dumps(data))
    for ly in d.get("layers") or []:
        src = ly.get("source")
        if not isinstance(src, dict):
            continue
        if asset_fn and isinstance(src.get("asset_id"), int):
            src["asset_id"] = asset_fn(src["asset_id"])
        seq = src.get("sequence")
        if asset_fn and isinstance(seq, dict) and isinstance(seq.get("asset_ids"), list):
            seq["asset_ids"] = [asset_fn(x) if isinstance(x, int) else x for x in seq["asset_ids"]]
        if comp_fn and isinstance(src.get("comp_id"), int):
            src["comp_id"] = comp_fn(src["comp_id"])
        sp = src.get("sprite")
        if asset_fn and isinstance(sp, dict) and isinstance(sp.get("asset_id"), int):
            sp["asset_id"] = asset_fn(sp["asset_id"])
    # 効果の中の参照(mask_image・overlay_source など)
    for ly in d.get("layers") or []:
        for fx in (ly.get("effects") or []) if isinstance(ly, dict) else []:
            pr = fx.get("params") if isinstance(fx, dict) else None
            if not isinstance(pr, dict):
                continue
            if asset_fn and isinstance(pr.get("asset_id"), int):
                pr["asset_id"] = asset_fn(pr["asset_id"])
            if comp_fn and isinstance(pr.get("comp_id"), int):
                pr["comp_id"] = comp_fn(pr["comp_id"])
    return d


def engine_file(path: str) -> Path | None:
    """エンジンの配布物。comp-kit → mg-libs の順に探す(上の階層へは出さない)。"""
    for root in (COMP_KIT, MG_LIBS):
        p = (root / path).resolve()
        if root.resolve() in p.parents and p.is_file():
            return p
    return None


# ── 入れ子・参照 ──────────────────────────────────────────────────────────────

def child_comp_ids(data: dict) -> set[int]:
    """文書が中で使っているコンポジション(comp レイヤー、効果 overlay_source、mesh のテクスチャなど、
    レイヤーの中のどこかにある comp_id をすべて拾う)。"""
    out: set[int] = set()

    def walk(v):
        if isinstance(v, dict):
            cid = v.get("comp_id")
            if isinstance(cid, int) and not isinstance(cid, bool):
                out.add(cid)
            for x in v.values():
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)

    walk(data.get("layers") or [])
    return out


def _deep_layer_count(comp_id: int, session: Session, seen: set[int] | None = None) -> int:
    """入れ子の中まで数えたレイヤーの数(描き出しの重さの目安)。"""
    seen = seen if seen is not None else set()
    if comp_id in seen:
        return 0
    seen.add(comp_id)
    c = session.get(Composition, comp_id)
    if not c:
        return 0
    try:
        data = json.loads(c.data_json or "{}")
    except Exception:
        return 0
    n = len(data.get("layers") or [])
    for cid in child_comp_ids(data):
        n += _deep_layer_count(cid, session, seen)
    return n


def render_workers(comp_id: int, session: Session) -> int:
    """描き出しの並列数。入れ子の深い重い comp は 1 本あたり 5〜10GB 使うので(さくら全編で空き 11GB まで
    落ちた、2026-11-14)、空きメモリ 40GB を残す範囲に絞る。"""
    layers = _deep_layer_count(comp_id, session)
    per_gb = 1.5 if layers < 60 else 4.0 if layers < 250 else 9.0
    try:
        avail_gb = next(int(l.split()[1]) for l in open("/proc/meminfo") if l.startswith("MemAvailable")) / 1048576
    except Exception:
        avail_gb = 48.0
    return max(1, min(8, int((avail_gb - 40.0) / per_gb)))


def is_stale_deep(c: Composition, session: Session) -> bool:
    """描き出しが古いか。入れ子の子が変わった場合・素材ファイルが無い場合も古いとみなす。"""
    a = session.get(Asset, c.rendered_asset_id) if c.rendered_asset_id else None
    if not a or not Path(a.file_path).exists():
        return True
    try:
        key = json.loads(a.gen_params_json or "{}").get("content_key", "")
    except Exception:
        key = ""
    return key != content_key(c.id, session)


def find_cycle(comp_id: int, data: dict, session: Session) -> bool:
    """comp_id の文書を data にしたとき、入れ子が自分へ戻ってくるか。"""
    seen: set[int] = set()
    todo = list(child_comp_ids(data))
    while todo:
        cid = todo.pop()
        if cid == comp_id:
            return True
        if cid in seen:
            continue
        seen.add(cid)
        c = session.get(Composition, cid)
        if c:
            try:
                todo.extend(child_comp_ids(json.loads(c.data_json or "{}")))
            except Exception:
                pass
    return False


def content_key(comp_id: int, session: Session) -> str:
    """描き出しの中身を決める版の組(自分+入れ子の rev)。入れ子が変わっても古いと分かるように。"""
    parts, seen, todo = [], set(), [comp_id]
    while todo:
        cid = todo.pop()
        if cid in seen:
            continue
        seen.add(cid)
        c = session.get(Composition, cid)
        if not c:
            continue
        parts.append(f"{cid}:{c.rev}")
        try:
            todo.extend(child_comp_ids(json.loads(c.data_json or "{}")))
        except Exception:
            pass
    return ",".join(sorted(parts))


# ── 動画素材のコマ(キャプチャ用)──────────────────────────────────────────────

_vlocks: dict[str, threading.Lock] = {}
_vlocks_guard = threading.Lock()


def _has_alpha(src: Path) -> bool:
    try:
        r = subprocess.run([FFMPEG, "-hide_banner", "-i", str(src)], capture_output=True, text=True, timeout=20)
        for line in r.stderr.splitlines():
            if "Video:" in line:
                return any(k in line for k in ("rgba", "argb", "bgra", "yuva", "gbrap", "ya8"))
    except Exception:
        pass
    return False


def video_frame(asset: Asset, n: int, fps: float) -> Path | None:
    """動画素材の n コマ目(fps で数える)の画像。VCHUNK コマずつ切り出してキャッシュする。"""
    src = Path(asset.file_path)
    if not src.exists() or n < 0:
        return None
    key = f"{asset.id}_{int(src.stat().st_mtime)}_{fps:.4f}".replace(".", "p")
    d = VFRAME_DIR / key
    c0 = (n // VCHUNK) * VCHUNK
    for ext in ("png", "jpg"):
        p = d / f"{n:06d}.{ext}"
        if p.exists():
            return p
    done = d / f".chunk_{c0:06d}"
    with _vlocks_guard:
        lock = _vlocks.setdefault(f"{key}/{c0}", threading.Lock())
    with lock:
        if not done.exists():
            d.mkdir(parents=True, exist_ok=True)
            ext = "png" if _has_alpha(src) else "jpg"
            q = ["-pix_fmt", "rgba"] if ext == "png" else ["-q:v", "1", "-qmin", "1"]
            cmd = [FFMPEG, "-y", "-v", "error", "-ss", f"{c0 / fps:.6f}", "-i", str(src),
                   "-vf", f"fps={fps}", "-frames:v", str(VCHUNK), "-start_number", str(c0),
                   *q, str(d / f"%06d.{ext}")]
            r = subprocess.run(cmd, capture_output=True, timeout=300)
            if r.returncode != 0:
                log.warning(f"vframe extract failed asset {asset.id} @{c0}: {r.stderr.decode(errors='replace')[-300:]}")
            done.touch()
    for ext in ("png", "jpg"):
        p = d / f"{n:06d}.{ext}"
        if p.exists():
            return p
    # 素材の終わりより先: 最後のコマで止める
    have = sorted(x for x in d.glob("[0-9]*.*"))
    return have[-1] if have else None


# ── 描き出し ──────────────────────────────────────────────────────────────────

async def render_comp(comp_id: int, job_id: int, progress_cb=None, frames: tuple[int, int] | None = None) -> int:
    """コンポジションを動画素材に描き出し、その comp を指すクリップを新しい素材へ差し替える。素材 id を返す。"""
    from app.services.motion_graphics import render_html_to_video
    from app.services.media_info import probe
    from app.services.thumbnail import generate_video_thumbnail

    with Session(engine) as s:
        c = s.get(Composition, comp_id)
        if not c:
            raise ValueError(f"コンポジション {comp_id} がありません")
        comp = comp_dict(c)
        key = content_key(comp_id, s)
        workers = render_workers(comp_id, s)
    transparent = not comp["data"].get("bg")
    dest = GENERATED_DIR / str(comp["project_id"])
    dest.mkdir(parents=True, exist_ok=True)
    out = dest / (f"comp{comp_id}_r{comp['rev']}_{job_id}." + ("mov" if transparent else "mp4"))
    html = player_html(comp, "capture", API_BASE)

    def _progress(p: float) -> None:
        # 取り消されたら撮るのをやめる(例外で抜けるとワーカーのブラウザも閉じる)
        with Session(engine) as s2:
            j = s2.get(Job, job_id)
            if j is not None and j.status == "cancelled":
                raise RuntimeError("取り消されました")
        if progress_cb:
            progress_cb(0.9 * p)

    await render_html_to_video(
        html, out,
        duration_sec=comp["duration_frames"] / comp["fps"],
        fps=comp["fps"], width=comp["width"], height=comp["height"],
        transparent=transparent, capture="canvas",
        progress_cb=_progress, workers=workers,
    )
    info = probe(out)
    gp = {"comp_id": comp_id, "rev": comp["rev"], "content_key": key, "job_id": job_id,
          "derived": {"op": "render_comp", "note": f"コンポジション「{comp['name']}」r{comp['rev']}"}}
    with Session(engine) as s:
        a = Asset(project_id=comp["project_id"], name=f"🎞 {comp['name']} r{comp['rev']}{out.suffix}",
                  asset_type="generated", file_path=str(out), duration_sec=info.duration_sec,
                  width=info.width, height=info.height, file_size_bytes=info.file_size_bytes,
                  gen_params_json=json.dumps(gp, ensure_ascii=False))
        s.add(a); s.commit(); s.refresh(a)
        asset_id = a.id
    try:
        generate_video_thumbnail(out, asset_id)
    except Exception as e:
        log.warning(f"thumbnail failed: {e}")
    # 軽量版: 透明なら VP9 のアルファつき webm(Chrome 系のプレビューで下が透ける)、不透明なら H.264
    pdir = PROXIES_DIR / str(comp["project_id"])
    pdir.mkdir(parents=True, exist_ok=True)
    if transparent:
        proxy = pdir / f"{asset_id}.webm"
        cmd = [FFMPEG, "-y", "-v", "error", "-i", str(out), "-vf", "scale='min(960,iw)':-2",
               "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "34",
               "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-auto-alt-ref", "0", str(proxy)]
    else:
        proxy = pdir / f"{asset_id}.mp4"
        cmd = [FFMPEG, "-y", "-v", "error", "-i", str(out), "-vf", "scale='min(960,iw)':-2",
               "-c:v", "libx264", "-crf", "26", "-preset", "veryfast", "-pix_fmt", "yuv420p",
               "-movflags", "+faststart", str(proxy)]
    p = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
    _, err = await p.communicate()
    if transparent:
        # iOS・Safari 用の不透明の写し(暗い地に重ねる)。assets.py が UA を見て出し分ける
        alt = pdir / f"{asset_id}.safari.mp4"
        p2 = await asyncio.create_subprocess_exec(
            FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i", f"color=c=0x18181c:s={info.width}x{info.height}:r={comp['fps']}",
            "-i", str(out), "-filter_complex", "[0][1]overlay=shortest=1,scale='min(960,iw)':-2,format=yuv420p",
            "-c:v", "libx264", "-crf", "26", "-preset", "veryfast", "-movflags", "+faststart", str(alt),
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
        _, err2 = await p2.communicate()
        if p2.returncode != 0:
            log.warning(f"comp safari proxy failed: {err2.decode(errors='replace')[-300:]}")
    if progress_cb:
        progress_cb(0.97)
    with Session(engine) as s:
        a = s.get(Asset, asset_id)
        if p.returncode == 0 and proxy.exists():
            a.proxy_path = str(proxy)
            s.add(a)
        else:
            log.warning(f"comp proxy failed: {err.decode(errors='replace')[-300:]}")
        c = s.get(Composition, comp_id)
        # 描いているあいだに保存されていたら「古い」のまま残す
        c.rendered_rev = comp["rev"]
        c.rendered_asset_id = asset_id
        c.updated_at = datetime.utcnow()
        s.add(c)
        n = 0
        for cl in s.exec(select(Clip).where(Clip.kind == "comp")).all():
            try:
                at = json.loads(cl.attrs_json or "{}")
            except Exception:
                continue
            if at.get("comp_id") != comp_id:
                continue
            at["rev"] = comp["rev"]
            cl.asset_id = asset_id
            cl.attrs_json = json.dumps(at, ensure_ascii=False)
            s.add(cl); n += 1
        s.commit()
    log.info(f"comp {comp_id} r{comp['rev']} → asset {asset_id}({n} クリップを差し替え)")
    return asset_id


def stale_comp_ids_for_project(project_id: int, session: Session) -> list[int]:
    """このプロジェクトのタイムラインに置いてある comp のうち、描き出しが古いもの。"""
    from app.models import Track
    tids = [t.id for t in session.exec(select(Track).where(Track.project_id == project_id)).all()]
    if not tids:
        return []
    out: list[int] = []
    for cl in session.exec(select(Clip).where(Clip.track_id.in_(tids)).where(Clip.kind == "comp")).all():
        try:
            cid = json.loads(cl.attrs_json or "{}").get("comp_id")
        except Exception:
            continue
        c = session.get(Composition, cid) if isinstance(cid, int) else None
        if not c or cid in out:
            continue
        if is_stale_deep(c, session):
            out.append(cid)
    return out


# ── サムネイル(未描き出しでも 1 コマだけ描く)────────────────────────────────

THUMB_DIR = DATA / "comp_cache" / "thumbs"
_thumb_lock = threading.Lock()


def comp_thumb(comp: dict, frame: int, width: int = 480) -> Path | None:
    """コンポジションの 1 コマを小さい JPEG に。rev ごとにキャッシュ。ヘッドレスのブラウザを 1 回立てる(数秒)。"""
    THUMB_DIR.mkdir(parents=True, exist_ok=True)
    frame = max(0, min(int(frame), comp["duration_frames"] - 1))
    # id は消したあと使い回されるので、作成時刻も鍵に入れる
    tag = "".join(ch for ch in (comp.get("created_at") or "") if ch.isdigit())[-12:]
    out = THUMB_DIR / f"{comp['id']}_{tag}_r{comp['rev']}_{frame}_{width}.jpg"
    if out.exists():
        return out
    with _thumb_lock:
        if out.exists():
            return out
        try:
            import base64, io
            from PIL import Image
            from playwright.sync_api import sync_playwright
            html = player_html(comp, "capture", API_BASE)
            with sync_playwright() as p:
                br = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader",
                                             "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
                try:
                    pg = br.new_page(viewport={"width": comp["width"], "height": comp["height"]})
                    pg.set_content(html, wait_until="load")
                    pg.evaluate("window.__madAssetsReady || 0")
                    pg.evaluate("(t) => window.seek(t)", frame / comp["fps"] * 1000.0)
                    durl = pg.evaluate("() => document.querySelector('canvas').toDataURL('image/png')")
                finally:
                    br.close()
            im = Image.open(io.BytesIO(base64.b64decode(durl.split(",", 1)[1]))).convert("RGBA")
            # 透明な所は市松にせず暗い地に
            bg = Image.new("RGBA", im.size, (24, 24, 28, 255))
            bg.alpha_composite(im)
            bg = bg.convert("RGB")
            bg.thumbnail((width, width))
            bg.save(out, "JPEG", quality=82)
            for old in THUMB_DIR.glob(f"{comp['id']}_*.jpg"):
                if f"_{tag}_r{comp['rev']}_" not in old.name:
                    old.unlink(missing_ok=True)
        except Exception as e:
            log.warning(f"comp thumb failed: {e}")
            return None
    return out if out.exists() else None
