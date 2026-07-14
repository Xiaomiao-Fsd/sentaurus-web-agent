import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "::",
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://10.6.22.1:5175",
        changeOrigin: false
      }
    }
  },
  preview: {
    host: "::",
    port: 4174,
    strictPort: true
  }
});