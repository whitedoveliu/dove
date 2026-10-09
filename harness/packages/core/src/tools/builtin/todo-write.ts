/**
 * TodoWrite —— 任务清单（元工具，永远在）
 * 状态按线程隔离、只活在进程内；它的价值是**把多步工作显式化**，不是持久化存储。
 */
import { defineTool, S } from "../types.ts";
import { guarded } from "./util.ts";

export type TodoStatus = "pending" | "in_progress" | "completed";
export interface TodoItem { content: string; status: TodoStatus; activeForm?: string }

const MAX_ITEMS = 60;
const STORE = new Map<string, TodoItem[]>();

export function getTodos(threadId: string): TodoItem[] {
  return STORE.get(threadId) ?? [];
}

export function setTodos(threadId: string, todos: TodoItem[]): void {
  STORE.set(threadId, todos);
}

function normalize(input: unknown): TodoItem[] {
  if (!Array.isArray(input)) throw new Error("todos 必须是数组");
  if (input.length > MAX_ITEMS) throw new Error("一次最多 " + MAX_ITEMS + " 项（当前 " + input.length + "）");
  return input.map((raw, i) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const content = String(o.content ?? "").trim();
    if (!content) throw new Error("第 " + (i + 1) + " 项缺少 content");
    const status = String(o.status ?? "pending").trim();
    if (status !== "pending" && status !== "in_progress" && status !== "completed") {
      throw new Error("第 " + (i + 1) + " 项的 status 非法：" + status + "（只能是 pending / in_progress / completed）");
    }
    return {
      content,
      status: status as TodoStatus,
      activeForm: o.activeForm === undefined ? undefined : String(o.activeForm),
    };
  });
}

export const TodoWriteTool = defineTool({
  name: "TodoWrite",
  description:
    "维护当前任务清单（整表覆盖）。多步任务开工前先写清单，并把正在做的那一项标成 in_progress；" +
    "做完立刻标 completed。清单是给用户看进度的，不是给自己写日记，条目要短。",
  parameters: S.obj({
    todos: S.arr(
      S.obj({
        content: S.str("任务内容（祈使句，一句话）"),
        status: S.str("pending | in_progress | completed"),
        activeForm: S.str("正在做时的进行时描述（可选）"),
      }, ["content", "status"]),
      "完整任务清单（整表覆盖，不是增量）",
    ),
  }, ["todos"]),
  outputTier: "exact",
  approval: "never",
  concurrencySafe: false,
  execute: (input, ctx) => guarded(async () => {
    const todos = normalize(input.todos);
    setTodos(ctx.threadId, todos);
    const counts = {
      pending: todos.filter((t) => t.status === "pending").length,
      in_progress: todos.filter((t) => t.status === "in_progress").length,
      completed: todos.filter((t) => t.status === "completed").length,
    };
    ctx.emit("tool:todos", { toolCallId: ctx.toolCallId, threadId: ctx.threadId, todos, counts });
    return { todos, counts, note: "清单已更新（整表覆盖）。" };
  }),
});
