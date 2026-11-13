#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AviUtl 0.18 プロジェクト (.aup) + 拡張編集 0.92 のデータを JSON / .exo に書き出す。

標準ライブラリだけで動く。

    python3 aup_parse.py 1.05.aup -o 1.05.json --exo 1.05_exo --validate

わかっていること / 推定 / 不明 は出力 JSON の "format_notes" にも書く。

.aup の入れ物
    0x00  "AviUtl ProjectFile version 0.18\\0" (32 バイト)
    0x20  u32 編集ハンドルの展開後サイズ, u32 (=1), char[260] 入力名, char[260] 出力名
    0x230 圧縮した編集ハンドル → そのあとフレーム表・各フィルタの設定(未解読、読み飛ばす)
    ...   "AviUtl ProjectFile version 0.18\\0" (フッタ)
          "FilterProject 0.1\\0"
          { u32 名前長, 名前(cp932, NUL 込み), u32 展開後サイズ, 圧縮データ } の繰り返し
          → 名前 "拡張編集" のかたまりが exedit のデータ
    圧縮: 1 バイトの頭 b。b&0x80 なら「次の 1 バイトを (b&0x7f) 回」、そうでなければ
          「続く b バイトをそのまま」。回数が 0 のときは続く 3 バイト(LE)が回数。

拡張編集のかたまり (展開後)
    0x00  "80EE", u32 フィルタ数, u32 オブジェクト数, ..., [6]=オブジェクト 1 個の大きさ(1480)
    0x60  ..., [2]=シーン数, [3]=レイヤー設定の数, [4]=シーン 1 個の大きさ(220),
          [5]=レイヤー設定 1 個の大きさ(76), [7]=トラックバー移動スクリプトの数
    0x100 レイヤー設定 {i32 scene, i32 layer, u32 flag, char name[64]}
    続き  シーン設定 220 バイト, 移動スクリプト名 128 バイト, フィルタ表 112 バイト,
          オブジェクト (1480 バイト + そのオブジェクトの拡張データ) の繰り返し
"""
import argparse
import collections
import json
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MAGIC = b'AviUtl ProjectFile version 0.18\0'
FILTER_MAGIC = b'FilterProject 0.1\0'

# ---------------------------------------------------------------- 名前の表

# 拡張編集の「移動の種類」(トラックバーのボタン)。下位 4 ビット。
TRACK_MODES = {
    0: '移動無し', 1: '直線移動', 2: '曲線移動', 3: '瞬間移動', 4: '中間点無視',
    5: '移動量指定', 6: 'ランダム移動', 7: '加減速移動', 8: '反復移動', 15: 'スクリプト',
}
TRACK_ACCEL = 0x40   # 加速 (aviutl_exedit_sdk の Object::TrackMode: isAccelerate=0x40)
TRACK_DECEL = 0x20   # 減速 (isDecelerate=0x20)

BLEND_MODES = ['通常', '加算', '減算', '乗算', 'スクリーン', 'オーバーレイ', '比較(明)',
               '比較(暗)', '輝度', '色差', '陰影', '明暗', '差分']
FIGURE_TYPES = ['背景', '円', '四角形', '三角形', '五角形', '六角形', '星型']
TEXT_TYPES = ['標準文字', '影付き文字', '影付き文字(薄)', '縁取り文字', '縁取り文字(細)']
TEXT_ALIGN = ['左寄せ[上]', '中央揃え[上]', '右寄せ[上]', '左寄せ[中]', '中央揃え[中]',
              '右寄せ[中]', '左寄せ[下]', '中央揃え[下]', '右寄せ[下]',
              '縦書 上寄[右]', '縦書 中央[右]', '縦書 下寄[右]',
              '縦書 上寄[中]', '縦書 中央[中]', '縦書 下寄[中]',
              '縦書 上寄[左]', '縦書 中央[左]', '縦書 下寄[左]']

# name が空のとき type が指す、組み込みスクリプトの並び (exedit.anm / .obj / .cam / .scn の順)
BUILTIN_ANM = ['震える', '振り子', '弾む', '座標の拡大縮小(個別オブジェクト)', '画面外から登場',
               'ランダム方向から登場', '拡大縮小して登場', 'ランダム間隔で落ちながら登場',
               '弾んで登場', '広がって登場', '起き上がって登場', '何処からともなく登場',
               '反復移動', '座標の回転(個別オブジェクト)', '立方体(カメラ制御)', '球体(カメラ制御)',
               '砕け散る', '点滅', '点滅して登場', '簡易変形', '簡易変形(カメラ制御)',
               'リール回転', '万華鏡', '円形配置', 'ランダム配置']
BUILTIN_OBJ = ['集中線', '走査線', 'カウンター', 'レンズフレア', '雲', '星', '雪', '雨',
               'ランダム小物配置(カメラ制御)', 'ライン(移動軌跡)', '扇型', '多角形',
               '周辺ボケ光量', 'フレア', '水面']
BUILTIN_CAM = ['手ぶれ', '目標中心回転', '目標サイズ固定視野角']
# シーンチェンジは本体組み込み分 → exedit.scn の順 (この並びは未検証)
BUILTIN_SCN = ['クロスフェード', 'ワイプ(円)', 'ワイプ(四角)', 'ワイプ(時計)', 'スライス', 'スワップ',
               'スライド', '縮小回転', '押し出し(横)', '押し出し(縦)', '回転(横)', '回転(縦)',
               'キューブ回転(横)', 'キューブ回転(縦)', 'フェードアウトイン', '放射ブラー', 'ぼかし',
               'ワイプ(横)', 'ワイプ(縦)', 'ロール(横)', 'ロール(縦)', 'ランダムライン',
               '発光', 'レンズブラー', 'ドア', '起き上がる', 'リール回転', '図形ワイプ',
               '図形で隠す', '図形で隠す(放射)', '砕け散る', 'ページめくり']
SCRIPT_FILTERS = {'アニメーション効果': BUILTIN_ANM, 'カスタムオブジェクト': BUILTIN_OBJ,
                  'カメラ効果': BUILTIN_CAM, 'シーンチェンジ': BUILTIN_SCN}

# UndoFish 氏「イージング」トラックバースクリプトの番号 (easing_aviutl.lua の表)
EASING_NAMES = ['linear', 'inQuad', 'outQuad', 'inOutQuad', 'outInQuad', 'inCubic', 'outCubic',
                'inOutCubic', 'outInCubic', 'inQuart', 'outQuart', 'inOutQuart', 'outInQuart',
                'inQuint', 'outQuint', 'inOutQuint', 'outInQuint', 'inSine', 'outSine',
                'inOutSine', 'outInSine', 'inExpo', 'outExpo', 'inOutExpo', 'outInExpo',
                'inCirc', 'outCirc', 'inOutCirc', 'outInCirc', 'inElastic', 'outElastic',
                'inOutElastic', 'outInElastic', 'inBack', 'outBack', 'inOutBack', 'outInBack',
                'inBounce', 'outBounce', 'inOutBounce', 'outInBounce']

OBJECT_TYPES = {
    '動画ファイル': 'video', '画像ファイル': 'image', '音声ファイル': 'audio', 'テキスト': 'text',
    '図形': 'shape', 'フレームバッファ': 'framebuffer', '音声波形表示': 'waveform',
    'シーン': 'scene', 'シーン(音声)': 'scene_audio', '直前オブジェクト': 'previous_object',
    'カスタムオブジェクト': 'custom_object', '時間制御': 'time_control',
    'グループ制御': 'group_control', 'カメラ制御': 'camera_control',
    'パーティクル出力': 'particle', 'シーンチェンジ': 'scene_change', '部分フィルタ': 'partial_filter',
}

# Object.flag のビット。名前は aviutl_exedit_sdk (Object::Flag) のもの。
# このファイルでは 0x10000 は映像・音声の全メディアオブジェクトに立っている。
OBJ_FLAGS = [(0x1, 'exist'), (0x100, 'clipping'), (0x200, 'camera'),
             (0x10000, 'filter'), (0x20000, 'sound'), (0x40000, 'effect'),
             (0x80000, 'control'), (0x100000, 'show_range')]

OBJ_SIZE = 1480
N_FILTER = 12
N_TRACK = 64
N_CHECK = 48


# ---------------------------------------------------------------- 道具

def rle_decode(buf, pos, out_size, exact=True):
    """pos から out_size バイトぶん展開する。(展開結果, 読み終えた位置) を返す。
    exact=False のときは out_size を越えたところで止めて切り詰める (頭だけ読みたいとき)。"""
    out = bytearray()
    n = len(buf)
    while len(out) < out_size:
        if pos >= n:
            raise ValueError('圧縮データが途中で終わった (pos=%d)' % pos)
        b = buf[pos]
        pos += 1
        c = b & 0x7f
        if c == 0:
            c = int.from_bytes(buf[pos:pos + 3], 'little')
            pos += 3
        if b & 0x80:
            out += bytes((buf[pos],)) * c
            pos += 1
        else:
            out += buf[pos:pos + c]
            pos += c
    if len(out) != out_size:
        if not exact:
            return bytes(out[:out_size]), pos
        raise ValueError('展開後サイズが合わない: %d != %d' % (len(out), out_size))
    return bytes(out), pos


def cstr(b, enc='cp932'):
    return b.split(b'\0', 1)[0].decode(enc, 'replace')


def load_filter_defs():
    path = os.path.join(HERE, 'exedit092_filters.json')
    if not os.path.exists(path):
        return []
    with open(path, encoding='utf-8') as fp:
        return json.load(fp)['filters']


def match_filter_def(defs, name, flag, tn, cn, es):
    c = [d for d in defs if d['name'] == name and len(d['tracks']) == tn
         and len(d['checks']) == cn and d['exdata_size'] == es]
    if not c:
        return None
    c2 = [d for d in c if (d['flag'] & 0x20) == (flag & 0x20)]
    return (c2 or c)[0]


def fmt_num(v, scale):
    """exo と同じ桁で数値を文字列にする。"""
    if scale == 1:
        return '%d' % v
    if scale == 10:
        return '%.1f' % (v / 10.0)
    if scale == 100:
        return '%.2f' % (v / 100.0)
    return repr(v / float(scale))


def scaled(v, scale):
    if scale == 1:
        return v
    return round(v / float(scale), 4)


# ---------------------------------------------------------------- 本体 (AviUtl 側)

def parse_container(data):
    if data[:32] != MAGIC:
        raise ValueError('AviUtl ProjectFile version 0.18 ではない')
    handle_size, one = struct.unpack_from('<II', data, 32)
    info = {
        'header': cstr(data[:32]),
        'edit_handle_size': handle_size,
        'input_name': cstr(data[40:300]),
        'output_name_buffer': cstr(data[300:560]),
    }
    # 編集ハンドルは頭の 4096 バイトだけ展開する。ヘッダの大きさ (edit_handle_size) と
    # 実際の圧縮データの終わりは 403 バイト合わず、終わりの決め方は未解読。
    handle, pos = rle_decode(data, 0x230, 4096, exact=False)
    # 編集ハンドル内の位置は 1.05.aup で確かめた固定位置。値が変なら None にする。
    w, h, frames = struct.unpack_from('<iii', handle, 260)
    info['project_path'] = cstr(handle[:260])
    info['width'], info['height'], info['frame_count'] = w, h, frames
    sel = struct.unpack_from('<ii', handle, 272)
    info['select_range_guess'] = list(sel)
    fmt, ch, rate, _bps, _blk, bits = struct.unpack_from('<HHIIHH', handle, 0x1ec)
    if fmt == 1 and 1 <= ch <= 8 and 8000 <= rate <= 192000:
        info['audio'] = {'rate': rate, 'channels': ch, 'bits': bits}
    else:
        info['audio'] = None
    vr, vs = struct.unpack_from('<ii', handle, 0x208)
    if 0 < vr < 1000000 and 0 < vs < 1000000:
        info['video_rate'], info['video_scale'] = vr, vs
        info['fps'] = round(vr / vs, 6)
    else:
        info['video_rate'] = info['video_scale'] = info['fps'] = None
    # フッタ以降のかたまり
    foot = data.rfind(MAGIC + FILTER_MAGIC)
    if foot < 0:
        raise ValueError('フッタ (FilterProject 0.1) が見つからない')
    info['unparsed_body_bytes'] = foot - 0x230   # 編集ハンドルの残り・フレーム表・各フィルタ設定 (未解読)
    chunks = {}
    p = foot + len(MAGIC) + len(FILTER_MAGIC)
    order = []
    while p + 8 <= len(data):
        nl = struct.unpack_from('<I', data, p)[0]
        if nl == 0 or nl > 260:
            break
        name = cstr(data[p + 4:p + 4 + nl])
        p += 4 + nl
        size = struct.unpack_from('<I', data, p)[0]
        p += 4
        body, p = rle_decode(data, p, size)
        chunks[name] = body
        order.append({'name': name, 'size': size})
    info['filter_project_chunks'] = order
    info['trailing_bytes'] = len(data) - p
    return info, chunks


# ---------------------------------------------------------------- 本体 (拡張編集)

def parse_exedit(ex, defs):
    if ex[:4] != b'80EE':
        raise ValueError('拡張編集データの印 80EE がない')
    h1 = struct.unpack_from('<23I', ex, 4)
    h2 = struct.unpack_from('<8I', ex, 0x60)
    n_filter, n_object = h1[0], h1[1]
    obj_size, n_track, n_check, n_fpo = h1[6], h1[7], h1[8], h1[9]
    n_scene, n_layer, scene_size, layer_size, n_tra = h2[2], h2[3], h2[4], h2[5], h2[7]
    if (obj_size, n_track, n_check, n_fpo) != (OBJ_SIZE, N_TRACK, N_CHECK, N_FILTER):
        raise ValueError('オブジェクト構造体の大きさが想定と違う: %r' % ((obj_size, n_track, n_check, n_fpo),))
    out = {'header_raw': {'h1': list(h1), 'h2': list(h2),
                          'note': 'h1=[filter_n, object_n, ?, ?, ?, ?, object_size, track_n, check_n, '
                                  'filter_per_object, ?...] h2=[?, ?, scene_n, layer_setting_n, '
                                  'scene_size, layer_size, ?, track_script_n]'}}
    p = 0x100
    layers = []
    for k in range(n_layer):
        sc, ly, fl = struct.unpack_from('<iiI', ex, p)
        layers.append({'scene': sc, 'layer': ly, 'flag': fl, 'name': cstr(ex[p + 12:p + layer_size])})
        p += layer_size
    scenes = []
    for k in range(n_scene):
        ints = struct.unpack_from('<%di' % (scene_size // 4), ex, p)
        scenes.append({'index': ints[0], 'flag': ints[1], 'name': cstr(ex[p + 8:p + 72]),
                       'ints': ints})
        p += scene_size
    tra = []
    for k in range(n_tra):
        tra.append(cstr(ex[p:p + 128]))
        p += 128
    filters = []
    for k in range(n_filter):
        fl, tn, cn, es = struct.unpack_from('<4I', ex, p)
        name = cstr(ex[p + 16:p + 112])
        filters.append({'id': k, 'name': name, 'flag': fl, 'track_n': tn, 'check_n': cn,
                        'exdata_size': es, 'def': match_filter_def(defs, name, fl, tn, cn, es)})
        p += 112
    raw_objs = []
    for k in range(n_object):
        o = p
        flag, layer_disp, fb, fe = struct.unpack_from('<Iiii', ex, o)
        r = {
            'id': k, 'flag': flag, 'layer_disp': layer_disp, 'start': fb, 'end': fe,
            'dispname': cstr(ex[o + 0x10:o + 0x50]),
            'leader_raw': struct.unpack_from('<i', ex, o + 0x50)[0],
            'fp': [struct.unpack_from('<ihhI', ex, o + 0x54 + 12 * i) for i in range(N_FILTER)],
            'status': ex[o + 0xe4:o + 0xf0],
        }
        r['track_sum'], r['check_sum'], r['exdata_sum'] = struct.unpack_from('<hhi', ex, o + 0xf0)
        r['tl'] = struct.unpack_from('<64i', ex, o + 0xf8)
        r['tr'] = struct.unpack_from('<64i', ex, o + 0x1f8)
        r['tm'] = struct.unpack_from('<128h', ex, o + 0x2f8)   # (num, script_idx) の組
        r['cv'] = struct.unpack_from('<48i', ex, o + 0x3f8)
        r['exdata_offset_raw'], r['group'] = struct.unpack_from('<Ii', ex, o + 0x4b8)
        r['tp'] = struct.unpack_from('<64i', ex, o + 0x4c0)
        r['layer'], r['scene'] = struct.unpack_from('<ii', ex, o + 0x5c0)
        r['ex'] = ex[o + OBJ_SIZE:o + OBJ_SIZE + r['exdata_sum']]
        p = o + OBJ_SIZE + r['exdata_sum']
        raw_objs.append(r)
    out['end_offset'] = p
    out['size'] = len(ex)
    return out, layers, scenes, tra, filters, raw_objs


def decode_exdata(fdef, name, blob):
    """フィルタ 1 個ぶんの拡張データを、exo と同じ項目名の dict にする。"""
    res = collections.OrderedDict()
    if not blob:
        return res
    if fdef is None or not fdef.get('exdata'):
        res['_raw_hex'] = blob.hex()
        return res
    off = 0
    for typ, size, key in fdef['exdata']:
        part = blob[off:off + size]
        if typ == 0:
            if key is None and part.strip(b'\0'):
                res['_internal_%d_hex' % off] = part.hex()
        elif typ == 1:
            if key is None:
                key = 'scene' if name in ('シーン', 'シーン(音声)') else '_num_%d' % off
            res[key] = int.from_bytes(part, 'little', signed=True)
        elif typ == 2:
            res[key] = cstr(part)
        elif typ == 3:
            if key == 'text':
                res[key] = part.decode('utf-16-le', 'replace').split('\0', 1)[0]
            elif key in ('color', 'color2') and size == 3:
                res[key] = part.hex()            # exo と同じ rrggbb
            else:
                res[key] = part.hex()
        off += size
    return res


def annotate_exdata(name, exd):
    """番号の意味を足す (元の番号は残す)。"""
    add = {}
    if 'blend' in exd and name in ('標準描画', '拡張描画', 'パーティクル出力'):
        b = exd['blend']
        add['blend_name'] = BLEND_MODES[b] if 0 <= b < len(BLEND_MODES) else None
    if name == '図形':
        t = exd.get('type', 0)
        add['type_name'] = (exd.get('name') or None) if exd.get('name') else (
            FIGURE_TYPES[t] if 0 <= t < len(FIGURE_TYPES) else None)
    if name == 'テキスト':
        t = exd.get('type', 0)
        a = exd.get('align', 0)
        add['type_name'] = TEXT_TYPES[t] if 0 <= t < len(TEXT_TYPES) else None
        add['align_name'] = TEXT_ALIGN[a] if 0 <= a < len(TEXT_ALIGN) else None
    if name in SCRIPT_FILTERS:
        if exd.get('name'):
            add['script'] = exd['name']
        else:
            lst = SCRIPT_FILTERS[name]
            t = exd.get('type', 0)
            add['script'] = lst[t] if 0 <= t < len(lst) else None
            add['script_builtin'] = True
    if name == 'マスク':
        if exd.get('name'):
            add['type_name'] = exd['name']
        else:
            t = exd.get('type', 0)
            add['type_name'] = FIGURE_TYPES[t] if 0 <= t < len(FIGURE_TYPES) else None
    exd.update(add)
    return exd


def build(info, exinfo, layers, scenes, tra, filters, raw_objs):
    # --- 中間点の鎖: leader_raw が同じものが 1 本。先頭 (拡張データを持つ) が親。
    chains = collections.defaultdict(list)
    for r in raw_objs:
        if r['leader_raw'] != -1:
            chains[r['leader_raw']].append(r)
    chain_of = {}
    for cid, (key, lst) in enumerate(sorted(chains.items())):
        lst.sort(key=lambda r: r['start'])
        for i, r in enumerate(lst):
            chain_of[r['id']] = (cid, i, len(lst), lst[0]['id'])
    by_id = {r['id']: r for r in raw_objs}

    objects = []
    for r in raw_objs:
        ch = chain_of.get(r['id'])
        leader = by_id[ch[3]] if ch else r
        fl_names = [n for bit, n in OBJ_FLAGS if r['flag'] & bit]
        unknown_bits = r['flag'] & ~sum(b for b, _ in OBJ_FLAGS)
        first = filters[r['fp'][0][0]]['name'] if r['fp'][0][0] >= 0 else None
        if first in OBJECT_TYPES:
            otype = OBJECT_TYPES[first]
        elif first is None:
            otype = 'empty'
        else:
            otype = 'filter_object'
        o = collections.OrderedDict()
        o['id'] = r['id']
        o['scene'] = r['scene']
        o['layer'] = r['layer'] + 1            # 画面表示と同じ 1 始まり
        o['start'] = r['start']                # 0 始まりのフレーム (exo は +1)
        o['end'] = r['end']                    # 最後のフレーム (含む)
        o['type'] = otype
        o['type_name'] = first
        o['flags'] = fl_names
        if unknown_bits:
            o['flag_unknown_bits'] = hex(unknown_bits)
        o['camera_target'] = bool(r['flag'] & 0x200)      # カメラ制御の対象
        o['clip_with_above'] = bool(r['flag'] & 0x100)    # 上のオブジェクトでクリッピング
        if r['group']:
            o['group'] = r['group']
        if r['dispname']:
            o['name'] = r['dispname']
        # 先頭フィルタの status bit0 が 0 のオブジェクトは描かれない (1.05 の完成動画で確認:
        # ルートのメモ用テキストが画面に出ていない)。タイムライン上のメモ・消音に使われている。
        if not (leader['status'][0] & 1):
            o['disabled'] = True
        if ch:
            o['chain'] = {'id': ch[0], 'index': ch[1], 'count': ch[2], 'leader': ch[3],
                          'role': 'leader' if ch[1] == 0 else 'follower'}
        fl_out = []
        for i in range(N_FILTER):
            fid, tb, cb, eo = r['fp'][i]
            if fid < 0:
                break
            f = filters[fid]
            fdef = f['def']
            fo = collections.OrderedDict()
            fo['name'] = f['name']
            fo['filter_id'] = fid
            # 状態は親のものを使う (子の値は古いまま残っていることが多い)
            st = leader['status'][i]
            fo['status'] = st
            # bit0=有効。ただし先頭 (入力) と最後 (出力) のフィルタは有効/無効の切替が無い。
            fo['enabled'] = bool(st & 1)
            if st & 2:
                fo['folded'] = True
            tracks = []
            for t in range(f['track_n']):
                ti = tb + t
                tname, scale = ('track%d' % t, 1)
                if fdef:
                    tname, scale = fdef['tracks'][t][0], fdef['tracks'][t][1]
                num, sidx = r['tm'][2 * ti], r['tm'][2 * ti + 1]
                mode = num & 0x0f
                tk = collections.OrderedDict()
                tk['name'] = tname
                if not fdef:
                    tk['scale_unknown'] = True
                if mode == 0:
                    tk['value'] = scaled(r['tl'][ti], scale)
                else:
                    tk['left'] = scaled(r['tl'][ti], scale)
                    tk['right'] = scaled(r['tr'][ti], scale)
                    tk['mode'] = TRACK_MODES.get(mode, 'unknown_%d' % mode)
                    tk['mode_num'] = num
                    if num & TRACK_ACCEL:
                        tk['accel'] = True
                    if num & TRACK_DECEL:
                        tk['decel'] = True
                    if num & ~(0x0f | TRACK_ACCEL | TRACK_DECEL):
                        tk['mode_unknown_bits'] = hex(num & ~(0x0f | TRACK_ACCEL | TRACK_DECEL))
                    if mode == 15:
                        sname = tra[sidx] if 0 <= sidx < len(tra) else None
                        tk['script'] = sname
                        tk['param'] = r['tp'][ti]
                        if sname and sname.endswith('@イージング'):
                            e = r['tp'][ti]
                            tk['easing'] = EASING_NAMES[e - 1] if 1 <= e <= len(EASING_NAMES) else None
                    elif r['tp'][ti]:
                        tk['param'] = r['tp'][ti]
                tk['_scale'] = scale
                tracks.append(tk)
            fo['tracks'] = tracks
            checks = collections.OrderedDict()
            for c in range(f['check_n']):
                cname, cdef = ('check%d' % c, 0)
                if fdef:
                    cname, cdef = fdef['checks'][c][0] or ('check%d' % c), fdef['checks'][c][1]
                if cdef is not None and cdef < 0:
                    continue     # ボタン / 選択リスト。中身は拡張データ側にある
                checks[cname] = r['cv'][cb + c]
            fo['checks'] = checks
            src = leader
            _fid, _tb, _cb, leo = src['fp'][i]
            blob = src['ex'][leo:leo + f['exdata_size']] if f['exdata_size'] else b''
            exd = annotate_exdata(f['name'], decode_exdata(fdef, f['name'], blob))
            fo['exdata'] = exd
            fl_out.append(fo)
        o['filters'] = fl_out
        objects.append(o)

    # --- シーン
    lay_by_scene = collections.defaultdict(list)
    for l in layers:
        if l['flag'] or l['name']:
            d = {'layer': l['layer'] + 1, 'flag': l['flag']}
            if l['flag'] & 1:
                d['hidden'] = True
            if l['flag'] & 2:
                d['locked'] = True
            if l['flag'] & 0x10:
                d['coord_link'] = True
            if l['flag'] & 0x20:
                d['clip'] = True
            if l['name']:
                d['name'] = l['name']
            lay_by_scene[l['scene']].append(d)
    per_scene = collections.defaultdict(list)
    for o in objects:
        per_scene[o['scene']].append(o)
    scene_out = []
    for s in scenes:
        ints = s['ints']
        objs = per_scene.get(s['index'], [])
        d = collections.OrderedDict()
        d['index'] = s['index']
        d['name'] = s['name'] or ('Root' if s['index'] == 0 else 'Scene %d' % s['index'])
        d['name_stored'] = s['name']
        d['flag'] = s['flag']
        d['alpha'] = bool(s['flag'] & 2)
        d['width'] = ints[18] or info['width']
        d['height'] = ints[19] or info['height']
        d['size_is_project_default'] = not (ints[18] or ints[19])
        d['max_frame_stored'] = ints[20]
        d['object_count'] = len(objs)
        d['length'] = (max(o['end'] for o in objs) + 1) if objs else 0
        d['layers_used'] = sorted(set(o['layer'] for o in objs))
        d['layer_settings'] = sorted(lay_by_scene.get(s['index'], []), key=lambda x: x['layer'])
        names = ['current_frame', 'timeline_scale', 'timeline_disp_begin_pos', 'selected_object',
                 'selected_frame_begin', 'selected_frame_end', 'disp_bpm_grid', 'bpm_grid_tempo',
                 'bpm_grid_base', 'disp_xy_grid', 'xy_grid_width', 'xy_grid_height',
                 'disp_camera_grid', 'camera_grid_size', 'camera_grid_num', 'disp_out_of_frame',
                 'out_of_frame_scale', 'bpm_grid_beat', 'disp_begin_layer']
        d['ui_state'] = {n: ints[21 + i] for i, n in enumerate(names) if ints[21 + i]}
        scene_out.append(d)

    doc = collections.OrderedDict()
    doc['format_notes'] = FORMAT_NOTES
    doc['project'] = info
    doc['exedit'] = collections.OrderedDict()
    doc['exedit']['header'] = exinfo
    doc['exedit']['track_scripts'] = tra
    doc['exedit']['filters'] = [{k: v for k, v in f.items() if k != 'def'} | {'known': f['def'] is not None}
                                for f in filters]
    doc['exedit']['scenes'] = scene_out
    doc['exedit']['objects'] = objects
    return doc


FORMAT_NOTES = {
    'frames': 'start/end は 0 始まり・end は含む。layer は 1 始まり (画面の表示と同じ)。exo では start/end とも +1。',
    'tracks': 'value/left/right は画面に出る値 (保存値 ÷ _scale)。mode が無い = 移動無し (value だけ)。'
              '中間点無視 では鎖の最初の left と最後の right だけが意味を持つ。',
    'chain': '中間点で分かれた区間は 1 区間 = 1 オブジェクトとして保存されている。chain.id が同じものが 1 本。'
             '拡張データ (文字・色・ファイル・スクリプト名) とフィルタの有効/無効は親 (leader) のものを子にも写してある。',
    'reliable': ['入れ物と圧縮 (展開後サイズが 1 バイト単位で一致)', 'オブジェクト構造体の位置 (終端が一致)',
                 'フィルタ名・トラック数・チェック数 (ファイル内の表)', 'トラック名/倍率・チェック名・拡張データの項目名 '
                 '(exedit.auf 0.92 のフィルタ定義から取り出した表 exedit092_filters.json)',
                 '中間点の鎖 (全鎖で区間が連続)', 'イージング番号 (easing_aviutl.lua の表)'],
    'by_sdk': ['Object.flag のビット名', 'filter.enabled (status の bit0=Active, bit1=Folding, bit2=Gui)', 'accel=0x40 / decel=0x20',
               'scene.alpha (flag の bit1)', 'layer_settings の hidden=bit0 / locked=bit1 / coord_link=bit4 / clip=bit5',
               'シーン設定の項目順 (ui_state)'],
    'inferred': ['object.disabled (先頭フィルタの Active が 0 → 描かれない。完成動画 1 か所で確認)',
                 '編集ハンドル内の fps・音声形式の位置', '組み込みスクリプトの番号→名前 (name が空のとき)'],
    'unknown': ['exedit ヘッダの一部の数値', '編集ハンドルの終わりの位置 (ヘッダの大きさと 403 バイト合わない)', '拡張データ内の内部用バイト (_internal_*)',
                '本体側のフレーム表・各フィルタ設定 (unparsed_body_bytes)'],
}


# ---------------------------------------------------------------- exo 書き出し

def exo_track(tk):
    sc = tk['_scale']
    if 'value' in tk:
        return fmt_num(round(tk['value'] * sc), sc)
    s = '%s,%s,%d' % (fmt_num(round(tk['left'] * sc), sc), fmt_num(round(tk['right'] * sc), sc),
                      tk['mode_num'])
    if tk['mode_num'] & 0x0f == 15:
        s += '@%s' % tk.get('script')
        s += ',%d' % tk.get('param', 0)
    elif 'param' in tk:
        s += ',%d' % tk['param']
    return s


def write_exo(doc, outdir, readable):
    os.makedirs(outdir, exist_ok=True)
    pj = doc['project']
    paths = []
    for sc in doc['exedit']['scenes']:
        objs = [o for o in doc['exedit']['objects'] if o['scene'] == sc['index']]
        if not objs:
            continue
        objs.sort(key=lambda o: (o['layer'], o['start']))
        L = ['[exedit]', 'width=%d' % sc['width'], 'height=%d' % sc['height'],
             'rate=%s' % pj.get('video_rate'), 'scale=%s' % pj.get('video_scale'),
             'length=%d' % sc['length'],
             'audio_rate=%s' % (pj['audio'] or {}).get('rate'), 'audio_ch=%s' % (pj['audio'] or {}).get('channels')]
        if sc['alpha']:
            L.append('alpha=1')
        if sc['name_stored']:
            L.append('name=%s' % sc['name_stored'])
        for n, o in enumerate(objs):
            L.append('[%d]' % n)
            L.append('start=%d' % (o['start'] + 1))
            L.append('end=%d' % (o['end'] + 1))
            L.append('layer=%d' % o['layer'])
            if o.get('group'):
                L.append('group=%d' % o['group'])
            if 'control' not in o['flags'] and 'sound' not in o['flags']:
                L.append('overlay=1')
            if o['clip_with_above']:
                L.append('clipping=1')
            if 'sound' not in o['flags']:
                L.append('camera=%d' % (1 if o['camera_target'] else 0))
            if 'sound' in o['flags']:
                L.append('audio=1')
            follower = o.get('chain', {}).get('role') == 'follower'
            if follower:
                L.append('chain=1')
            for i, f in enumerate(o['filters']):
                L.append('[%d.%d]' % (n, i))
                L.append('_name=%s' % f['name'])
                first_or_last = (i == 0 or i == len(o['filters']) - 1)
                if not f['enabled'] and not first_or_last:
                    L.append('_disable=1')
                for tk in f['tracks']:
                    L.append('%s=%s' % (tk['name'], exo_track(tk)))
                if follower:
                    continue
                for k, v in f['checks'].items():
                    L.append('%s=%d' % (k, v))
                for k, v in f['exdata'].items():
                    if k.startswith('_') or k.endswith('_name') or k in ('script', 'script_builtin'):
                        continue
                    if k == 'text' and not readable:
                        raw = v.encode('utf-16-le')
                        v = (raw + b'\0' * (2048 - len(raw))).hex()
                    elif k == 'text':
                        v = json.dumps(v, ensure_ascii=False)
                    L.append('%s=%s' % (k, v))
        fn = os.path.join(outdir, 'scene%02d.%s' % (sc['index'], 'exo.txt' if readable else 'exo'))
        if readable:
            with open(fn, 'w', encoding='utf-8', newline='\n') as fp:
                fp.write('\n'.join(L) + '\n')
        else:
            with open(fn, 'w', encoding='cp932', errors='replace', newline='\r\n') as fp:
                fp.write('\n'.join(L) + '\n')
        paths.append(fn)
    return paths


# ---------------------------------------------------------------- 点検

def validate(doc, exinfo, raw_objs):
    rep = []
    ok = True

    def line(cond, msg):
        nonlocal ok
        rep.append(('OK  ' if cond else 'NG  ') + msg)
        ok = ok and cond

    line(exinfo['end_offset'] == exinfo['size'],
         'オブジェクト列の終端 = データ終端 (%d / %d)' % (exinfo['end_offset'], exinfo['size']))
    objs = doc['exedit']['objects']
    scenes = {s['index']: s for s in doc['exedit']['scenes']}
    line(all(o['scene'] in scenes for o in objs), '全オブジェクトのシーン番号がシーン表にある')
    line(all(0 <= o['start'] <= o['end'] for o in objs), '全オブジェクトで 0 <= start <= end')
    line(all(1 <= o['layer'] <= 100 for o in objs), '全オブジェクトでレイヤーが 1..100')
    by = collections.defaultdict(list)
    for o in objs:
        by[(o['scene'], o['layer'])].append(o)
    ov = 0
    for k, lst in by.items():
        lst.sort(key=lambda o: o['start'])
        for a, b in zip(lst, lst[1:]):
            if b['start'] <= a['end']:
                ov += 1
    line(ov == 0, '同じシーン・同じレイヤーでの重なり %d 件' % ov)
    over = sum(1 for o in objs if o['end'] >= scenes[o['scene']]['max_frame_stored'] + 1
               and scenes[o['scene']]['max_frame_stored'] > 0)
    rep.append('INFO 保存されている max_frame を越えて終わるオブジェクト %d 個 (シーンの長さは最後のオブジェクトで決まる)' % over)
    # 鎖
    ch = collections.defaultdict(list)
    for o in objs:
        if 'chain' in o:
            ch[o['chain']['id']].append(o)
    bad = 0
    for lst in ch.values():
        lst.sort(key=lambda o: o['start'])
        if any(a['end'] + 1 != b['start'] or a['layer'] != b['layer'] or a['scene'] != b['scene']
               for a, b in zip(lst, lst[1:])):
            bad += 1
        if [len(o['filters']) for o in lst] != [len(lst[0]['filters'])] * len(lst):
            bad += 1
    line(bad == 0, '中間点の鎖 %d 本がすべて連続・同レイヤー・同じフィルタ構成 (不良 %d)' % (len(ch), bad))
    raw_leaders = collections.Counter()
    for r in raw_objs:
        if r['leader_raw'] != -1:
            raw_leaders[r['leader_raw']] += (1 if r['exdata_sum'] > 0 else 0)
    line(all(v == 1 for v in raw_leaders.values()), '各鎖で拡張データを持つのは 1 区間だけ')
    unknown = sorted(set(f['name'] for o in objs for f in o['filters']
                         if not doc['exedit']['filters'][f['filter_id']]['known']))
    line(not unknown, '使われている全フィルタに定義表がある (無いもの: %s)' % unknown)
    # 文字
    texts = [f['exdata'].get('text', '') for o in objs for f in o['filters'] if f['name'] == 'テキスト'
             and o.get('chain', {}).get('role') != 'follower']
    bad_text = sum(1 for t in texts if '�' in t)
    line(bad_text == 0, 'テキスト %d 個の復号で不正文字 %d 個' % (len(texts), bad_text))
    # シーン参照
    ref = collections.Counter()
    for o in objs:
        if o['type'] == 'scene' and o.get('chain', {}).get('role') != 'follower':
            ref[o['filters'][0]['exdata'].get('scene')] += 1
    missing = [k for k in ref if k not in scenes or scenes[k]['object_count'] == 0]
    line(not missing, 'シーンオブジェクトの参照先がすべて中身のあるシーン (参照されるシーン %d 個、空/不明: %s)'
         % (len(ref), missing))
    rep.append('INFO シーン %d 個中オブジェクトあり %d 個 / オブジェクト %d 個 / 鎖 %d 本' % (
        len(scenes), sum(1 for s in scenes.values() if s['object_count']), len(objs), len(ch)))
    return ok, rep


# ---------------------------------------------------------------- 入口

def dump_json(doc, path):
    """オブジェクト 1 個 = 1 行。grep しやすく、差分も見やすい。"""
    objs = doc['exedit']['objects']
    doc2 = dict(doc)
    ex2 = dict(doc['exedit'])
    ex2['objects'] = '@@OBJECTS@@'
    doc2['exedit'] = ex2
    head = json.dumps(doc2, ensure_ascii=False, indent=1)
    lines = ',\n'.join(json.dumps(o, ensure_ascii=False, separators=(',', ':')) for o in objs)
    text = head.replace('"@@OBJECTS@@"', '[\n' + lines + '\n]')
    with open(path, 'w', encoding='utf-8') as fp:
        fp.write(text + '\n')


def parse_file(path):
    with open(path, 'rb') as fp:
        data = fp.read()
    info, chunks = parse_container(data)
    info['source'] = os.path.abspath(path)
    ex = chunks.get('拡張編集')
    if ex is None:
        raise ValueError('拡張編集のデータが入っていない')
    defs = load_filter_defs()
    exinfo, layers, scenes, tra, filters, raw_objs = parse_exedit(ex, defs)
    doc = build(info, exinfo, layers, scenes, tra, filters, raw_objs)
    return doc, exinfo, raw_objs


def main():
    ap = argparse.ArgumentParser(description='AviUtl .aup (拡張編集 0.92) → JSON / exo')
    ap.add_argument('aup')
    ap.add_argument('-o', '--out', help='JSON の出力先')
    ap.add_argument('--exo', metavar='DIR', help='シーンごとの .exo (cp932) と .exo.txt (UTF-8・文字は復号) を書く')
    ap.add_argument('--validate', action='store_true', help='点検結果を表示')
    a = ap.parse_args()
    doc, exinfo, raw_objs = parse_file(a.aup)
    if a.validate:
        ok, rep = validate(doc, exinfo, raw_objs)
        print('\n'.join(rep))
        doc['validation'] = rep
    if a.out:
        dump_json(doc, a.out)
        print('wrote', a.out, os.path.getsize(a.out), 'bytes')
    if a.exo:
        p1 = write_exo(doc, a.exo, readable=False)
        p2 = write_exo(doc, a.exo, readable=True)
        print('wrote %d exo + %d exo.txt in %s' % (len(p1), len(p2), a.exo))
    if not a.out and not a.exo and not a.validate:
        pj = doc['project']
        print(json.dumps({k: pj[k] for k in ('width', 'height', 'fps', 'frame_count', 'audio')}, ensure_ascii=False))
        print('scenes', len(doc['exedit']['scenes']), 'objects', len(doc['exedit']['objects']))


if __name__ == '__main__':
    main()
