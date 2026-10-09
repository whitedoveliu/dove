/**
 * steering（中途插话，T1.6）
 * 物理边界（答疑 P2-12 第 3 条）：生成一旦发起，输入快照即冻结。
 * 插话**无法注入当前这次生成**，只能在步边界折叠。
 * 所以：立即持久化 + 立即回显「已插队」，不承诺打断正在生成的 token。
 */
export class SteeringQueue {
  #queues = new Map<string, string[]>();

  push(threadId: string, text: string): void {
    const q = this.#queues.get(threadId) ?? [];
    q.push(text);
    this.#queues.set(threadId, q);
  }

  pending(threadId: string): boolean { return (this.#queues.get(threadId)?.length ?? 0) > 0; }

  drain(threadId: string): string[] {
    const q = this.#queues.get(threadId) ?? [];
    this.#queues.set(threadId, []);
    return q;
  }

  clear(threadId: string): void { this.#queues.delete(threadId); }
}
