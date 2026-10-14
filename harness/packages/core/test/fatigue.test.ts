/**
 * 疲劳 / 清醒时长（emotion/fatigue.ts）—— 回归测试，为一次真实事故而写：
 *
 * 用户看见模型说「我已经连续清醒 206 小时」。查下去：`awakeSince` 从第一次运行起就冻住
 * （`~/.dove/fatigue.json` 停在 10-06，到 10-14 都没人动过），因为生产里**没有人调
 * sleep()/wake()**，而旧的 `snapshot()` 又是「纯读不落盘」—— 于是每轮都把 206 小时
 * 重新渲染给模型看，疲劳也一路（重）算到 100/100。
 *
 * 钉两条规则：① 空闲 ≥ 3 小时 = 睡过一觉（清醒时长从「现在」重新起算）；
 * ② 推进过的状态要落盘（一分钟粒度），否则永远从同一个老起点重算、永远醒不来。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FatigueService, FATIGUE_IDLE_SLEEP_AFTER_HOURS,
  FATIGUE_AWAKE_PER_HOUR, FATIGUE_SLEEP_PER_HOUR,
} from "../src/emotion/fatigue.ts";

const HOUR = 3_600_000;
/** 固定「现在」，别让测试读真实时钟（REVIEW.md 第八条：不依赖外部环境） */
const NOW = 1_791_900_000_000;

function withConfig(record: Record<string, number | boolean> | null, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "dove-fatigue-"));
  try {
    if (record) writeFileSync(join(dir, "fatigue.json"), JSON.stringify(record, null, 2) + "\n");
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const serviceAt = (dir: string, nowMs: number): FatigueService =>
  new FatigueService({ configDir: dir, now: () => new Date(nowMs) });

test("回归：冻了两百多小时的旧状态，第一次读就自愈（不再是「连续清醒 206 小时」）", () => {
  const frozen = NOW - 206 * HOUR;
  withConfig({ fatigue: 0.3, sleeping: false, updatedAt: frozen, awakeSince: frozen }, (dir) => {
    const svc = serviceAt(dir, NOW);
    const snap = svc.snapshot();
    assert.ok(snap.hours < 0.01, "清醒时长要从「现在」重新起算，实际 " + snap.hours);
    assert.equal(snap.fatigue, 0, "睡这么久的疲劳应回落到 0（206×15/h 早就打穿下界）");
    assert.equal(snap.state, "awake");

    // 渲染给模型的那段话里不能再出现 206
    const block = svc.renderBlock();
    assert.match(block, /已连续清醒 0\.0 小时/);
    assert.doesNotMatch(block, /206/);

    // 而且顺手落盘了（否则下次读又从老起点重算）
    const saved = JSON.parse(readFileSync(join(dir, "fatigue.json"), "utf8")) as { updatedAt: number; awakeSince: number };
    assert.equal(saved.updatedAt, NOW);
    assert.equal(saved.awakeSince, NOW);
  });
});

test("空闲 2.9 小时（< 阈值）：不算睡，按清醒速率累积", () => {
  const start = NOW - 2.9 * HOUR;
  withConfig({ fatigue: 10, sleeping: false, updatedAt: start, awakeSince: start }, (dir) => {
    const snap = serviceAt(dir, NOW).snapshot();
    assert.ok(Math.abs(snap.hours - 2.9) < 0.01, "清醒时长≈2.9，实际 " + snap.hours);
    assert.ok(Math.abs(snap.fatigue - (10 + 2.9 * FATIGUE_AWAKE_PER_HOUR)) < 0.1, "疲劳按 4/h 涨，实际 " + snap.fatigue);
  });
});

test("空闲 3.1 小时（≥ 阈值）：按睡过一觉算 —— 疲劳回落、清醒重新起算", () => {
  assert.ok(FATIGUE_IDLE_SLEEP_AFTER_HOURS > 2.9 && FATIGUE_IDLE_SLEEP_AFTER_HOURS <= 3.1, "阈值本身也要是 3 小时");
  const start = NOW - 3.1 * HOUR;
  withConfig({ fatigue: 50, sleeping: false, updatedAt: start, awakeSince: start }, (dir) => {
    const snap = serviceAt(dir, NOW).snapshot();
    assert.ok(snap.hours < 0.01, "睡醒即现在，实际 " + snap.hours);
    assert.ok(Math.abs(snap.fatigue - (50 - 3.1 * FATIGUE_SLEEP_PER_HOUR)) < 0.1, "按 15/h 回落，实际 " + snap.fatigue);
    assert.equal(snap.sleeping, false, "是「睡醒了」，不是还在睡");
  });
});

test("显式睡着的记录照旧走睡眠那条路（空闲规则不干扰它）", () => {
  const start = NOW - 5 * HOUR;
  withConfig({ fatigue: 30, sleeping: true, updatedAt: start, awakeSince: start }, (dir) => {
    const snap = serviceAt(dir, NOW).snapshot();
    // 需要睡 (30-8)/15 = 1.467 小时到点，剩下 3.533 小时按清醒累积
    assert.equal(snap.sleeping, false, "睡够了应该自然醒");
    assert.ok(Math.abs(snap.fatigue - (8 + (5 - 30 / 15 + 8 / 15) * 4)) < 0.05, "8 + 3.533×4，实际 " + snap.fatigue);
  });
});

test("落盘节流：一分钟内连读不写盘，超过一分钟才写", () => {
  withConfig({ fatigue: 0, sleeping: false, updatedAt: NOW, awakeSince: NOW }, (dir) => {
    const before = JSON.parse(readFileSync(join(dir, "fatigue.json"), "utf8")) as { updatedAt: number };
    // 30 秒后读：快照要往前走，但盘上不动（一分钟粒度）
    const s30 = serviceAt(dir, NOW + 30_000).snapshot();
    assert.equal(s30.updatedAt, NOW + 30_000, "快照本身要按经过时间推进");
    assert.equal((JSON.parse(readFileSync(join(dir, "fatigue.json"), "utf8")) as { updatedAt: number }).updatedAt, before.updatedAt);
    // 两分钟后再读：写上
    serviceAt(dir, NOW + 120_000).snapshot();
    assert.equal((JSON.parse(readFileSync(join(dir, "fatigue.json"), "utf8")) as { updatedAt: number }).updatedAt, NOW + 120_000);
  });
});
