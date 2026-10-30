# スマホ単独起動 + 同一 Wi-Fi 同期 設計書

## 1. 目的

- スマホ単独で DSH を起動し、AI をスマホだけで完結して使えるようにする。
- 同一 Wi-Fi 接続時に、スマホと PC（その他デバイス）のセッション・プラグインを自動同期する。

## 2. 現状（v1.0.5 まで）

- Android アプリは WebView ラッパー。DSH Host は PC 側で起動し、スマホはクライアント。
- 「同期」は単一 Host を共有する方式（セッションは追記ログ + 排他ロック）。
- セッション履歴のコピー同期は原理的に不可。

## 3. スマホ単独起動のアプローチ

DSH Host は Node.js プロセス。Android で Node を動かすには 2 案:

### A. Termux 経由（推奨・最小変更）
- アプリに「ローカルホストを起動」ボタンを追加。
- ボタン押下で Termux を `am start` し、`dsh` (または `dsh web`) を起動。
- WebView の接続先を `http://127.0.0.1:<port>` に切り替える。
- メリット: APK が小さいまま。Node ランタイムを同梱しない。
- デメリット: Termux の事前インストールが必要。UX が 2 ステップ。

### B. nodejs-mobile 同梱（将来）
- APK に Node ランタイムを同梱し、アプリ内で Host を起動。
- メリット: 完全自己完結。
- デメリット: APK サイズ増大、ビルド複雑、Android NDK 依存。

当面は A を採用し、B は将来の拡張とする。

## 4. 同一 Wi-Fi 自動同期のアプローチ

複数 Host（スマホ/PC）間でセッションを同期するには、単一 Host 共有モデルを拡張する。

### 4.1 デバイス発見
- mDNS (Bonjour/Zeroconf) で同一サブネット上の DSH Host を発見。
- 各 Host は `_dsh._tcp` サービスを advertise。

### 4.2 セッション同期
- セッションは追記ログ。各 Host が自分のセッションストアを持つ。
- 同期は「イベントの差分交換」: 各 Host が最後に受け取ったイベント ID を記録し、差分を pull/push。
- 競合解決: イベントは追記のみなので、タイムスタンプ + デバイス ID で順序付け。同一セッションへの同時書き込みは last-writer-wins ではなく append-only でマージ。

### 4.3 プラグイン同期
- プラグインは DSH_HOME/plugins または cordis.patch.yml で管理。
- 同期対象: プラグイン一覧 + 設定。バイナリは転送しない（各デバイスで install）。
- 同期トリガー: Wi-Fi 接続検出、フォアグラウンド復帰、手動。

### 4.4 セキュリティ
- 同期はペアリング済みデバイス間のみ（PIN で初回ペアリング）。
- 転送は TLS または同一 LAN 内の平文 + HMAC 署名。

## 5. 実装フェーズ

### Phase 1: スマホ単独起動（Termux 経由）
- Android: 「ローカルホスト起動」ボタン + Termux intent
- 接続先を 127.0.0.1 に切り替える UI

### Phase 2: mDNS 発見 + デバイス一覧
- Node 側: mdns パッケージで advertise/discover
- UI: 発見済みデバイス一覧

### Phase 3: セッション差分同期
- sync プロトコル（pull/push events）
- 競合解決

### Phase 4: プラグイン同期
- プラグイン一覧の交換 + 設定マージ

## 6. データモデル

### SyncCursor
```json
{ "deviceId": "uuid", "sessionId": "...", "lastEventId": "..." }
```

### SyncMessage
```json
{ "type": "events", "sessionId": "...", "events": [...], "from": "deviceId" }
```

## 7. テスト方針

- lib/sync.js の純粋関数をユニットテスト。
- mDNS は実機/エミュレータで統合テスト。