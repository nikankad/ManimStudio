import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Built assets are served by the Python app (mathengine/server.py).
export default defineConfig({
  plugins: [react()],
  base: './',
  // MathLive (~800 kB) is its own chunk, loaded only when an equation is edited.
  build: { outDir: '../mathengine/web', emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 900 },
});
