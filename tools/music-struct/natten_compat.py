"""allin1 が要求する旧 NATTEN API を、0.17.x の分割APIへ橋渡しする。

背景:
  allin1 1.1.0 は `natten.functional.natten1dav / natten1dqkrpb / natten2dav /
  natten2dqkrpb` を import する。これは NATTEN 0.15 系の名前で、0.17 以降で
  `na1d_qk / na1d_av / na2d_qk / na2d_av` に改名された(引数順も変わった)。
  0.21 系では QK/AV の分割API自体が消え、融合API `na1d(q,k,v,...)` だけになっている。

なぜ融合APIで代替できないか:
  融合APIは **rpb(相対位置バイアス)を受け取らない**。allin1 の学習済み重みは rpb を
  持つので、これを渡せないと同じ出力にならない。よって 0.17.5(分割API + rpb対応)を使う。

等価性の根拠:
  0.15.1 の実装では `natten1dqkrpb(q, k, rpb, ks, dil)` は
  `na1d_qk_with_bias(q, k, rpb, ks, dil)` の単なる別名だった。
  0.17.5 の `na1d_qk(q, k, kernel_size, dilation, rpb=...)` は同じ計算で、
  引数の並びが変わっただけ。ここではその並び替えだけを行う。

使い方: allin1 を import する前に、この関数を1度呼ぶ。
"""
from __future__ import annotations


def _patch_torch_symbols() -> None:
    """torch 2.13 で消えた内部シンボルを復元する。

    NATTEN 0.17.5 は `from torch.cuda import _device_t` を行うが、torch 2.13 では
    この private エイリアスが削除されている。用途は **型注釈だけ** (`Optional[_device_t]`)
    なので、等価な公開型 `torch.types.Device` を同名で生やせば足りる。
    """
    import torch

    if not hasattr(torch.cuda, "_device_t"):
        import torch.types

        torch.cuda._device_t = getattr(torch.types, "Device", int)  # type: ignore[attr-defined]


def install() -> None:
    _patch_torch_symbols()
    import natten.functional as F

    if hasattr(F, "natten1dqkrpb"):
        return  # 旧APIがそのままある版(0.15系)なら何もしない

    if not (hasattr(F, "na1d_qk") and hasattr(F, "na1d_av")):
        raise RuntimeError(
            "NATTEN に QK/AV の分割APIがありません。0.17.x を入れてください "
            "(0.21系は融合APIのみで rpb を渡せないため allin1 では使えません)"
        )

    def natten1dqkrpb(query, key, rpb, kernel_size, dilation):
        return F.na1d_qk(query, key, kernel_size, dilation, rpb=rpb)

    def natten2dqkrpb(query, key, rpb, kernel_size, dilation):
        return F.na2d_qk(query, key, kernel_size, dilation, rpb=rpb)

    def natten1dav(attn, value, kernel_size, dilation):
        return F.na1d_av(attn, value, kernel_size, dilation)

    def natten2dav(attn, value, kernel_size, dilation):
        return F.na2d_av(attn, value, kernel_size, dilation)

    F.natten1dqkrpb = natten1dqkrpb
    F.natten2dqkrpb = natten2dqkrpb
    F.natten1dav = natten1dav
    F.natten2dav = natten2dav
