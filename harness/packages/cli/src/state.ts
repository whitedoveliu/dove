/**
 * CLI 的一点点本地状态：最近一次「提问」的 toolCallId。
 *
 * 为什么要落一个文件：AskUserQuestion 的答案是按 toolCallId 投递的，而回答它的人
 * 几乎一定是在**另一个终端**里敲 `dove answer`（提问的那个终端正卡在流式输出里）。
 * 没有这个记忆，用户就只能从滚动的日志里手抄 id。
 *
 * 为什么放系统临时目录而不是 ~/.dove：那是用户在用的数据目录（里面有库、记忆、技能），
 * CLI 不该往里塞自己的私货。而且这份提示的寿命只有几分钟 —— 提问默认 5 分钟就超时，
 * 重启后被清掉完全没关系。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface LastQuestion {
  questionId: string;
  /** 问题正文（给 `dove answer` 无参时回显「你要回答的是哪一个」） */
  brief: string;
  ts: number;
}

function fileFor(port: number): string {
  return join(tmpdir(), `dove-cli-q-${port}.json`);
}

/** 记下最近的提问。写失败不能影响主流程（只丢了个便利提示） */
export function rememberQuestion(port: number, q: LastQuestion): void {
  try {
    const dir = tmpdir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(fileFor(port), JSON.stringify(q), "utf8");
  } catch { /* ignore */ }
}

export function lastQuestion(port: number): LastQuestion | null {
  try {
    const j = JSON.parse(readFileSync(fileFor(port), "utf8")) as LastQuestion;
    return j && typeof j.questionId === "string" ? j : null;
  } catch {
    return null;
  }
}
