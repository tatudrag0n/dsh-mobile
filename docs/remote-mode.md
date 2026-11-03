# リモートモード — PC の Host に接続する

単体モード（既定）ではスマホが Host です。このドキュメントは、PC 側で
動かした DSH Host にスマホから接続する **従来の使い方** を説明します。

```
  PC のブラウザ ──┐
                  ├──  1 つの DSH Host ── セッションストア（$DSH_HOME/sessions）
  スマホ ─────────┘        （WebSocket のライブイベントストリーム）
```

- ホスト側: `index.js`（ペアリング、PWA の配信、接続状態の注入）
- ブラウザ側: `client.js`（スマホ用レイアウト、同期チップ、未送信キュー、PWA 化）

## 1. 「自動同期」が成立する理由

DSH のセッションは **単一書き込みの追記ログ** で、プロセス間の排他ロック
（Windows では名前付きセマフォ）があります。したがって「PC 側とスマホ側で
セッションをコピーして同期する」方式は原理的に成立しません。

本プラグインはこれを回避します。**スマホは Host のもう一つのクライアント**です。

- セッションの書き込みは **Host だけ** が行う（ロック競合は起きない）
- PC とスマホは同じイベントストリームを購読するので、**片方で起きたことは
  もう片方に即座に反映される**
- スマホが PC に到達できない時間帯のメッセージは、**未送信キュー**に
  貯めて、回線が戻った瞬間に自動送信する

## 2. 導入

プラグインは `@local/dsh-mobile` というローカルパッケージとして、
DSH プロファイルに読み込みます。

```jsonc
// C:\Users\<user>\.dsh\profiles\web\package.json
{
  "dependencies": {
    "@local/dsh-mobile": "link:C:/root/dsh-mobile"
  },
  "dsh": {
    "profile": {
      "bundles": ["…", "@local/dsh-mobile"]
    }
  }
}
```

## 3. PC 側でホストを起動する

```powershell
C:\root\dsh-mobile\dsh-mobile.ps1 start
```

- ホストを **LAN の IPv4:3080**（LAN 公開）で起動します
- 起動後に **ペアリングカード**（PIN・URL・QR）が端末に出力されます
- カードと引き換え用のファイルは `$DSH_HOME\mobile-pair.json` に書き出されます
  （トークンを含むため他人に見せないこと）

```
dsh-mobile: phone pairing ready
dsh-mobile:   PIN   144422
dsh-mobile:   URL   http://192.168.0.166:3080/?token=…
dsh-mobile:   PIN page http://192.168.0.166:3080/mobile
```

補助コマンド:

```powershell
.\dsh-mobile.ps1 status    # 起動状況とペアリングカード
.\dsh-mobile.ps1 install   # Windows の自動起動（ログイン時にホストを起動）
.\dsh-mobile.ps1 uninstall # 自動起動を解除
.\dsh-mobile.ps1 stop      # 停止
.\dsh-mobile.ps1 restart   # 再起動（PIN とトークンが更新されます）
```

`dsh web` を直接起動する場合も、LAN 公開のためにはパッチ層が必要です。

```powershell
dsh --profile web --patch C:\root\dsh-mobile\lan.patch.yml --no-open
```

> dsh 0.2.1 以降、`0.0.0.0`（ワイルドカード）への bind は webserver プラグインが
> 起動時に拒否します（ネットワークに RCE を公開するため）。そのため
> `lan.patch.yml` では `host` に **具体的な LAN の IPv4 アドレス**を入れます。

### 3.1 CLI とデスクトップアプリ dsh のバージョン一致（必須）

スマホ/Web 側のホスト（`dsh web`）と、デスクトップアプリで **dsh の
バージョンが違うと**、デスクトップアプリが書いたセッションログを Web 側が
読めません。Web 側は新しい型のイベント（例: `job/registered`）を解釈できない
まま「そのログは新しい harness が書いた可能性が高い」と判断し、**履歴の
読み込みを拒否**します。

```powershell
npm install -g @deepseek-ai/dsh@<デスクトップアプリと同じバージョン>
dsh --version
```

`dsh-mobile.ps1 start` は起動時に CLI とデスクトップアプリの版を突き合わせ、
違う場合は警告を表示します。

## 4. スマホをペアリングする（リモートモード）

1. スマホと PC を **同じ Wi-Fi** に接続する
2. アプリのメニュー →「PC のホストに接続する（リモート）」を選ぶ
3. `http://192.168.0.166:3080/mobile` を開き、PC の 6 桁 PIN を入力
4. そのまま DSH が開き、同期チップが「同期中」になれば完了

PIN を間違えると 5 回で 10 分ロックされます（接続元アドレス単位）。

## 5. スマホ側の機能（リモートモード）

| 機能 | 説明 |
| --- | --- |
| スマホレイアウト | セッション一覧はドロワー、タッチ領域 44px、入力欄 16px |
| 同期チップ | **同期中 / 接続中… / オフライン**。タップで再接続 |
| 未送信キュー | オフライン中の送信は失われず、回線復帰後に自動送信 |
| 失効したセッション | 401/403 で「ホストの認証が失効しました」と再ペアリング導線 |
| PC との自動追従 | 起動直後に PC の最新会話へ移動（入力済みなら維持） |
| PWA | サービスワーカーでアプリシェルを保持。iOS は「ホーム画面に追加」 |

## 6. セキュリティ（リモートモード）

- **認証**: 起動トークン → 署名済み cookie（既定 30 日）
- **Origin / Host 検査**: loopback と LAN アドレスのみ。`sec-fetch-site:
  cross-site` は拒否
- **ペアリング PIN**: 未認証クライアントは PIN が必要（5 回失敗でロック）
- **平文 HTTP**: TLS はありません。信頼できる Wi-Fi でのみ使うか、
  `tailscale serve` などで HTTPS を前段に置いてください
- **公開の判断**: LAN のアドレスへのバインドは意図的な信頼の決定です

## 7. 設定（行設定）

`cordis.patch.yml` の `dsh-mobile` 行で設定できます。

| キー | 既定 | 説明 |
| --- | --- | --- |
| `pin` | `''` | ペアリング PIN。空なら起動ごとにランダムな 6 桁 |
| `pairPath` | `/mobile` | ペアリング面の URL 接頭辞 |
| `lanUrls` | `[]` | 追加で広告するホスト |
| `maxFailedPinAttempts` | `5` | ロックまでの失敗回数 |
| `lockoutMinutes` | `10` | ロック時間（分） |

## 8. 検証ツール

```powershell
node tools\verify.mjs        "http://192.168.0.166:3080/?token=…"
node tools\outbox-probe.mjs  "http://192.168.0.166:3080/?token=…"
node tools\ui-probe.mjs      "http://127.0.0.1:3080/?token=…" "http://192.168.0.166:3080/mobile"
node tools\pair-probe.mjs    "http://192.168.0.166:3080/?token=…" "http://192.168.0.166:3080/mobile"
node tools\history-probe.mjs "http://192.168.0.166:3080"
node tools\webview-log.mjs   20
```

`tools\ui.ps1` は Android エミュレータの画面を操作します（`tap` / `type` / `dump`）。
