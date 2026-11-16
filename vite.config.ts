import { fileURLToPath, URL } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'

/**
 * 卡图同源代理 + 缺图回退。
 *
 * 两个卡图 CDN 都不返回 CORS 头，跨域直接把图画进 canvas 会污染画布，
 * 导出 GIF / 卡组长图会失败，所以必须由开发服务器代理成同源地址。
 * momobako 缺新卡 / 先行卡（例如 71599345 决斗者之力），404 时回源到 ygoprodeck。
 *
 * 生产环境是纯静态产物：需要在反向代理上做同样的 404 → ygoprodeck 回退，
 * 或者用 VITE_CARD_IMG_BASE 指向自己的图片代理。
 */
const MOMOBAKO_PICS = 'https://cdn.233.momobako.com/ygopro/pics'
const YGOPRODECK_PICS = 'https://images.ygoprodeck.com/images/cards'

const imageCache = new Map<string, { body: Buffer; type: string }>()

async function fetchCardImage(base: string, path: string) {
  try {
    const response = await fetch(`${base}${path}`)
    if (!response.ok) return null
    const type = response.headers.get('content-type') || ''
    if (!type.startsWith('image/')) return null
    return { body: Buffer.from(await response.arrayBuffer()), type }
  } catch {
    return null
  }
}

function cardImageMiddleware() {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url || '').split('?')[0]
    if (!/^\/\d+\.jpg$/.test(path)) {
      res.statusCode = 404
      res.end()
      return
    }

    const cached = imageCache.get(path)
    if (cached) {
      res.setHeader('content-type', cached.type)
      res.setHeader('cache-control', 'public, max-age=86400')
      res.end(cached.body)
      return
    }

    const hit =
      (await fetchCardImage(MOMOBAKO_PICS, path)) || (await fetchCardImage(YGOPRODECK_PICS, path))
    if (!hit) {
      res.statusCode = 404
      res.end()
      return
    }

    if (imageCache.size > 600) imageCache.clear()
    imageCache.set(path, hit)
    res.setHeader('content-type', hit.type)
    res.setHeader('cache-control', 'public, max-age=86400')
    res.end(hit.body)
  }
}

function cardImagePlugin(): Plugin {
  return {
    name: 'ygo-card-image-proxy',
    configureServer(server) {
      server.middlewares.use('/pics', cardImageMiddleware())
    },
    configurePreviewServer(server) {
      server.middlewares.use('/pics', cardImageMiddleware())
    },
  }
}

export default defineConfig({
  plugins: [vue(), cardImagePlugin()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1200,
  },
})
