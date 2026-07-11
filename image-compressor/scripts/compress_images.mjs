#!/usr/bin/env node
/**
 * 画像圧縮・リサイズスクリプト（Node.js + sharp版）
 * 使い方:
 *   node compress_images.mjs 画像1 画像2 ... [--format jpg|png|webp|avif] [--max-size 1920] [--quality 85]
 *
 * エンコーダー:
 *   jpg  -> MozJPEG (sharp内蔵)
 *   png  -> sharp出力後にOxipngで追加最適化（bin/oxipng）
 *   webp -> libwebp (sharp内蔵)
 *   avif -> libavif/aom (sharp内蔵)
 *
 * 入力:
 *   PSD/PSB以外 -> sharpが直接読み込み
 *   PSD/PSB     -> ag-psdでレイヤー合成済みのRGBAピクセルを取得し、
 *                  sharpのraw入力として以降のパイプラインに渡す（個別レイヤーは扱わない）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import dotenv from "dotenv";
import { readPsd, initializeCanvas } from "ag-psd";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILL_ROOT = path.dirname(__dirname);
const OXIPNG_BIN = path.join(SKILL_ROOT, "bin", "oxipng");

const VALID_FORMATS = ["jpg", "png", "webp", "avif"];
const PSD_EXTENSIONS = [".psd", ".psb"];

// ag-psdはNode環境ではデフォルトでnode-canvas(ネイティブ依存)を要求するが、
// このMacにはHomebrew/ビルドツールが無いため、createImageDataだけを満たす
// 最小限のフェイクcanvasを登録してネイティブ依存を回避する
function fakeCreateCanvas(width, height) {
  return {
    width,
    height,
    getContext() {
      return {
        createImageData(w, h) {
          return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
        },
        putImageData() {},
        getImageData(w2, h2) {
          return { width: w2, height: h2, data: new Uint8ClampedArray(w2 * h2 * 4) };
        },
        drawImage() {},
      };
    },
  };
}
initializeCanvas(fakeCreateCanvas);

function isPsd(inputPath) {
  return PSD_EXTENSIONS.includes(path.extname(inputPath).toLowerCase());
}

/**
 * PSD/PSBファイルを読み込み、レイヤー合成済みのRGBAピクセルをsharpインスタンスとして返す。
 * 個別レイヤーの合成は行わず、PSDファイル自体が保持する合成済み画像（composite image）を使う。
 */
function loadPsdAsSharp(inputPath) {
  const buffer = fs.readFileSync(inputPath);
  const psd = readPsd(buffer, {
    skipCompositeImageData: false,
    skipLayerImageData: true,
    skipThumbnail: true,
    useImageData: true,
  });
  if (!psd.imageData) {
    throw new Error("PSDに合成画像データが含まれていません");
  }
  const { width, height, data } = psd.imageData;
  const rawBuffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return sharp(rawBuffer, { raw: { width, height, channels: 4 } });
}

function parseArgs(argv) {
  const images = [];
  let format = null;
  let maxSize = 1920;
  let quality = 85;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--format") {
      format = argv[++i];
    } else if (arg === "--max-size") {
      maxSize = parseInt(argv[++i], 10);
    } else if (arg === "--quality") {
      quality = parseInt(argv[++i], 10);
    } else {
      images.push(arg);
    }
  }

  if (images.length === 0) {
    console.error("エラー: 入力画像パスを1つ以上指定してください");
    process.exit(1);
  }
  if (format && !VALID_FORMATS.includes(format)) {
    console.error(`エラー: --format は ${VALID_FORMATS.join(" / ")} のいずれかを指定してください`);
    process.exit(1);
  }
  if (!Number.isFinite(maxSize) || maxSize <= 0) {
    console.error("エラー: --max-size には正の整数を指定してください");
    process.exit(1);
  }
  if (!Number.isFinite(quality) || quality < 1 || quality > 100) {
    console.error("エラー: --quality には1〜100の整数を指定してください");
    process.exit(1);
  }

  return { images, format, maxSize, quality };
}

function resolveExt(inputPath, formatArg) {
  if (formatArg) return formatArg;
  const ext = path.extname(inputPath).toLowerCase().replace(".", "");
  if (ext === "jpeg") return "jpg";
  if (VALID_FORMATS.includes(ext)) return ext;
  // 未対応拡張子は JPG にフォールバック
  return "jpg";
}

function resolveOutputPath(baseDir, stem, ext) {
  let candidate = path.join(baseDir, `${stem}.${ext}`);
  if (!fs.existsSync(candidate)) return candidate;
  let counter = 1;
  for (;;) {
    candidate = path.join(baseDir, `${stem}_${counter}.${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
    counter++;
  }
}

async function main() {
  const { images, format, maxSize, quality } = parseArgs(process.argv.slice(2));

  const projectRoot = process.cwd();
  dotenv.config({ path: path.join(projectRoot, ".env") });
  const outputDirRel = process.env.IMAGE_COMPRESS_OUTPUT_PATH || "images/compressed";
  const outputDir = path.join(projectRoot, outputDirRel);
  fs.mkdirSync(outputDir, { recursive: true });

  let successCount = 0;
  const failed = [];

  for (const imagePathStr of images) {
    const expanded = imagePathStr.startsWith("~")
      ? path.join(process.env.HOME || "", imagePathStr.slice(1))
      : imagePathStr;
    const inputPath = path.resolve(expanded);

    if (!fs.existsSync(inputPath)) {
      console.error(`エラー: ファイルが見つかりません: ${inputPath}`);
      failed.push(inputPath);
      continue;
    }

    let originalSize;
    let meta;
    let image;
    try {
      originalSize = fs.statSync(inputPath).size;
      image = isPsd(inputPath) ? loadPsdAsSharp(inputPath) : sharp(inputPath);
      meta = await image.metadata();
    } catch (e) {
      console.error(`エラー: 画像を開けませんでした: ${inputPath} (${e.message})`);
      failed.push(inputPath);
      continue;
    }

    const ext = resolveExt(inputPath, format);
    const stem = path.basename(inputPath, path.extname(inputPath));
    const outputPath = resolveOutputPath(outputDir, stem, ext);

    try {
      let pipeline = image.resize({
        width: maxSize,
        height: maxSize,
        fit: "inside",
        withoutEnlargement: true,
      });

      if (ext === "jpg") {
        pipeline = pipeline
          .flatten({ background: { r: 255, g: 255, b: 255 } })
          .jpeg({ mozjpeg: true, quality });
        await pipeline.toFile(outputPath);
      } else if (ext === "webp") {
        pipeline = pipeline.webp({ quality });
        await pipeline.toFile(outputPath);
      } else if (ext === "avif") {
        pipeline = pipeline.avif({ quality });
        await pipeline.toFile(outputPath);
      } else {
        // png
        pipeline = pipeline.png();
        await pipeline.toFile(outputPath);
        await execFileAsync(OXIPNG_BIN, ["-o", "max", outputPath]);
      }
    } catch (e) {
      console.error(`エラー: 保存に失敗: ${inputPath} (${e.message})`);
      failed.push(inputPath);
      continue;
    }

    const newSize = fs.statSync(outputPath).size;
    const newMeta = await sharp(outputPath).metadata();
    const ratio = originalSize ? (1 - newSize / originalSize) * 100 : 0;

    console.log(
      `[OK] ${path.basename(inputPath)} ` +
        `${meta.width}x${meta.height} (${(originalSize / 1024).toFixed(1)}KB) ` +
        `-> ${newMeta.width}x${newMeta.height} (${(newSize / 1024).toFixed(1)}KB, -${ratio.toFixed(1)}%) ` +
        `=> ${outputPath}`,
    );
    successCount++;
  }

  console.log(`\n完了: ${successCount}/${images.length} 件`);
  console.log(`出力先: ${outputDir}`);
  if (failed.length > 0) {
    console.error(`失敗: ${failed.length} 件`);
    process.exit(1);
  }
}

main();
