# 開発・検証・リリース手順

## 必要な環境

- Node.js 22 以上（CI は 22 / 24）。Node 側の実行時依存パッケージはありません。
- JDK 17、Android SDK Platform 35、Build Tools 35.0.0、platform-tools。
- Gradle は `android/gradlew` / `gradlew.bat`（8.13）を使用します。
- **ランタイムの組み立ては Linux / WSL を推奨・対象とします。** `tar` と xz/zstd 対応、シンボリックリンクを作れるファイルシステムが必要です。Windows の展開エラーを無視して進める動作は廃止しました。WSL では Linux 側の作業ディレクトリを使ってください。
- 通信先：npm、Google/Maven/Gradle の配布先、Termux パッケージ配布先、GitHub。ネットワーク制限のある環境では APK・ランタイムのフルビルドはできません。

`JAVA_HOME` と `ANDROID_HOME` を設定するか、`android/local.properties` に `sdk.dir` を指定します（このファイルは Git 管理対象外）。

## クリーンチェックアウトからのテスト

```sh
npm test
cd android
bash gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug :app:assembleDebugAndroidTest
```

ランタイムを用意しなくても Java のコンパイル・単体テスト・lint は実行できます。ただし、その APK で単体 Host を起動することはできません。

- `test/auth.test.js`：実 HTTP で PIN 制限、転送ヘッダー偽装、本文上限、未実装同期の拒否。
- `test/http.test.js`：本文の期限・同時処理上限・中断、PIN 記録の期限・件数上限。
- `test/service-worker.test.js`：実際の配信スクリプトを VM 内の Web API モックで実行し、認証応答をキャッシュしないことと更新時の削除範囲を検証。
- `test/outbox.test.js`：配信するキュー実装を実行し、送信確認、失敗、再読み込み、セッション切り替え、並行送信を検証。
- `test/runtime-build.test.mjs`：依存ロック、キャッシュ破損、ハッシュ照合、固定 URL、ZIP のタイムゾーン非依存性。
- Android JVM テスト：起動ゲートの停止競合・古いコールバック、ディレクトリ更新の失敗・ロールバック・中断復旧。
- Android instrumentation テスト：実ソケットでブリッジ認証、本文・ヘッダー制限、停止時の接続解放。

API 35 の端末またはエミュレータを接続して、次を実行します。

```sh
cd android
bash gradlew :app:connectedDebugAndroidTest
```

CI は Node テスト、Android デバッグビルド、JVM テスト、lint、instrumentation APK のコンパイルを行います。Actions の手動実行では API 35 エミュレータ上の instrumentation テストも実行します。実際の DSH、OAuth、画面操作、長時間バックグラウンド実行は別途端末上で確認してください。

### 実 Host を使うテスト

通常の `npm test` は `DSH_MOBILE_TEST_URL` がない場合に実 Host 向け6件をスキップします。`npm run test:live` は設定がないと **終了コード2で失敗**します。

```sh
# 実利用中の Host ではなく、専用の DSH_HOME と /mobile を使う Host を起動する。
export DSH_MOBILE_TEST_URL=http://127.0.0.1:3080
export DSH_MOBILE_PAIR_FILE=/absolute/path/to/test-home/mobile-pair.json
npm run test:live
```

テストは誤った PIN の試行を含むため、実利用中の環境に向けないでください。

## DSH パッケージツリーの用意

ビルドには DSH 本体が別途必要です。利用・再配布の条件は上流のライセンスを確認してください。

1. 検証対象の DeepSeek Harness デスクトップ版を入手し、バージョンと元配布物の SHA-256 を記録する。
2. `resources/app.asar` と、その隣にある場合は `app.asar.unpacked` を同じ場所にコピーする。
3. 例えば次のように展開する（展開ツールはビルド時だけ使用）。

```sh
npm exec --yes --package=@electron/asar@3.2.17 -- asar extract /path/to/resources/app.asar dist/upstream
find dist/upstream -path '*/node_modules/@deepseek-ai/dsh/package.json'
```

`--dsh` には、見つかった `node_modules` の親ディレクトリを渡します。配置は上流の版によって異なるため固定しません。同じリリースの両 ABI には、同じ DSH ツリーを使用してください。

## Termux 依存の固定

`runtime/termux-lock.json` に ABI に対応するアーキテクチャごとのパッケージ版・取得パス・サイズ・SHA-256 を記録します。**通常のビルドは最新版索引を取得せず、このロックだけを使います。** キャッシュも毎回ハッシュを検証します。

この変更で導入したロックは初期状態では空です。未検証のバージョンやハッシュを推測して埋めていません。最初のリリース準備時と依存更新時だけ、配布先にアクセスできる環境で次を実行してください。

```sh
node scripts/build-runtime.mjs --abi arm64-v8a --dsh /path/to/dsh-tree --update-lock true
node scripts/build-runtime.mjs --abi x86_64 --dsh /path/to/dsh-tree --update-lock true
```

生成したロックの差分をレビューし、両 ABI の起動・機能を検証してからロックを版管理に含めます。以降は `--update-lock` を付けません。別ロックは `--lock /path/to/lock.json` で指定できます。

ロックの初回作成時は Termux の HTTPS 配布索引を信頼します。この仕組みは署名付き APT メタデータの検証を実装するものではありません。固定版がミラーから消えた場合は、検証済み `.deb` キャッシュを使うか、明示的にロックを更新してください。黙って最新版に切り替わることはありません。

## ランタイムと APK の組み立て

```sh
node scripts/build-runtime.mjs --abi arm64-v8a --dsh /path/to/dsh-tree
node scripts/build-runtime.mjs --abi x86_64 --dsh /path/to/dsh-tree
cd android
bash gradlew assembleDebug
```

生成物：

- `dist/dsh-mobile-runtime-<abi>.zip`
- `android/app/src/main/jniLibs/<abi>/lib*.so`
- `android/app/src/main/assets/runtime-manifest.json`（URL・SHA-256・サイズ）

これらは大容量のため Git 管理しません。同じ Node / zlib、ソース、DSH ツリー、依存ロックを用います。時刻は `SOURCE_DATE_EPOCH`（既定は1980年1月1日 UTC）で固定します。DSH ツリーの取得元とハッシュもリリース記録に残してください。

### ローカル配布で検証する

```sh
node scripts/build-runtime.mjs --abi x86_64 --dsh /path/to/dsh-tree \
  --url http://127.0.0.1:8099/dsh-mobile-runtime-x86_64.zip
node scripts/serve-runtime.mjs dist 8099
# 別ターミナル
adb reverse tcp:8099 tcp:8099
cd android
bash gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

`--url` は **APK をビルドする前** に指定してください。HTTP はループバックの開発用 URL に限り、遠隔配布は HTTPS を使います。

### リリース署名と公開

1. 新版を出す場合は `package.json` の version、`android/app/build.gradle` の versionName / versionCode を更新する。既存リリースのランタイムを差し替えない。
2. 両 ABI のランタイムをビルドする。既定の URL は `releases/download/v<version>/...zip`。`releases/latest` は拒否する。
3. キーストアを安全に用意し、以下の環境変数を設定する。値をソース・チャット・ログに貼らない。
   - `DSH_MOBILE_KEYSTORE`：キーストアのパス（省略時は `android/dsh-mobile.keystore`）
   - `DSH_MOBILE_KEYSTORE_PASSWORD`
   - `DSH_MOBILE_KEY_ALIAS`
   - `DSH_MOBILE_KEY_PASSWORD`
4. `cd android && bash gradlew assembleRelease`。署名設定がなければ失敗する。デバッグキーへのフォールバックはない。
5. `apksigner verify --verbose --print-certs <apk>` で署名を確認し、マニフェストのハッシュと ZIP の `sha256sum` を照合する。
6. 対応する `v<version>` リリースに **このビルドで生成した ZIP と APK** を一緒に公開する。古い URL の ZIP も削除・上書きしない。
7. 新規インストール、旧 APK の新規インストール、旧 APK からの更新、更新失敗時の復旧を両 ABI で確認する。

APK は起動時にインストール済みランタイムのダイジェストを比較します。一致しなければ対応する ZIP を取得し、検証済みステージングを配置します。`home/` の会話・資格情報は置き換えません。旧ランタイムは配置後の検証が成功するまで保持します。

## Android 15 以降の長時間実行

Host は現在 `dataSync` 型のフォアグラウンドサービスです。これは無制限の常駐を保証しません。Android 15 以降のバックグラウンド時間制限に達したら `onTimeout()` で停止し、アプリ内に再起動案内を残します。自動再起動で制限を回避しません。継続稼働が必要な場合は PC Host のリモートモードを使ってください。

テスト端末では Android の開発者向け手順に従って `data_sync_fgs_timeout_duration` を短縮し、バックグラウンド移行→停止→アプリを開いて再起動、を確認します。設定変更後は必ず元の値に戻してください。別のサービス型への変更は用途と配布ポリシーの確認が必要であり、この修正では行っていません。
