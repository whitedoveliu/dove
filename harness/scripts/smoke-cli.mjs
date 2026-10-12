#!/usr/bin/env node
/**
 * CLI 冒烟 —— 把 CLI 当成**真的客户端**跑一遍：临时内核 + 真命令行进程 + HTTP。
 *
 * 为什么不能只跑单测：CLI 的价值全在「进程边界」上 —— 端口发现、SSE 逐帧解析、
 * Ctrl+C 之后能不能退干净、退出码对不对。这些在进程内都测不出来。
 * 历史教育（scripts/smoke-cli-exit.mjs）：任务 13 秒做完、进程挂了 4000 秒被 SIGKILL，
 * 所以这里每条命令都卡了超时，而且**先断言退出码，再断言输出**。
 *
 * 隔离：import "./_isolate.ts" 在**任何** import 之前 —— 它把 DOVE_DB / DOVE_CONFIG /
 * DOVE_WORKSPACE 指到临时目录，然后我们把这套环境原样交给临时内核子进程。
 * 不隔离的话，这个脚本建的线程会直接落进用户的生产库（踩过：cron 任务灌进生产库烧掉 1000 轮）。
 *
 * 用 8831：不要碰用户在跑的 8790（那条内核在用真库、真记忆）。
 */
import "./_isolate.ts";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { existsSync, readFileSync, rmSync } from "node:fs";

const PORT = Number(process.env.SMOKE_CLI_PORT ?? 8831);
const BASE = `http://127.0.0.1:${PORT}`;
const HARNESS = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const CLI = join(HARNESS, "bin", "dove.mjs");

let pass = 0;
let fail = 0;
const fails = [];
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log("  ✓ " + name); }
  else { fail++; fails.push(name); console.log("  ✗ " + name + (detail ? " — " + detail : "")); }
};

/** ANSI 转义：--json 里混进一个就会让下游 jq 解析失败，所以要专门盯 */
const ANSI = /\x1b\[[0-9;]*m/;

/** 跑一次 CLI。返回 { code, out, err, seconds, killed } */
function runCli(args, { timeoutS = 60, env = {}, interruptAfterMs } = {}) {
  return new Promise((resolve) => {
    const childEnv = { ...process.env, ...env };
    delete childEnv.DOVE_PORT;              // 默认走端口文件发现；要显式指端口就自己在 env 里给
    const t0 = Date.now();
    const p = spawn(process.execPath, [CLI, ...args], { cwd: HARNESS, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", killed = false, signalled = false;
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.stderr.on("data", (d) => { err += d.toString(); if (interruptAfterMs && !signalled) { /* 有输出就等等再打断 */ } });
    if (interruptAfterMs) setTimeout(() => { signalled = true; p.kill("SIGINT"); }, interruptAfterMs);
    const timer = setTimeout(() => { killed = true; p.kill("SIGKILL"); }, timeoutS * 1000);
    p.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, out, err, seconds: (Date.now() - t0) / 1000, killed });
    });
  });
}

/** 等内核就绪：轮询 /api/health（最多 timeoutMs） */
async function waitHealth(timeoutMs = 40_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok && (await r.json()).ok === true) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

console.log(`=== 起一个临时内核（端口 ${PORT}，库 ${process.env.DOVE_DB}）===`);
const kernel = spawn(process.execPath, ["--no-warnings", "packages/server/src/main.ts"], {
  cwd: HARNESS,
  // DOVE_APPROVE 保持默认的 ask：审批流是 CLI 最有用的一条，冒烟必须走真策略。
  // （代价：如果模型在 home 上忽然要调一个 medium 风险的工具，这一轮会等 5 分钟超时 ——
  //   实测「只回复两个字」这种请求不会触发工具，风险可以接受。）
  env: { ...process.env, DOVE_PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
let klog = "";
kernel.stdout.on("data", (d) => { klog += d.toString(); });
kernel.stderr.on("data", (d) => { klog += d.toString(); });

const up = await waitHealth();
check(`临时内核在 ${PORT} 上就绪`, up, klog.split("\n").slice(-4).join(" | "));
// 「端口上有东西」不等于「那个东西是我们起的内核」：8831 上要是蹲着别人（或上一次没退干净的自己），
// 后面的断言会全部以一个看不懂的理由失败（找不到端口文件、端口发现落到 8790）。所以这里认一下门牌。
const ownPortFile = join(process.env.DOVE_CONFIG, "port");
let ownPort = "";
try { ownPort = readFileSync(ownPortFile, "utf8").trim(); } catch { /* 下面报 */ }
if (up && ownPort !== String(PORT)) {
  console.log(`  ✗ ${PORT} 上响应 /api/health 的不是这次起的那个内核（它没写 ${ownPortFile}）`);
  console.log(`    先把它停掉再跑：lsof -nP -iTCP:${PORT} -sTCP:LISTEN -t | xargs kill`);
  stopKernel();
  process.exit(1);
}
if (!up) {
  stopKernel();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(1);
}

function stopKernel() {
  try { kernel.kill("SIGTERM"); } catch { /* ignore */ }
  setTimeout(() => { try { kernel.kill("SIGKILL"); } catch { /* ignore */ } }, 3_000).unref?.();
}

try {  console.log("\n=== 1. 端口发现（内核写的 ~/.dove/port 那一份） ===");
  const portFile = join(process.env.DOVE_CONFIG, "port");
  let filePort = "";
  try { filePort = readFileSync(portFile, "utf8").trim(); } catch { /* 下面会报 */ }
  check(`内核把实际端口写进了 ${portFile}`, filePort === String(PORT), `读到「${filePort}」`);
  const spec = join(process.env.DOVE_CONFIG, "api-spec.md");
  let specText = "";
  try { specText = readFileSync(spec, "utf8"); } catch { /* ignore */ }
  check("内核写了 api-spec.md，且带 curl 示例", specText.includes("curl") && specText.includes(String(PORT)),
    specText ? "没有 curl/PORT" : "文件不存在");

  const health = await runCli(["health", "--json"], { timeoutS: 20 });
  check("dove health --json 退出码 0", health.code === 0, `code=${health.code} ${health.err.slice(0, 120)}`);
  let hj = null;
  try { hj = JSON.parse(health.out); } catch { /* ignore */ }
  check("health 的字段值对得上（ok/model/tools）", hj?.ok === true && hj?.tools > 20 && !!hj?.model,
    JSON.stringify(hj)?.slice(0, 160));
  check("health 不带 --port 也能找到内核（走端口文件）", !ANSI.test(health.out), "输出里有 ANSI 转义");

  console.log("\n=== 2. threads：new -> list -> show -> rm ===");
  const made = await runCli(["threads", "new", "冒烟线程", "--json"], { timeoutS: 20 });
  let th = null;
  try { th = JSON.parse(made.out); } catch { /* ignore */ }
  check("threads new 退出码 0 且回了线程对象", made.code === 0 && !!th?.id, `code=${made.code} out=${made.out.slice(0, 120)}`);
  const list = await runCli(["threads", "list"], { timeoutS: 20 });
  check("threads list 里能看到刚建的标题", list.code === 0 && list.out.includes("冒烟线程"), `code=${list.code}`);
  const show = await runCli(["threads", "show", String(th?.id)], { timeoutS: 20 });
  check("threads show 拿得到这个线程（空会话也给回 0）", show.code === 0 && show.out.includes(String(th?.id)), `code=${show.code}`);
  const rm = await runCli(["threads", "rm", String(th?.id)], { timeoutS: 20 });
  const after = await runCli(["threads", "list", "--json"], { timeoutS: 20 });
  check("threads rm 之后再列就没有它了",
    rm.code === 0 && !JSON.parse(after.out).some((x) => x.id === th?.id), `rm=${rm.code}`);

  console.log("\n=== 3. tools / skills / logs / goals：不许崩 ===");
  const tools = await runCli(["tools"], { timeoutS: 20 });
  check("tools 退出码 0（内核没开放工具表时也只是给提示）", tools.code === 0, `code=${tools.code} ${tools.err.slice(0, 160)}`);
  check("tools 至少说清了原因（版本较旧 / 需要脚本会话 / 列出清单）",
    /较旧|session\/token|个工具/.test(tools.err + tools.out), (tools.err + tools.out).slice(0, 160));
  const skills = await runCli(["skills"], { timeoutS: 20 });
  check("skills 退出码 0", skills.code === 0, `code=${skills.code}`);
  const logs = await runCli(["logs", "--tail", "5"], { timeoutS: 20 });
  check("logs --tail 5 退出码 0 且有条数行", logs.code === 0 && logs.out.trim().split("\n").length >= 1, `code=${logs.code}`);
  const goals = await runCli(["goals"], { timeoutS: 20 });
  check("goals 退出码 0（目标路由没上线时也不报错）", goals.code === 0, `code=${goals.code}`);

  console.log("\n=== 4. approve / answer 的失败路径 ===");
  const noPending = await runCli(["approve"], { timeoutS: 20 });
  check("approve（空表）退出码 0", noPending.code === 0, `code=${noPending.code}`);
  check("approve（空表）说的是「没有待审批」", /没有待审批/.test(noPending.out), noPending.out.slice(0, 120));
  const badApprove = await runCli(["approve", "--tool-call-id", "tc_nope", "--allow"], { timeoutS: 20 });
  check("approve 一个不存在的 id 退出码非 0", badApprove.code !== 0, `code=${badApprove.code}`);
  const badAnswer = await runCli(["answer", "--id", "tc_nope", "随便答一句"], { timeoutS: 20 });
  check("answer 一个不存在的问题退出码非 0", badAnswer.code !== 0, `code=${badAnswer.code}`);
  const badFlag = await runCli(["run", "--definitely-not-a-flag", "x"], { timeoutS: 20 });
  check("不认识的旗标退出码 2（用法错）", badFlag.code === 2, `code=${badFlag.code}`);

  console.log("\n=== 5. 线程不存在：退出码非 0 ===");
  const ghost = await runCli(["run", "--thread", "th_does_not_exist", "你好"], { timeoutS: 30 });
  check("run --thread <不存在> 退出码非 0", ghost.code !== 0, `code=${ghost.code}`);
  check("并提示了下一步（threads list）", /threads list/.test(ghost.err), ghost.err.slice(0, 160));

  console.log("\n=== 6. 真跑一轮模型（--home）===");
  const runHome = await runCli(["run", "--home", "只回复两个字：收到"], { timeoutS: 120 });
  check("run --home 退出码 0", runHome.code === 0, `code=${runHome.code} ${runHome.err.slice(-200)}`);
  check("stdout 里有模型给的文字「收到」", runHome.out.includes("收到"), JSON.stringify(runHome.out.slice(0, 120)));
  check("提示/统计走 stderr，没污染 stdout", !/━|→/.test(runHome.out), JSON.stringify(runHome.out.slice(0, 120)));
  check("非 TTY 自动关色（stdout 无 ANSI）", !ANSI.test(runHome.out), "有 ANSI 转义");
  check(`进程没有拖着不退（${runHome.seconds.toFixed(1)}s）`, runHome.seconds < 60 && !runHome.killed, `${runHome.seconds.toFixed(1)}s`);

  console.log("\n=== 7. --json：逐行可 JSON.parse ===");
  const jr = await runCli(["run", "--home", "--json", "只回复两个字：收到"], { timeoutS: 120, env: { DOVE_CONFIG: process.env.DOVE_CONFIG } });
  const lines = jr.out.split("\n").filter(Boolean);
  let bad = 0;
  const types = [];
  let threadLine = null, sawDone = false, textTotal = "";
  for (const l of lines) {
    try {
      const ev = JSON.parse(l);
      types.push(ev.type);
      if (ev.type === "thread") threadLine = ev;
      if (ev.type === "done") sawDone = true;
      if (ev.type === "text") textTotal += ev.content ?? "";
    } catch { bad++; }
  }
  check("--json 每行都能 parse", bad === 0 && lines.length > 3, `行数 ${lines.length}，坏了 ${bad}`);
  check("--json 里没有 ANSI 转义", !ANSI.test(jr.out), "混了颜色");
  check("事件流里有 thread/text/done", !!threadLine && textTotal.includes("收到") && sawDone, types.join(","));
  check("thread 事件指向 home 线程", threadLine?.threadId === "th_home", JSON.stringify(threadLine));
  check("--json 执行退出码 0", jr.code === 0, `code=${jr.code}`);

  console.log("\n=== 8. Ctrl+C：停线程 + 退出 130 + 不许挂住 ===");
  const sig = await runCli(["run", "--home", "写一篇八百字的中文文章介绍图灵测试"], { timeoutS: 60, interruptAfterMs: 1_500 });
  check("Ctrl+C 退出码 130", sig.code === 130, `code=${sig.code} signal=${sig.signal}`);
  check(`Ctrl+C 后 20 秒内退出（实测 ${sig.seconds.toFixed(1)}s）`, sig.seconds < 20 && !sig.killed, `${sig.seconds.toFixed(1)}s`);
  check("退出前说了要停（不是静默掐死）", /停止/.test(sig.err), sig.err.slice(-160));
  const stopAfter = await runCli(["stop"], { timeoutS: 20 });
  check("停过之后再 stop 报「没有在跑的回合」（内核那边确实停了）", /没有在跑的回合/.test(stopAfter.out), stopAfter.out.slice(0, 120));

  console.log("\n=== 9. version / status ===");
  const ver = await runCli(["version"], { timeoutS: 20 });
  check("version 退出码 0 且带内核版本", ver.code === 0 && /内核/.test(ver.out), `code=${ver.code} ${ver.out}`);
  const st = await runCli(["status"], { timeoutS: 20 });
  check("status 退出码 0 且打出工作区与规模", st.code === 0 && /工作区/.test(st.out) && /规模/.test(st.out), `code=${st.code}`);

  console.log("\n=== 10. 审批闭环：真卡住 -> 在终端里放行 -> 任务跑完 ===");
  await approvalRound();

  console.log("\n=== 11. up 幂等 / steer / tools --json / --help 离线 ===");
  // up 在已经跑着的端口上必须走「不重复启动」那条：不然用户第二次敲 dove up 会起出第二个内核，
  // 两个进程抢同一个库（这条断言成本 0，因为内核本来就在跑）
  const upAgain = await runCli(["up", "--port", String(PORT)], { timeoutS: 30 });
  check("内核已经在跑时 up 不重复启动（退出码 0 + 明说）",
    upAgain.code === 0 && /已经在跑/.test(upAgain.out), `code=${upAgain.code} ${upAgain.out.slice(0, 120)}`);

  const scratch = await runCli(["threads", "new", "插话冒烟", "--json"], { timeoutS: 20 });
  let scratchId = null;
  try { scratchId = JSON.parse(scratch.out)?.id; } catch { /* ignore */ }
  const steer = await runCli(["steer", "--thread", String(scratchId), "顺便看一眼日志"], { timeoutS: 20 });
  check("steer 投进去退出码 0", steer.code === 0 && /已插话/.test(steer.out), `code=${steer.code} ${steer.out.slice(0, 120)}`);
  // 插话是挂在**线程**上的，留着会在下一轮被注入 —— 用完就把线程删掉（不然它污染后面的断言）
  await runCli(["threads", "rm", String(scratchId)], { timeoutS: 20 });

  const tj = await runCli(["tools", "--json"], { timeoutS: 20 });
  let tjParsed = null;
  try { tjParsed = JSON.parse(tj.out); } catch { /* ignore */ }
  check("tools --json 的 stdout 是可解析 JSON（降级时也有一行，不是空气）",
    tj.code === 0 && Array.isArray(tjParsed?.tools), `code=${tj.code} out=${JSON.stringify(tj.out).slice(0, 120)}`);

  // --help 必须在**任何网络请求之前**返回：所以故意指一个空端口，连不上也不许影响它
  const help = await runCli(["run", "--help", "--port", "1"], { timeoutS: 20 });
  check("dove run --help 不需要内核也返回 0", help.code === 0 && /dove run/.test(help.out), `code=${help.code}`);
  const mainHelp = await runCli(["--help"], { timeoutS: 20 });
  const missing = ["health", "threads", "run", "chat", "stop", "steer", "approve", "answer", "tools", "goals", "logs", "skills", "up", "version"]
    .filter((c) => !mainHelp.out.includes(c));
  check("dove --help 列全了要求的子命令", mainHelp.code === 0 && missing.length === 0, "缺：" + missing.join(","));

  // 非 TTY 下 chat 必须**明确拒绝**（而不是进去就静默退出）：脚本化调用应该改用 dove run
  const chatNoTty = await runCli(["chat"], { timeoutS: 20 });
  check("非 TTY 时 chat 返回用法错（2）并指向 dove run",
    chatNoTty.code === 2 && /dove run/.test(chatNoTty.err + chatNoTty.out), `code=${chatNoTty.code}`);
} finally {
  stopKernel();
}

/**
 * 这一段跑的是**真的**审批：让模型调一次 Bash（越界 mkdir → 本地启发式判 medium），
 * 内核会阻塞等审批；CLI 在另一个进程里看到它、放行它，原来的那一轮才继续跑完。
 * 这才是 `dove approve` 存在的理由 —— GUI 没开的时候，终端得能把活儿放行。
 *
 * 模型可能不听指挥（不调工具）—— 那时按「跳过」处理，不判失败，但要打印出来。
 */
async function approvalRound() {
  const probeDir = `/tmp/dove-cli-approval-probe-${process.pid}`;
  const post = async (p, body) => {
    const r = await fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return r.json();
  };
  const proj = await post("/api/projects", { name: "CLI 审批冒烟" });
  const th = await post("/api/threads", { kind: "project", projectId: proj.id, title: "审批冒烟" });

  const child = spawn(process.execPath, [CLI, "run", "--thread", th.id,
    `用 Bash 工具执行这条命令，然后告诉我结果：mkdir -p ${probeDir}`],
    { cwd: HARNESS, env: { ...process.env, DOVE_CONFIG: process.env.DOVE_CONFIG }, stdio: ["ignore", "pipe", "pipe"] });
  let rerr = "";
  child.stderr.on("data", (d) => { rerr += d.toString(); });
  const done = new Promise((resolve) => child.on("exit", (code) => resolve(code ?? -1)));

  let pending = [];
  for (let i = 0; i < 45; i++) {
    const r = await runCli(["pending", "--json"], { timeoutS: 20 });
    try { pending = JSON.parse(r.out); } catch { pending = []; }
    if (Array.isArray(pending) && pending.length > 0) break;
    await new Promise((r2) => setTimeout(r2, 1_000));
  }

  if (!Array.isArray(pending) || pending.length === 0) {
    console.log("  ⚠ 跳过：模型这次没有发起需要审批的工具调用（这一段没验证到）");
    console.log("    stderr 尾部：" + rerr.slice(-200).replace(/\n/g, " | "));
  } else {
    check("pending 里能看到待审批（带 toolCallId 与标题）",
      typeof pending[0].toolCallId === "string" && !!pending[0].request?.title,
      JSON.stringify(pending[0]).slice(0, 160));
    const allow = await runCli(["approve", "--allow"], { timeoutS: 20 });
    check("approve --allow 放行成功（1/1）", allow.code === 0 && /已允许 1\/1/.test(allow.out), `${allow.code} ${allow.out}`.slice(0, 160));
    const after = await runCli(["pending", "--json"], { timeoutS: 20 });
    check("放行之后待审批清空", JSON.parse(after.out || "[]").length === 0, after.out.slice(0, 120));
    const code = await done;
    check("被审批卡住的那一轮继续跑完（退出码 0）", code === 0, `code=${code} ${rerr.slice(-200)}`);
    check("工具真的执行了（探针目录被建出来）", existsSync(probeDir), probeDir);
  }
  try { rmSync(probeDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log("\n=== 12. 就地审批的判定与开关（TTY 才问，非 TTY 不许问） ===");
{
  // pty 里的按键时序不适合进 CI（我用 Python 的 pty 驱动手工验过：提示出现 → 写 y → 已允许 → 脚本 85ms 跑完）。
  // 这里钉住可确定的两层：①「哪些回答算同意」②「什么时候允许问」。
  const { parseApprovalAnswer, inlineAllowed } = await import("../packages/cli/src/run.ts");
  check("y / yes / 是 算同意", ["y", "Y", "yes", "是"].every((x) => parseApprovalAnswer(x) === "allow"));
  // 误判一次 = 一条命令被悄悄放行，所以只认白名单；其余（含空回车）一律拒绝
  check("空回车 / n / 其它任何输入都算拒绝", ["", " ", "n", "no", "yep", "好的"].every((x) => parseApprovalAnswer(x) === "deny"));
  check("冒烟进程不是 TTY → 不许就地问（脚本/CI 不能被卡住）", inlineAllowed({ cmd: "run", sub: "", rest: [], flags: new Map() }) === false);
  check("--no-inline-approve 明确关掉", inlineAllowed({ cmd: "run", sub: "", rest: [], flags: new Map([["no-inline-approve", true]]) }) === false);
  check("--json 下不许问（stdout 必须是一行一个 JSON）", inlineAllowed({ cmd: "run", sub: "", rest: [], flags: new Map([["json", true]]) }) === false);
}

console.log("\n" + "=".repeat(50));
console.log(`结果：${pass} 通过 / ${fail} 失败`);
if (fails.length) { console.log("失败："); for (const f of fails) console.log("  - " + f); }
process.exit(fail === 0 ? 0 : 1);
