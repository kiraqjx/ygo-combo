import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
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

/**
 * 决斗资源（Lua 脚本 + 卡数据）由 `npm run assets:duel` 生成到仓库根的 duel-assets/，
 * 不进 dist：开发 / preview 由这个中间件直接读盘，生产环境用 VITE_DUEL_ASSET_BASE 指到 CDN。
 */
const DUEL_ASSET_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), 'duel-assets')
const DUEL_ASSET_TYPES: Record<string, string> = {
  '.lua': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
}

function duelAssetMiddleware() {
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const path = (req.url || '').split('?')[0]
    if (!path.startsWith('/duel-assets/')) {
      next()
      return
    }
    const rel = normalize(decodeURIComponent(path.slice('/duel-assets/'.length)))
    if (!rel || rel.startsWith('..') || rel.includes('/../')) {
      res.statusCode = 403
      res.end()
      return
    }
    try {
      const body = await readFile(join(DUEL_ASSET_ROOT, rel))
      const ext = extname(rel)
      // 带 ?v= 的请求由 manifest 版本号决定 URL，可以长缓存；不带版本的必须每次校验
      const versioned = (req.url || '').includes('?')
      res.setHeader('content-type', DUEL_ASSET_TYPES[ext] || 'application/octet-stream')
      res.setHeader(
        'cache-control',
        versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=86400, must-revalidate',
      )
      res.end(body)
    } catch {
      res.statusCode = 404
      res.end()
    }
  }
}

function duelAssetPlugin(): Plugin {
  return {
    name: 'ygo-duel-assets',
    configureServer(server) {
      server.middlewares.use(duelAssetMiddleware())
    },
    configurePreviewServer(server) {
      server.middlewares.use(duelAssetMiddleware())
    },
  }
}

/**
 * 模型接口反代。
 *
 * 浏览器直连 api.deepseek.com 没有 CORS 头，密钥也不该裸露在跨域请求里，
 * 所以统一走同源 `/api/llm`（OpenAI 兼容协议）与 `/api/anthropic`
 * （Anthropic Messages 协议），由这里转发。生产部署需要在反向代理上配同样的
 * location（见 README 的部署说明）。
 *
 * 目标地址可以用 VITE_LLM_PROXY_TARGET / VITE_ANTHROPIC_PROXY_TARGET 覆盖。
 */
const LLM_PROXY_TARGET = process.env.VITE_LLM_PROXY_TARGET || 'https://api.deepseek.com'
const ANTHROPIC_PROXY_TARGET =
  process.env.VITE_ANTHROPIC_PROXY_TARGET || 'https://api.anthropic.com'

const llmProxy = {
  '/api/llm': {
    target: LLM_PROXY_TARGET,
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api\/llm/, ''),
  },
  '/api/anthropic': {
    target: ANTHROPIC_PROXY_TARGET,
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api\/anthropic/, ''),
  },
}

export default defineConfig({
  plugins: [vue(), cardImagePlugin(), duelAssetPlugin()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: llmProxy,
  },
  preview: {
    proxy: llmProxy,
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1200,
  },
})
