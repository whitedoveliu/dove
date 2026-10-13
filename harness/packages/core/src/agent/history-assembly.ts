/**
 * 压缩之后的 wire 历史装配：**检查点前缀 + 检查点之后的消息**
 *
 * 为什么单独一个文件：① agent/runtime.ts 贴着 400 行上限；② 这条拼装规则值得单独测 ——
 * 它是「压缩到底有没有留下来」的唯一现场，少一段（前缀丢了）或多一段（前缀之后的历史又重建了一遍）
 * 都是静默的：模型照答，只是账单和记忆一起坏掉。
 *
 * 为什么前缀**原样透传**、不再过一遍 toWireHistory：检查点里存的就是那一刻真实上过 wire 的消息
 * （ChatMessage[]），再转一次等于重建，而重建与实时只差一个字节就会让缓存前缀整段作废
 * （见 agent/wire-history.ts 的铁律二）。所以这里只做拼接，一行转换都不加。
 *
 * 无检查点（或检查点 payload 为空 —— session/store.ts 已把空 payload 视同「没有检查点」）时，
 * 返回值与「直接 toWireHistory(recentMessages(…))」**逐字节相同**：前缀是空数组，拼接不引入任何差异。
 */
import type { ChatMessage } from "../providers/types.ts";
import type { Message } from "../session/types.ts";
import { toWireHistory } from "./wire-history.ts";

/**
 * 装配需要的两个读口（就是 Store 上的那两个方法）。写成结构化类型而不是 import Store：
 * 测试与将来的别的历史源都能直接满足它，而装配这段逻辑与 SQLite 无关。
 */
export interface WireHistorySource {
  /** 该线程最新的压缩检查点（没有则 undefined）；payload 是已拼好的 wire 消息序列 */
  compactedHistory(threadId: string): { payload: unknown[]; at: number } | undefined;
  /** 检查点**之后**的消息（没有检查点时等价于 recentMessages）；仍是未撤销的那一份 */
  historyForWire(threadId: string, limit: number): Message[];
}

/**
 * 最终交给 provider 的 wire 历史 = （检查点里的**已拼好**前缀）+（检查点之后的消息转 wire）。
 * `limit` 只作用于检查点之后那一段（前缀不受它约束：它本来就是「被保留的那部分历史」）。
 */
export function assembleWireHistory(o: {
  store: WireHistorySource;
  threadId: string;
  limit: number;
  supportsImages: boolean;
}): ChatMessage[] {
  const cp = o.store.compactedHistory(o.threadId);
  const tail = toWireHistory(o.store.historyForWire(o.threadId, o.limit), o.threadId, o.supportsImages);
  if (!cp || cp.payload.length === 0) return tail;
  return [...(cp.payload as ChatMessage[]), ...tail];
}

/** 检查点的写口（就是 Store.setCompactedHistory）。结构化类型：装配这段逻辑与 SQLite 无关 */
export interface CheckpointSink {
  setCompactedHistory(threadId: string, payload: unknown[], at: number): void;
}

/**
 * 落一条压缩检查点：payload = 压缩结果**剥掉本轮在飞的段**。
 *
 * 为什么剥：在飞段（本轮循环推进去的 assistant / tool / 注入 user 消息）回合末才落库，而检查点
 * 之后的历史是按 `created_at > at` 从库里取的 —— 留在检查点里就意味着下一条 wire 上同一段出现两遍
 * （既在检查点前缀里，又在重建的尾巴里）。重发的代价是账单，重复的代价是模型看见自己说过两遍同样的话。
 *
 * ⚠️ 「在飞」只能按**对象身份**认（`inFlight` = loop/turn.ts 自己推消息时记下的那个集合），
 *    不能按「本轮 user 消息的下标 + 1」这类下标算：压缩会把 messages 就地换成压缩结果（前缀前移），
 *    同一个消息的下标当场变小；同一轮里压第二次时按下标算出来的边界就错位，剥不干净的那一段会被
 *    写进检查点 —— 这正是本函数存在的原因。压缩保留下来的消息仍是同一批对象（context/compact.ts
 *    的产物也包含它们），身份不怕重排 / 删减。
 *
 * ⚠️ 边界（有意）：`inFlight` 只包含**循环**推的消息。运行时自己 append 的图片消息因此留在检查点里
 *    —— 这正是必须的：它们的 createdAt 是挂载时刻、早于 `at`，`created_at > at` 取不回来，
 *    剥掉就等于模型此后再也看不到那张图（见 agent/image-attach.ts 顶部）。压缩产物（摘要 / 退化消息）
 *    同理不在集合里，必须留 —— 它们是新的前缀本体。
 *
 * ⚠️ 返回的 `at` 是**这一刻的检查点边界**，调用方必须拿它兜住「回合末才落库的那些消息」：
 *    `at` 与回合末那次写库可以落在**同一毫秒**（Date.now() 只有毫秒精度，stub / 快速失败的一步
 *    都能做到），而尾巴的判据是 `created_at > at` —— 相等就取不回来，于是这一轮的产出在下一轮
 *    整个消失（比重复更坏：模型与用户都不知道）。所以回合末落库的消息要把 createdAt 抬到
 *    `at + 1` 之上（见 agent/runtime.ts 里 assistantMsg 的那一行）。
 */
export function persistCompactedHistory(o: {
  store: CheckpointSink;
  threadId: string;
  /** 压缩结果（要落成检查点的那个数组） */
  compacted: ChatMessage[];
  /** 本轮循环自己推的那些消息（loop/turn.ts 的 inFlight；按对象身份） */
  inFlight: ReadonlySet<ChatMessage>;
  /** 检查点时刻；缺省 = 现在（测试可注入固定值） */
  at?: number;
}): { at: number; kept: number } {
  const at = o.at ?? Date.now();
  const kept = o.compacted.filter((m) => !o.inFlight.has(m));
  o.store.setCompactedHistory(o.threadId, kept, at);
  return { at, kept: kept.length };
}
