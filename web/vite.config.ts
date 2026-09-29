import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  server: {
    proxy: { '/admin/api/v1': { target: process.env.ADMIN_API_TARGET || 'http://127.0.0.1:15006', changeOrigin: true, configure(proxy) { proxy.on('proxyReq', (request) => request.setHeader('origin', process.env.ADMIN_PUBLIC_ORIGIN || process.env.ADMIN_API_TARGET || 'http://127.0.0.1:15006')); } } },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
