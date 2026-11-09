import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { darkTheme } from './src/build/dark-theme';
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  css: { postcss: { plugins: [darkTheme()] } },
  build: { outDir: 'dist/client' },
  server: {
    strictPort: true,
    host: '127.0.0.1',
    // Follow the API server's PORT from .env (default 4310).
    proxy: {
      '/api': `http://127.0.0.1:${loadEnv(mode, process.cwd(), '').PORT || 4310}`,
    },
  },
}));
