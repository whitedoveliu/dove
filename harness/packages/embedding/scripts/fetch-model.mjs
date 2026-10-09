#!/usr/bin/env node
/**
 * 下载模型（离线运行用）。
 *   node packages/embedding/scripts/fetch-model.mjs [模型名]
 * 默认下 Xenova/bge-small-zh-v1.5 的 int8 权重 + 词表，约 24 MB。
 */
import { mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { MODEL_FILES, DEFAULT_MODEL, DEFAULT_HF_ENDPOINT, resolveModelDir } from "../src/model-path.ts";

const model = process.argv[2] ?? process.env.DOVE_EMBED_MODEL ?? DEFAULT_MODEL;
const endpoint = process.env.DOVE_HF_ENDPOINT ?? DEFAULT_HF_ENDPOINT;
const dir = resolveModelDir(model);
const mb = (n) => (n / 1048576).toFixed(1) + " MB";

console.log(`模型: ${model}`);
console.log(`镜像: ${endpoint}`);
console.log(`目录: ${dir}\n`);

let ok = 0, skipped = 0;
for (const rel of MODEL_FILES) {
  const target = join(dir, rel);
  if (existsSync(target) && statSync(target).size > 0) {
    console.log(`  ✓ 已有  ${mb(statSync(target).size).padStart(9)}  ${rel}`);
    skipped++;
    continue;
  }
  const url = `${endpoint}/${model}/resolve/main/${rel}`;
  process.stdout.write(`  ↓ ${rel} ... `);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) { console.log(`✗ HTTP ${res.status}`); continue; }
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, buf);
  console.log(mb(buf.length));
  ok++;
}

const ready = existsSync(join(dir, "onnx/model_quantized.onnx")) && existsSync(join(dir, "vocab.txt"));
console.log(`\n下载 ${ok} 个 / 跳过 ${skipped} 个`);
console.log(ready ? "✅ 模型就绪" : "❌ 模型不完整（缺 model_quantized.onnx 或 vocab.txt）");
process.exit(ready ? 0 : 1);
