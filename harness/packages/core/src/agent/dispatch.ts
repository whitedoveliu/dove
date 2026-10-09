/**
 * Home → 项目线程的调度（D8，从 runtime.ts 抽出来，那边超 400 行了）
 *
 * 在目标项目线程里完整跑一轮，**只把结论带回 Home** —— 同样是上下文隔离。
 */
export async function runDispatch(
  run: (opts: { threadId: string; userText: string; projectId: string; signal?: AbortSignal;
                sink: (e: { type: string; [k: string]: unknown }) => void })
    => Promise<{ endReason: string }>,
  deps: {
    store: { getProject(id: string): { id: string; name: string } | undefined;
             getOrCreateProjectThread(id: string, title?: string): { id: string } };
    projectId: string;
    instruction: string;
    signal?: AbortSignal;
    sink: (e: Record<string, unknown>) => void;
  },
): Promise<{ output: string; endReason: string }> {
  const proj = deps.store.getProject(deps.projectId);
  if (!proj) return { output: `项目 ${deps.projectId} 不存在`, endReason: "not-found" };
  const target = deps.store.getOrCreateProjectThread(deps.projectId, proj.name);
  deps.sink({ type: "dispatch_start", projectId: deps.projectId, label: proj.name, instruction: deps.instruction.slice(0, 300) });
  const chunks: string[] = [];
  let reason = "stop";
  try {
    const res = await run({
      threadId: target.id, userText: deps.instruction, projectId: deps.projectId,
      signal: deps.signal,
      sink: (e) => {
        if (e.type === "text") chunks.push(String(e.content ?? ""));
        deps.sink({ type: "dispatch_event", projectId: deps.projectId, inner: e.type });
      },
    });
    reason = res.endReason;
  } catch (e) {
    return { output: "项目线程执行失败：" + (e instanceof Error ? e.message : String(e)), endReason: "error" };
  }
  const output = chunks.join("").trim() || "(项目线程没有产出文本结论)";
  deps.sink({ type: "dispatch_done", projectId: deps.projectId, endReason: reason });
  return { output, endReason: reason };
}
