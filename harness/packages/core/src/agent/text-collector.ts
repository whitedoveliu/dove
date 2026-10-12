/**
 * 助手文本收集器：模型增量 → 脱敏 → part + 日志 + 推流。
 *
 * 从 runtime.ts 抽出来（那边贴着 400 行硬约束）：这里是纯「文本进、事件出」的管道，
 * 不认识线程、工具、记忆。
 *
 * ⚠️ 纪律：**每个 step 结束都必须 flush()**，不能只在整轮结束时 flush 一次。
 *    脱敏器（security/redact-stream.ts）有 256 字符回看窗口，短回复会被整段扣住 ——
 *    只在整轮结束才放出来的话，实测后果有三条：
 *      1. 日志里看不到这一步说过什么（整轮只剩最后一条 assistant_text，
 *         实测 1092 轮对话只留下 2 条 —— 就是这个问题）；
 *      2. **两个 step 的文本被拼成一条**：实测心跳回合里模型在两个 step 各回了一遍
 *         HEARTBEAT_OK，日志里就是 "HEARTBEAT_OKHEARTBEAT_OK"（问题 ⑥ 的一半根因）；
 *      3. 完成守卫看到"模型说过话"就开了续跑，而用户那边一个字都没收到。
 */
import type { Part } from "../session/types.ts";
import type { EventLog } from "../session/event-log.ts";
import { RedactStream } from "../security/redact-stream.ts";

export interface TextCollectorOptions {
  parts: Part[];
  eventLog: EventLog;
  sink: (e: { type: string; [k: string]: unknown }) => void;
  runId: string;
  /** 当前 step 号（惰性取：日志按步归档） */
  step: () => number;
}

export class TextCollector {
  #parts: Part[];
  #eventLog: EventLog;
  #sink: TextCollectorOptions["sink"];
  #runId: string;
  #step: () => number;
  #redactor: RedactStream;
  #text: { type: "text"; text: string; state?: "streaming" } | null = null;
  #reasoning: { type: "reasoning"; text: string; state?: "streaming" } | null = null;

  constructor(o: TextCollectorOptions) {
    this.#parts = o.parts;
    this.#eventLog = o.eventLog;
    this.#sink = o.sink;
    this.#runId = o.runId;
    this.#step = o.step;
    // 回复层流式脱敏（T8.1）：密钥/凭据绝不推到界面或落进日志
    this.#redactor = new RedactStream({
      onHit: (hits) => {
        this.#eventLog.append("redacted", { where: "assistant_text", hits }, { run: this.#runId, step: this.#step() });
        this.#sink({ type: "redacted", hits });
      },
    });
  }

  #ensureText(): { type: "text"; text: string; state?: "streaming" } {
    if (!this.#text) {
      this.#text = { type: "text", text: "", state: "streaming" };
      this.#parts.push(this.#text as Part);
    }
    return this.#text;
  }

  /** 模型的一段输出（逐 token 推流） */
  push(delta: string): void {
    const safe = this.#redactor.push(delta);
    if (safe.length === 0) return;
    this.#ensureText().text += safe;
    this.#eventLog.append("assistant_text", { delta: safe.slice(0, 400) }, { run: this.#runId, step: this.#step() });
    this.#sink({ type: "text", content: safe });
  }

  /** 推理增量：只进 parts 与界面，不写日志正文（可能很长），也不做脱敏（不是用户可见回复） */
  reasoning(delta: string, full: string): void {
    if (!this.#reasoning) {
      this.#reasoning = { type: "reasoning", text: "", state: "streaming" };
      this.#parts.push(this.#reasoning as Part);
    }
    this.#reasoning.text = full;
    this.#sink({ type: "reasoning", content: delta });
  }

  /** 放掉脱敏器扣住的尾巴。每个 step 结束都要调（见文件头），整轮结束再调一次兜底 */
  flush(): void {
    const tail = this.#redactor.flush();
    if (tail.length === 0) return;
    this.#ensureText().text += tail;
    this.#eventLog.append("assistant_text", { delta: tail.slice(0, 400) }, { run: this.#runId, step: this.#step() });
    this.#sink({ type: "text", content: tail });
  }

  /**
   * 空回合说明（问题 ④）：直接写进唯一的 text part 并推一条 text。
   * 用赋值而不是追加 —— 这条文案是这一轮**唯一**的内容，不该和空串拼在一起。
   */
  annotate(text: string): void {
    this.#ensureText().text = text;
    this.#sink({ type: "text", content: text });
  }
}
