/**
 * 运行中的「待发送队列」—— 前端这一半的状态机（纯函数，好测）。
 *
 * 为什么需要它：一个回合跑起来之后（isLoading），输入框以前会把文本**直接丢掉**。
 * 现在运行中发送 = 排队：等这个回合结束自动发下一条。它和「插话」是两条路 ——
 *
 *   排队  → 等**整个回合**跑完，按正常发送路径发一条新消息
 *   插话  → 等**这一步（step）**跑完，内核把它折进当前回合（见 lib/api.ts 的 steerMessage）
 *
 * ⚠️ 队列是**会话级**的：面板能同时跑多个会话，A 会话排的队绝不能被发到 B 会话去。
 *    所以每条都带着自己的 project key，渲染和出队都按当前会话过滤。
 *
 * 队列本身不做去重 / 不做上限：用户排了几条就是几条，语义上都在等他发。
 * 只有「非空文本」会进队列（空串由调用方拦掉，这里再兜一次）。
 */

export interface QueuedMessage {
  /** 行的 key，也是删除 / 插话的定位依据 */
  id: string;
  text: string;
  /** 排给哪个会话（key = projectId；草稿页还没有项目时为 ""） */
  project: string;
}

let seq = 0;

/** 队列项 id：时间戳 + 自增序号，同一毫秒内也不会撞 */
export function newQueuedId(): string {
  seq += 1;
  return `q${Date.now().toString(36)}${seq}`;
}

/** 入队（尾插）。空白文本原样返回，不改队列。 */
export function enqueueMessage(queue: QueuedMessage[], project: string, text: string): QueuedMessage[] {
  const trimmed = text.trim();
  if (!trimmed) return queue;
  return [...queue, { id: newQueuedId(), text: trimmed, project }];
}

/** 只看当前会话的队列（渲染队列条用） */
export function queueForProject(queue: QueuedMessage[], project: string): QueuedMessage[] {
  return queue.filter((q) => q.project === project);
}

/** 按 id 移除（删除 / 插话成功后都用它）。找不到就是原队列。 */
export function removeQueuedMessage(queue: QueuedMessage[], id: string): QueuedMessage[] {
  return queue.filter((q) => q.id !== id);
}

/**
 * 取**当前会话**的队首（回合结束后自动发下一条用）——不改原数组，其余原样保留
 * （包括别的会话排的那些）。head 为 null 表示这个会话没排任何东西。
 */
export function takeQueueHead(
  queue: QueuedMessage[], project: string,
): { head: QueuedMessage | null; rest: QueuedMessage[] } {
  const head = queue.find((q) => q.project === project) ?? null;
  if (!head) return { head: null, rest: queue };
  return { head, rest: queue.filter((q) => q.id !== head.id) };
}

/**
 * 草稿页的队列搬家：项目还没建出来时排的队挂在 "" 上，项目建出来之后
 * 要跟着迁到真实 project id，否则这几条会永远没人发（也永远不显示）。
 *
 * ⚠️ from **允许是空串**（草稿页）—— 所以这里不能写 `!from` 的守卫，
 *    那会把唯一需要搬家的那种情况挡掉（单测抓到过）。
 */
export function rekeyQueuedProject(queue: QueuedMessage[], from: string, to: string): QueuedMessage[] {
  if (!to || from === to) return queue;
  return queue.map((q) => (q.project === from ? { ...q, project: to } : q));
}
