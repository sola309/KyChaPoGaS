"""実ジョブでの検証(読み取り専用)。DB のスナップショットと実測表があるときだけ走る。

H3_GUARD_REALDATA_DB  : kychapogas.db のコピー(mode=ro で開く。本物の DB は指定しないこと)
H3_GUARD_REALDATA_CSV : h3ref_jobs.csv(系列長の実測表)
参照ファイル(data/assets 以下)は読むだけ。
"""
import csv
import json
import os
import sqlite3

import pytest

from app.services import h3_guard as G

DB = os.environ.get("H3_GUARD_REALDATA_DB")
CSV = os.environ.get("H3_GUARD_REALDATA_CSV")
pytestmark = pytest.mark.skipif(not (DB and CSV and os.path.exists(DB) and os.path.exists(CSV)),
                                reason="実データ(H3_GUARD_REALDATA_DB / _CSV)未指定")


@pytest.fixture(scope="module")
def real():
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row

    def resolve(aid):
        r = con.execute("select * from asset where id=?", (aid,)).fetchone()
        return dict(r) if r else None

    def params(jid):
        return json.loads(con.execute("select params from job where id=?", (jid,)).fetchone()[0])
    table = {r["id"]: r for r in csv.DictReader(open(CSV))}
    yield resolve, params, table
    con.close()


def _total(resolve, p):
    eff, _ = G.apply_quality_preset(p)
    calls, errs = G.plan_calls(eff, resolve)
    assert errs == [], errs
    return max(e.total for e in G.token_estimates(eff, calls))


# 実測表(h3ref_jobs.csv, ラベルのトークン数は概算)と数百トークン以内で一致すること
@pytest.mark.parametrize("jid", [7311, 7478, 7490, 4714, 4709])
def test_matches_measured_table(real, jid):
    resolve, params, table = real
    got = _total(resolve, params(jid))
    want = int(table[str(jid)]["seq_est"])
    assert abs(got - want) <= 300, (jid, got, want)


def test_7497_matches_independent_recount(real):
    # 7497 は表に無い。checker_calc.py(独立に書いた式)+同じプロンプト数で 187,109
    resolve, params, _ = real
    assert abs(_total(resolve, params(7497)) - 187_109) <= 300


@pytest.mark.parametrize("jid", [4673, 4714, 4771, 4781, 5360, 5367, 7311])
def test_known_collapsed_jobs_are_over(real, jid):
    resolve, params, _ = real
    assert _total(resolve, params(jid)) > G.max_seq_tokens()


@pytest.mark.parametrize("jid", [7480, 7489, 7490, 7478, 7497])
def test_large_ok_jobs_are_under(real, jid):
    resolve, params, _ = real
    assert _total(resolve, params(jid)) <= G.max_seq_tokens()


@pytest.mark.parametrize("jid", [7311, 4714, 4673])
def test_collapsed_jobs_rejected_by_check_job(real, jid):
    resolve, params, _ = real
    errs = G.check_job(params(jid), resolve)
    assert any("系列長" in e for e in errs), errs


def test_7311_also_rejected_for_12_pictures(real):
    resolve, params, _ = real
    errs = G.check_job(params(7311), resolve)
    assert any("参照画像が 12 枚" in e for e in errs), errs
