#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""After Effects プロジェクト (.aep, RIFX) を、キーフレームの値とイージングまで読んで JSON にする。

    python3 aep_parse.py project.aep -o aep_full.json

aep_survey.py (ざっくり調査) の続き。プロパティの木をそのまま残し、各プロパティに
静的な値 (v)・キーフレーム (k)・エクスプレッション (x) を付ける。

時刻: レイヤーの ldta とキーの時刻は 24.8 固定小数の整数を「1/120 秒 × 256」(0x7800) で割る。
キーの時刻はレイヤー時間 (コンポ時間 = レイヤーの start + キー時刻)。
キー 1 個の形 (ldat の 1 要素):
  先頭 8 バイト = 時刻 (int32) / 補間 in・out (1 直線 2 ベジェ 3 停止) / 2 バイト 旗
  空間でない n 次元: 値 n, 入りの速さ n, 入りの影響 n, 出の速さ n, 出の影響 n (double)
  空間 (位置・色、tdb4[5] != 0): 0, 次のキーまでの道のり, 入りの速さ, 入りの影響, 出の速さ, 出の影響,
                                  値 n, 入りの接線 n, 出の接線 n
影響は 0〜1 (既定 1/6)。不透明度・スケールは 1 = 100%。色は ARGB 0〜255。
ldta: 104 = トラックマットの種類、132 = 親レイヤーの id、160 = マットに使うレイヤーの id (AE 2023 の方式)。
既定値のプロパティ (アンカーポイント・不透明度など) はファイルに入らないことがある。
レイヤーの旗 (ldta 36〜39 の下 3 バイト) は推定: 0x1 表示, 0x4 エフェクト有効, 0x80 連続ラスタライズ,
0x200 調整レイヤー, 0x400 3D, 0x800 モーションブラー, 0x4000 カメラ, 0x8000 ヌル。
1 本のファイル (1111_恋妹2022_Ae23_v21.aep, AE 2023) で確かめた。
"""
import argparse
import json
import struct

from aep_survey import chunks, mn, utf8

TB = 0x7800  # 1/120 秒 × 256

FLAG_BITS = {'visible': 0x1, 'effects_on': 0x4, 'collapse': 0x80, 'adjustment': 0x200,
             'threeD': 0x400, 'motion_blur': 0x800, 'camera': 0x4000, 'null': 0x8000}


def r(x, n=5):
    return round(x, n) if isinstance(x, float) else x


class Parser:
    def __init__(self, data):
        self.d = data
        self.items = []

    # ---- 1 本のプロパティ
    def prop(self, b, e, name):
        name = name or ''
        d = self.d
        p = {'mn': name}
        tdb4 = None
        for t, cb, sz in chunks(d, b, e):
            if t == b'tdb4':
                tdb4 = d[cb:cb + sz]
            elif t == b'cdat':
                p['_cdat'] = d[cb:cb + sz]
            elif t == b'Utf8' and sz:
                p['x'] = utf8(d, cb, sz)
            elif t == b'tdsn' and sz > 8:
                nm = utf8(d, cb + 8, sz - 8)
                if nm and nm != '-_0_/-':
                    p['name'] = nm
            elif t == b'tdpi':
                p['layer_ref'] = struct.unpack_from('>I', d, cb)[0]
            elif t == b'LIST' and d[cb:cb + 4] == b'list':
                h = None
                for t2, b2, s2 in chunks(d, cb + 4, cb + sz):
                    if t2 == b'lhd3':
                        h = d[b2:b2 + s2]
                    elif t2 == b'ldat' and h is not None:
                        n = struct.unpack_from('>I', h, 8)[0]
                        isz = struct.unpack_from('>I', h, 16)[0]
                        if n:
                            p['_keys'] = (d[b2:b2 + s2], n, isz)
            elif t == b'LIST' and d[cb:cb + 4] == b'GCst':
                for t2, b2, s2 in chunks(d, cb + 4, cb + sz):
                    if t2 == b'LIST':
                        for t3, b3, s3 in chunks(d, b2 + 4, b2 + s2):
                            if t3 == b'Utf8':
                                p.setdefault('grad_xml', []).append(utf8(d, b3, s3))
        spatial = bool(tdb4 and tdb4[5])
        if '_keys' in p:
            raw, n, isz = p.pop('_keys')
            if spatial:
                dim = (isz - 56) // 24 if (isz - 56) % 24 == 0 else None
            else:
                dim = (isz - 8) // 40 if (isz - 8) % 40 == 0 else None
            keys = []
            for i in range(n):
                k = raw[i * isz:(i + 1) * isz]
                t = struct.unpack_from('>i', k, 0)[0] / TB
                kk = {'t': r(t, 4), 'i': k[4], 'o': k[5], 'f': k[7]}
                if dim:
                    v = struct.unpack_from('>%dd' % ((isz - 8) // 8), k, 8)
                    if spatial:
                        kk.update(v=[r(x) for x in v[6:6 + dim]], si=r(v[2]), ii=r(v[3]),
                                  so=r(v[4]), io=r(v[5]),
                                  ti=[r(x) for x in v[6 + dim:6 + 2 * dim]],
                                  to=[r(x) for x in v[6 + 2 * dim:6 + 3 * dim]])
                    else:
                        val = v[0:dim]
                        kk.update(v=[r(x) for x in val] if dim > 1 else r(val[0]),
                                  si=[r(x) for x in v[dim:2 * dim]], ii=[r(x) for x in v[2 * dim:3 * dim]],
                                  so=[r(x) for x in v[3 * dim:4 * dim]], io=[r(x) for x in v[4 * dim:5 * dim]])
                else:
                    kk['raw'] = k.hex()
                keys.append(kk)
            p['k'] = keys
            p['dim'] = dim
            p['spatial'] = spatial
        if '_cdat' in p:
            c = p.pop('_cdat')
            nd = len(c) // 8
            vals = struct.unpack('>%dd' % nd, c[:nd * 8]) if nd else ()
            if 'k' in p and p.get('dim'):
                pass
            else:
                if name.endswith('Color') or 'Color' in name or (tdb4 and tdb4[5] == 0x06):
                    p['v'] = [r(x, 3) for x in vals[:4]]
                elif nd:
                    # 次元は不明なので 0 でない所まで (最大 4。色の ARGB) を残す
                    vv = list(vals[:4])
                    while len(vv) > 1 and vv[-1] == 0.0:
                        vv.pop()
                    p['v'] = [r(x) for x in vv] if len(vv) > 1 else r(vv[0])
        return p

    # ---- シェイプのパス (shap)
    def shape_path(self, b, e):
        d = self.d
        out = {}
        for t, cb, sz in chunks(d, b, e):
            if t == b'shph':
                closed = not (d[cb + 3] & 0x08)
                x0, y0, x1, y1 = struct.unpack_from('>ffff', d, cb + 4)
                out.update(closed=closed, bbox=[r(x0, 3), r(y0, 3), r(x1, 3), r(y1, 3)])
            elif t == b'LIST' and d[cb:cb + 4] == b'list':
                h = None
                for t2, b2, s2 in chunks(d, cb + 4, cb + sz):
                    if t2 == b'lhd3':
                        h = d[b2:b2 + s2]
                    elif t2 == b'ldat' and h is not None:
                        n = struct.unpack_from('>I', h, 8)[0]
                        isz = struct.unpack_from('>I', h, 16)[0]
                        if isz == 8 and 'bbox' in out:
                            x0, y0, x1, y1 = out['bbox']
                            pts = [struct.unpack_from('>ff', d, b2 + i * 8) for i in range(n)]
                            out['pts'] = [[r(x0 + px * (x1 - x0), 2), r(y0 + py * (y1 - y0), 2)]
                                          for px, py in pts]
        return out

    def text_doc(self, b, e):
        """btdk (CoolType の辞書。鍵は番号) から文字・書体・大きさ・色を拾う。鍵の意味は 1 本のファイルで確かめた推定"""
        import re
        blob = b''
        for t2, b2, s2 in chunks(self.d, b, e):
            if t2 == b'LIST' and self.d[b2:b2 + 4] == b'btdk':
                blob = self.d[b2 + 4:b2 + s2]
        if not blob:
            return None

        def u16(m):
            raw = re.sub(rb'\\(.)', rb'\1', m)
            return raw.decode('utf-16-be', 'replace')
        strs = [(m.start(), u16(m.group(1))) for m in re.finditer(rb'\(\xfe\xff((?:[^)\\]|\\.)*)\)', blob, re.S)]
        fonts = []
        for pos, sv in strs:
            if blob[max(0, pos - 40):pos].find(b'/CoolTypeFont') >= 0 or blob[max(0, pos - 30):pos].endswith(b'/0 << /0 '):
                pass
        for m in re.finditer(rb'/99 /CoolTypeFont /0 << /0 \(\xfe\xff((?:[^)\\]|\\.)*)\)', blob, re.S):
            fonts.append(u16(m.group(1)))
        text, tpos = None, 0
        m = re.search(rb'/1 \[ << /0 << /0 \(\xfe\xff((?:[^)\\]|\\.)*)\)', blob, re.S)
        if m:
            text, tpos = u16(m.group(1)).rstrip('\r').replace('\r', '\n'), m.start()
        out = {'text': text, 'fonts': fonts[:4]}
        tail = blob[tpos:]
        m = re.search(rb'/6 << /0 (\d+) /1 ([\d.\-]+)', tail)
        if m:
            out['font'] = fonts[int(m.group(1))] if int(m.group(1)) < len(fonts) else None
            out['size'] = float(m.group(2))
            st = tail[m.start():m.start() + 2500]
            m2 = re.match(rb'/6 << /0 \d+ /1 [\d.\-]+ /2 \w+ /3 \w+ /4 \w+ /5 ([\d.\-]+)', st)
            if m2:
                out['leading'] = float(m2.group(1))
            c1 = re.search(rb'/53 << /99 /SimplePaint /0 << /0 1 /1 \[ ([\d. \-]+) \]', st)
            c2 = re.search(rb'/54 << /99 /SimplePaint /0 << /0 1 /1 \[ ([\d. \-]+) \]', st)
            f56 = re.search(rb'/56 (true|false)', st)
            f57 = re.search(rb'/57 (true|false)', st)
            w63 = re.search(rb'/63 ([\d.\-]+)', st)
            tr = re.search(rb'/12 ([\d.\-]+) /13', st)
            if c1:
                out['fill'] = [float(x) for x in c1.group(1).split()]
            if c2:
                out['stroke'] = [float(x) for x in c2.group(1).split()]
            out['fill_on'] = (f56.group(1) == b'true') if f56 else True
            out['stroke_on'] = (f57.group(1) == b'true') if f57 else False
            if w63:
                out['stroke_width'] = float(w63.group(1))
            if tr:
                out['tracking'] = float(tr.group(1))
        m = re.search(rb'/5 << /0 (\d) ', blob[tpos:])
        if m:
            out['justify'] = int(m.group(1))   # 0 左 1 右 2 中央 (推定)
        return out

    def disabled(self, b, e):
        """グループ・エフェクトの tdsb の bit0 = 有効 (目のアイコン)"""
        for t, cb, sz in chunks(self.d, b, e):
            if t == b'tdsb':
                return not (self.d[cb + 3] & 1)
            return False
        return False

    # ---- プロパティの木 (tdgp)
    def group(self, b, e):
        d = self.d
        kids = []
        cur = None
        for t, cb, sz in chunks(d, b, e):
            if t == b'tdmn':
                cur = mn(d, cb, sz)
            elif t == b'LIST':
                lt = d[cb:cb + 4]
                if lt == b'tdgp':
                    if cur != 'ADBE Group End':
                        g = {'mn': cur, 'kids': self.group(cb + 4, cb + sz)}
                        if self.disabled(cb + 4, cb + sz):
                            g['enabled'] = False
                        kids.append(g)
                elif lt == b'tdbs':
                    kids.append(self.prop(cb + 4, cb + sz, cur))
                elif lt == b'sspc':
                    eff = {'mn': cur, 'effect': True}
                    for t2, b2, s2 in chunks(d, cb + 4, cb + sz):
                        if t2 == b'fnam':
                            for t3, b3, s3 in chunks(d, b2, b2 + s2):
                                if t3 == b'Utf8':
                                    eff['name'] = utf8(d, b3, s3)
                        elif t2 == b'LIST' and d[b2:b2 + 4] == b'tdgp':
                            eff['kids'] = self.group(b2 + 4, b2 + s2)
                            if self.disabled(b2 + 4, b2 + s2):
                                eff['enabled'] = False
                            # 付け直した名前 (エクスプレッションはこの名前で呼ぶ)
                            for t3, b3, s3 in chunks(d, b2 + 4, b2 + s2):
                                if t3 == b'tdsn' and s3 > 8:
                                    nm = utf8(d, b3 + 8, s3 - 8)
                                    if nm and nm != '-_0_/-':
                                        eff['user_name'] = nm
                                    break
                    kids.append(eff)
                elif lt == b'om-s':
                    p = {'mn': cur, 'path': True}
                    keys = []
                    for t2, b2, s2 in chunks(d, cb + 4, cb + sz):
                        if t2 == b'tdbs' or (t2 == b'LIST' and d[b2:b2 + 4] == b'tdbs'):
                            q = self.prop(b2 + 4, b2 + s2, cur)
                            for kk in ('k', 'x'):
                                if kk in q:
                                    p[kk] = q[kk]
                        elif t2 == b'LIST' and d[b2:b2 + 4] == b'omks':
                            for t3, b3, s3 in chunks(d, b2 + 4, b2 + s2):
                                if t3 == b'LIST' and d[b3:b3 + 4] == b'shap':
                                    keys.append(self.shape_path(b3 + 4, b3 + s3))
                    p['shapes'] = keys
                    if 'k' in p:
                        for kk, sh in zip(p['k'], keys):
                            kk['shape'] = sh
                            kk.pop('raw', None)
                    kids.append(p)
                elif lt == b'btds':
                    texts = []
                    for t2, b2, s2 in chunks(d, cb + 4, cb + sz):
                        if t2 == b'LIST' and d[b2:b2 + 4] == b'btdk':
                            blob = d[b2 + 4:b2 + s2]
                            q = 0
                            while True:
                                q = blob.find(b'(\xfe\xff', q)
                                if q < 0:
                                    break
                                e2 = q + 3
                                buf = bytearray()
                                while e2 < len(blob):
                                    c = blob[e2]
                                    if c == 0x5c:  # バックスラッシュのエスケープ
                                        buf.append(blob[e2 + 1])
                                        e2 += 2
                                        continue
                                    if c == 0x29 and len(buf) % 2 == 0:
                                        break
                                    buf.append(c)
                                    e2 += 1
                                s = bytes(buf).decode('utf-16-be', 'replace')
                                if s.strip():
                                    texts.append(s)
                                q = e2
                    kids.append({'mn': cur, 'text': texts[:8], 'doc': self.text_doc(cb + 4, cb + sz)})
                elif lt in (b'otst', b'mrst'):
                    pass
                else:
                    sub = self.group(cb + 4, cb + sz)
                    if sub:
                        kids.append({'mn': cur, 'list': lt.decode('latin1'), 'kids': sub})
        return kids

    def layer(self, b, e):
        d = self.d
        L = {}
        for t, cb, sz in chunks(d, b, e):
            if t == b'ldta' and sz >= 164:
                x = d[cb:cb + sz]
                L['id'] = struct.unpack_from('>I', x, 0)[0]
                st, ip, op = [struct.unpack_from('>i', x, o)[0] / TB for o in (12, 20, 28)]
                L['start'] = r(st, 4)
                L['in'] = r(st + ip, 4)
                L['out'] = r(st + op, 4)
                L['stretch_raw'] = x[4:12].hex()
                a = int.from_bytes(x[37:40], 'big')
                L['flags'] = [k for k, v in FLAG_BITS.items() if a & v]
                L['flags_raw'] = '%06x' % a
                L['source_id'] = struct.unpack_from('>I', x, 40)[0]
                L['label'] = x[61]
                L['matte_mode'] = struct.unpack_from('>I', x, 104)[0]   # 1 アルファ 2 反転 3 ルミナンス 4 反転 (3・4 は推定)
                L['matte_id'] = struct.unpack_from('>I', x, 160)[0]
                L['parent_id'] = struct.unpack_from('>I', x, 132)[0]
            elif t == b'Utf8' and 'name' not in L:
                L['name'] = utf8(d, cb, sz)
            elif t == b'LIST' and d[cb:cb + 4] == b'tdgp':
                L['props'] = self.group(cb + 4, cb + sz)
        return L

    def item(self, b, e, parent):
        d = self.d
        it = {'parent': parent}
        names, layers, sub = [], [], []
        for t, cb, sz in chunks(d, b, e):
            if t == b'idta':
                it['type'] = {1: 'folder', 4: 'comp', 7: 'footage'}.get(
                    struct.unpack_from('>H', d, cb)[0], 'unknown')
                it['id'] = struct.unpack_from('>I', d, cb + 16)[0]
            elif t == b'Utf8':
                names.append(utf8(d, cb, sz))
            elif t == b'cdta' and sz >= 160:
                x = d[cb:cb + sz]
                div, dvd = struct.unpack_from('>II', x, 4)
                it['fps_exact'] = r(dvd / div, 4) if div else None
                dur, dd = struct.unpack_from('>II', x, 44)
                it['duration'] = r(dur / dd, 4) if dd else None
                it['width'], it['height'] = struct.unpack_from('>HH', x, 140)
                it['bg'] = list(x[0x45:0x48]) if sz > 0x48 else None
            elif t == b'LIST':
                lt = d[cb:cb + 4]
                if lt == b'Layr':
                    layers.append(self.layer(cb + 4, cb + sz))
                elif lt == b'Sfdr':
                    sub.append((cb + 4, cb + sz))
                elif lt == b'Pin ':
                    for t2, b2, s2 in chunks(d, cb + 4, cb + sz):
                        if t2 == b'sspc' and s2 >= 42:
                            x = d[b2:b2 + s2]
                            it['footage_kind'] = x[22:26].decode('latin1')
                            it['width'], it['height'] = struct.unpack_from('>II', x, 30)
                            if s2 >= 0x40:
                                fr = struct.unpack_from('>I', x, 0x3c)[0]
                                it['fps_raw'] = fr
                        elif t2 == b'LIST' and d[b2:b2 + 4] == b'Als2':
                            for t3, b3, s3 in chunks(d, b2 + 4, b2 + s2):
                                if t3 == b'alas':
                                    try:
                                        it['path'] = json.loads(utf8(d, b3, s3)).get('fullpath')
                                    except ValueError:
                                        pass
                        elif t2 == b'opti' and s2 >= 4:
                            kind = d[b2:b2 + 4]
                            if kind == b'Soli':
                                it['solid'] = True
                                x = d[b2:b2 + s2]
                                if s2 >= 26:
                                    it['solid_color'] = [r(v, 3) for v in struct.unpack_from('>ffff', x, 6)]
                                    nm = x[26:].split(b'\0', 1)[0]
                                    if nm:
                                        it['solid_name'] = nm.decode('cp932', 'replace')
        it['name'] = names[0] if names else ''
        if it.get('type') == 'footage' and not it['name'] and it.get('path'):
            it['name'] = it['path'].replace('\\', '/').rsplit('/', 1)[-1]
        if layers:
            it['layers'] = layers
        self.items.append(it)
        for sb, se in sub:
            self.walk(sb, se, it.get('id'))

    def walk(self, b, e, parent):
        for t, cb, sz in chunks(self.d, b, e):
            if t == b'LIST' and self.d[cb:cb + 4] == b'Item':
                self.item(cb + 4, cb + sz, parent)

    def run(self):
        d = self.d
        if d[:4] != b'RIFX' or d[8:12] != b'Egg!':
            raise ValueError('AE の RIFX ファイルではない')
        for t, cb, sz in chunks(d, 12, len(d)):
            if t == b'LIST' and d[cb:cb + 4] == b'Fold':
                self.walk(cb + 4, cb + sz, 0)
        return self.items


def main():
    ap = argparse.ArgumentParser(description='AE プロジェクトをキーフレームまで読む')
    ap.add_argument('aep')
    ap.add_argument('-o', '--out', required=True)
    a = ap.parse_args()
    with open(a.aep, 'rb') as fp:
        data = fp.read()
    items = Parser(data).run()
    with open(a.out, 'w', encoding='utf-8') as fp:
        json.dump({'source': a.aep, 'items': items}, fp, ensure_ascii=False, separators=(',', ':'))
    nl = sum(len(i.get('layers', [])) for i in items)
    print('items', len(items), 'layers', nl, '->', a.out)


if __name__ == '__main__':
    main()
