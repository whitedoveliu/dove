/**
 * 两轴权限模型（sandbox × approval）—— **纯函数层**的契约。
 * 端到端（真的跑工具、真的问审批）在 write-scope.test.ts；这里只钉判定与解析。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_PROFILE, PERMISSION_PRESETS, normalizeProfile, normalizePermissionMode, legacyModeOf,
  decideWrite, writableRootsOf, isCredentialWriteTarget, extractPaths, isWithinPath,
  DenialMemory, denialKey,
} from "../src/tools/permission.ts";

test("normalizeProfile：新字段优先、旧值双读、脏数据一律退回默认（绝不放宽）", () => {
  assert.deepEqual(
    normalizeProfile({ permission: { sandbox: "danger-full-access", approval: "never", writableRoots: ["/x"] } }),
    { sandbox: "danger-full-access", approval: "never", writableRoots: ["/x"] },
  );
  // 旧枚举 + 更老的别名
  assert.deepEqual(normalizeProfile({ permissionMode: "full" }), { sandbox: "danger-full-access", approval: "never", writableRoots: [] });
  assert.deepEqual(normalizeProfile({ permissionMode: "auto" }), { sandbox: "danger-full-access", approval: "review", writableRoots: [] });
  assert.deepEqual(normalizeProfile({ permissionMode: "workspace" }), DEFAULT_PROFILE);
  assert.deepEqual(normalizeProfile({ permissionMode: "readonly" }), { sandbox: "read-only", approval: "never", writableRoots: [] });
  // readOnly 是更老的一位布尔：它比 permissionMode 更严，必须压过它
  assert.equal(normalizeProfile({ readOnly: true, permissionMode: "full" }).sandbox, "read-only");
  // 脏数据
  assert.deepEqual(normalizeProfile(null), DEFAULT_PROFILE);
  assert.deepEqual(normalizeProfile({ permission: { sandbox: "yolo", approval: 1, writableRoots: "x" } }), DEFAULT_PROFILE);
  assert.deepEqual(normalizeProfile({ permissionMode: 42 }), DEFAULT_PROFILE);
  assert.deepEqual(normalizeProfile({ permission: { writableRoots: ["/a", "", 7, "  ", " /b "] } }).writableRoots, ["/a", "/b"]);
});

test("预设表 = 两轴绑定；四档与旧枚举行为一致；描述不许说谎（P8）", () => {
  const byValue = Object.fromEntries(PERMISSION_PRESETS.map((p) => [p.value, p]));
  assert.deepEqual(byValue["read-only"]!.profile, { sandbox: "read-only", approval: "never", writableRoots: [] });
  assert.deepEqual(byValue["workspace-write"]!.profile, DEFAULT_PROFILE);
  assert.deepEqual(byValue["danger-full-access"]!.profile, { sandbox: "danger-full-access", approval: "never", writableRoots: [] });
  assert.deepEqual(byValue["auto"]!.profile, { sandbox: "danger-full-access", approval: "review", writableRoots: [] });
  // 沙箱还没接入这件事必须写在档位描述里（否则档位名字在骗人）
  assert.match(byValue["workspace-write"]!.description, /沙箱尚未接入/);
  assert.match(byValue["danger-full-access"]!.description, /工作区外/);
  // profile → 旧 mode（老面板/CLI 只认 mode）
  assert.equal(legacyModeOf(byValue["auto"]!.profile), "auto");
  assert.equal(legacyModeOf(byValue["workspace-write"]!.profile), "workspace-write");
  assert.equal(legacyModeOf({ ...DEFAULT_PROFILE, sandbox: "danger-full-access" }), "danger-full-access");
  assert.equal(normalizePermissionMode("full"), "danger-full-access");
  assert.equal(normalizePermissionMode("nonsense"), "workspace-write");
});

test("decideWrite：判定表逐格（可写根 / 越界 / 只读子路径 / 只读沙箱 / 完全权限）", () => {
  const ws = "/tmp/dove-ws-probe";
  const write = { ...DEFAULT_PROFILE };
  assert.deepEqual(decideWrite(join(ws, "a.txt"), write, ws), { kind: "allow", escalated: false });
  assert.equal(decideWrite("/tmp/dove-other/a.txt", write, ws).kind, "ask");
  assert.equal(decideWrite(join(ws, ".git/config"), write, ws).kind, "deny");
  assert.equal(decideWrite(join(ws, ".git"), write, ws).kind, "deny");
  assert.equal(decideWrite(join(ws, ".codex/config.toml"), write, ws).kind, "deny");
  assert.equal(decideWrite(join(ws, "src/.gitkeep"), write, ws).kind, "allow", ".gitkeep 不是 .git 目录");
  // 只读沙箱：连工作区内也拒（工具本该被裁，这是兜底）
  assert.equal(decideWrite(join(ws, "a.txt"), { ...write, sandbox: "read-only" }, ws).kind, "deny");
  // 完全权限：越界放行并标 escalated；区内不算越界
  assert.deepEqual(decideWrite("/etc/hosts", { ...write, sandbox: "danger-full-access" }, ws), { kind: "allow", escalated: true });
  assert.deepEqual(decideWrite(join(ws, "a.txt"), { ...write, sandbox: "danger-full-access" }, ws), { kind: "allow", escalated: false });
  // 只读子路径的保护只在 workspace-write 成立（"完全权限"就是完全）
  assert.equal(decideWrite(join(ws, ".git/config"), { ...write, sandbox: "danger-full-access" }, ws).kind, "allow");
  // 额外可写目录把"越界"变成"区内"
  const extra = { ...write, writableRoots: ["/tmp/dove-extra-probe"] };
  assert.deepEqual(decideWrite("/tmp/dove-extra-probe/sub/x.txt", extra, ws), { kind: "allow", escalated: false });
  assert.equal(writableRootsOf(extra, ws).length, 2);
  // 越界审批的建议根 = 目标所在目录
  const ask = decideWrite("/tmp/dove-other/a.txt", write, ws);
  assert.ok(ask.kind === "ask" && ask.suggestedRoot === "/tmp/dove-other");
  // 前缀相近但不是子路径
  assert.ok(isWithinPath(join(ws, "a/b"), ws));
  assert.ok(!isWithinPath(ws + "x", ws), "\"…-probe\" 与 \"…-probex\" 不是同一棵树");
});

test("凭证名单：只覆盖纯密钥目标；配置目录明确不在内（否则挡掉正常干活）", () => {
  const home = homedir();
  assert.equal(isCredentialWriteTarget(join(home, ".ssh/authorized_keys")), true);
  assert.equal(isCredentialWriteTarget(join(home, ".ssh/authorized_keys2")), true);
  assert.equal(isCredentialWriteTarget(join(home, ".ssh/id_rsa")), true);
  assert.equal(isCredentialWriteTarget(join(home, ".ssh/id_ed25519.pub")), false, "公钥不是秘密");
  assert.equal(isCredentialWriteTarget(join(home, ".ssh/known_hosts")), false);
  assert.equal(isCredentialWriteTarget(join(home, ".aws/credentials")), true);
  assert.equal(isCredentialWriteTarget(join(home, ".gnupg/secring.gpg")), true);
  assert.equal(isCredentialWriteTarget(join(home, ".config/gcloud/application_default_credentials.json")), true);
  // 反例：这些是正常干活的目标 —— 上一轮的真实任务就是改 ~/.kimi-code/config.toml
  assert.equal(isCredentialWriteTarget(join(home, ".kimi-code/config.toml")), false);
  assert.equal(isCredentialWriteTarget(join(home, ".codex/config.toml")), false);
  assert.equal(isCredentialWriteTarget(join(home, ".dove/SOUL.md")), false);
  assert.equal(isCredentialWriteTarget("/tmp/authorized_keys"), false, "家目录之外的同名文件不算（那是越界那一档的事）");
});

test("extractPaths：粗提绝对路径 / ~ 路径（明确不是边界）", () => {
  const paths = extractPaths("cp a.txt /tmp/out/x.txt && rm -rf ~/Documents/old", "/ws");
  assert.ok(paths.includes("/tmp/out/x.txt"));
  assert.ok(paths.includes(join(homedir(), "Documents/old")));
  assert.deepEqual(extractPaths("echo hi > out.txt", "/ws"), [], "相对路径不参与（判不了越界就别猜）");
  assert.deepEqual(extractPaths("ls -la", "/ws"), []);
});

test("DenialMemory：记形状、线程隔离、超上限淘汰最老的", () => {
  const mem = new DenialMemory();
  const key = denialKey("th1", "Write", "/etc/hosts");
  assert.equal(mem.has(key), false);
  mem.deny(key);
  assert.equal(mem.has(key), true);
  assert.equal(mem.has(denialKey("th1", "Write", "/etc/other")), false, "形状不同不算命中");
  assert.equal(mem.has(denialKey("th2", "Write", "/etc/hosts")), false, "线程不同不算命中");
  for (let i = 0; i < 500; i++) mem.deny(denialKey("th1", "Bash", "cmd" + i));
  assert.equal(mem.has(denialKey("th1", "Bash", "cmd0")), false, "超上限要淘汰最老的");
  assert.equal(mem.has(denialKey("th1", "Bash", "cmd499")), true);
});
