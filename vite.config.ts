import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
      '@shared': path.resolve(import.meta.dirname, './shared'),
      '@core': path.resolve(import.meta.dirname, './server/core'),
    },
  },
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:4455', changeOrigin: false },
    },
  },
})
