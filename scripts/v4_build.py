#!/usr/bin/env python3
"""v4プロンプト(ストーリーv2・連番U01-U30)をCodexに執筆させる(監督=Claude / 実作業=Codex)。

  python3 scripts/v4_build.py --units U01 U02 ... [--parallel 4]
  python3 scripts/v4_build.py --all --parallel 4

入力: docs/anipafe2026-cut-packets.json(新intent) / docs/anipafe2026-prompts-v4/units.json /
      v3本文(形式の見本・内容は旧設計) / dossier(build_dossier.py)
出力: docs/anipafe2026-prompts-v4/<unit>.txt / scratchpad/v4_notes/<unit>.md
"""
import argparse, json, os, re, subprocess, sys, tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / os.environ.get("KYCHA_PROMPT_OUT", "docs/anipafe2026-prompts-v4")
RULES_FILE = OUT / "RULES.md"          # v5: リサーチで確定した規則文(あれば preamble に前置)
FIXES_FILE = OUT / "fixes.json"        # v5: 単位別の修正指示 {uid: [..]}(あれば brief に追記)
V3 = ROOT / "docs/anipafe2026-prompts-v3"
SCRATCH = Path(os.environ.get("KYCHA_SCRATCH",
    "/tmp/claude-1000/-home-kigarashi309-workspace-projects-KyChaPoGaS/"
    "fb27b228-d3de-4a00-be24-0842163e55c1/scratchpad"))
DOSSIER = SCRATCH / "v4_dossier.txt"
CODEX = os.path.expanduser("~/.npm-global/bin/codex")

MG_HEAVY = {7, 11, 16, 17, 21, 24, 30, 52, 56, 57, 61, 62, 63, 64}

# 単位ごとの v4 指針(v3からの差分・配分・新プレースホルダ)
GUIDE = {
"U01": "C1は維持(半月+影)。C2はオーブが**空**であること(意志は円環へ戻った)を光の抜けで示す。v3本文をほぼ流用可。",
"U02": "ロゴ年表は維持。⚠追加: 7.16s以降、廻天ロゴ(<Picture 4>)が加速スネアごとに**回転して裏返り**、裏面は文字のない黒。裏返り切ったら螺旋が収束しC4へ。文字はロゴの複製のみ。",
"U03": "C4=まどかの手が届く(本編の名を呼ぶ救済)。手の先に呼ばれた者の輪郭が光の線で一度だけ引かれる。C5=#2955無傷のガラス越しの対峙(まどか微笑・ほむら伏し目)。C6=ガラスが砕け、白い空隙の向こうに{{BLACK_WAVE}}の兆し。人物なし。",
"U04": "**v3本文を維持**。翼窓の中の黒い波＝マルグリートの肖像、の意味づけをsummaryに一文だけ足す。画は変えない。",
"U05": "主体は悪魔ほむら{{HOMU_ID}}(弓ほむら#949は使わない)。C8=色が上へ持ち去られる(帯マスクが1枚ずつ剥がれ上昇、赤だけ残る)。C9=弓で魔獣を撃つ。魔獣は倒れず輪郭のない黒に崩れ地に溜まる({{BLACK_WAVE}})。C10=人物なし・空の{{ORB_ID}}、磁器窓の光がスネアごとに消え、最後に横倒し。",
"U06": "I2VA・#2958。v3の骨格(翼窓→黒い波)を維持。⚠差分: 黒い波が翼の輪郭の**外へ溢れ出す**(縁を越える＝約束が死んだ)。溢れた先は枝分かれの流体。",
"U07": "C12=人物なし。赤い目{{QB_ID}}一対だけ、瞳に上から降りる細い光が映る(C43と同じ構図・見る者の交代)。C13={{UM_ID}}が光として上から降り、地上の{{HOMU_ID}}の輪郭を光の帯がなぞろうとして届かない(名のない者の輪郭は引けない)。",
"U08": "C14={{UM_ID}}の誘い(リップシンク・日本語「綺麗な場所へ行こう」・下顔クロップ<Picture 2>、C45と同一撮り)。C15={{HOMU_ID}}(悪魔・眼鏡なし)の「どこにもない」=最初の否。反射の口元。閉じた唇の線がC16の亀裂へマッチカット。C16=人物なし、黒い地面の直線の亀裂(縁は半月と同じ言葉で灼ける)。C17=割れた崖<Picture 5>の縁に{{HOMU_ID}}が**立って見下ろす**(バレエは廃止)。崖の切断面と{{HALF_MOON}}の切断面が同一直線。オーブは出さない。<Audio 1>の宣言は投入時に自動付与されるので書かない。<d>[Japanese] …</d> は書いてよい。",
"U09": "{{HOMU_ID}}の手が開き、指の間の光が彼女のシルエット窓になる。窓の中＝底の光景: {{NAME_STONE}}が無数に並ぶ野、刻みの中に宇宙。クララドールズ・人形は出さない(廃止)。窓の縁は硬い線、中身は縁を越えない。",
"U10": "まどか<Picture 1>と4人(プレート<Picture 2>)が亀裂の縁に並ぶ=名を持つ者の群れ。スネアごとに一人ずつ**輪郭が硬い光の線で描き直される**(名前＝輪郭)。武器は輪郭線の一部として一瞬。最後はまどかの顔のクローズアップで輪郭が最も強い。対峙ではない(誰とも戦わない)。Never merge the characters.",
"U11": "C20=座る{{HOMU_ID}}<Picture 3>、手に空のオーブ、床の亀裂が一段深くなり底から白い光。C21=走るまどか(制服<Picture 2>)のPOV<Picture 4>、亀裂＝走る線のワイプ、足音ごとに伸びる。C22=KV<Picture 5>: 垂直の亀裂、窓の中に{{BLACK_WAVE}}。",
"U12": "C23={{HOMU_ID}}が亀裂を見下ろし、底の黒い水面に映る顔が**ワス**(同じ顔の別人、反射だけが微笑む)。鏡像構図<Picture 1>を反射で。ワスは反射としてだけ、一瞬。C24=足元の断面が断片パネルになって剥がれ落ち、縁が光を拾う。落ちるたび底が深くなる。彼女は動かない。",
"U13": "C25=上からの円環の光({{UM_ID}}の姿は出さない・光だけ)が{{HOMU_ID}}の肩を止めようとするが輪郭をなぞれない。彼女は見返さず一歩踏み出す。C26=翼を畳んだ垂直の降下。上の光が遠ざかり下の白い光(石の野)が近づく。深度面の速度差。",
"U14": "C27=河川敷<Picture 1>にまどか<Picture 5>と杏子私服<Picture 6>、笑っている。C28=公園<Picture 2>にさやか・マミ・なぎさ(プレート<Picture 7>)。C29=正門<Picture 3>、人物なし、門の影に{{SOURCELESS_SHADOW}}が重なる。C30=工場裏路地<Picture 4>の逆光に魔獣<Picture 8>、倒れず消えず一方向を向く、スネアごとに階調が抜けて黒い面になる(リミテッド平塗り)。人物なし。{{TH:DAY}}はC27-29、C30だけ変調。",
"U15": "{{TH:ROOT}}。C31={{NAME_STONE}}の野に{{HOMU_ID}}が降り立つ。遠くに紫丁香<Picture 1>とセルマ<Picture 2>が並んで見ている。空に{{HALF_MOON}}、影が月の半分を覆う(C1変奏2回目)。C32=二人のバストアップ、認めて目を逸らす。唯一の動作=紫丁香が眼鏡を外し掛け直す(スネア)。口は動かない。ほむらは気づかない。二人は脇役: 出番はここだけ。",
"U16": "{{TH:ROOT}}。C33=赤い目{{QB_ID}}が石に触れる(口も表情も動かない)。スネアごとに別の石の宇宙が強く光る。C34=赤い目に映る石<Picture 3>、瞳孔の中で石の刻みの宇宙が**吸われるように暗くなる**(名が燃える予告)。ほむらは遠景に小さく。",
"U17": "{{TH:ROOT}}。C35=人物なし、石の野の全景、{{HALF_MOON}}の半分を影が覆う、野の中央に{{MARG_SHADOW}}。C36={{HOMU_ID}}が石の間を歩く、通るたび石が暗くなる、足元に影がもう一人分。C37=**名が燃える**: 石の刻みの宇宙が暗くなり、光が細い線になって赤い目へ吸われる。{{BURNED_STONE}}の根元から黒い水が枝分かれして滲む。C38=セルマ<Picture 5>・紫丁香<Picture 6>が並んで見送る({{SEEOFF}})、燃やされた者の影が地へ沈む。脇役の最後の出番。",
"U18": "C39={{BLACK_WAVE}}が底から立ち上がり石の野を覆う、{{HOMU_ID}}が中央に立つ。C40=波の中からワス(ほむらと同じ顔・姿、鏡像<Picture 2>を波の中で)が立ち上がり手を伸ばす。C41=手が届く瞬間ワスが**溶ける**(dissolution: 手→肩→顔の順、顔が最後)、本物だけが残る、波は膝まで。魔獣<Picture 3>は波の質感の参照(weak)。",
"U19": "{{BLACK_WAVE}}の中に{{HOMU_ID}}一人。波は静まり腰の高さで止まる。彼女は上を見る。はるか上から円環の光({{UM_ID}}は光だけ)が降りてくる。減衰が主役。長い1〜2ショット。",
"U20": "C43=打点ゼロ・{{HOMU_ID}}の目に映るまどか<Picture 1>(反射)。まどかは底へ降りてきた。C12と同じ構図。C44=糸の手元<Picture 3>: 赤い糸が上(円環)と下(底)の両方へ張り、指に食い込む。糸は渡さない・切らない。最後0.5秒だけ顔。SILENT寄りだがC44にスネア2発あり(BEAT LAWは書く)。",
"U21": "**v3本文をほぼ維持**(同一撮り反転・英語リップシンク・複数の影＝We)。意味: 「私の本当の愛を受け取れば地獄になると私たちは知っている」(ほむら)／「これはあなたの過去へは帰らない」(まどか)。C46のドラム1発目で背後の{{BLACK_WAVE}}が動き始める。",
"U22": "C47=人物なし・{{BLACK_WAVE}}の群、パネル分割で一つの面が無数に割れる(顔はない＝答える口がない)。魔獣<Picture 1>は質感参照(weak)。C48=まどか<Picture 2>と4人(プレート<Picture 3>)、輪郭が硬い線、武器を構える、まどかだけ一歩前へ。Never merge the characters.",
"U23": "C49=人物なし・{{NAME_STONE}}が内側から割れ<Picture 2>の閃光、上へ抜ける光。C50=まどか<Picture 3>の手に弓<Picture 4>、指が弦に触れる。C51={{HOMU_ID}}の輪郭が{{BLACK_WAVE}}に溶け始める(自ら)、空の半月<Picture 5>に亀裂。C52=まどかの涙、弦を引く、引き絞りの光が画面を裂く線。C53=鏡像対峙<Picture 6>の3段目: 呼ぶ者(まどか正面)と答えない者(ほむら、輪郭の半分が溶けている)。敵としてではない。5カット全部を[Shot]で。",
"U24": "C54=白黒反転(イヌカレー質感): {{BLACK_WAVE}}に{{HOMU_ID}}の顔が据わる＝完成形のワルプルギス。反転の瞬間＝ワスの偽の顔が本物の顔に替わる。ワルプルギス<Picture 2>の巨大な少女と歯車のシルエットが波の上に立つ。C55=まどか<Picture 5>の矢＝**名を呼ぶ線**が波を走り抜け、線の跡で名を持つ記録が一人ずつ輪郭を取り戻し光へ上る。燃やされた名無しとほむらの顔だけが残る。{{HALF_MOON}}と{{NAME_STONE}}が同じ画に入る唯一の場所。",
"U25": "C56=#2943の水面(三つ編み・翼なしの人間ほむら=群の内側に残った像)。黒い一滴が落ち、落ちた面積だけ別の時間(窓・同心円は使わない)。顔は見せない。C57=同じ水面、まどか<Picture 2>、反射だけが割れる<Picture 3>。実体は無傷。{{TH:WATER}}。",
"U26": "C58=完成形ワルプルギス(ほむらの顔)<Picture 1>が**底へ帰る**(去るのではない)、燃やされた名無しの波を連れて。上に残るまどか<Picture 2>の小さな後ろ姿。空の折り畳み＝世界規模のワイプ。C59=人物なし、一本の赤い糸<Picture 3>が天と底を繋いだまま**伸びていく**。切れない。",
"U27": "**v3本文を維持**。意味: 内側にいるのは『マルグリートの器＋ほむらの顔』の二人分の視界。彼女は回り始める(回り続ける愚者の継承)。",
"U28": "C61=過去: まどか<Picture 1><Picture 2>の何百回の死、4人の断片<Picture 3>が一瞬混ざる、datamosh。C62=あり得なかった過去: **ほむらのいない世界**、並ぶ二人の画から片方が抜けている、C61と同速度同質感。C63=捨てた自分: ほむらの顔をした断片<Picture 5>がパネルに割れる。C64=満月が一瞬満ちて{{HALF_MOON}}へ戻る、白い水面にまどか<Picture 2>が一人、上を見る。",
"U29": "SILENT UNIT。C65=人物なし、赤い目{{QB_ID}}と、その目に映る{{BURNED_STONE}}(<Picture 2>の反射構図・刻みの中の宇宙は消えている)。C66=まどか<Picture 3>の口元だけ、無音で3モーラ(ho-mu-ra の口形: 丸い唇→閉じた唇→開いた唇)、答えは映さない、文字は出さない。C14と同じ画角。",
"U30": "I2VA・#2948。**v3の骨格を維持**しつつ、⚠上書きは剥がれない・紋章石は出ない(廃止)。C1と同一: 半月と、横切る{{SOURCELESS_SHADOW}}だけ。9.58秒の静止。SILENT UNIT。",
}


def load():
    pk = json.load(open(ROOT / "docs/anipafe2026-cut-packets.json"))
    cuts = {c["n"]: c for c in pk["cuts"]}
    units = json.load(open(OUT / "units.json"))
    return cuts, units


def brief_for(uid, cuts, units):
    u = units[uid]
    ns = u["cuts"]
    off, hits, bu, marks = 0.0, {"snare": [], "kick": [], "cymbal": []}, [], []
    intents, lyr = [], []
    for n in ns:
        c = cuts[n]
        for k in hits:
            hits[k] += [round(off + t, 3) for t in c["hits"].get(k, [])]
        for b in c["manual_buildups"]:
            bu.append((round(b["start_sec"] - c["sec"][0] + off, 3),
                       round(b["end_sec"] - c["sec"][0] + off, 3)))
        if off:
            marks.append(round(off, 3))
        intents.append(f"C{n} ({c['dur']}s): {c['intent']}")
        lyr.append(c["lyrics"] or "(歌詞なし)")
        off += c["dur"]
    prev_n, next_n = ns[0] - 1, ns[-1] + 1
    ctx = []
    if prev_n in cuts:
        ctx.append(f"【直前 C{prev_n}】{cuts[prev_n]['intent'][:160]}")
    if next_n in cuts:
        ctx.append(f"【直後 C{next_n}】{cuts[next_n]['intent'][:160]}")
    links = sorted({x for n in ns for x in cuts[n]["links"]})
    for L in links:
        if L in cuts and L not in ns:
            ctx.append(f"【リンク C{L}】{cuts[L]['intent'][:140]}")
    mg = ("★このカットはMG重点指定。窓・マスク・ワイプ・Z順を主役に据える" if set(ns) & MG_HEAVY
          else "MGは控えめでよい。光と芝居が主役")
    refs = "\n".join(f"<Picture {i+1}> #{a}" for i, a in enumerate(u["refs"][:9]))
    v3 = (V3 / f"{u['v3_id']}.txt")
    v3txt = v3.read_text() if v3.exists() else "(なし)"
    fixes = ""
    if FIXES_FILE.exists():
        fx = json.load(open(FIXES_FILE)).get(uid) or []
        if fx:
            fixes = "\n## ⚠ 前版(v4)の診断で判明した、この単位で必ず直すこと\n" + "\n".join(f"- {x}" for x in fx) + "\n"
    # ── v5: ショット計画(カット境界 + 強いスネア、上限5)・被写体数・禁止要素 ──
    plan, off2 = [], 0.0
    for n in ns:
        plan.append((round(off2, 3), f"C{n} 開始(カット境界)"))
        off2 += cuts[n]["dur"]
    cand = [t for t in hits["snare"] if all(abs(t - b[0]) > 0.6 for b in plan)]
    extra = max(0, 5 - len(plan))
    # 中央付近の強い候補を等間隔に選ぶ
    if cand and extra:
        step = max(1, len(cand) // extra)
        for t in cand[::step][:extra]:
            plan.append((t, "スネア(任意のショット境界候補)"))
    plan.sort()
    plan_txt = "\n".join(f"- {t:.3f}s: {why}" for t, why in plan)
    forbid = []
    for n in ns:
        m = re.search(r"示唆で消すもの[:：]\s*(.+?)(?:。|$)", cuts[n]["intent"])
        if m:
            forbid.append(f"C{n}: {m.group(1)}")
    forbid_txt = "\n".join(f"- {x}" for x in forbid) if forbid else "- (なし)"
    nop = [f"C{n}" for n in ns if cuts[n].get("no_person")]
    audio = u.get("audio")
    audio_note = {
        "beat": "投入時に <Audio 1>(伴奏ステム)の宣言文が subject_definitions / retention_analysis / overall_soundscape に**自動付与**される。本文に <Audio N> の宣言を書かないこと。BEAT LAW は書く。",
        "lipsync": "投入時に <Audio 1>(歌唱ステム)の宣言文とLIPSYNC LAWが**自動付与**される。本文に <Audio N> の宣言を書かないこと。歌詞は <d>[Japanese] …</d> / <d>[English] …</d> の形で該当ショットに書く。",
        None: "参照音声なし。打点ゼロなら 'SILENT UNIT: there are no drums in this cut.' を明記。",
    }[audio]
    return f"""単位 {uid}(v4・ストーリーv2)のH3映像プロンプトを書いてください。

## このカット
- 担当カット: {'+'.join('C'+str(n) for n in ns)} / 実尺 {round(off,2)}秒 / 生成 {u['frames']}フレーム / モード {u['mode']}
- 題: {u['title']}
- 歌詞: {' / '.join(lyr)}
- {mg}
- 参照音声: {audio_note}

## v4 指針(この単位で v3 から変えること・守ること)
{GUIDE[uid]}
{fixes}
## ショット計画の目安(境界はこの時刻に置く。全部で5ショット以内・各2秒以上・カットは新情報のときだけ)
{plan_txt}
人物なしカット: {', '.join(nop) if nop else 'なし'}

## この単位で画に出さないもの(設計の「示唆で消すもの」。代わりに何を見せるかを肯定形で書く)
{forbid_txt}

## 配分規則(全体)
本筋はまどかとほむら。杏子・マミ・さやか・なぎさが次。ワス・マルグリート・セルマ・紫丁香は脇役で、指針に書かれた出番以外に出さない。
マルグリートの実体は一度も描かない(影 {{{{MARG_SHADOW}}}} と C7 の翼窓だけ)。

## 視覚の法則(ストーリーv2)
名前＝輪郭(硬い線)。名無し＝{{{{BLACK_WAVE}}}}(縁のない流体)。名を呼ぶ＝線を引く(走る線のワイプ)。窓の縁は硬く、中身は縁を越えない。

## 設計意図(⚠印は確定事項・覆せない)
{chr(10).join(intents)}

## 全体の中での位置
{chr(10).join(ctx) if ctx else '(前後リンクなし)'}

## 実測打点(**丸めずに使う**。ショット境界はこの生値に置く)
snare: {hits['snare']}
kick: {hits['kick']}
cymbal: {len(hits['cymbal'])}発
盛り上げ区間: {bu if bu else 'なし'}
{'内部カット境界(統合単位): ' + str(marks) if marks else ''}

## 参照画像(役割宣言は自分で決める。storyboard anchor / target frame は禁止)
{refs}
既定は `subject definition only, not a target frame and not a storyboard anchor`。

## 使えるプレースホルダ(投入時に展開。キャラ・物の外見を自分の言葉で書かない)
{{{{HOMU_ID}}}} 悪魔ほむら / {{{{UM_ID}}}} アルティメットまどか(円環) / {{{{ORB_ID}}}} ダークオーブ / {{{{GEM_ID}}}} ほむらのジェム / {{{{QB_ID}}}} キュゥべえ / {{{{MAJUU_ID}}}} 魔獣 / {{{{WALP_ID}}}} ワルプルギス / {{{{HALF_MOON}}}} 半月 / {{{{SOURCELESS_SHADOW}}}} 光源のない影 / {{{{SEEOFF}}}} 見送る構図 / {{{{REACH_HAND}}}} 届かない手 / {{{{NAME_STONE}}}} 名の石 / {{{{BURNED_STONE}}}} 燃えた石 / {{{{BLACK_WAVE}}}} 名無しの黒い波 / {{{{MARG_SHADOW}}}} マルグリートの影 / {{{{TH:PRO}}}} {{{{TH:MEM}}}} {{{{TH:CITY}}}} {{{{TH:GOLD}}}} {{{{TH:DAY}}}} {{{{TH:STORM}}}} {{{{TH:A3}}}} {{{{TH:WATER}}}} {{{{TH:ROOT}}}}(底根) 様式テーゼ / {{{{BEATLAW}}}} {{{{DP}}}} {{{{ST2}}}} {{{{LENS}}}} {{{{FOCUS}}}}
制服のまどかは <Picture N> を指して "human Madoka in school uniform" と短く呼ぶ(外見は参照が担う)。

## 形式の見本(旧設計 v3 の同位置の本文。**内容は旧物語なので指針どおり書き換える**。維持指定の単位は本文をほぼ残す)
{v3txt}

## ⚠ 必須(これが無いと自動で拒否される)
- 打点との関係を必ず書く: `BEAT LAW: ...` または `Each snare ...`。打点ゼロなら `SILENT UNIT: there are no drums in this cut.`
- 実測値のうち最低3つを本文中に生値で書く(打点がある単位)
- Ref2VAの6セクション(subject_definitions / summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music: N/A)。I2VAは冒頭 "Create a video from this image." で始める
- 文字・数字・ロゴを出さない(U02のロゴ複製のみ例外)。品質語を使わない。否定は様式分類のみ
- 1ショット1カメラ運動。ショット境界 `[Shot N] At MM:SS.mmm,` は厳密増加

## 提出前の自己点検(書き終えたら必ず)
- 各ショットの冒頭3文が「見えるもの」だけになっているか(抽象語が混じっていないか)
- ショット数≤5・各≥2秒・カットは新情報のときだけか。同被写体の寄りは Push In にしたか
- LAW は3つ以内・各2文以内か。一般則(同一性/縁)の再掲を消したか
- 参照1枚に仕事1つ、本文は <Subject N>/<Picture N> で指しているか。被写体数を宣言したか
- MG要素に 硬い縁/深度面/LOCK/スペキュラ/中身 の5点があるか
- 否定文・品質語・文字が無いか。0秒時点で絵になっているか
- detailed_description(プレースホルダ除く)が450〜700語に収まっているか

## 出力形式(この形ちょうど。前置き不要)
<<<PROMPT>>>
(プロンプト本文のみ)
<<<END>>>
<<<NOTES>>>
(a)指針のどこを画にしたか (b)前後カットとの繋がり (c)実測打点の使用箇所 (d)自信のない点
<<<END>>>
"""


def run_one(uid, rules, brief):
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
        f.write(rules + "\n\n" + brief)
        path = f.name
    try:
        r = subprocess.run(
            [CODEX, "exec", "-m", "gpt-5.6-sol",
             "-c", "model_reasoning_effort=high",
             "--skip-git-repo-check", "--sandbox", "read-only", "-"],
            stdin=open(path), capture_output=True, text=True, timeout=2400)
        out = r.stdout
    except subprocess.TimeoutExpired:
        return uid, None, "timeout"
    finally:
        os.unlink(path)
    ps = re.findall(r"<<<PROMPT>>>\s*(.*?)\s*<<<END>>>", out, re.S)
    ns = re.findall(r"<<<NOTES>>>\s*(.*?)\s*<<<END>>>", out, re.S)
    body = next((p for p in reversed(ps) if len(p) > 400), None)
    note = next((p for p in reversed(ns) if len(p) > 80), "")
    return uid, body, note


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--units", nargs="*")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--parallel", type=int, default=4)
    ap.add_argument("--force", action="store_true", help="既存の U##.txt があっても書き直す")
    a = ap.parse_args()

    cuts, units = load()
    targets = sorted(units) if a.all else (a.units or [])
    if not a.force:
        targets = [u for u in targets if not (OUT / f"{u}.txt").exists()]
    (SCRATCH / "v4_notes").mkdir(parents=True, exist_ok=True)
    dossier = DOSSIER.read_text()
    extra_rules = ("\n\n" + RULES_FILE.read_text() + "\n") if RULES_FILE.exists() else ""
    rules = (
        "あなたはAniPAFE2026のH3映像プロンプトを書く担当です。監督(Claude)が全数検査します。\n"
        "以下は本作の設計知識の全層です。**層1(ストーリー v2・2026-09-04確定)が物語の正**で、"
        "他層に残る旧設定(紋章石=残骸、クララドールズの誕生、閉じた環、セルマ達の旧設定)は無効です。\n"
        "特に: 物語(層1)/演出原則(層2)/色(層3)/MG辞書(層4)/憲法(層6)/H3の実測知見(層10-11)/"
        "参考プロンプトの形式(層13)/名簿の逐語記述(層14)。\n\n"
        + dossier +
        "\n\n⚠ ファイルは読み書きしない。上の資料だけで書く。\n"
        "⚠ プレースホルダ {{...}} はそのまま書く(投入時に名簿から展開される)。キャラの外見を自分の言葉で書かない。\n"
        "⚠ 単位番号は v4 の連番(U01-U30)。見本の v3 番号は無視する。\n"
        + extra_rules)

    jobs = [(uid, rules, brief_for(uid, cuts, units)) for uid in targets]
    done, fail = 0, []
    print(f"開始: {len(jobs)}単位 / 並列{a.parallel}", flush=True)
    with ThreadPoolExecutor(max_workers=a.parallel) as ex:
        for uid, body, note in ex.map(lambda j: run_one(*j), jobs):
            if body:
                (OUT / f"{uid}.txt").write_text(body)
                (SCRATCH / "v4_notes" / f"{uid}.md").write_text(note or "")
                done += 1
                print(f"✓ {uid}: {len(body.split())}語", flush=True)
            else:
                fail.append(uid)
                print(f"✗ {uid}: {note}", flush=True)
    print(f"\n完了 {done}/{len(jobs)}  失敗 {fail}", flush=True)


if __name__ == "__main__":
    main()
