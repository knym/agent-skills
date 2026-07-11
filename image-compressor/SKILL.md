---
name: image-compressor
description: 添付された複数の画像を一括で圧縮・リサイズするスキル。「画像を圧縮して」「このスクショを軽くして」「リサイズして」「画像を小さくして」「tifやpsdをClaude Codeで見れる形式にして」などのリクエストで使用する。Node.js(sharp)で長辺1920pxにリサイズし、JPEG(MozJPEG)/PNG(Oxipng)/WebP(libwebp)/AVIF(libavif)で出力先ディレクトリに保存する。入力にはTIFF、PSD/PSB(Photoshop、CMYKモード含む)、HEIC/HEIF(macOSでは`sips`経由)も対応。
license: MIT
author: shohei
version: 2.1.0
---

# 画像圧縮・リサイズ

添付された画像を一括で圧縮・リサイズして出力先ディレクトリに保存するスキル。

## 実行手順

1. ユーザーが添付した画像パスを収集する
2. ユーザーの指示から出力フォーマット（`jpg` / `png` / `webp` / `avif`）、長辺サイズ、品質などの指定を抽出する
3. 以下のコマンドを実行する

基本（元の拡張子を維持、長辺1920px）:

```bash
node .claude/skills/image-compressor/scripts/compress_images.mjs "画像1" "画像2" "画像3"
```

JPGで出力:

```bash
node .claude/skills/image-compressor/scripts/compress_images.mjs "画像1" "画像2" --format jpg
```

PNGで出力、長辺1280px、品質90:

```bash
node .claude/skills/image-compressor/scripts/compress_images.mjs "画像1" --format png --max-size 1280 --quality 90
```

AVIFで出力（次世代フォーマットで最大限圧縮したい場合）:

```bash
node .claude/skills/image-compressor/scripts/compress_images.mjs "画像1" "画像2" --format avif
```

PSD(Photoshop)ファイルをPNGに変換:

```bash
node .claude/skills/image-compressor/scripts/compress_images.mjs "design.psd" --format png
```

HEIC(iPhone写真)をJPEGに変換:

```bash
node .claude/skills/image-compressor/scripts/compress_images.mjs "IMG_1234.HEIC" --format jpg
```

1. 出力パスと圧縮結果をユーザーに報告する

## 引数

| 引数         | 説明                                              | デフォルト       |
| ------------ | ------------------------------------------------- | ---------------- |
| `images`     | 入力画像パス（可変長・必須）                      | —                |
| `--format`   | 出力フォーマット（`jpg` / `png` / `webp` / `avif`） | 元の拡張子を維持 |
| `--max-size` | 長辺の最大ピクセル数                              | `1920`           |
| `--quality`  | 品質（1-100、jpg/webp/avifに適用。pngは無関係）   | `85`             |

## エンコーダー

| フォーマット | 使用エンコーダー                        |
| ------------ | ---------------------------------------- |
| JPEG (`jpg`) | MozJPEG（sharp内蔵）                     |
| PNG (`png`)  | Oxipng（`bin/oxipng`で追加最適化）       |
| WebP (`webp`)| libwebp（sharp内蔵）                     |
| AVIF (`avif`)| libavif / aom（sharp内蔵）               |

## 入力フォーマット

sharp(libvips)が直接読める形式（JPEG/PNG/WebP/AVIF/TIFF等）に加えて、PSD/PSB（Photoshop）・HEIC/HEIFにも対応する。`--format`未指定時、これらはそのままでは出力対応フォーマットに含まれないため、JPGにフォールバックする（他の未対応拡張子と同じ挙動）。

### PSD/PSB（Photoshop）

- `ag-psd`（純JS製、ネイティブ依存なし）でパースし、**レイヤー合成済みの画像（composite image）をRGBAピクセルとして取得**してから、sharpのraw入力として以降のリサイズ・エンコード処理に渡す
- **個別レイヤーは扱わない**。あくまでPhotoshop上で表示されるのと同じ「合成済みの1枚絵」として読み込む
- **CMYKモードのPSDにも対応**（印刷用素材はCMYKで作られていることが多い）。ag-psdは既定でCMYKを拒否するが、実際のデコード処理自体は実装されているため、内部の許可リスト（`supportedColorModes`）にCMYKを追加して有効化している
- **非対応: CMYK+アルファ/特色チャンネルなど5チャンネル以上のPSD**（`Invalid channel count`エラーになる）。ag-psdの`readDataRLE`がチャンネル数4固定を前提にした実装のため、5チャンネル以上のファイルは長さテーブルの読み取り自体がずれて内容が壊れる。安全に対応するには本格的なパッチが必要なため見送っている
- 合成画像データを含まない・壊れているPSDはエラーとしてスキップし、他のファイルの処理は続行する

### HEIC/HEIF

- sharpに同梱されているlibheifは、実機写真（iPhone等で撮影されたHEVC圧縮のHEIC）の**メタデータは読めるがピクセルデコードには失敗する**（`No decoding plugin installed for this compression format`エラー）
- **macOSでは標準の`sips`コマンド（OS自体のHEVCデコーダを利用）で一旦JPEGに変換してから読み込む**ことでこれを回避している。追加インストール不要
- macOS以外の環境では`sips`が無いため、sharp本体のHEIF対応に委ねる（環境によっては失敗する場合がある）

### 非対応フォーマット

EPS・AI（PostScript/Illustrator）、カメラRAW（RW2など）は、変換に必要なライブラリ（ImageMagick・libraw等）がHomebrew無しでは用意できないため非対応。

## 設定

プロジェクトルートの `.env` に以下の環境変数を設定する（任意。未設定時はデフォルト値を使用）:

```text
IMAGE_COMPRESS_OUTPUT_PATH=images/compressed
```

| 変数名                       | 説明                                                  |
| ---------------------------- | ----------------------------------------------------- |
| `IMAGE_COMPRESS_OUTPUT_PATH` | 出力先ディレクトリ（デフォルト: `images/compressed`） |

## 出力

- ファイル名: 元ファイル名をそのまま使う（`photo.jpg` → `photo.jpg`）。同名ファイルが既に存在する場合のみ `_1`, `_2` … と連番を付与
- 保存先: プロジェクトルートの `images/compressed/`
- JPEG出力時、RGBA画像は白背景で合成してRGBに変換する
- 長辺が `--max-size` 未満の場合はリサイズせず圧縮のみ行う

## 依存パッケージ確認

初回セットアップとして以下を実行する（`node_modules` が無い場合のみ）:

```bash
cd .claude/skills/image-compressor && npm install
```

主な依存パッケージ:

| パッケージ | 用途                                                         |
| ---------- | ------------------------------------------------------------ |
| `sharp`    | 画像のリサイズ・エンコード（libvips）                        |
| `ag-psd`   | PSD/PSBファイルのパース（純JS製、ネイティブ依存なし）         |
| `dotenv`   | `.env` からの設定読み込み                                     |

Oxipngバイナリ（`bin/oxipng`）はスキルに同梱済みのため再ダウンロードは不要。ただし同梱バイナリは **macOS arm64 (aarch64-apple-darwin) 専用**。他OS/アーキテクチャで使う場合は [oxipngのGitHub Releases](https://github.com/shssoichiro/oxipng/releases) から該当環境向けバイナリを取得し、`bin/oxipng` を差し替えること。
