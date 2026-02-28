import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
    plugins: [react()],
    root: resolve(__dirname, "src/frontend"),
    base: "/dashboard/",
    build: {
        outDir: resolve(__dirname, "dist/public"),
        emptyOutDir: true
    },
    server: {
        port: 5173,
        proxy: {
            "/dashboard/api": "http://localhost:3000",
            "/dashboard/events": "http://localhost:3000",
            "/dashboard/logout": "http://localhost:3000"
        }
    }
});
