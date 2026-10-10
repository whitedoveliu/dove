/**
 * 图片挂载中继（ReadImage → 对话）
 *
 * 为什么需要它：OpenAI 兼容协议里 role:"tool" 的 content **只能是字符串**，
 * 图片塞不进工具结果。本仓库既有的图片通道是**消息 parts 的 "image" 类型**：
 * 引用（文件路径）落在 parts 里，装配时才重水化成 data URL（context/images.ts）。
 *
 * 于是 ReadImage 的图片这样走：
 *   ① 立即把 image part 作为**下一条 user 消息**排进本轮的对话（takePending），
 *      运行时的 onBeforeStep 会把它追加到 live 消息数组 → **下一步模型就能看到**；
 *   ② 回合结束时 flush() 把同一条消息落库（store.addMessage），
 *      之后的每一轮由 toWireHistory / convertMessages 重新水化。
 *
 * 为什么落库放在回合末而不是立即：消息按 createdAt 排序装配。立即写会得到
 *   [user(图)] [assistant(tool_calls ReadImage)] [tool(结果)]
 * ——图片出现在「要求读图」之前，模型读自己的历史会莫名其妙。
 * 回合末写才是正确的
 *   [assistant(tool_calls ReadImage)] [tool(结果)] [user(图)]。
 * 代价：回合中途崩溃时图片不落库（那一轮本来也没跑完）。
 *
 * 配对纪律不受影响：图片消息是独立的 user 消息，assistant.tool_calls 与
 * role:"tool" 的结果仍然一一配对。
 */
import { randomUUID } from "node:crypto";
import type { ChatMessage } from "../providers/types.ts";
import type { Message, Part } from "../session/types.ts";
import type { Store } from "../session/store.ts";
import type { ImageAttachRequest, ImageAttachResult } from "../tools/types.ts";
import { hydrateImages } from "../context/images.ts";
import { IMAGE_MAX_PER_TURN } from "../constants.ts";

export interface ImageRelayOptions {
  store: Store;
  threadId: string;
  model: string;
  /** 模型不支持图片输入时直接拒绝（别让模型以为图挂上了） */
  supportsImages: boolean;
}

export class ImageRelay {
  #store: Store;
  #threadId: string;
  #model: string;
  #supportsImages: boolean;
  #live: ChatMessage[] = [];
  #toStore: Message[] = [];
  #count = 0;

  constructor(opts: ImageRelayOptions) {
    this.#store = opts.store;
    this.#threadId = opts.threadId;
    this.#model = opts.model;
    this.#supportsImages = opts.supportsImages;
  }

  /** 本轮挂了几张 */
  get attachedCount(): number { return this.#count; }
  /** 还在等注入的条数（诊断用） */
  get pendingCount(): number { return this.#live.length; }

  /** 挂一张图：校验 + 读成 data URL + 排进本轮的待注入队列 */
  async attach(req: ImageAttachRequest): Promise<ImageAttachResult> {
    if (!this.#supportsImages) {
      return {
        ok: false,
        error: "MODEL_NO_VISION：当前模型 " + this.#model + " 不支持图片输入",
        note: "换一个支持图片的模型，或改用 OCR / 让用户描述画面。",
      };
    }
    if (this.#count >= IMAGE_MAX_PER_TURN) {
      return {
        ok: false,
        error: "本轮已经挂满 " + IMAGE_MAX_PER_TURN + " 张图",
        note: "先就着已经挂上的图回答，需要更多图就在下一轮再读。",
      };
    }
    // 立刻读并水化：文件读不到 / 超限在这里就变成结构化错误，而不是静默丢一张图
    const h = hydrateImages([req.path], { supportsImages: true });
    if (h.blocks.length === 0) {
      return { ok: false, error: h.notes.join(" ").trim() || "图片读不出来（未知原因）" };
    }
    const caption = "（ReadImage 挂上的图片：" + (req.filename ?? req.path) + "）";
    const parts: Part[] = [
      { type: "text", text: caption, state: "output-available" },
      { type: "image", mediaType: req.mediaType, url: req.path, filename: req.filename, state: "output-available" },
    ];
    const id = this.#threadId + "--img-" + randomUUID().slice(0, 8);
    // ① 本轮立刻可见（下一步生效）
    this.#live.push({ role: "user", content: [{ type: "text", text: caption }, ...h.blocks] });
    // ② 回合末落库（引用路径，不落 base64）
    this.#toStore.push({ id, threadId: this.#threadId, role: "user", parts, createdAt: Date.now() });
    this.#count++;
    return { ok: true, id, note: h.notes.join(" ").trim() || undefined };
  }

  /** 取出还没注入的图片消息（运行时在每个 step 开始时调用；取走即清空） */
  takePending(): ChatMessage[] {
    if (this.#live.length === 0) return [];
    const out = this.#live;
    this.#live = [];
    return out;
  }

  /** 回合末落库；返回写入条数。落库失败不影响本轮的对话（图已经在上下文里了） */
  flush(): number {
    let n = 0;
    for (const m of this.#toStore) {
      try { this.#store.addMessage(m); n++; } catch { /* 落库失败不能影响主流程 */ }
    }
    this.#toStore = [];
    return n;
  }
}
