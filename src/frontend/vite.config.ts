import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
    plugins: [react()],
    base: "/dashboard/",
    build: {
        outDir: resolve(__dirname, "../../dist/frontend"),
        emptyOutDir: true
    },
    server: {
        proxy: {
            "/dashboard/api": "http://localhost:3000",
            "/dashboard/logout": "http://localhost:3000"
        }
    }
});
