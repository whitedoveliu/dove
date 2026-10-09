import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// 开发端口 5273；/api 全部代理到本地内核 8790（生产由内核静态托管 dist/）
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  server: {
    port: 5273,
    strictPort: true,
    proxy: {
      // http-proxy 默认流式透传，SSE 不会被缓冲
      "/api": {
        target: "http://127.0.0.1:8790",
        changeOrigin: true,
      },
    },
  },
  preview: { port: 5273 },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1200 },
});
