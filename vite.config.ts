import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

function copyPdfJsCmaps() {
  return {
    name: 'copy-pdfjs-cmaps',
    configResolved(config: { root: string }) {
      const source = path.resolve(config.root, 'node_modules/pdfjs-dist/cmaps');
      const destination = path.resolve(config.root, 'public/pdfjs/cmaps');
      fs.cpSync(source, destination, { recursive: true });
    },
  };
}

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/pdf-editor/' : '/',
  plugins: [copyPdfJsCmaps(), react()],
  optimizeDeps: {
    exclude: ['pdfjs-dist'],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('pdfjs-dist')) return 'pdfjs-runtime';
          if (id.includes('tesseract.js')) return 'ocr-runtime';
          if (id.includes('@cantoo/pdf-lib')) return 'secure-pdf';
          if (id.includes('pdf-lib')) return 'pdf-lib-runtime';
          if (id.includes('@supabase')) return 'supabase-runtime';
          if (id.includes('lucide-react')) return 'icons';
          if (id.includes('/react/') || id.includes('react-dom')) return 'react-runtime';
          return undefined;
        },
      },
    },
  },
});
