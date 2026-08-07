import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  plugins: [vue()],
  test: {
    globals: true,
    environment: 'jsdom',
    // include source files
    includeSource: ['src/**/*.vue'],
  },
});
