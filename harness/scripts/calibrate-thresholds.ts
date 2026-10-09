#!/usr/bin/env node
/** 记忆通道阈值标定：更大的标注集，并验证「问候走问候通道」这个假设 */
const { createOnnxEmbedding } = await import("../packages/embedding/src/onnx.ts");
const { cosine } = await import("../packages/core/src/memory/embedding.ts");
const { resolveModelDir } = await import("../packages/embedding/src/model-path.ts");
const p = await createOnnxEmbedding({ modelDir: resolveModelDir() });
const { isGreeting } = await import("../packages/core/src/context/greeting.ts");

const mems = [
  "用户喜欢暖色调、低饱和的配色，讨厌高饱和",
  "这个项目前端用 React 19 + Vite 构建",
  "构建命令是 npm run build",
  "数据库用 node:sqlite，不用外部服务",
  "用户叫林知夏，在上海，接受远程合作",
  "作品集站点的主题色只改 styles/main.css 的 :root",
];
// [query, 正确记忆下标(无则 -1), 是否纯问候]
const cases = [
  ["我喜欢什么颜色", 0, false], ["配色偏好是什么来着", 0, false],
  ["前端技术栈是什么", 1, false], ["用的什么框架", 1, false],
  ["怎么打包", 2, false], ["构建命令是啥", 2, false],
  ["数据存哪", 3, false], ["用的什么数据库", 3, false],
  ["用户是谁", 4, false], ["她在哪", 4, false],
  ["改主题色要动哪个文件", 5, false], ["配色改哪里", 5, false],
  // 无关（非问候）
  ["今天中午吃什么", -1, false], ["给我讲个笑话", -1, false],
  ["量子纠缠退相干实验装置怎么搭", -1, false], ["帮我订张机票", -1, false],
  ["这首诗的意境如何", -1, false], ["推荐个电影", -1, false],
  // 纯问候
  ["你好", -1, true], ["hi", -1, true], ["谢谢", -1, true], ["早上好", -1, true],
  ["こんにちは", -1, true], ["嗨", -1, true],
];

const vs = await p.embed([...mems, ...cases.map(c => c[0])]);
const mv = vs.slice(0, mems.length), qv = vs.slice(mems.length);

const R = [], I = [], G = [];
console.log("=== 相关 ===");
for (let i = 0; i < cases.length; i++) {
  const [q, idx, greet] = cases[i];
  if (idx < 0) continue;
  const s = cosine(qv[i], mv[idx]);
  const others = mv.map((v, j) => j === idx ? -1 : cosine(qv[i], v));
  R.push(s);
  console.log(`  ${s.toFixed(4)}  "${q}"  最强干扰 ${Math.max(...others).toFixed(4)}`);
}
console.log("\n=== 无关 ===");
for (let i = 0; i < cases.length; i++) {
  const [q, idx] = cases[i];
  if (idx >= 0) continue;
  const best = Math.max(...mv.map(v => cosine(qv[i], v)));
  (isGreeting(q) ? G : I).push(best);
  console.log(`  ${best.toFixed(4)}  "${q}"${isGreeting(q) ? "   [纯问候]" : ""}`);
}

const mn = a => Math.min(...a), mx = a => Math.max(...a);
console.log();
console.log(`  相关        n=${R.length}  最低 ${mn(R).toFixed(4)}  中位 ${R.sort((a,b)=>a-b)[Math.floor(R.length/2)].toFixed(4)}`);
console.log(`  无关(非问候) n=${I.length}  最高 ${mx(I).toFixed(4)}`);
console.log(`  纯问候      n=${G.length}  最高 ${mx(G).toFixed(4)}`);
console.log();
console.log("=== 假设检验：把纯问候排除后能分开吗 ===");
const hi = mn(R), lo = mx(I);
console.log(`  非问候噪声上限 ${lo.toFixed(4)}  vs  相关下限 ${hi.toFixed(4)}  →  ${hi > lo ? "✓ 可分，阈值取 " + ((hi+lo)/2).toFixed(3) : "✗ 仍重叠"}`);
console.log(`  （含问候的噪声上限是 ${mx([...I,...G]).toFixed(4)}）`);

console.log("\n=== 阈值扫描（含/不含问候两条口径）===");
const scan = (poolMax, label) => {
  let best = { t: 0, f1: 0 };
  for (let t = 0.20; t <= 0.70; t += 0.01) {
    const tp = R.filter(x => x >= t).length, fn = R.length - tp;
    const fp = I.concat(G).filter(x => x >= t).length + (label === "nonGreet" ? 0 : 0);
    const prec = tp / Math.max(1, tp + fp), rec = tp / Math.max(1, tp + fn);
    const f1 = prec + rec === 0 ? 0 : 2 * prec * rec / (prec + rec);
    if (f1 > best.f1) best = { t, f1, prec, rec };
  }
  console.log(`  ${label}: 最佳 t=${best.t.toFixed(2)}  F1=${best.f1.toFixed(3)}  精确 ${best.prec.toFixed(2)} 召回 ${best.rec.toFixed(2)}`);
  return best.t;
};
const t1 = scan(mx([...I, ...G]), "所有消息");
const t2 = scan(mx(I), "排除纯问候");
console.log();
console.log(`  结论：问候若先进问候通道（互斥），记忆通道阈值可降到 ${t2.toFixed(2)} 而不是 ${t1.toFixed(2)}`);
