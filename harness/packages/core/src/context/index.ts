/**
 * 上下文装配模块统一出口（M2）
 * 分层：context 只依赖 session / providers 与 constants，绝不反向 import 上层。
 */
export * from "./segments.ts";
export * from "./assemble.ts";
export * from "./tail-context.ts";
export * from "./memories-block.ts";
export * from "./tokens.ts";
export * from "./convert.ts";
export * from "./compact.ts";
export * from "./compact-prompt.ts";
export * from "./instructions.ts";   // 项目指令（AGENTS.md）：发现规则在那边，接线在 agent/assemble-adapter.ts
