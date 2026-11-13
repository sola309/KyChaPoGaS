#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""After Effects プロジェクト (.aep, RIFX) から安く取れる情報だけを抜き出す。

    python3 aep_survey.py project.aep -o aep_survey.json

取れるもの: コンポジション (名前・大きさ・fps・長さ)、フッテージ (パス・大きさ)、レイヤー
(名前・ソース・種類の推定・イン/アウト)、エフェクトの match name、キーフレームのあるプロパティと
個数、エクスプレッションの文、テキストレイヤーの文字 (あれば)。
キーフレームの値・補間・マスク・シェイプの中身は読まない。

位置は 1 本のファイル (AE 2022 の 1111_恋妹2022.aep) で確かめたもので、ほかの版では
ずれるかもしれない。あやしい項目は *_guess / *_raw にしてある。
"""
import argparse
import collections
import json
import struct


def chunks(d, p, end):
    while p + 8 <= end:
        tag = d[p:p + 4]
        sz = struct.unpack_from('>I', d, p + 4)[0]
        yield tag, p + 8, sz
        p = p + 8 + sz + (sz & 1)


def utf8(d, b, sz):
    return d[b:b + sz].decode('utf-8', 'replace').rstrip('\0')


def mn(d, b, sz):
    return d[b:b + sz].split(b'\0', 1)[0].decode('latin1')


class Survey:
    def __init__(self, data):
        self.d = data
        self.items = []
        self.effect_count = collections.Counter()
        self.effect_names = {}
        self.keyed_props = collections.Counter()
        self.expr_props = collections.Counter()
        self.expressions = collections.Counter()
        self.match_names = collections.Counter()

    # ---- プロパティの木 (tdgp)
    def walk_props(self, b, sz, path, layer):
        d = self.d
        cur = None
        for tag, cb, csz in chunks(d, b, b + sz):
            if tag == b'tdmn':
                cur = mn(d, cb, csz)
                if cur != 'ADBE Group End':
                    self.match_names[cur] += 1
            elif tag == b'LIST':
                lt = d[cb:cb + 4]
                sub = path + [cur or '?']
                if lt == b'tdgp':
                    if cur in ('ADBE Root Vectors Group',):
                        layer['has_shape_contents'] = True
                    if cur == 'ADBE Text Properties':
                        layer['has_text'] = True
                    if cur == 'ADBE Camera Options Group':
                        layer['has_camera_options'] = True
                    if cur == 'ADBE Light Options Group':
                        layer['has_light_options'] = True
                    if cur and cur.startswith('ADBE Vector') and len(path) >= 1:
                        layer.setdefault('vector_items', collections.Counter())[cur] += 1
                    self.walk_props(cb + 4, csz - 4, sub, layer)
                elif lt == b'sspc':
                    # エフェクト 1 個
                    name = None
                    for t2, b2, s2 in chunks(d, cb + 4, cb + csz):
                        if t2 == b'fnam':
                            for t3, b3, s3 in chunks(d, b2, b2 + s2):
                                if t3 == b'Utf8':
                                    name = utf8(d, b3, s3)
                        elif t2 == b'LIST' and d[b2:b2 + 4] == b'tdgp':
                            if path and path[-1] == 'ADBE Effect Parade':
                                self.effect_count[cur] += 1
                                if name:
                                    self.effect_names.setdefault(cur, name)
                                layer.setdefault('effects', []).append(
                                    {'match_name': cur, 'name': name})
                            self.walk_props(b2 + 4, s2 - 4, sub, layer)
                elif lt == b'tdbs':
                    nkey = 0
                    expr = None
                    for t2, b2, s2 in chunks(d, cb + 4, cb + csz):
                        if t2 == b'LIST' and d[b2:b2 + 4] == b'list':
                            for t3, b3, s3 in chunks(d, b2 + 4, b2 + s2):
                                if t3 == b'lhd3' and s3 >= 12:
                                    nkey = struct.unpack_from('>I', d, b3 + 8)[0]
                        elif t2 == b'Utf8' and s2 > 0:
                            expr = utf8(d, b2, s2)
                    key = '/'.join(sub[-3:])
                    if nkey:
                        self.keyed_props[cur] += 1
                        layer.setdefault('keyframed', []).append({'path': key, 'keys': nkey})
                    if expr:
                        self.expr_props[cur] += 1
                        self.expressions[expr] += 1
                        layer.setdefault('expressions', []).append({'path': key, 'text': expr})
                elif lt == b'btdk':
                    # テキストの中身。UTF-16BE の文字列 (FE FF で始まる) を拾う
                    blob = d[cb + 4:cb + csz]
                    texts = []
                    p = 0
                    while True:
                        p = blob.find(b'(\xfe\xff', p)
                        if p < 0:
                            break
                        e = blob.find(b')', p)
                        if e < 0:
                            break
                        s = blob[p + 3:e].decode('utf-16-be', 'replace')
                        if s.strip():
                            texts.append(s)
                        p = e
                    if texts:
                        layer.setdefault('text_strings', []).extend(texts[:20])
                else:
                    self.walk_props(cb + 4, csz - 4, sub, layer)

    def parse_layer(self, b, sz):
        d = self.d
        layer = collections.OrderedDict()
        for tag, cb, csz in chunks(d, b, b + sz):
            if tag == b'ldta' and csz >= 96:
                x = d[cb:cb + csz]
                layer['id'] = struct.unpack_from('>I', x, 0)[0]
                st, sd, ip, idv, op, od = struct.unpack_from('>iIiIiI', x, 12)
                layer['start_time'] = round(st / sd, 4) if sd else None
                layer['in_point'] = round((st + ip) / idv, 4) if idv else None      # 推定: start からの相対
                layer['out_point'] = round((st + op) / od, 4) if od else None
                layer['attr_raw'] = x[36:40].hex()
                layer['source_id'] = struct.unpack_from('>I', x, 40)[0]
                layer['label_guess'] = x[61]
                layer['name_cp932'] = x[64:96].split(b'\0', 1)[0].decode('cp932', 'replace')
            elif tag == b'Utf8' and 'name' not in layer:
                layer['name'] = utf8(d, cb, csz)
            elif tag == b'LIST' and d[cb:cb + 4] == b'tdgp':
                self.walk_props(cb + 4, csz - 4, [], layer)
        if 'vector_items' in layer:
            layer['vector_items'] = dict(layer['vector_items'])
        return layer

    def parse_item(self, b, sz, parent):
        d = self.d
        item = collections.OrderedDict()
        item['parent'] = parent
        names = []
        layers = []
        children = []
        for tag, cb, csz in chunks(d, b, b + sz):
            if tag == b'idta':
                item['type'] = {1: 'folder', 4: 'comp', 7: 'footage'}.get(
                    struct.unpack_from('>H', d, cb)[0], 'unknown')
                item['id'] = struct.unpack_from('>I', d, cb + 16)[0]
            elif tag == b'Utf8':
                names.append(utf8(d, cb, csz))
            elif tag == b'cdta' and csz >= 160:
                x = d[cb:cb + csz]
                div, dvd = struct.unpack_from('>II', x, 4)
                item['time_scale'] = dvd / div if div else None
                dur = struct.unpack_from('>I', x, 44)[0]
                dur_div = struct.unpack_from('>I', x, 48)[0]
                item['duration'] = round(dur / dur_div, 4) if dur_div else None
                item['width'], item['height'] = struct.unpack_from('>HH', x, 140)
                item['fps'] = struct.unpack_from('>H', x, 156)[0]
            elif tag == b'LIST':
                lt = d[cb:cb + 4]
                if lt == b'Layr':
                    layers.append(self.parse_layer(cb + 4, csz - 4))
                elif lt == b'Sfdr':
                    children.append((cb + 4, csz - 4))
                elif lt == b'Pin ':
                    for t2, b2, s2 in chunks(d, cb + 4, cb + csz):
                        if t2 == b'sspc' and s2 >= 42:
                            x = d[b2:b2 + s2]
                            item['footage_kind'] = x[22:26].decode('latin1')
                            item['width'], item['height'] = struct.unpack_from('>II', x, 30)[0], \
                                struct.unpack_from('>II', x, 30)[1]
                        elif t2 == b'LIST' and d[b2:b2 + 4] == b'Als2':
                            for t3, b3, s3 in chunks(d, b2 + 4, b2 + s2):
                                if t3 == b'alas':
                                    try:
                                        j = json.loads(utf8(d, b3, s3))
                                        item['path'] = j.get('fullpath')
                                    except ValueError:
                                        item['path_raw'] = utf8(d, b3, s3)
                        elif t2 == b'opti' and s2 >= 4:
                            kind = d[b2:b2 + 4]
                            if kind == b'Soli':
                                item['solid'] = True
        item['name'] = names[0] if names else ''
        if item.get('type') == 'footage' and not item['name'] and item.get('path'):
            item['name'] = item['path'].replace('\\', '/').rsplit('/', 1)[-1]
        if layers:
            item['layers'] = layers
        self.items.append(item)
        for cb, csz in children:
            self.walk_items(cb, csz, item.get('id'))

    def walk_items(self, b, sz, parent):
        d = self.d
        for tag, cb, csz in chunks(d, b, b + sz):
            if tag == b'LIST' and d[cb:cb + 4] == b'Item':
                self.parse_item(cb + 4, csz - 4, parent)

    def run(self):
        d = self.d
        if d[:4] != b'RIFX' or d[8:12] != b'Egg!':
            raise ValueError('AE の RIFX ファイルではない')
        top = collections.Counter()
        for tag, cb, csz in chunks(d, 12, len(d)):
            if tag == b'LIST':
                lt = d[cb:cb + 4]
                top['LIST:' + lt.decode('latin1')] += 1
                if lt == b'Fold':
                    self.walk_items(cb + 4, csz - 4, 0)
            else:
                top[tag.decode('latin1')] += 1
        by_id = {it.get('id'): it for it in self.items}
        n_layers = 0
        kinds = collections.Counter()
        for it in self.items:
            for ly in it.get('layers', []):
                n_layers += 1
                src = by_id.get(ly.get('source_id'))
                ly['source'] = src['name'] if src else None
                ly['source_type'] = src['type'] if src else None
                if ly.get('has_text'):
                    k = 'text'
                elif ly.get('has_camera_options'):
                    k = 'camera'
                elif ly.get('has_light_options'):
                    k = 'light'
                elif ly.get('has_shape_contents'):
                    k = 'shape'
                elif src and src['type'] == 'comp':
                    k = 'precomp'
                elif src and src.get('solid'):
                    k = 'solid'
                elif src:
                    k = 'footage'
                else:
                    k = 'null_or_other'
                ly['kind_guess'] = k
                kinds[k] += 1
        return collections.OrderedDict([
            ('notes', '位置は 1 本のファイルで確かめた推定。in/out は start_time + 相対値として計算。'
                      'attr_raw (4 バイト) のビットの意味は未解読 (3D・調整レイヤーなどはここに入っている)。'),
            ('top_level_chunks', dict(top)),
            ('counts', {'items': len(self.items),
                        'comps': sum(1 for i in self.items if i.get('type') == 'comp'),
                        'footage': sum(1 for i in self.items if i.get('type') == 'footage'),
                        'folders': sum(1 for i in self.items if i.get('type') == 'folder'),
                        'layers': n_layers, 'layer_kinds': dict(kinds)}),
            ('effects', [{'match_name': k, 'name': self.effect_names.get(k), 'count': v}
                         for k, v in self.effect_count.most_common()]),
            ('keyframed_properties', dict(self.keyed_props.most_common())),
            ('expression_properties', dict(self.expr_props.most_common())),
            ('expressions', [{'text': k, 'count': v} for k, v in self.expressions.most_common()]),
            ('match_names', dict(self.match_names.most_common())),
            ('items', self.items),
        ])


def main():
    ap = argparse.ArgumentParser(description='AE プロジェクトのざっくり調査')
    ap.add_argument('aep')
    ap.add_argument('-o', '--out')
    a = ap.parse_args()
    with open(a.aep, 'rb') as fp:
        data = fp.read()
    res = Survey(data).run()
    res['source'] = a.aep
    text = json.dumps(res, ensure_ascii=False, indent=1)
    if a.out:
        with open(a.out, 'w', encoding='utf-8') as fp:
            fp.write(text + '\n')
        print('wrote', a.out)
    c = res['counts']
    print(json.dumps(c, ensure_ascii=False))
    for e in res['effects']:
        print('  effect', e['match_name'], e['name'], e['count'])


if __name__ == '__main__':
    main()
