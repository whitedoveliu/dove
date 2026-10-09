/**
 * schema 归一化（T3.3）
 * 内部 schema 本身就是 JSON Schema（types.ts 的 S 助手），这里只做 provider 兼容清洗：
 * 去掉 $schema / $id / $comment / $defs / additionalProperties:false 等 provider 不认或不稳的字段，
 * 递归处理 properties / items / anyOf / oneOf / allOf，内联 $ref，并保证顶层是 object。
 * 只产出纯数据（可安全 JSON.stringify），不改工具自身定义。
 */
import type { Tool, ToolSchema } from "../providers/types.ts";

/** provider 普遍不接受或语义不稳的关键字 */
const DROP_KEYS = new Set([
  "$schema", "$id", "$comment", "$defs", "definitions", "$anchor", "$dynamicRef",
  "unevaluatedProperties", "patternProperties", "contentMediaType", "contentEncoding",
  "examples", "deprecated", "readOnly", "writeOnly", "$vocabulary",
]);

const MAX_DEPTH = 8;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function resolveRef(ref: unknown, defs: Record<string, unknown>): unknown {
  if (typeof ref !== "string") return undefined;
  const m = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref);
  if (!m) return undefined;
  const key = m[1].replace(/~1/g, "/").replace(/~0/g, "~");
  return defs[key];
}

/** 归一化任意 schema 片段 */
export function normalizeSchema(input: unknown, depth = 0): Record<string, unknown> {
  if (depth > MAX_DEPTH) return { type: "object", properties: {} };
  if (!isPlainObject(input)) return { type: "object", properties: {} };

  const defs: Record<string, unknown> = {
    ...(isPlainObject(input.$defs) ? input.$defs : {}),
    ...(isPlainObject(input.definitions) ? input.definitions : {}),
  };

  // $ref：能解析就直接展开（provider 对 #/$defs 支持参差）
  if (typeof input.$ref === "string") {
    const target = resolveRef(input.$ref, defs);
    if (target !== undefined) {
      const inlined = normalizeSchema(target, depth + 1);
      if (typeof input.description === "string" && !inlined.description) inlined.description = input.description;
      return inlined;
    }
    // 解不开的引用：放宽为任意值，别把参数卡死
    return typeof input.description === "string" ? { description: input.description } : {};
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (DROP_KEYS.has(k) || v === undefined) continue;
    if (k === "additionalProperties") {
      // 只删 false（部分 provider 会因此拒绝或强制 strict）；true / 子 schema 保留
      if (v === false) continue;
      out[k] = isPlainObject(v) ? normalizeSchema(v, depth + 1) : v;
      continue;
    }
    if (k === "properties") {
      const props: Record<string, unknown> = {};
      if (isPlainObject(v)) for (const [pk, pv] of Object.entries(v)) props[pk] = normalizeSchema(pv, depth + 1);
      out.properties = props;
      continue;
    }
    if (k === "items") {
      out.items = Array.isArray(v) ? v.map((it) => normalizeSchema(it, depth + 1)) : normalizeSchema(v, depth + 1);
      continue;
    }
    if (k === "anyOf" || k === "oneOf" || k === "allOf") {
      out[k] = Array.isArray(v) ? v.map((it) => normalizeSchema(it, depth + 1)) : [];
      continue;
    }
    if (k === "required") {
      if (Array.isArray(v) && v.length > 0) out.required = v.filter((x) => typeof x === "string");
      continue;
    }
    if (Array.isArray(v)) { out[k] = v.map((x) => (isPlainObject(x) ? normalizeSchema(x, depth + 1) : x)); continue; }
    out[k] = isPlainObject(v) ? normalizeSchema(v, depth + 1) : v;
  }

  // 有 properties 但没 type → 补 object；required 必须是 properties 的子集（严格 provider 会报错）
  if (out.properties && !out.type) out.type = "object";
  if (Array.isArray(out.required)) {
    const keys = isPlainObject(out.properties) ? new Set(Object.keys(out.properties)) : new Set<string>();
    const req = (out.required as string[]).filter((k) => keys.has(k));
    if (req.length > 0) out.required = req; else delete out.required;
  }
  return out;
}

/** 归一化工具入参：顶层必须是 object + properties */
export function normalizeParameters(schema: unknown): Record<string, unknown> {
  const out = normalizeSchema(schema);
  if (out.type !== "object" || !isPlainObject(out.properties)) {
    return { type: "object", properties: isPlainObject(out.properties) ? out.properties : {} };
  }
  return out;
}

/** 工具 → wire schema（顺序由调用方决定，本函数不排序） */
export function normalizeToolSchema(tool: Tool): ToolSchema {
  return {
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: normalizeParameters(tool.parameters) },
  };
}
