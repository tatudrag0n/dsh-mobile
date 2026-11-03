# 同梱物のライセンス

このリポジトリのコードは MIT（`LICENSE`）です。単体モードの APK とランタイム
には、次の第三者の成果物が含まれます。

## アプリに含まれるもの（`jniLibs`）

APK には、実行ファイルと共有ライブラリが `lib*.so` として入っています。
これらは [Termux](https://github.com/termux/termux-packages) がビルドした
パッケージから取り出しています。

| パッケージ | 版 | ライセンス |
| --- | --- | --- |
| nodejs | 26.13.0 | MIT（Node.js 本体。V8 は BSD-3-Clause、ICU は Unicode License） |
| bash | 5.3.20 | GPL-3.0-or-later |
| readline | 8.3.6 | GPL-3.0-or-later |
| ncurses | 6.6 | MIT 系（X11 ライセンス） |
| libc++ | 30 | Apache-2.0 with LLVM exception |
| libicu | 78.3 | Unicode License v3 |
| openssl | 3.6.5 | Apache-2.0 |
| zlib | 1.3.2 | zlib License |
| libiconv | 1.19 | LGPL-2.1-or-later |
| libandroid-support | 29 | MIT |
| libc-ares | 1.34.9 | MIT |
| libffi | 3.8.0 | MIT |
| libsqlite | 3.54.1 | Public Domain |

GPL / LGPL の成果物（bash, readline, libiconv）は **実行ファイルおよび共有
ライブラリとして同梱** しており、対応するソースは Termux のパッケージ
リポジトリから取得できます。

- パッケージ一覧: https://packages.termux.dev/apt/termux-main/
- ビルド定義: https://github.com/termux/termux-packages

ライセンス全文は各パッケージの `share/doc/<name>/copyright` に含まれます。
このアプリは再配布時にそれらを `THIRD_PARTY_LICENSES/` へ展開する想定です
（未同梱の場合は上記リポジトリを参照してください）。

## ランタイム（`runtime-*.zip`）

- **DeepSeek Harness** (`@deepseek-ai/dsh` とその依存) — MIT。
  デスクトップアプリに同梱されているパッケージツリーと同じものです。
  各パッケージの `LICENSE` は `app/node_modules/<package>/LICENSE` に残しています。

## 変更を加えた箇所

- `app/node_modules/node-addon-require-builtin-android-arm64` は、上流の
  ネイティブアドオンの代わりに **このプロジェクトが書いた JS 実装**
  （`runtime/shim/require-builtin`）です。
- `profile/` と `plugins/smartphone-use/` はこのプロジェクトの成果物です。
