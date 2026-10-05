import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base: './' so the same build works inside Electron (file://) and on GitHub Pages (/triage-demo/).
export default defineConfig({ plugins: [react()], base: './', build: { outDir: 'dist', chunkSizeWarningLimit: 1500 } });
