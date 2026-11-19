import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// 개발 중에는 Vite가 화면을, 백엔드(기본 8000번)가 API를 맡는다.
// 배포본은 `npm run build` 결과물을 백엔드가 직접 서빙하므로 이 프록시가 필요 없다.
const backend = `http://127.0.0.1:${process.env.ALEPH_BACKEND_PORT ?? "8000"}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // 폰트 조각이 작다고 CSS 안에 base64로 박아 넣지 않는다 (CSS가 불어나고 조각 받기의 뜻이 없어진다).
  build: { assetsInlineLimit: 0 },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: { "/api": { target: backend, changeOrigin: false } },
  },
});
