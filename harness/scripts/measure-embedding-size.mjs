#!/usr/bin/env node
/** 量 ONNX embedding 模型的真实体积（走 hf-mirror.com，huggingface.co 这网络连不上） */
const MIRROR = "https://hf-mirror.com";
const MODELS = [
  "Xenova/bge-small-zh-v1.5",
  "Xenova/bge-base-zh-v1.5",
  "Xenova/multilingual-e5-small",
  "Xenova/multilingual-e5-base",
  "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
  "onnx-community/bge-m3-ONNX",
];
const mb = (n) => (n / 1048576).toFixed(1).padStart(7) + " MB";

async function hf(repo) {
  const r = await fetch(`${MIRROR}/api/models/${repo}?blobs=true`);
  if (!r.ok) return { repo, error: "HTTP " + r.status };
  const j = await r.json();
  const files = (j.siblings ?? []).map((s) => ({ name: s.rfilename, size: s.size ?? 0 }));
  const onnx = files.filter((f) => f.name.endsWith(".onnx") || f.name.endsWith(".onnx_data"));
  return { repo, total: files.reduce((a, f) => a + f.size, 0), count: files.length, onnx };
}

const rows = [];
for (const m of MODELS) {
  const r = await hf(m);
  rows.push(r);
  if (r.error) { console.log(`\n${m}\n  ✗ ${r.error}`); continue; }
  console.log(`\n${m}`);
  console.log(`  整仓: ${mb(r.total)} / ${r.count} 个文件`);
  const q = r.onnx.filter((f) => /quantized/i.test(f.name));
  const f32 = r.onnx.filter((f) => !/quantized|int8|_q4|_q8/i.test(f.name));
  for (const f of q) console.log(`  量化: ${mb(f.size)}  ${f.name}`);
  for (const f of f32) console.log(`  fp32: ${mb(f.size)}  ${f.name}`);
}
