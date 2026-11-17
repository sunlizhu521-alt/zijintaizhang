import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ root: 'rating', publicDir: false, plugins: [react()], base: '/gongyingshangpingji/', build: { outDir: '../dist/gongyingshangpingji', emptyOutDir: true } });
