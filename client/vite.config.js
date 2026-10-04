import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    // Bind on all interfaces so the app is reachable from a container or a
    // device on the LAN during development.
    host: true,
    proxy: {
      // Proxying keeps the browser on a single origin (localhost:3000), so
      // SameSite=Strict cookies are treated as first-party during development.
      // This is also the shape a production reverse proxy uses.
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        // Cookies are the entire auth mechanism; without this the Set-Cookie
        // headers from the API never reach the browser.
        cookieDomainRewrite: '',
      },
    },
  },
  build: {
    // Split the vendor bundle so a security-payload change does not invalidate
    // the cached framework chunk for returning visitors.
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
          bootstrap: ['bootstrap', 'react-bootstrap'],
        },
      },
    },
    // Surface the real size of what we ship rather than a warning threshold.
    chunkSizeWarningLimit: 600,
    sourcemap: true,
  },
});
