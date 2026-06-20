import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5177,
    proxy: {
      "/api/nav": {
        target: "https://api.mfapi.in",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/nav/, "/mf"),
      },
    },
  },
});
