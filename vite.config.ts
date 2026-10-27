import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type ProxyOptions } from 'vite'
import vue from '@vitejs/plugin-vue'

/**
 * 卡图同源代理：卡图 CDN 不返回 CORS 头，直接用会把 canvas 画脏，
 * 导出 GIF 就取不到像素。代理成 /pics/xxx.jpg 后与页面同源，canvas 可读。
 */
const cardImageProxy: Record<string, ProxyOptions> = {
  '/pics': {
    target: 'https://cdn.233.momobako.com',
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/pics/, '/ygopro/pics'),
  },
}

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: cardImageProxy,
  },
  preview: {
    proxy: cardImageProxy,
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1200,
  },
})
