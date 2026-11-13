#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AviUtl プロジェクトが指す素材(静止画・動画・連番)の一覧づくり、PC からの取り寄せ、KyChaPoGaS への登録。

aup_to_comp.py から使う。単体でも動く:

    python3 aup_materials.py 1.05.json --list                       # シーンごとの必要量
    python3 aup_materials.py 1.05.json --fetch-stills               # 静止画を全部取り寄せる
    python3 aup_materials.py 1.05.json --fetch-seq --scene 1        # そのシーンの連番(必要なコマだけ)

PC 側は読むだけ(sftp の get だけを使う)。取り寄せた量は materials/_transfer_log.json に足し込む。
"""
import argparse
import collections
import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.request
import uuid

SAKURA = '/home/kigarashi309/workspace/projects/KyChaPoGaS/reference/aviutl_mad/sakura'
PC_ROOT = 'I:\\MAD\\1111_さくらの雲スカアレットの恋\\'
SSH_HOST = 'sola2070'
GUIDE_BASENAME = '0.avi'            # 下絵(元の OP 動画)
SEQ_RE = re.compile(r'^(\d+)\.(png|jpg|jpeg|bmp|tga)$', re.I)
SCENE_AVI_RE = re.compile(r'^scene(\d+)_', re.I)
FFMPEG = 'ffmpeg'


def norm(p):
    return p.lstrip('*')


def rel_of(path):
    """PC の絶対パス → materials の下の相対パス(/ 区切り)。プロジェクトの外は _ext/ の下。"""
    p = norm(path)
    if p.lower().startswith(PC_ROOT.lower()):
        return p[len(PC_ROOT):].replace('\\', '/')
    return '_ext/' + p.replace(':', '').replace('\\', '/')


def video_meta(exdata):
    """動画ファイルの拡張データの内部バイトから (コマ数, fps)。読めなければ (None, 60)。"""
    h = exdata.get('_internal_260_hex') or ''
    try:
        b = bytes.fromhex(h)
        n = int.from_bytes(b[8:12], 'little')
        rate = int.from_bytes(b[12:16], 'little')
        scale = int.from_bytes(b[16:20], 'little') or 1
        if 0 < rate / scale <= 240:
            return n, rate / scale
    except Exception:
        pass
    return None, 60.0


class Materials:
    def __init__(self, sakura=SAKURA, root=None, api=None, project_id=None, budget_mb=3000):
        self.sakura = sakura
        self.root = root or os.path.join(sakura, 'materials')
        self.api = api
        self.project_id = project_id
        self.budget = budget_mb * 1e6
        self.map_path = os.path.join(sakura, 'asset_map.json')
        self.log_path = os.path.join(self.root, '_transfer_log.json')
        self.amap = self._load(self.map_path, {})
        self.tlog = self._load(self.log_path, {'bytes': 0, 'files': 0})
        self._listing = None

    @staticmethod
    def _load(p, default):
        try:
            return json.load(open(p, encoding='utf-8'))
        except Exception:
            return default

    def save(self):
        os.makedirs(self.root, exist_ok=True)
        json.dump(self.amap, open(self.map_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        json.dump(self.tlog, open(self.log_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

    # ---- PC の一覧(_pc_listing.txt: "大きさ|絶対パス") ----
    @property
    def listing(self):
        if self._listing is None:
            self._listing = {}
            p = os.path.join(self.root, '_pc_listing.txt')
            if os.path.exists(p):
                for l in open(p, encoding='utf-8-sig'):
                    l = l.rstrip('\r\n')
                    if '|' in l:
                        s, q = l.split('|', 1)
                        self._listing[q.lower()] = (int(s), q)
        return self._listing

    def pc_size(self, path):
        v = self.listing.get(norm(path).lower())
        return v[0] if v else None

    def local(self, path):
        return os.path.join(self.root, rel_of(path))

    # ---- 取り寄せ ----
    def fetch(self, paths, label=''):
        """PC の絶対パスの並びを sftp でまとめて取る。あるものは飛ばす。取れた数を返す。"""
        todo = []
        for p in paths:
            p = norm(p)
            loc = self.local(p)
            if os.path.exists(loc) and os.path.getsize(loc) > 0:
                continue
            sz = self.pc_size(p)
            if sz is None:
                continue
            todo.append((p, loc, sz))
        if not todo:
            return 0
        need = sum(t[2] for t in todo)
        if self.tlog['bytes'] + need > self.budget:
            print(f'[fetch] 予算超え: 既に {self.tlog["bytes"]/1e6:.0f}MB + {need/1e6:.0f}MB > {self.budget/1e6:.0f}MB。{label} は取らない', file=sys.stderr)
            return 0
        got = 0
        for i in range(0, len(todo), 200):
            chunk = todo[i:i + 200]
            bf = os.path.join(self.root, f'_batch_{uuid.uuid4().hex[:8]}.txt')
            with open(bf, 'w', encoding='utf-8') as f:
                for p, loc, sz in chunk:
                    os.makedirs(os.path.dirname(loc), exist_ok=True)
                    f.write('-get "/%s" "%s"\n' % (p.replace('\\', '/'), loc + '.part'))
            subprocess.run(['sftp', '-o', 'BatchMode=yes', '-b', bf, SSH_HOST],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            os.remove(bf)
            for p, loc, sz in chunk:
                if os.path.exists(loc + '.part') and os.path.getsize(loc + '.part') == sz:
                    os.replace(loc + '.part', loc)
                    got += 1
                    self.tlog['bytes'] += sz
                    self.tlog['files'] += 1
                elif os.path.exists(loc + '.part'):
                    os.remove(loc + '.part')
            self.save()
        print(f'[fetch] {label}: {got}/{len(todo)} 個 {need/1e6:.1f}MB (累計 {self.tlog["bytes"]/1e6:.0f}MB)', file=sys.stderr)
        return got

    # ---- 登録 ----
    def upload(self, local_path, name=None):
        boundary = uuid.uuid4().hex
        name = name or os.path.basename(local_path)
        data = open(local_path, 'rb').read()
        body = b''.join([
            f'--{boundary}\r\nContent-Disposition: form-data; name="project_id"\r\n\r\n{self.project_id}\r\n'.encode(),
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode('utf-8'),
            data, f'\r\n--{boundary}--\r\n'.encode()])
        req = urllib.request.Request(self.api + '/api/assets/upload', data=body,
                                     headers={'Content-Type': f'multipart/form-data; boundary={boundary}'})
        with urllib.request.urlopen(req, timeout=600) as r:
            return json.load(r)

    def still_asset(self, path, fetch=False):
        """静止画 → {'asset_id', 'w', 'h'} か None。"""
        key = norm(path)
        e = self.amap.get(key)
        if e and e.get('project_id') == self.project_id:
            return e
        loc = self.local(key)
        if not os.path.exists(loc) and fetch:
            self.fetch([key], os.path.basename(loc))
        if not os.path.exists(loc) or self.api is None:
            return None
        # 名前のぶつかりを避けるため、相対パスのハッシュを頭に付ける
        h = hashlib.md5(rel_of(key).encode()).hexdigest()[:6]
        a = self.upload(loc, f'{h}_{os.path.basename(loc)}')
        e = {'asset_id': a['id'], 'w': a.get('width'), 'h': a.get('height'), 'kind': 'image',
             'project_id': self.project_id, 'local': os.path.relpath(loc, self.root)}
        self.amap[key] = e
        self.save()
        return e

    def file_asset(self, key, local_path, extra=None):
        """手元のファイル(下絵など)をそのまま登録。"""
        e = self.amap.get(key)
        if e and e.get('project_id') == self.project_id:
            return e
        if not os.path.exists(local_path) or self.api is None:
            return None
        a = self.upload(local_path)
        e = {'asset_id': a['id'], 'w': a.get('width'), 'h': a.get('height'), 'kind': a.get('asset_type'),
             'project_id': self.project_id, 'local': local_path}
        e.update(extra or {})
        self.amap[key] = e
        self.save()
        return e

    # ---- 連番 ----
    def seq_info(self, path):
        """連番の最初のファイルのパス → (フォルダ, 最初の番号, 桁, 拡張子, PC にある番号の並び)。"""
        p = norm(path)
        d, base = p.rsplit('\\', 1)
        m = SEQ_RE.match(base)
        if not m:
            return None
        first, ext, digits = int(m.group(1)), m.group(2), len(m.group(1))
        pre = d.lower() + '\\'
        nums = []
        for k in self.listing:
            if k.startswith(pre) and '\\' not in k[len(pre):]:
                mm = SEQ_RE.match(k[len(pre):])
                if mm and len(mm.group(1)) == digits and mm.group(2).lower() == ext.lower():
                    nums.append(int(mm.group(1)))
        nums.sort()
        return d, first, digits, ext, nums

    def seq_asset(self, path, lo, hi, fps=60.0, fetch=False):
        """連番の lo〜hi 番目(1 始まり・最初のファイルが 1)を含む動画素材。
        返り値 {'asset_id', 'first': 動画の 0 コマ目が連番の何番目か(1 始まり), 'count', 'fps'} か None。
        すでに登録済みの範囲に入っていればそれを返す(入っていなければ、ある分だけで返す)。"""
        key = norm(path)
        e = self.amap.get(key)
        if e and e.get('project_id') == self.project_id and e['first'] <= lo and e['first'] + e['count'] - 1 >= hi:
            return e
        if not fetch:
            return e if (e and e.get('project_id') == self.project_id) else None
        info = self.seq_info(key)
        if not info:
            return e
        d, first, digits, ext, nums = info
        have = set(nums)
        if e and e.get('project_id') == self.project_id:
            lo, hi = min(lo, e['first']), max(hi, e['first'] + e['count'] - 1)
        want = [first + i - 1 for i in range(lo, hi + 1) if (first + i - 1) in have]
        if not want:
            return e
        # 抜けのない並びにする(頭から続く分だけ)
        run = [want[0]]
        for n in want[1:]:
            if n != run[-1] + 1:
                break
            run.append(n)
        files = [f'{d}\\{n:0{digits}d}.{ext}' for n in run]
        self.fetch(files, f'連番 {rel_of(d)} {run[0]}-{run[-1]}')
        ok = []
        for n, f in zip(run, files):
            if not os.path.exists(self.local(f)):
                break
            ok.append(n)
        if not ok:
            return e
        ldir = self.local(d + '\\x')[:-2]
        hsh = hashlib.md5(rel_of(d).encode()).hexdigest()[:8]
        os.makedirs(os.path.join(self.root, '_seq'), exist_ok=True)
        out = os.path.join(self.root, '_seq', f'seq_{hsh}_{ok[0]:04d}-{ok[-1]:04d}.mov')
        if not os.path.exists(out):
            cmd = [FFMPEG, '-y', '-v', 'error', '-framerate', str(fps), '-start_number', str(ok[0]),
                   '-i', os.path.join(ldir, f'%0{digits}d.{ext}'), '-frames:v', str(len(ok)),
                   '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-qscale:v', '9',
                   '-vendor', 'apl0', out + '.tmp.mov']
            r = subprocess.run(cmd, capture_output=True)
            if r.returncode != 0:
                print('[seq] ffmpeg 失敗', r.stderr.decode(errors='replace')[-300:], file=sys.stderr)
                return e
            os.replace(out + '.tmp.mov', out)
        if self.api is None:
            return e
        a = self.upload(out)
        e = {'asset_id': a['id'], 'w': a.get('width'), 'h': a.get('height'), 'kind': 'seq',
             'first': ok[0] - first + 1, 'count': len(ok), 'fps': fps,
             'project_id': self.project_id, 'local': os.path.relpath(out, self.root)}
        self.amap[key] = e
        self.save()
        return e


# ---------------------------------------------------------------- 一覧

def hidden_layers(exedit):
    return {(s['index'], ls['layer']) for s in exedit['scenes'] for ls in s['layer_settings'] if ls.get('hidden')}


def scan(doc, scenes=None, include_disabled=False):
    """映るオブジェクトが指すファイル。
    返り値: stills = {path: [scene...]}, videos = {path: [(scene, start, end, pos_lo, pos_hi, fps, filter名)]}"""
    ex = doc['exedit']
    hid = hidden_layers(ex)
    chains = collections.defaultdict(list)
    for o in ex['objects']:
        chains[o.get('chain', {}).get('leader', o['id'])].append(o)
    stills = collections.defaultdict(set)
    videos = collections.defaultdict(list)
    for segs in chains.values():
        segs.sort(key=lambda o: o['start'])
        o = segs[0]
        if scenes is not None and o['scene'] not in scenes:
            continue
        if not include_disabled and (o.get('disabled') or (o['scene'], o['layer']) in hid):
            continue
        start, end = segs[0]['start'], segs[-1]['end']
        for fi, f in enumerate(o['filters']):
            if not f['enabled'] or f['name'] == '音声ファイル':
                continue
            x = f['exdata']
            for k in ('file', 'name'):
                v = x.get(k)
                if not (isinstance(v, str) and ':\\' in v):
                    continue
                v = norm(v)
                if f['name'] in ('動画ファイル', '動画ファイル合成'):
                    vals = []
                    sp = 100.0
                    for sg in segs:
                        tr = {t['name']: t for t in sg['filters'][fi]['tracks']}
                        p = tr['再生位置']
                        vals += [p.get('value', p.get('left')), p.get('right', p.get('value', p.get('left')))]
                        s_ = tr['再生速度']
                        sp = max(abs(s_.get('value', s_.get('left', 100)) or 0), abs(s_.get('right', 0) or 0))
                    n, fps = video_meta(x)
                    lo = min(vals)
                    hi = max(max(vals), lo + (end - start) * sp / 100.0 * fps / 60.0)
                    videos[v].append((o['scene'], start, end, int(lo), int(hi) + 1, fps, f['name']))
                else:
                    stills[v].add(o['scene'])
    return stills, videos


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('json')
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--fetch-stills', action='store_true')
    ap.add_argument('--fetch-seq', action='store_true')
    ap.add_argument('--scene', type=int, action='append')
    ap.add_argument('--budget-mb', type=float, default=3000)
    a = ap.parse_args()
    doc = json.load(open(a.json, encoding='utf-8'))
    m = Materials(budget_mb=a.budget_mb)
    stills, videos = scan(doc, set(a.scene) if a.scene else None)
    if a.list:
        print('静止画', len(stills), '個', sum(m.pc_size(p) or 0 for p in stills) / 1e6, 'MB')
        for v, uses in sorted(videos.items()):
            if v.endswith('\\' + GUIDE_BASENAME):
                continue
            info = m.seq_info(v)
            lo, hi = min(u[3] for u in uses), max(u[4] for u in uses)
            if info:
                d, first, digits, ext, nums = info
                per = (m.pc_size(v) or 0) / 1e6
                hi = min(hi, len(nums))
                print(f'連番 {rel_of(d)} {lo}-{hi} ({hi-lo+1} コマ ≈ {per*(hi-lo+1):.0f}MB / 全 {len(nums)}) scenes {sorted(set(u[0] for u in uses))}')
            else:
                print(f'動画 {rel_of(v)} {(m.pc_size(v) or 0)/1e6:.0f}MB scenes {sorted(set(u[0] for u in uses))}')
    if a.fetch_stills:
        m.fetch(sorted(stills), '静止画')
    if a.fetch_seq:
        for v, uses in sorted(videos.items()):
            if m.seq_info(v):
                lo, hi = min(u[3] for u in uses), max(u[4] for u in uses)
                m.seq_asset(v, lo, hi, uses[0][5], fetch=True)
    print('累計', m.tlog)


if __name__ == '__main__':
    main()
