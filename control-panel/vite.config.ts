import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  server: {
    port: 3006,
    // 钉死端口：这个端口是开发态的固定入口（scripts/dove.sh 与 README 都按它找面板），
    // 静默挪走会让人对着 3006 的白屏查半天。
    strictPort: true,
    host: "0.0.0.0",
    // 开发态取本地令牌：**同源**（vite）→ 内核，浏览器根本不查 CORS ——
    // 所以内核的白名单里不需要放 3006（3000–3099 是**项目 dev server** 的分配区间，
    // 放进去等于给某个项目页面发令牌。见 harness/packages/server/src/panel-origin.ts）。
    // 内核换了端口（DOVE_PORT）时这条目标要跟着改 —— TOKEN_PATHS 的兜底地址同理。
    proxy: {
      "/api/local-token": "http://127.0.0.1:8790",
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
