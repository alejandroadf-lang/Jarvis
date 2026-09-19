import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // ws: the live-call endpoint is a WebSocket under the same prefix,
      // and without this the dev server proxies the handshake as plain
      // HTTP and the call never opens.
      '/api': { target: 'http://localhost:3001', ws: true },
    },
  },
});
