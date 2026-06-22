import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

const host = process.env.TAURI_DEV_HOST;

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  // Use Dart Sass's modern compiler API (the legacy JS API is deprecated).
  css: { preprocessorOptions: { scss: { api: "modern-compiler" } } },
  // Tauri expects a fixed port and ignores vite's auto-port fallback.
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1431 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  // Tauri uses a fixed target; on Android/Windows use the right one.
  build: {
    // Match the actual webview engine: Android + Windows are Chromium (transpiling down to safari13 there
    // just bloats + slows the bundle); macOS/Linux desktop use WebKit. [launch perf]
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105"
      : process.env.TAURI_ENV_PLATFORM === "android" ? "chrome108"
      : "safari13",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
