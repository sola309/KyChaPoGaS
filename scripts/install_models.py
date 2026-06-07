#!/usr/bin/env python3
"""
KyChaPoGaS — モデルダウンローダー

使い方:
  python scripts/install_models.py [--config scripts/models.local.json] [--dry-run]

scripts/models.local.json (gitignore) で enabled: true にしたモデルをダウンロードします。
ファイルが存在しない場合は tools/models.example.json をコピーして使います。
"""

import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).parent.parent


def _load_env_token() -> str:
    """Read CIVITAI_TOKEN from the environment, then backend/.env as a fallback."""
    token = os.getenv("CIVITAI_TOKEN", "").strip()
    if token:
        return token
    env_file = ROOT / "backend" / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("CIVITAI_TOKEN=") and not line.startswith("#"):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


CIVITAI_TOKEN = _load_env_token()


def _authorize_url(url: str) -> str:
    """Civitai requires an API token; append it as a query param when needed."""
    if "civitai.com" in url and CIVITAI_TOKEN and "token=" not in url:
        sep = "&" if "?" in url else "?"
        return f"{url}{sep}token={urllib.parse.quote(CIVITAI_TOKEN)}"
    return url


def load_config(config_path: Path) -> dict:
    local = ROOT / "scripts" / "models.local.json"
    example = ROOT / "tools" / "models.example.json"

    if config_path.exists():
        with open(config_path, encoding="utf-8") as f:
            return json.load(f)

    if local.exists():
        with open(local, encoding="utf-8") as f:
            return json.load(f)

    if example.exists():
        print(f"[INFO] models.local.json が見つかりません。{example} をコピーします...")
        import shutil
        shutil.copy(example, local)
        with open(local, encoding="utf-8") as f:
            return json.load(f)

    print("[ERR]  models.example.json が見つかりません。")
    sys.exit(1)


def human_size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def download(url: str, dest: Path, dry_run: bool) -> None:
    if dest.exists():
        print(f"  → スキップ (既存): {dest.name}")
        return
    if "civitai.com" in url and not CIVITAI_TOKEN:
        print("  ✗ Civitai のダウンロードには CIVITAI_TOKEN が必要です。")
        print("    backend/.env の CIVITAI_TOKEN= にトークンを設定してください。")
        return
    if dry_run:
        print(f"  → [dry-run] {dest}")
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"  → ダウンロード中: {url}")
    print(f"     保存先: {dest}")

    # Civitai blocks the default urllib User-Agent (→ 403) and authenticates via
    # a ?token= query param (a Bearer header is rejected with 400). Send a
    # browser-like UA and the token in the URL — matching a working `curl`.
    headers = {"User-Agent": "Mozilla/5.0 (compatible; KyChaPoGaS-installer/1.0)"}
    fetch_url = _authorize_url(url)

    tmp = dest.with_suffix(dest.suffix + ".part")
    try:
        req = urllib.request.Request(fetch_url, headers=headers)
        with urllib.request.urlopen(req) as resp:
            total = int(resp.headers.get("Content-Length", 0))
            downloaded = 0
            chunk = 1024 * 256
            with open(tmp, "wb") as f:
                while True:
                    buf = resp.read(chunk)
                    if not buf:
                        break
                    f.write(buf)
                    downloaded += len(buf)
                    if total > 0:
                        pct = min(100, downloaded * 100 // total)
                        bar = "█" * (pct // 5) + "░" * (20 - pct // 5)
                        print(f"\r     [{bar}] {pct:3d}%  {human_size(downloaded)}/{human_size(total)}", end="", flush=True)
        tmp.replace(dest)
        print()
        print(f"  ✓ 完了: {dest.name}")
    except Exception as e:
        print(f"\n  ✗ 失敗: {e}")
        tmp.unlink(missing_ok=True)
        if dest.exists():
            dest.unlink()


def main():
    parser = argparse.ArgumentParser(description="KyChaPoGaS model installer")
    parser.add_argument("--config",  type=Path, default=ROOT / "scripts" / "models.local.json")
    parser.add_argument("--dry-run", action="store_true", help="ダウンロードせずに対象を表示のみ")
    args = parser.parse_args()

    cfg = load_config(args.config)
    if args.dry_run:
        print("[dry-run] 実際にはダウンロードしません\n")

    total_downloaded = 0
    total_skipped = 0

    for category, models in cfg.items():
        if category.startswith("_"):
            continue
        if not isinstance(models, list):
            continue

        enabled = [m for m in models if m.get("enabled", False)]
        if not enabled:
            continue

        print(f"\n── {category} ({len(enabled)} 件) ──")
        for m in enabled:
            name = m.get("name", "?")
            url  = m.get("url", "")
            dest = ROOT / m.get("dest", "")
            size = m.get("size_gb", 0)
            note = m.get("_note", "")

            print(f"\n  {name}")
            if note:
                print(f"  ※ {note}")
            if not url:
                print("  → URL 未設定。手動でダウンロードしてください。")
                continue

            # ディレクトリ指定の場合はスキップ（手動DL）
            if dest.suffix == "" or m.get("dest", "").endswith("/"):
                print(f"  → 複数ファイル構成。手動ダウンロード先: {dest}")
                continue

            download(url, dest, args.dry_run)
            if dest.exists():
                total_downloaded += 1
            else:
                total_skipped += 1

    print(f"\n完了: {total_downloaded} ダウンロード / {total_skipped} スキップ")


if __name__ == "__main__":
    main()
