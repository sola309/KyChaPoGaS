from typing import Optional
from sqlmodel import SQLModel, Field


class TrackBase(SQLModel):
    project_id: int = Field(foreign_key="project.id")
    name: str
    track_type: str  # video | audio | reference
    order: int = 0
    hidden: bool = False   # 非表示トラック(プレビュー/レンダから除外)
    # レイヤー(=コンポジション)の配置。JSON: {"x":0.0,"y":0.0,"w":1.0,"h":1.0,"fit":"contain"}
    # x/y/w/h は出力画面に対する比率。既定(空)は全画面。
    # 例: 左半分 {"x":0,"y":0.25,"w":0.5,"h":0.5} / 右半分 {"x":0.5,...}
    # 比較用に「Shotsを左・Videoを右」と置くだけで、1回のレンダー内で並ぶ。
    layout_json: str = ""


class Track(TrackBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)


class TrackCreate(TrackBase):
    pass


class TrackRead(TrackBase):
    id: int
