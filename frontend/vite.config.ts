import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/** The app icon (icon.png at the repository root) goes into the build: page icon, toolbar, Linux window icon. */
function appIcon(): Plugin {
  const icon = fileURLToPath(new URL('../icon.png', import.meta.url));
  return {
    name: 'app-icon',
    generateBundle() {
      if (existsSync(icon)) this.emitFile({ type: 'asset', fileName: 'icon.png', source: readFileSync(icon) });
      else this.warn('icon.png not found at the repository root: building without the app icon');
    },
  };
}

// Built assets are served by the Python app (mathengine/server.py).
export default defineConfig({
  plugins: [react(), appIcon()],
  base: './',
  // MathLive (~800 kB) is its own chunk, loaded only when an equation is edited.
  build: { outDir: '../mathengine/web', emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 900 },
});
