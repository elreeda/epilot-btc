import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
export default defineConfig({
  root: "web",
  plugins: [react()],
  server: { host: "127.0.0.1", proxy: { "/api": "http://127.0.0.1:3000" } },
  build: { outDir: "dist" },
});
