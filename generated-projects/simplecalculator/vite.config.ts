import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/', // base public path
  build: {
    minify: 'esbuild', // enable minification
    sourcemap: true,
  },
});
