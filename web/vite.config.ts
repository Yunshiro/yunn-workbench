import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 后端默认监听 3001；开发时把 /api 代理过去，SSE 走同一代理
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
