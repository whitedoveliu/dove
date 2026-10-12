#!/usr/bin/env node
/**
 * dove 可执行入口
 *
 * 为什么入口是 .mjs 而实现是 .ts：Node 24 起可以直接跑 TS（类型擦除），
 * 所以这里不需要构建步骤 —— 改完源码立刻生效，和内核（packages/server）同一套玩法。
 *
 * 这里只做一件事：把 argv 交给 main。真正的 CLI 在 packages/cli/src/，
 * 它**只走 HTTP**、绝不 import bootstrap —— 起第二份内核会跟用户已经在跑的
 * App 抢端口、抢库、抢记忆。
 */
import { main } from "../packages/cli/src/main.ts";

await main(process.argv.slice(2));
