/**
 * 有序 hook 注册表（横切特性的唯一挂载点）
 *
 * 为什么要有：以前来一个横切特性（审批策略 / 审计 / 脱敏 / 成本闸 / 记忆回写…）就得**改循环** ——
 * 在 loop/turn.ts 里插一行、在 loop/gates.ts 里排一个优先级。于是循环里长出一张写死的优先级表，
 * 谁先谁后是内核定的，新能力只能靠改内核插队。对照：Kimi Code 是一个有序 emitter（监听者可以
 * veto / allow / pass(meta) / waitUntil），Codex 有 12 个 hook 事件，Claude Code 有 ~30 个 ——
 * 它们的新特性是**注册**进去的，不是改循环。这里要的就是那个机制。
 *
 * ## 顺序是契约
 * 执行顺序 = 注册顺序，再用 `before` / `after` 提示微调（只认**同一个事件**里已经注册的 id；
 * 目标 id 不存在时退化为「按注册顺序插入」，不抛错 —— 被引用的钩子可能压根没装）。
 * 顺序会出现在 list() 与测试断言里，**不要**依赖「碰巧的注册时机」：要确定位置就写 before/after。
 *
 * ## 四个结果
 * - `pass`：继续；可携带 meta 给后面的监听者（后写覆盖前写，但 trail 里留痕：谁写了哪些键）。
 * - `veto`：否决，**短路** —— 后面的监听者（含已排队的 waitUntil）一律不再跑，原因原样带出。
 * - `allow`：正向短路 —— 有人明确放行就不必再问下去。「记住本次授权」正该这么用：
 *   一个同步监听者回 allow，排在后面的审批弹窗就不会弹。
 * - `waitUntil(factory)`：**延后到所有同步监听者都跑完**再求值。
 *   为什么必须有这个形态：弹审批窗要 await（可能等用户几分钟），而**同步监听者不该被它卡住** ——
 *   排在审批钩子后面的注册者仍然要立刻跑，否则「谁先谁后」就变成「谁快谁先」，顺序契约作废。
 *   ⚠️ 因此监听者函数**必须是同步的**：返回 Promise 直接抛错 —— 异步是 waitUntil 的活，
 *   不是让 registry 挨个 await 每个监听者。factory 的返回值按同样的语义处理（可以 veto / allow），
 *   多个 waitUntil 之间按注册顺序求值。嵌套 waitUntil 不支持（当成「没有意见」）。
 *
 * ## 纪律
 * - 同一个事件里 id 重复 → 直接抛错（两个同名监听者互相覆盖是最难查的一种 bug）。
 * - 跨事件用同一个 id 是允许的（一个钩子同时听 turnStart + turnEnd 很正常）。
 * - **没有全局单例**：createHookRegistry() 造独立实例，测试互不打扰。
 * - 监听者抛错一律往上冒（不吞）：钩子是基础设施，坏了要让调用方在日志里看见栈。
 */

export type HookEvent =
  | "turnStart" | "beforeStep" | "beforeToolExecute" | "afterToolExecute" | "stepEnd" | "turnEnd";

export type HookMeta = Record<string, unknown>;

export type HookResult =
  | { kind: "pass"; meta?: HookMeta }
  | { kind: "veto"; reason: string }
  | { kind: "allow"; meta?: HookMeta }
  | { kind: "waitUntil"; factory: () => Promise<HookResult | void> };

/** 交给监听者的 payload：调用方给的字段 + event + 到目前为止累积的 meta（只读副本） */
export interface HookPayload extends HookMeta {
  event: HookEvent;
  meta: HookMeta;
}

export type HookFn = (payload: HookPayload) => HookResult | void;

/** 一条执行痕迹：谁（id）做了什么（kind）、写了哪些 meta 键 —— 合并后覆盖了谁一目了然 */
export interface HookTrace { id: string; kind: "pass" | "allow" | "veto" | "waitUntil"; keys: string[] }

export interface FireResult {
  /** 被否决时的原因（短路，后面的监听者没跑） */
  vetoed?: string;
  /** 是否有人回 allow（正向短路） */
  allowed?: boolean;
  /** 合并后的元数据（后写覆盖前写） */
  meta: HookMeta;
  /** 留痕：按执行顺序记下每个监听者做了什么 */
  trail: HookTrace[];
}

export interface RegisterOpts {
  id?: string;
  /** 插到这个 id 之前（同事件内） */
  before?: string;
  /** 插到这个 id 之后（同事件内） */
  after?: string;
}

export interface HookRegistry {
  /** 注册一个监听者；返回注销函数（重复调用是 no-op） */
  register(event: HookEvent, fn: HookFn, opts?: RegisterOpts): () => void;
  fire(event: HookEvent, payload?: HookMeta): Promise<FireResult>;
  /** 已注册的 id，顺序即执行顺序（诊断 / 测试用） */
  list(event: HookEvent): string[];
}

interface Entry { id: string; fn: HookFn }

/** 是不是 PromiseLike（用来把「异步监听者」这种误用当场抓住） */
function isThenable(v: unknown): boolean {
  return typeof (v as { then?: unknown } | null | undefined)?.then === "function";
}

export function createHookRegistry(): HookRegistry {
  const table = new Map<HookEvent, Entry[]>();
  let auto = 0;

  function bucket(event: HookEvent): Entry[] {
    let b = table.get(event);
    if (!b) { b = []; table.set(event, b); }
    return b;
  }

  function register(event: HookEvent, fn: HookFn, opts: RegisterOpts = {}): () => void {
    const list = bucket(event);
    const id = opts.id ?? `${event}#${++auto}`;
    if (list.some((e) => e.id === id)) {
      throw new Error(`hook id 重复："${id}"（事件 ${event}）—— 同一个 id 只能注册一次，否则两个监听者会互相覆盖`);
    }
    // 插入位置：注册顺序是默认值，after 往后、before 往前的提示只做「不超过」的取小，
    // 于是 before/after 都写着时以 before 为准（更靠前的那条约束赢），不会自相矛盾地前后跳。
    let at = list.length;
    if (opts.after) {
      const i = list.map((e) => e.id).lastIndexOf(opts.after);
      if (i >= 0) at = i + 1;
    }
    if (opts.before) {
      const i = list.findIndex((e) => e.id === opts.before);
      if (i >= 0) at = Math.min(at, i);
    }
    list.splice(at, 0, { id, fn });

    let live = true;
    return () => {
      if (!live) return;
      live = false;
      const arr = bucket(event);
      const i = arr.findIndex((e) => e.id === id);
      if (i >= 0) arr.splice(i, 1);
    };
  }

  async function fire(event: HookEvent, payload: HookMeta = {}): Promise<FireResult> {
    const meta: HookMeta = {};
    const trail: HookTrace[] = [];
    const deferred: { id: string; factory: () => Promise<HookResult | void> }[] = [];
    let vetoed: string | undefined;
    let allowed: boolean | undefined;

    /** 把一条结果并进累积状态；返回 true 表示「到此为止」（短路） */
    const absorb = (id: string, r: HookResult | void): boolean => {
      if (!r || r.kind === "pass") {
        if (r?.meta) { Object.assign(meta, r.meta); trail.push({ id, kind: "pass", keys: Object.keys(r.meta) }); }
        return false;
      }
      if (r.kind === "veto") { vetoed = r.reason; trail.push({ id, kind: "veto", keys: [] }); return true; }
      if (r.kind === "allow") {
        if (r.meta) Object.assign(meta, r.meta);
        allowed = true;
        trail.push({ id, kind: "allow", keys: r.meta ? Object.keys(r.meta) : [] });
        return true;
      }
      // waitUntil：只排队，**不 await** —— 同步监听者必须全部跑完才轮到它（见文件头）
      deferred.push({ id, factory: r.factory });
      trail.push({ id, kind: "waitUntil", keys: [] });
      return false;
    };

    // ① 同步段：一次跑完，中途 veto / allow 立刻短路（连已排队的 waitUntil 也一并丢掉：
    //    结论已经有了，再去弹窗问人只是打扰）
    const snapshot = [...(table.get(event) ?? [])];
    for (const e of snapshot) {
      const r = e.fn({ ...payload, event, meta: { ...meta } });
      if (isThenable(r)) {
        throw new TypeError(`hook "${e.id}" 返回了 Promise：监听者必须是同步函数，异步工作请用 { kind: "waitUntil", factory }`);
      }
      if (absorb(e.id, r as HookResult | void)) return { vetoed, allowed, meta, trail };
    }

    // ② 延后段：到这里所有同步监听者都跑完了，再按注册顺序求值
    for (const d of deferred) {
      const r = await d.factory();
      // 嵌套 waitUntil 不支持：再排队就等于「后面还有人能推翻前面的结论」，语义不成立
      if (r && r.kind === "waitUntil") continue;
      if (absorb(d.id, r)) break;
    }
    return { vetoed, allowed, meta, trail };
  }

  return {
    register,
    fire,
    list: (event) => (table.get(event) ?? []).map((e) => e.id),
  };
}
