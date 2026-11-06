import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // Lets "npm run dev" reach a server started with "npm run server".
    proxy: { '/ws': { target: 'ws://localhost:3000', ws: true } },
  },
});
