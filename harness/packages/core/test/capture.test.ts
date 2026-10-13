/**
 * 区域截屏（`POST /api/capture`）的结果分支 —— **不需要真的截屏**。
 *
 * 为什么这个文件放在 core/test 下：`npm test` 只扫这个目录（服务器的路由没有自己的测试目录）。
 * 被测的就一个文件（legacy/routes-capture.ts），路径不跨层，断言的是**面板看到的响应形状**：
 * 501 / 413 / 200(cancelled) / 200(ok) 四种，以及「任何路径都不留临时文件」。
 * 「没有图」一律归到 cancelled —— 包括 macOS 上按 Esc 会留下的那个 0 字节文件（见下）。
 *
 * 真截屏（会弹系统十字框选）只在 DOVE_TEST_REAL_CAPTURE=1 时才跑，默认 skip。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import { CAPTURE_MAX_BYTES, captureRegion, handleCaptureRoutes } from "../../server/src/legacy/routes-capture.ts";

/** 1×1 的合法 PNG（已知字节，不依赖任何外部工具） */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);

/** 假响应：只记状态码与 body —— legacy 的 json() 只干这两件事 */
function fakeRes(): { res: ServerResponse; out: { status: number; body: string } } {
  const out = { status: 0, body: "" };
  const res = {
    writeHead(code: number) { out.status = code; return res; },
    end(body?: string) { out.body = body ?? ""; },
  };
  return { res: res as unknown as ServerResponse, out };
}

function fakeReq(method: string): IncomingMessage {
  return { method, resume: () => { /* 没有 body */ } } as unknown as IncomingMessage;
}

/** 跑一次 captureRegion，并回收注入的 run 看到的临时文件路径 */
async function capture(write?: (file: string) => void | Promise<void>) {
  const seen: { file: string } = { file: "" };
  const out = await captureRegion({
    platform: "darwin",
    run: async (file) => {
      seen.file = file;
      if (write) await write(file);
      return true;
    },
  });
  return { out, file: seen.file };
}

test("截屏：非 macOS → 501，一个字节都不读", async () => {
  const r = await captureRegion({ platform: "linux", run: async () => { throw new Error("不该被调用"); } });
  assert.deepEqual(r, { ok: false, status: 501, error: "只有 macOS 支持框选截屏" });
});

test("截屏：用户取消 / 非零退出 → cancelled，不是 error（临时文件照样删掉）", async () => {
  const seen: { file: string } = { file: "" };
  const r = await captureRegion({ platform: "darwin", run: async (file) => { seen.file = file; return false; } });
  assert.deepEqual(r, { ok: false, cancelled: true });
  assert.ok(seen.file, "临时文件路径应该被交给 screencapture");
  assert.equal(existsSync(seen.file), false, "取消也要删临时文件");
  assert.equal(existsSync(dirname(seen.file)), false, "临时目录要整个删掉");
});

test("截屏：退出码 0 + 0 字节文件 → cancelled（macOS 上按 Esc 就是这么结束的）", async () => {
  // 实测：Esc 结束框选时 screencapture 退出码 0，但留下一个 0 字节文件。
  // 这条必须走 cancelled（面板保持安静），不能翻成 500 —— 否则每按一次 Esc 弹一次红条。
  const { out, file } = await capture((f) => writeFileSync(f, ""));
  assert.deepEqual(out, { ok: false, cancelled: true });
  assert.equal(existsSync(file), false, "空结果路径也要清理");
  assert.equal(existsSync(dirname(file)), false, "临时目录要整个删掉");
});

test("截屏：退出码 0 但根本没有文件 → 也是 cancelled", async () => {
  // screencapture 没写文件（没选任何区域）：existsSync 为假 → bytes 按 0 走同一条取消分支
  const seen: { file: string } = { file: "" };
  const out = await captureRegion({ platform: "darwin", run: async (file) => { seen.file = file; return true; } });
  assert.deepEqual(out, { ok: false, cancelled: true });
  assert.equal(existsSync(seen.file), false);
  assert.equal(existsSync(dirname(seen.file)), false, "临时目录要整个删掉");
});

test("截屏：超过 6 MiB → 413", async () => {
  const { out, file } = await capture((f) => writeFileSync(f, Buffer.alloc(CAPTURE_MAX_BYTES + 1)));
  assert.deepEqual(out, { ok: false, status: 413, error: "截屏太大（超过 6 MB）" });
  assert.equal(existsSync(file), false, "超大文件路径也要清理");
  assert.equal(existsSync(dirname(file)), false, "临时目录要整个删掉");
});

test("截屏：正常图 → base64 回给面板，临时文件删掉", async () => {
  const { out, file } = await capture((f) => writeFileSync(f, PNG_1X1));
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(Buffer.from(out.data, "base64").equals(PNG_1X1), true, "base64 要能还原成原图");
  assert.equal(existsSync(file), false, "成功了也不许留临时文件");
  assert.equal(existsSync(dirname(file)), false, "临时目录要整个删掉");
});

test("截屏：runner 抛错也要走 finally（临时文件不留）", async () => {
  const seen: { file: string } = { file: "" };
  await assert.rejects(captureRegion({
    platform: "darwin",
    run: async (file) => { seen.file = file; writeFileSync(file, PNG_1X1); throw new Error("模拟 screencapture 崩了"); },
  }));
  assert.ok(seen.file, "临时文件路径应该被交给 runner");
  assert.equal(existsSync(seen.file), false, "抛错也要删临时文件");
  assert.equal(existsSync(dirname(seen.file)), false, "临时目录要整个删掉");
});

test("截屏路由：只有 POST /api/capture 归它管", async () => {
  const a = fakeRes();
  assert.equal(await handleCaptureRoutes("/api/capture", fakeReq("GET"), a.res), false);
  const b = fakeRes();
  assert.equal(await handleCaptureRoutes("/api/chat", fakeReq("POST"), b.res), false);
  assert.equal(b.out.status, 0, "不该写任何响应");
});

test("截屏路由：四种结果各自的 HTTP 形状（面板按这个渲染）", async () => {
  // ① 非 macOS
  {
    const { res, out } = fakeRes();
    assert.equal(await handleCaptureRoutes("/api/capture", fakeReq("POST"), res, { platform: "linux" }), true);
    assert.equal(out.status, 501);
    assert.deepEqual(JSON.parse(out.body), { ok: false, error: "只有 macOS 支持框选截屏" });
  }
  // ② 取消：200，但 ok=false（面板保持安静）
  {
    const { res, out } = fakeRes();
    await handleCaptureRoutes("/api/capture", fakeReq("POST"), res, { platform: "darwin", run: async () => false });
    assert.equal(out.status, 200);
    assert.deepEqual(JSON.parse(out.body), { ok: false, cancelled: true });
  }
  // ③ 空结果（Esc 的退出码 0 + 0 字节）：形状和取消完全一样
  {
    const { res, out } = fakeRes();
    await handleCaptureRoutes("/api/capture", fakeReq("POST"), res, { platform: "darwin", run: async (f) => { writeFileSync(f, ""); return true; } });
    assert.equal(out.status, 200);
    assert.deepEqual(JSON.parse(out.body), { ok: false, cancelled: true });
  }
  // ④ 超大 413
  {
    const { res, out } = fakeRes();
    await handleCaptureRoutes("/api/capture", fakeReq("POST"), res, { platform: "darwin", run: async (f) => { writeFileSync(f, Buffer.alloc(CAPTURE_MAX_BYTES + 1)); return true; } });
    assert.equal(out.status, 413);
    assert.deepEqual(JSON.parse(out.body), { ok: false, error: "截屏太大（超过 6 MB）" });
  }
  // ⑤ 成功：字段名就是契约
  {
    const { res, out } = fakeRes();
    await handleCaptureRoutes("/api/capture", fakeReq("POST"), res, { platform: "darwin", run: async (f) => { writeFileSync(f, PNG_1X1); return true; } });
    assert.equal(out.status, 200);
    const body = JSON.parse(out.body) as { ok: boolean; name: string; mediaType: string; data: string };
    assert.equal(body.ok, true);
    assert.equal(body.name, "screenshot.png");
    assert.equal(body.mediaType, "image/png");
    assert.equal(Buffer.from(body.data, "base64").equals(PNG_1X1), true);
  }
});

test("截屏：真截屏（要人框选，默认跳过）", { skip: process.env.DOVE_TEST_REAL_CAPTURE !== "1" }, async () => {
  // 走真的 `screencapture -i -x`：macOS 会画出十字框选，等人选完
  const r = await captureRegion();
  // 形状断言：要么拿到图，要么是取消 —— 两条路都不该是"未处理的错误"
  assert.ok(r.ok || "cancelled" in r, JSON.stringify(r));
});
