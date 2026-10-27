import { GIFEncoder, applyPalette, quantize } from 'gifenc'
import { drawBoardFrame, layoutBoard, type BoardFramePaint } from './boardCanvas'
import type { ZoneId } from '@/types'

export interface GifExportOptions {
  /** 输出宽度（高度按布局自动算） */
  width?: number
  /** 每帧停留毫秒 */
  holdMs?: number
  onProgress?: (percent: number) => void
  shouldCancel?: () => boolean
  /** 卡名 → 同源卡图地址；返回 null 表示这张卡没有卡图 */
  imageUrlOf?: (name: string) => string | null
}

const ZONES: ZoneId[] = ['hand', 'field', 'st', 'gy', 'banish', 'extra', 'deck']
const PRELOAD_CONCURRENCY = 6

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    const timer = window.setTimeout(() => resolve(null), 5000)
    image.onload = () => {
      window.clearTimeout(timer)
      resolve(image)
    }
    image.onerror = () => {
      window.clearTimeout(timer)
      resolve(null)
    }
    image.src = url
  })
}

/** 收集所有帧里出现过的卡名 */
function collectNames(frames: BoardFramePaint[]): string[] {
  const names = new Set<string>()
  for (const frame of frames) {
    for (const zone of ZONES) {
      for (const card of frame.snapshot[zone] || []) {
        if (card.name) names.add(card.name)
      }
    }
  }
  return [...names]
}

/** 并发预加载卡图，失败的卡后面会退回文字卡牌 */
async function preloadImages(
  names: string[],
  urlOf: (name: string) => string | null,
  onTick: () => void,
  shouldCancel: () => boolean,
): Promise<Map<string, HTMLImageElement>> {
  const map = new Map<string, HTMLImageElement>()
  let cursor = 0

  const worker = async () => {
    for (;;) {
      if (shouldCancel()) return
      const index = cursor
      cursor += 1
      if (index >= names.length) return
      const name = names[index]
      const url = urlOf(name)
      if (url) {
        const image = await loadImage(url)
        if (image) map.set(name, image)
      }
      onTick()
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(PRELOAD_CONCURRENCY, names.length) }, () => worker()),
  )
  return map
}

/**
 * 把逐帧场面渲染成 GIF。
 * 卡图从同源地址读取（dev / preview 由 vite 代理，生产用 VITE_CARD_IMG_BASE），
 * 取不到就退回文字卡牌。
 */
export async function renderBoardGif(
  frames: BoardFramePaint[],
  options: GifExportOptions = {},
): Promise<Blob | null> {
  if (!frames.length) return null

  const width = options.width ?? 480
  const holdMs = Math.max(100, options.holdMs ?? 800)
  const layout = layoutBoard(width)
  const shouldCancel = options.shouldCancel || (() => false)

  const canvas = document.createElement('canvas')
  canvas.width = layout.width
  canvas.height = layout.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('当前浏览器不支持 canvas，无法导出')

  // 1. 预加载卡图
  let images = new Map<string, HTMLImageElement>()
  if (options.imageUrlOf) {
    const names = collectNames(frames)
    let loaded = 0
    images = await preloadImages(
      names,
      options.imageUrlOf,
      () => {
        loaded += 1
        options.onProgress?.(Math.round((loaded / Math.max(1, names.length)) * 30))
      },
      shouldCancel,
    )
    if (shouldCancel()) return null
  }

  // 2. 逐帧编码
  const gif = GIFEncoder()
  for (let i = 0; i < frames.length; i += 1) {
    if (shouldCancel()) return null
    drawBoardFrame(
      ctx,
      {
        ...frames[i],
        imageOf: (name) => images.get(name) || null,
      },
      width,
    )
    const { data } = ctx.getImageData(0, 0, layout.width, layout.height)
    const palette = quantize(data, 256, { format: 'rgba4444' })
    const index = applyPalette(data, palette, 'rgba4444')
    gif.writeFrame(index, layout.width, layout.height, { palette, delay: holdMs })
    options.onProgress?.(30 + Math.round(((i + 1) / (frames.length + 1)) * 70))
    // 让出主线程，保证进度条能刷新
    await new Promise((resolve) => window.setTimeout(resolve, 0))
  }

  if (shouldCancel()) return null
  gif.finish()
  options.onProgress?.(100)
  const bytes = gif.bytes()
  return new Blob([bytes.buffer as ArrayBuffer], { type: 'image/gif' })
}

/** 触发浏览器下载 */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 2000)
}
