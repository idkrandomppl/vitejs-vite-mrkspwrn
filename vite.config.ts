import { defineConfig } from 'vite';

export default defineConfig({
  base: '/vitejs-vite-mrkspwrn/',
  optimizeDeps: {
    exclude: ['@huggingface/transformers'],
  },
  assetsInclude: ['**/*.wasm'],
});
