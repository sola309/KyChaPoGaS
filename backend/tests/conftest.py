"""h3_guard のテスト共通設定。

安全のため:
- 本物の DB(backend/data/kychapogas.db)には一切つながない。app.db.database.engine を
  一時ファイルの SQLite に差し替え、各モジュールが名前で取り込んだ engine も差し替える。
- ComfyUI には一切つながない(COMFYUI_URL を閉じたポートへ。アップロードは呼ばれたら失敗させる)。
- GPU は使わない(torch を import しない)。
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
os.environ["COMFYUI_URL"] = "http://127.0.0.1:9"     # 閉じたポート(誤って叩いても届かない)
_live_tok = BACKEND.parent / "tools" / "comfyui" / "comfy" / "text_encoders" / "qwen25_tokenizer"
if "H3_QWEN_TOKENIZER_DIR" not in os.environ and _live_tok.exists():
    os.environ["H3_QWEN_TOKENIZER_DIR"] = str(_live_tok)


@pytest.fixture(scope="session", autouse=True)
def _temp_engine(tmp_path_factory):
    """全テストで一時 DB を使う(本物の DB パスへの接続を物理的に作らない)。"""
    from sqlmodel import SQLModel, create_engine
    import app.db.database as dbm
    db = tmp_path_factory.mktemp("db") / "test.db"
    eng = create_engine(f"sqlite:///{db}", connect_args={"check_same_thread": False})
    from app.models import Project, Asset, Track, Clip, Job  # noqa: F401
    SQLModel.metadata.create_all(eng)
    real = dbm.engine
    dbm.engine = eng
    patched = []
    for name, mod in list(sys.modules.items()):
        if name.startswith("app.") and getattr(mod, "engine", None) is real:
            mod.engine = eng
            patched.append(mod)
    yield eng
    for mod in patched:
        mod.engine = real
    dbm.engine = real


@pytest.fixture(autouse=True)
def _isolated_settings(monkeypatch):
    """data/settings.json(本物)の上書き値に左右されないよう空にする。"""
    from app.services import settings_store
    monkeypatch.setattr(settings_store, "_CACHE", {})
    monkeypatch.delenv("H3_MAX_SEQ_TOKENS", raising=False)
    yield


def _ffmpeg() -> str:
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


@pytest.fixture(scope="session")
def media(tmp_path_factory):
    """テスト用の画像・動画(黒一色、CPU で数秒)。戻り値: 名前 → asset 行(dict)。"""
    from PIL import Image
    d = tmp_path_factory.mktemp("media")
    out = {}
    for name, (w, h) in {"card": (1024, 1536), "face": (1024, 1024), "wide": (1344, 768),
                         "small": (928, 672)}.items():
        p = d / f"{name}.png"
        Image.new("RGB", (w, h), (10, 20, 30)).save(p)
        out[name] = {"file_path": str(p), "width": w, "height": h, "duration_sec": None}
    for name, (w, h, n) in {"v1344_345": (1344, 768, 345), "v960_345": (960, 544, 345),
                            "v1344_200": (1344, 768, 200), "v1344_362": (1344, 768, 362),
                            "v1344_576": (1344, 768, 576), "v_tiny": (640, 360, 3),
                            "v1920_328": (1920, 1080, 328)}.items():
        p = d / f"{name}.mp4"
        subprocess.run([_ffmpeg(), "-nostdin", "-v", "error", "-y", "-f", "lavfi",
                        "-i", f"color=c=black:s={w}x{h}:r=24", "-frames:v", str(n),
                        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "51", "-pix_fmt", "yuv420p", str(p)],
                       check=True)
        out[name] = {"file_path": str(p), "width": w, "height": h, "duration_sec": n / 24}
    return out


@pytest.fixture()
def resolver(media):
    """asset_id → 行。ID は 100 番台=画像、200 番台=動画。"""
    table = {101: media["card"], 102: media["face"], 103: media["wide"], 104: media["small"],
             201: media["v1344_345"], 202: media["v960_345"], 203: media["v1344_200"],
             204: media["v1344_362"], 205: media["v1344_576"], 206: media["v_tiny"],
             207: media["v1920_328"]}
    return table.get
