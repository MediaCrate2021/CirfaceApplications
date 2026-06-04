import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@cirface/core': path.resolve(__dirname, '../../packages/core/src'),
    },
  },
  server: {
    port: 5174,
    proxy: {
      '/api':   'http://localhost:3001',
      '/auth':  'http://localhost:3001',
      '/logo':  'http://localhost:3001',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
