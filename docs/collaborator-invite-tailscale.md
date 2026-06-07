# 共同編集者の招待手順（Tailscale）— 安全運用マニュアル

最終更新: **2026-06-03**

このドキュメントは、KyChaPoGaS の共同編集者を **Tailscale 経由で「このアプリ（ポート 8002）だけ」に招待** するための手順です。

> ## ⚠️ 最重要のセキュリティ原則
> 1. **このマシン1台だけ**を共有する（tailnet 全体を見せない）→ Tailscale の「単一デバイス共有」を使う。
> 2. **ポート 8002 だけ**に制限する（SSH=22 や他ポートは**絶対に開けない**）→ Tailscale の ACL/Grants で制限する。
> 3. **埋め込みターミナルは管理者(自分)だけに限定する**。アプリ内のターミナルは**ホスト(DGX Spark)の本物のシェル**に繋がるため、招待者が使えると「アプリに入れる＝PCを操作できる」になってしまう。**管理者の端末のTailscale IPからのみ許可**し、招待者は不可にする（手順1）。
>   - 注意: アプリの**表示名は各自が自由に設定でき、なりすまし可能**。管理者判定には使わず、**Tailscaleが詐称を防ぐ“接続元IP”**で判定する。
>
> Tailscale は**招待しただけだと既定で全ポートに到達可能**になりがちです。**手順3（ACL制限）を必ず実施**してください。

サーバ（DGX Spark）の Tailscale アドレス:
- IP: `100.92.208.57`（確認: `tailscale ip -4`）
- 名前(MagicDNS): `tailscale status` の自ノード名で確認（例 `dgx-spark`）
- アプリURL: `http://100.92.208.57:8002/`

---

## 手順1: サーバ側 — ターミナルを「管理者(自分)だけ」に限定して起動

埋め込みターミナルはホストのシェルに繋がるため、**管理者の端末のTailscale IPからのみ許可**します（招待者は別IP→不可）。

### まず「自分の端末（ブラウザで開く側）のTailscale IP」を調べる

> サーバ(`100.92.208.57`)ではなく、**あなたがアプリを開く端末**（ノートPC等）の Tailscale IP です。アプリへの接続元IPがこれになります。

```bash
# 管理者の端末（自分のPC）で:
tailscale ip -4        # 例: 100.92.130.50
```

### その IP だけにターミナルを許可して常駐起動（サーバ側で実行）

```bash
cd /home/kigarashi309/workspace/projects/KyChaPoGaS/repo
./scripts/serve.sh restart --admin-ip=100.92.130.50      # ← 自分の端末のIPに置き換え
# 複数端末を管理者にするなら backend/.env の ADMIN_TERMINAL_IPS にカンマ区切りで列挙
```

確認:

```bash
# サーバ自身(loopback)からは常に true:
curl -s http://localhost:8002/api/health        # => ... "terminal_enabled":true
```

動作:
- **管理者(あなた)のブラウザ** … ターミナルUIが表示され使える（接続元IPが許可リストにあるため）。
- **招待者のブラウザ** … ターミナルUIは非表示・`/ws/terminal` も接続拒否（別IPのため）。
- `terminal_enabled` は**接続してきた相手ごとに**判定されます（管理者=true / 招待者=false）。

> **もっと厳しくしたい**（自分もリモートでは使わない）場合は、全員無効化:
> ```bash
> ./scripts/serve.sh restart --no-terminal
> ```
> `backend/.env` に `ADMIN_TERMINAL_IPS=...` または `KYCHAPOGAS_DISABLE_TERMINAL=1` を入れて固定してもOK。

---

## 手順2: Tailscale で「このマシンだけ」を共有（招待）

> 単一デバイス共有では、**相手はこの1台にしかアクセスできません**（tailnet 内の他のノードは一切見えない）。公式: 「Sharing gives the recipient access to only the shared machine ... and nothing else.」

1. 管理コンソール **https://login.tailscale.com/admin** を開く（Owner/Admin権限が必要）。
2. **Machines** ページ → サーバ機（DGX Spark）の行の **「…」メニュー → Share**。
3. **Copy invite link**（または Email で送信）。
   - **「Reusable link」は基本オフ**（1回だけ使える招待にする）。
   - 複数人を入れる場合は人数分リンクを発行、または各メールに送る。
4. 共有相手の作業:
   - 各自の端末に **Tailscale を導入**しログイン（個人の無料アカウントでOK）。
   - 受け取ったリンクを開いて **Accept**。これで「このマシンだけ」が相手の Tailscale に現れます。

> 補足: 「ユーザー招待（Invite external users / tailnet 全体に招待）」ではなく、**Machines → Share（単一デバイス共有）**を使うのが安全です。前者は tailnet 全体に入れてしまいます。

---

## 手順3: ACL / Grants で「ポート 8002 だけ」に制限（必須）

共有ユーザーは tailnet のポリシーに従います。共有相手（`autogroup:shared`）を**8002 だけ**に絞ります。

1. 管理コンソール → **Access controls**（ポリシーファイル / HuJSON）。
2. 以下のいずれかを追加します（**Grants 推奨**。Tailscale は新規設定に grants を推奨）。

### Grants（推奨）

```jsonc
{
  "grants": [
    // 共有ユーザーは DGX Spark の TCP 8002 のみ許可（他ポート・SSHは不可）
    {
      "src": ["autogroup:shared"],
      "dst": ["100.92.208.57"],
      "ip":  ["tcp:8002"]
    }
  ]
}
```

### 従来の ACLs（既存tailnetがacls運用ならこちら）

```jsonc
{
  "acls": [
    {
      "action": "accept",
      "src": ["autogroup:shared"],
      "dst": ["100.92.208.57:8002"]
    }
  ]
}
```

> - `dst` はサーバの **Tailscale IP**（`100.92.208.57`）で指定。タグ運用なら `tag:kychapogas` 等でも可。
> - 特定の人だけにするなら `src` をメールアドレスに: `"src": ["alice@example.com"]`。

### ⛔ ここで必ず確認（最重要）

- ポリシーに **`* → *:*`（全員→全ポート許可）** のような広い既定ルールが残っていないか。残っていると**共有ユーザーも全ポート（SSH含む）に到達**します。
  - 自分（オーナー/管理者 = `autogroup:member`）には広い権限を残してよいですが、**`autogroup:shared` には 8002 以外を一切許可しない**こと。
- **Tailscale SSH** を使っている場合、`ssh` セクションで `autogroup:shared` に SSH を**付与しない**こと（DGX Spark に SSH で入られないように）。
- 編集後 **Save**。文法エラーがあれば保存時に弾かれます。

---

## 手順4: 動作確認

**共有相手側:**
- ブラウザで `http://100.92.208.57:8002/` が開ける → OK。
- 右上「👤 名前を設定して参加」で表示名を入れ、同じプロジェクトを開くと、お互いのアバター・再生ヘッドが見える（共同編集プレゼンス）。
- SSH 等が**遮断**されていることの確認（相手の端末で）:
  ```bash
  tailscale ping 100.92.208.57           # 疎通(ネットワーク層)は通ってよい
  nc -vz 100.92.208.57 22                # → 失敗/タイムアウトすればSSHは遮断できている（成功したらACLを見直す）
  nc -vz 100.92.208.57 8002              # → 成功すればアプリには到達できる
  ```

**ターミナル制限の確認:**
- 招待者の画面: 左下「Terminal」ボタンが**無い**こと、`Ctrl+\`` でも開かないこと。
- 管理者(あなた)の画面: ターミナルが使えること。
- ※ `curl http://localhost:8002/api/health` はサーバ自身(loopback)からなので常に `terminal_enabled:true`。判定は**接続元IPごと**に行われます（招待者の別IPからは false）。

---

## アクセスの取り消し（共有解除）

- **Machines → 対象マシン → Shared with → 相手の「…」→ Revoke**（その人の共有を解除）。
- もしくは Access controls の grant/acl から該当行を削除。
- 自分専用に戻すときは `./scripts/serve.sh restart`（`--no-terminal` 無し）でターミナルを再有効化。

---

## よくある質問・注意点

- **Q. アプリに入れたら結局 PC を操作できるのでは？**
  A. 手順1でターミナルを「管理者IPのみ」に限定していれば、招待者にはターミナルが出ず、アプリは「動画編集・AI生成・レンダー」など**アプリ機能の範囲内**に閉じます。ホストのシェルやファイルシステムへの自由アクセスはありません。判定はTailscaleが詐称を防ぐ**接続元IP**で行うため、表示名を管理者に偽装しても無意味です。
- **Q. 管理者IPはどこの値？**
  A. **アプリを開く自分の端末**（ノートPC等）の Tailscale IP（`tailscale ip -4`）です。サーバのIPではありません。端末を増やしたら `ADMIN_TERMINAL_IPS` に追記します。
- **Q. 将来 `tailscale serve`(HTTPS) を使う場合は？**
  A. プロキシ経由になると接続元IPがプロキシのものになるため、IP判定は使えません。その場合は Tailscale が付与する**本人識別ヘッダ(`Tailscale-User-Login`)**でメール単位に判定する方式に切り替えます（必要時に実装します）。
- **Q. インターネットに公開される？**
  A. されません。Tailscale はプライベートネットワークです。**Tailscale Funnel（公開機能）は使わないでください。**
- **HTTPS が欲しい場合**: `tailscale serve` で 8002 を tailnet 内 HTTPS として出すことも可能（`https://<machine>.<tailnet>.ts.net`）。ACL制限はそのまま有効。必要なら別途設定します。
- **LLMチャット**: 共有相手も使えるため、Anthropic APIの利用料が発生します（必要なら機能制限を検討）。
- **信頼できない相手には共有しない**: アプリ内からプロジェクトの素材閲覧・生成・レンダーは可能です。あくまで「信頼できる共同編集者」を想定した運用です。

---

参考（Tailscale公式・2026-06時点）:
- 単一デバイス共有: https://tailscale.com/kb/1084/sharing
- ACL/Grants 構文: https://tailscale.com/docs/reference/syntax/policy-file ・ https://tailscale.com/blog/acl-grants
- 招待 vs 共有の違い: https://tailscale.com/docs/reference/inviting-vs-sharing
