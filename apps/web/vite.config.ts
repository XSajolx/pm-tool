import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // "/" locally; the Pages workflow sets VITE_BASE_PATH=/pm-tool/ so assets and
  // the router both resolve under the project sub-path.
  base: process.env.VITE_BASE_PATH || "/",
  server: {
    port: 5173,
  },
});
