import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/gbk/",
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        "sheet-cam": "sheet-cam.html",
      },
    },
  },
});
