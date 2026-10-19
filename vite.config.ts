import { defineConfig } from 'vite'

export default defineConfig({
  build: { target: 'es2022' },
  optimizeDeps: {
    exclude: ['@tanstack/browser-db-sqlite-persistence', '@journeyapps/wa-sqlite'],
    esbuildOptions: { target: 'es2022' },
  },
})
