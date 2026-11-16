/**
 * 卡组一图流：把整套卡组画成一张竖版长图。
 *
 * 卡图必须走同源地址（`cardImageProxyUrl`，dev / preview 由 vite 代理），
 * 卡图 CDN 不返回 CORS 头，跨域画进 canvas 会污染画布，`toBlob` 直接抛错。
 * 取不到卡图（momobako 缺新卡、自定义卡）时画一个带卡名的占位块，保证图是完整的。
 */
import { cardImageProxyUrl } from './cardDb'
import type { DeckEntry } from '@/types'

export interface PosterDeck {
  name: string
  main: DeckEntry[]
  extra: DeckEntry[]
  side: DeckEntry[]
}

export interface PosterOptions {
  /** 输出倍率，默认 1.5（逻辑宽 1180 → 约 1770px，比卡图原图还大，不糊） */
  scale?: number
  /** 进度回调，0~100 */
  onProgress?: (percent: number) => void
}

interface Slot {
  id: number
  name: string
}

interface Block {
  label: string
  accent: string
  slots: Slot[]
  rows: number
  height: number
}

const FONT = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif'
const MONO = '"SF Mono", "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace'

const W = 1660
const PAD = 56
/** 一行 10 张，40 张主卡只占 4 行，整图不会又细又长 */
const COLS = 10
const GAP = 12
const CARD_W = Math.floor((W - PAD * 2 - GAP * (COLS - 1)) / COLS)
const CARD_H = Math.round(CARD_W * 1.458)
const HEADER_H = 214
const SECTION_TITLE_H = 76
const SECTION_GAP = 30
/** 最后一行卡片与页脚之间留白 */
const CONTENT_BOTTOM_GAP = 44
const FOOTER_H = 128
const PRELOAD_CONCURRENCY = 6

/** 展开成一张张卡（同名 3 张就占 3 格），和实体卡组摆出来的样子一致 */
function expandSlots(entries: DeckEntry[]): Slot[] {
  const out: Slot[] = []
  for (const entry of entries) {
    const copies = Math.max(0, Math.floor(entry.count))
    for (let i = 0; i < copies; i += 1) out.push({ id: entry.id, name: entry.name })
  }
  return out
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

function loadImage(url: string, timeout = 4000): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    const timer = window.setTimeout(() => resolve(null), timeout)
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

/** 按卡号去重后并发预加载卡图 */
async function preloadCardImages(
  ids: number[],
  onProgress: (percent: number) => void,
): Promise<Map<number, HTMLImageElement>> {
  const unique = [...new Set(ids)]
  const images = new Map<number, HTMLImageElement>()
  if (!unique.length) return images

  let cursor = 0
  let done = 0
  const worker = async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= unique.length) return
      const id = unique[index]
      const image = await loadImage(cardImageProxyUrl(id))
      if (image) images.set(id, image)
      done += 1
      onProgress(Math.round((done / unique.length) * 62))
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(PRELOAD_CONCURRENCY, unique.length) }, () => worker()),
  )
  return images
}

/** 卡名太长时按宽度截断加省略号 */
function fitName(ctx: CanvasRenderingContext2D, name: string, maxWidth: number, start: number): number {
  let size = start
  for (; size >= 22; size -= 2) {
    ctx.font = `700 ${size}px ${FONT}`
    if (ctx.measureText(name).width <= maxWidth) return size
  }
  return 22
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text
  let out = text
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) out = out.slice(0, -1)
  return `${out}…`
}

/** 手动画字间距（canvas 的 letterSpacing 兼容性不够稳） */
function drawSpaced(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, spacing: number) {
  let cursor = x
  for (const char of text) {
    ctx.fillText(char, cursor, y)
    cursor += ctx.measureText(char).width + spacing
  }
}

function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace('#', '')
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value
  const num = Number.parseInt(full, 16)
  const r = (num >> 16) & 255
  const g = (num >> 8) & 255
  const b = num & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function measureSpaced(ctx: CanvasRenderingContext2D, text: string, spacing: number): number {
  let width = 0
  for (const char of text) width += ctx.measureText(char).width + spacing
  return width - (text ? spacing : 0)
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const char of text) {
    const next = line + char
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line)
      line = char
    } else {
      line = next
    }
  }
  if (line) lines.push(line)
  return lines.slice(0, 4)
}

function drawBackdrop(ctx: CanvasRenderingContext2D, width: number, height: number) {
  const bg = ctx.createLinearGradient(0, 0, width * 0.45, height)
  bg.addColorStop(0, '#070a11')
  bg.addColorStop(0.45, '#0c131f')
  bg.addColorStop(1, '#080b12')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, width, height)

  const cool = ctx.createRadialGradient(width * 0.12, 40, 0, width * 0.12, 40, width * 0.95)
  cool.addColorStop(0, 'rgba(86, 190, 255, 0.20)')
  cool.addColorStop(0.5, 'rgba(86, 190, 255, 0.05)')
  cool.addColorStop(1, 'rgba(86, 190, 255, 0)')
  ctx.fillStyle = cool
  ctx.fillRect(0, 0, width, height)

  const violet = ctx.createRadialGradient(width * 0.92, height * 0.72, 0, width * 0.92, height * 0.72, width * 0.85)
  violet.addColorStop(0, 'rgba(150, 110, 255, 0.18)')
  violet.addColorStop(0.55, 'rgba(150, 110, 255, 0.04)')
  violet.addColorStop(1, 'rgba(150, 110, 255, 0)')
  ctx.fillStyle = violet
  ctx.fillRect(0, 0, width, height)

  // 细网格
  ctx.save()
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.022)'
  ctx.lineWidth = 1
  for (let x = 0; x <= width; x += 44) {
    ctx.beginPath()
    ctx.moveTo(x + 0.5, 0)
    ctx.lineTo(x + 0.5, height)
    ctx.stroke()
  }
  for (let y = 0; y <= height; y += 44) {
    ctx.beginPath()
    ctx.moveTo(0, y + 0.5)
    ctx.lineTo(width, y + 0.5)
    ctx.stroke()
  }
  ctx.restore()
}

function drawHeader(ctx: CanvasRenderingContext2D, deck: PosterDeck, total: number) {
  ctx.save()
  ctx.fillStyle = 'rgba(140, 205, 255, 0.62)'
  ctx.font = `600 12px ${MONO}`
  drawSpaced(ctx, 'DECK LIST', PAD, 74, 4)

  const name = deck.name?.trim() || '未命名卡组'
  const size = fitName(ctx, name, W - PAD * 2 - 260, 60)
  ctx.font = `700 ${size}px ${FONT}`
  const title = ctx.createLinearGradient(PAD, 0, PAD + 820, 0)
  title.addColorStop(0, '#f4f9ff')
  title.addColorStop(1, '#78b6ea')
  ctx.fillStyle = title
  ctx.fillText(name, PAD, 74 + size + 14)

  // 右上角总数
  ctx.textAlign = 'right'
  ctx.font = `700 46px ${MONO}`
  ctx.fillStyle = 'rgba(236, 246, 255, 0.92)'
  ctx.fillText(String(total), W - PAD, 104)

  ctx.textAlign = 'left'
  ctx.font = `600 11px ${MONO}`
  ctx.fillStyle = 'rgba(150, 190, 225, 0.55)'
  drawSpaced(ctx, 'CARDS', W - PAD - measureSpaced(ctx, 'CARDS', 3), 128, 3)

  // 分隔线
  const line = ctx.createLinearGradient(PAD, 0, W - PAD, 0)
  line.addColorStop(0, 'rgba(120, 200, 255, 0.55)')
  line.addColorStop(0.45, 'rgba(120, 200, 255, 0.12)')
  line.addColorStop(1, 'rgba(150, 110, 255, 0.02)')
  ctx.fillStyle = line
  ctx.fillRect(PAD, HEADER_H - 26, W - PAD * 2, 1.5)
  ctx.restore()
}

function drawSectionTitle(ctx: CanvasRenderingContext2D, block: Block, y: number) {
  ctx.save()
  const bar = ctx.createLinearGradient(0, y, 0, y + 30)
  bar.addColorStop(0, block.accent)
  bar.addColorStop(1, 'rgba(255, 255, 255, 0)')
  ctx.fillStyle = bar
  roundRect(ctx, PAD, y + 4, 4, 30, 2)
  ctx.fill()

  ctx.fillStyle = 'rgba(238, 246, 255, 0.94)'
  ctx.font = `600 21px ${FONT}`
  ctx.fillText(block.label, PAD + 16, y + 28)
  const labelWidth = ctx.measureText(block.label).width

  ctx.font = `600 13px ${MONO}`
  ctx.fillStyle = block.accent
  const countLabel = `${block.slots.length} 张`
  ctx.fillText(countLabel, PAD + 16 + labelWidth + 12, y + 26)
  const countWidth = ctx.measureText(countLabel).width

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(PAD + 16 + labelWidth + countWidth + 24, y + 21.5)
  ctx.lineTo(W - PAD, y + 21.5)
  ctx.stroke()
  ctx.restore()
}

function drawPlaceholder(
  ctx: CanvasRenderingContext2D,
  slot: Slot,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const grad = ctx.createLinearGradient(x, y, x + w, y + h)
  grad.addColorStop(0, '#18202d')
  grad.addColorStop(0.55, '#131a25')
  grad.addColorStop(1, '#0d131c')
  ctx.fillStyle = grad
  ctx.fillRect(x, y, w, h)

  ctx.save()
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.035)'
  ctx.lineWidth = 10
  for (let offset = -h; offset < w; offset += 30) {
    ctx.beginPath()
    ctx.moveTo(x + offset, y + h)
    ctx.lineTo(x + offset + h, y)
    ctx.stroke()
  }
  ctx.restore()

  ctx.save()
  ctx.fillStyle = 'rgba(150, 175, 205, 0.42)'
  ctx.font = `500 11px ${MONO}`
  ctx.fillText(`#${slot.id}`, x + 14, y + 24)

  ctx.fillStyle = 'rgba(206, 220, 236, 0.9)'
  ctx.font = `600 16px ${FONT}`
  const lines = wrapLines(ctx, slot.name, w - 28)
  const lineHeight = 24
  const startY = y + h / 2 - ((lines.length - 1) * lineHeight) / 2
  lines.forEach((line, index) => {
    ctx.fillText(ellipsize(ctx, line, w - 28), x + 14, startY + index * lineHeight)
  })
  ctx.restore()
}

function drawCard(
  ctx: CanvasRenderingContext2D,
  slot: Slot,
  image: HTMLImageElement | undefined,
  x: number,
  y: number,
  accent: string,
) {
  ctx.save()
  ctx.shadowColor = 'rgba(0, 0, 0, 0.5)'
  ctx.shadowBlur = 16
  ctx.shadowOffsetY = 7
  roundRect(ctx, x, y, CARD_W, CARD_H, 10)
  ctx.fillStyle = '#101722'
  ctx.fill()
  ctx.restore()

  ctx.save()
  roundRect(ctx, x, y, CARD_W, CARD_H, 10)
  ctx.clip()
  if (image) {
    ctx.drawImage(image, x, y, CARD_W, CARD_H)
  } else {
    drawPlaceholder(ctx, slot, x, y, CARD_W, CARD_H)
  }
  // 顶部高光，让卡面有点玻璃感
  const sheen = ctx.createLinearGradient(x, y, x, y + CARD_H * 0.4)
  sheen.addColorStop(0, 'rgba(255, 255, 255, 0.14)')
  sheen.addColorStop(1, 'rgba(255, 255, 255, 0)')
  ctx.fillStyle = sheen
  ctx.fillRect(x, y, CARD_W, CARD_H * 0.4)
  ctx.restore()

  // 描边跟着分区配色走，主 / 额 / 副一眼能分出来
  roundRect(ctx, x + 0.5, y + 0.5, CARD_W - 1, CARD_H - 1, 10)
  ctx.strokeStyle = hexToRgba(accent, 0.3)
  ctx.lineWidth = 1
  ctx.stroke()
}

function drawFooter(ctx: CanvasRenderingContext2D, height: number, deck: PosterDeck) {
  const y = height - FOOTER_H
  ctx.save()
  const fade = ctx.createLinearGradient(0, y, 0, y + FOOTER_H)
  fade.addColorStop(0, 'rgba(255, 255, 255, 0)')
  fade.addColorStop(1, 'rgba(255, 255, 255, 0.02)')
  ctx.fillStyle = fade
  ctx.fillRect(0, y, W, FOOTER_H)

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(PAD, y + 1)
  ctx.lineTo(W - PAD, y + 1)
  ctx.stroke()

  ctx.font = `600 13px ${FONT}`
  ctx.fillStyle = 'rgba(150, 205, 245, 0.75)'
  ctx.fillText('ygo-combo', PAD, y + 52)
  ctx.font = `400 12px ${FONT}`
  ctx.fillStyle = 'rgba(160, 180, 200, 0.4)'
  ctx.fillText('卡组可视化', PAD + 76, y + 52)

  const size = (list: DeckEntry[]) => list.reduce((sum, entry) => sum + entry.count, 0)
  ctx.textAlign = 'right'
  ctx.font = `400 12px ${FONT}`
  ctx.fillStyle = 'rgba(160, 180, 200, 0.45)'
  ctx.fillText(
    `主 ${size(deck.main)} · 额 ${size(deck.extra)} · 副 ${size(deck.side)}`,
    W - PAD,
    y + 46,
  )
  const stamp = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
  ctx.fillStyle = 'rgba(160, 180, 200, 0.28)'
  ctx.fillText(stamp, W - PAD, y + 68)
  ctx.restore()
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    // 优先 webp：同样的画质体积只有 png 的几十分之一；不支持的浏览器会返回 png
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob)
        return
      }
      canvas.toBlob((png) => {
        if (png) resolve(png)
        else reject(new Error('导出失败，当前浏览器可能不支持 canvas 编码'))
      }, 'image/png')
    }, 'image/webp', 0.94)
  })
}

/**
 * 渲染整套卡组为一张竖版长图。
 * 返回的 Blob 可能是 webp 或 png，调用方按 `blob.type` 取后缀即可。
 */
export async function renderDeckPoster(deck: PosterDeck, options: PosterOptions = {}): Promise<Blob> {
  const scale = Math.max(1, options.scale ?? 1.5)
  const onProgress = options.onProgress ?? (() => {})

  const sections: Array<{ label: string; accent: string; entries: DeckEntry[] }> = [
    { label: '主卡组', accent: '#5fc8ff', entries: deck.main },
    { label: '额外卡组', accent: '#a78bfa', entries: deck.extra },
    { label: '副卡组', accent: '#f6c86b', entries: deck.side },
  ]

  const blocks: Block[] = []
  for (const section of sections) {
    const slots = expandSlots(section.entries)
    if (!slots.length) continue
    const rows = Math.ceil(slots.length / COLS)
    blocks.push({
      label: section.label,
      accent: section.accent,
      slots,
      rows,
      height: SECTION_TITLE_H + rows * CARD_H + (rows - 1) * GAP,
    })
  }

  const contentH = blocks.reduce((sum, block) => sum + block.height + SECTION_GAP, 0)
  const height =
    HEADER_H +
    contentH -
    (blocks.length ? SECTION_GAP : 0) +
    CONTENT_BOTTOM_GAP +
    FOOTER_H

  const canvas = document.createElement('canvas')
  canvas.width = Math.round(W * scale)
  canvas.height = Math.round(height * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前浏览器不支持 canvas，无法导出长图')
  ctx.scale(scale, scale)

  const allSlots = blocks.flatMap((block) => block.slots)
  const images = await preloadCardImages(
    allSlots.map((slot) => slot.id),
    onProgress,
  )
  onProgress(66)

  drawBackdrop(ctx, W, height)
  drawHeader(ctx, deck, allSlots.length)
  onProgress(74)

  let cursorY = HEADER_H
  blocks.forEach((block, blockIndex) => {
    drawSectionTitle(ctx, block, cursorY)
    const gridTop = cursorY + SECTION_TITLE_H
    block.slots.forEach((slot, index) => {
      const col = index % COLS
      const row = Math.floor(index / COLS)
      drawCard(
        ctx,
        slot,
        images.get(slot.id),
        PAD + col * (CARD_W + GAP),
        gridTop + row * (CARD_H + GAP),
        block.accent,
      )
    })
    cursorY += block.height + SECTION_GAP
    onProgress(74 + Math.round(((blockIndex + 1) / blocks.length) * 18))
  })

  drawFooter(ctx, height, deck)
  onProgress(96)

  const blob = await canvasToBlob(canvas)
  onProgress(100)
  return blob
}
