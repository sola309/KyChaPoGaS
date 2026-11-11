"""📚 共有素材ライブラリ(長尺素材のカット一覧)のテーブル。

LibraryItem: ライブラリに入れた長尺素材 1 本(asset 1 件)ごとの情報と解析の状態。
LibraryCut:  解析で分けたカット(素材のフレーム番号 [start_frame, end_frame) で持つ)。
             タグ・評価・★・メモはユーザーが付ける。再解析しても重なり 60 % 以上の
             カットへ引き継ぐ(app/services/library_cuts.py)。
"""
from datetime import datetime
from typing import Optional

from sqlmodel import SQLModel, Field


LIBRARY_PARTS = ("本編", "予告", "特典", "OP・ED", "その他")
TRANS_KINDS = ("start", "hard", "dissolve", "fade_black", "fade_white", "flash_cut")
ANALYSIS_STATUSES = ("none", "queued", "running", "done", "error", "interrupted")


class LibraryItem(SQLModel, table=True):
    asset_id: int = Field(primary_key=True, foreign_key="asset.id")
    series: str = ""             # 例: 魔法少女まどか☆マギカ
    work: str = ""               # 例: 劇場版 前編 始まりの物語
    part: str = "本編"           # 本編 / 予告 / 特典 / OP・ED / その他
    sort_order: int = 0
    year: Optional[int] = None
    tags_json: str = "[]"        # ["劇場版", ...]
    note: str = ""
    rating: int = 0              # 0..5
    starred: bool = False
    chapters_json: str = "[]"    # [{title, start_frame, end_frame}](ffprobe のチャプター)
    # 解析の状態: none / queued / running / done / error / interrupted
    analysis_status: str = "none"
    analysis_progress: float = 0.0
    analysis_error: str = ""
    analysis_version: int = 0
    analysis_pid: Optional[int] = None
    analyzed_at: Optional[datetime] = None
    cut_count: int = 0
    fps: float = 0.0
    frames: int = 0
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class LibraryCut(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    asset_id: int = Field(index=True, foreign_key="asset.id")
    idx: int = 0                 # 時間順の通し番号(0 から、素材ごとに一意)
    start_frame: int = 0         # 素材のフレーム(素材の fps)
    end_frame: int = 0           # 含まない
    # 入り方: start / hard / dissolve / fade_black / fade_white / flash_cut
    trans_in: str = "hard"
    trans_frames: int = 0        # 入りの遷移の長さ(start_frame + trans_frames で終わる)。hard は 0
    # 解析で出す特徴
    luma: float = 0.0            # 明るさの平均 0..1
    motion: float = 0.0          # 前のコマとの差の平均 0..1
    sat: float = 0.0             # 彩度の平均 0..1
    hue: Optional[float] = None  # 主な色相(度)。色がほとんどないときは None
    dark: bool = False
    bright: bool = False
    # ユーザーが付ける
    tags_json: str = "[]"
    rating: int = 0
    starred: bool = False
    note: str = ""
    edited: bool = False         # つなぐ・分けるで境目を直した(再解析で境目を上書きしない)
    thumb_ver: int = 0           # サムネイルを作り直した回数(キャッシュよけ)
