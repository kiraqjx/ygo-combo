/**
 * 模拟起手一图流：把若干组起手牌画成一张竖版长图（每行 2 组，和界面里的排版一致）。
 *
 * 卡图必须走同源地址（`cardImageProxyUrl`，dev / preview 由 vite 代理），
 * 卡图 CDN 不返回 CORS 头，跨域画进 canvas 会污染画布，`toBlob` 直接抛错。
 * 取不到卡图（momobako 缺新卡、自定义卡）时画一个带卡名的占位块，保证图是完整的。
 */
import { cardImageProxyUrl } from './cardDb'

export interface HandPosterCard {
  id: number
  name: string
}

export interface HandPosterSample {
  cards: HandPosterCard[]
  /** 这一手是否算「可动」：true / false 会画标记，undefined 不画 */
  ok?: boolean
  /** 标记右侧的补充说明，例如命中的启动组 */
  note?: string
}

export interface HandPosterOptions {
  /** 卡组名，画在标题位置 */
  deckName?: string
  /** 主卡组张数，画在页脚 */
  deckSize?: number
  /** 输出倍率，默认 1.5；撞到画布上限时会自动降 */
  scale?: number
  /** 进度回调，0~100 */
  onProgress?: (percent: number) => void
}

const FONT = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif'
const MONO = '"SF Mono", "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace'

const W = 1660
const PAD = 56
/** 每行 2 组，20 组正好 10 行 */
const GROUPS_PER_ROW = 2
const COL_GAP = 36
const COL_W = Math.floor((W - PAD * 2 - COL_GAP * (GROUPS_PER_ROW - 1)) / GROUPS_PER_ROW)
/** 一组至少按 5 张排版（后手 6 张、自定义起手更多时按实际张数等比缩小） */
const MIN_CARDS_PER_GROUP = 5
const CARD_GAP = 8
/** 组内顶部「#01」标号占的高度 */
const LABEL_H = 26
/** 卡片下方卡名占的高度 */
const NAME_H = 20
const ROW_GAP = 22

interface CardSize {
  width: number
  height: number
}

/** 组内张数决定卡宽：5 张时最宽，张数越多越窄 */
function cardSize(perRow: number): CardSize {
  const width = Math.floor((COL_W - CARD_GAP * (perRow - 1)) / perRow)
  return { width, height: Math.round(width * 1.458) }
}
const HEADER_H = 196
const CONTENT_BOTTOM_GAP = 44
const FOOTER_H = 118
const PRELOAD_CONCURRENCY = 6
/** 画布高度上限（逻辑像素 × scale），超过就降倍率 */
const MAX_CANVAS_HEIGHT = 12000
/** 画布总像素上限：移动端 Safari 对超大画布的容忍度很低 */
const MAX_CANVAS_PIXELS = 16_000_000

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

/** 按卡号去重后并发预加载卡图（同一张卡在多组里只下一次） */
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
      onProgress(Math.round((done / unique.length) * 60))
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(PRELOAD_CONCURRENCY, unique.length) }, () => worker()),
  )
  return images
}

/** 标题太长时缩字号，缩到底再截断 */
function fitTitle(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, start: number): number {
  let size = start
  for (; size >= 24; size -= 2) {
    ctx.font = `700 ${size}px ${FONT}`
    if (ctx.measureText(text).width <= maxWidth) return size
  }
  return 24
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

  const violet = ctx.createRadialGradient(
    width * 0.92,
    height * 0.72,
    0,
    width * 0.92,
    height * 0.72,
    width * 0.85,
  )
  violet.addColorStop(0, 'rgba(150, 110, 255, 0.16)')
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

function drawHeader(
  ctx: CanvasRenderingContext2D,
  info: { title: string; groups: number; perHand: number; deckSize: number; movable: number | null },
) {
  ctx.save()
  ctx.fillStyle = 'rgba(140, 205, 255, 0.62)'
  ctx.font = `600 12px ${MONO}`
  drawSpaced(ctx, 'OPENING HANDS', PAD, 70, 4)

  const name = info.title?.trim() || '未命名卡组'
  const size = fitTitle(ctx, name, W - PAD * 2 - 300, 52)
  ctx.font = `700 ${size}px ${FONT}`
  const title = ctx.createLinearGradient(PAD, 0, PAD + 820, 0)
  title.addColorStop(0, '#f4f9ff')
  title.addColorStop(1, '#78b6ea')
  ctx.fillStyle = title
  ctx.fillText(ellipsize(ctx, name, W - PAD * 2 - 300), PAD, 70 + size + 14)

  // 副标题：抽了多少、每组几张、主卡组多大，判定过就带上可动组数
  const subtitle = [
    `模拟起手 ${info.groups} 组`,
    `每组 ${info.perHand} 张`,
    `主卡组 ${info.deckSize} 张`,
    info.movable === null ? '' : `可动 ${info.movable} / ${info.groups} 组`,
  ]
    .filter(Boolean)
    .join(' · ')
  ctx.font = `500 14px ${FONT}`
  ctx.fillStyle = 'rgba(150, 190, 225, 0.62)'
  ctx.fillText(subtitle, PAD, 148)

  // 右上角组数
  ctx.textAlign = 'right'
  ctx.font = `700 46px ${MONO}`
  ctx.fillStyle = 'rgba(236, 246, 255, 0.92)'
  ctx.fillText(String(info.groups), W - PAD, 104)

  ctx.font = `600 11px ${MONO}`
  ctx.fillStyle = 'rgba(150, 190, 225, 0.55)'
  drawSpaced(ctx, 'GROUPS', W - PAD - measureSpaced(ctx, 'GROUPS', 3), 128, 3)

  ctx.textAlign = 'left'
  const line = ctx.createLinearGradient(PAD, 0, W - PAD, 0)
  line.addColorStop(0, 'rgba(120, 200, 255, 0.55)')
  line.addColorStop(0.45, 'rgba(120, 200, 255, 0.12)')
  line.addColorStop(1, 'rgba(150, 110, 255, 0.02)')
  ctx.fillStyle = line
  ctx.fillRect(PAD, HEADER_H - 26, W - PAD * 2, 1.5)
  ctx.restore()
}

function drawPlaceholder(
  ctx: CanvasRenderingContext2D,
  card: HandPosterCard,
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
  ctx.font = `500 10px ${MONO}`
  ctx.fillText(`#${card.id}`, x + 12, y + 22)

  ctx.fillStyle = 'rgba(206, 220, 236, 0.9)'
  ctx.font = `600 15px ${FONT}`
  const lines = wrapLines(ctx, card.name, w - 24)
  const lineHeight = 22
  const startY = y + h / 2 - ((lines.length - 1) * lineHeight) / 2
  lines.forEach((line, index) => {
    ctx.fillText(ellipsize(ctx, line, w - 24), x + 12, startY + index * lineHeight)
  })
  ctx.restore()
}

function drawCard(
  ctx: CanvasRenderingContext2D,
  card: HandPosterCard,
  image: HTMLImageElement | undefined,
  x: number,
  y: number,
  size: CardSize,
) {
  const { width, height } = size
  ctx.save()
  ctx.shadowColor = 'rgba(0, 0, 0, 0.5)'
  ctx.shadowBlur = 14
  ctx.shadowOffsetY = 6
  roundRect(ctx, x, y, width, height, 9)
  ctx.fillStyle = '#101722'
  ctx.fill()
  ctx.restore()

  ctx.save()
  roundRect(ctx, x, y, width, height, 9)
  ctx.clip()
  if (image) {
    ctx.drawImage(image, x, y, width, height)
  } else {
    drawPlaceholder(ctx, card, x, y, width, height)
  }
  const sheen = ctx.createLinearGradient(x, y, x, y + height * 0.4)
  sheen.addColorStop(0, 'rgba(255, 255, 255, 0.14)')
  sheen.addColorStop(1, 'rgba(255, 255, 255, 0)')
  ctx.fillStyle = sheen
  ctx.fillRect(x, y, width, height * 0.4)
  ctx.restore()

  roundRect(ctx, x + 0.5, y + 0.5, width - 1, height - 1, 9)
  ctx.strokeStyle = 'rgba(95, 200, 255, 0.24)'
  ctx.lineWidth = 1
  ctx.stroke()

  // 卡名：卡图太小认不出来，所以压在下面写一行
  ctx.save()
  ctx.font = `500 11px ${FONT}`
  ctx.fillStyle = 'rgba(206, 220, 236, 0.76)'
  ctx.fillText(ellipsize(ctx, card.name, width), x + 1, y + height + 15)
  ctx.restore()
}

/** 组头：「#01」+ 可动 / 不可动 标记 + 补充说明 + 右侧分隔线 */
function drawGroupHeader(ctx: CanvasRenderingContext2D, sample: HandPosterSample, index: number, x: number, y: number) {
  ctx.save()
  ctx.textAlign = 'left'
  ctx.font = `600 12px ${MONO}`
  ctx.fillStyle = 'rgba(150, 205, 245, 0.82)'
  const label = `#${String(index + 1).padStart(2, '0')}`
  ctx.fillText(label, x, y + 14)
  let cursor = x + ctx.measureText(label).width + 10

  if (sample.ok !== undefined) {
    const text = sample.ok ? '可动' : '不可动'
    ctx.font = `700 11px ${FONT}`
    const chipW = ctx.measureText(text).width + 16
    const chipH = 18
    const chipY = y + 1
    roundRect(ctx, cursor, chipY, chipW, chipH, 9)
    ctx.fillStyle = sample.ok ? 'rgba(38, 205, 77, 0.16)' : 'rgba(158, 167, 179, 0.13)'
    ctx.fill()
    ctx.strokeStyle = sample.ok ? 'rgba(38, 205, 77, 0.5)' : 'rgba(158, 167, 179, 0.34)'
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.fillStyle = sample.ok ? '#5ce38a' : 'rgba(190, 200, 212, 0.78)'
    ctx.fillText(text, cursor + 8, y + 14)
    cursor += chipW + 10
  }

  if (sample.note) {
    ctx.font = `500 11px ${FONT}`
    ctx.fillStyle = 'rgba(150, 190, 225, 0.6)'
    ctx.fillText(ellipsize(ctx, sample.note, x + COL_W - cursor), cursor, y + 14)
  }
  ctx.restore()
}

function drawGroup(
  ctx: CanvasRenderingContext2D,
  sample: HandPosterSample,
  index: number,
  x: number,
  y: number,
  images: Map<number, HTMLImageElement>,
  size: CardSize,
) {
  drawGroupHeader(ctx, sample, index, x, y)
  sample.cards.forEach((card, cardIndex) => {
    drawCard(
      ctx,
      card,
      images.get(card.id),
      x + cardIndex * (size.width + CARD_GAP),
      y + LABEL_H,
      size,
    )
  })
}

function drawFooter(
  ctx: CanvasRenderingContext2D,
  height: number,
  info: { deckSize: number; groups: number; movable: number | null },
) {
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
  ctx.fillText('启动率 · 模拟起手', PAD + 76, y + 52)

  ctx.textAlign = 'right'
  ctx.font = `400 12px ${FONT}`
  ctx.fillStyle = 'rgba(160, 180, 200, 0.45)'
  const summary = [`主卡组 ${info.deckSize} 张`, `${info.groups} 组样本`]
  if (info.movable !== null) summary.push(`可动 ${info.movable} 组`)
  ctx.fillText(summary.join(' · '), W - PAD, y + 46)
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
 * 把模拟出来的若干组起手画成一张长图。
 * 返回的 Blob 可能是 webp 或 png，调用方按 `blob.type` 取后缀即可。
 */
export async function renderHandPoster(
  samples: HandPosterSample[],
  options: HandPosterOptions = {},
): Promise<Blob> {
  if (!samples.length) throw new Error('还没有模拟结果，先抽几组起手')
  const onProgress = options.onProgress ?? (() => {})

  const perHand = samples.reduce((max, sample) => Math.max(max, sample.cards.length), 0)
  // 后手 6 张 / 自定义起手张数更多时按实际张数缩卡宽，5 张时保持原来的尺寸
  const size = cardSize(Math.max(MIN_CARDS_PER_GROUP, perHand))
  const groupH = LABEL_H + size.height + NAME_H
  const rows = Math.ceil(samples.length / GROUPS_PER_ROW)
  const contentH = rows * groupH + (rows - 1) * ROW_GAP
  const height = HEADER_H + contentH + CONTENT_BOTTOM_GAP + FOOTER_H
  // 判定过（有 ok 字段）才算「可动」，一组都没判定时不显示这个口径
  const judged = samples.filter((sample) => sample.ok !== undefined).length
  const movable = judged ? samples.filter((sample) => sample.ok === true).length : null

  // 长图容易撞浏览器的画布上限（尤其 iOS 按总像素算），所以倍率同时受高度与像素数约束
  const baseScale = Math.max(1, options.scale ?? 1.5)
  const scale = Math.max(
    0.75,
    Math.min(baseScale, MAX_CANVAS_HEIGHT / height, Math.sqrt(MAX_CANVAS_PIXELS / (W * height))),
  )

  const canvas = document.createElement('canvas')
  canvas.width = Math.round(W * scale)
  canvas.height = Math.round(height * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前浏览器不支持 canvas，无法导出长图')
  ctx.scale(scale, scale)

  const images = await preloadCardImages(
    samples.flatMap((sample) => sample.cards.map((card) => card.id)),
    onProgress,
  )
  onProgress(64)

  drawBackdrop(ctx, W, height)
  drawHeader(ctx, {
    title: options.deckName ?? '',
    groups: samples.length,
    perHand,
    deckSize: options.deckSize ?? 0,
    movable,
  })
  onProgress(70)

  samples.forEach((sample, index) => {
    const col = index % GROUPS_PER_ROW
    const row = Math.floor(index / GROUPS_PER_ROW)
    drawGroup(
      ctx,
      sample,
      index,
      PAD + col * (COL_W + COL_GAP),
      HEADER_H + row * (groupH + ROW_GAP),
      images,
      size,
    )
  })
  onProgress(92)

  drawFooter(ctx, height, { deckSize: options.deckSize ?? 0, groups: samples.length, movable })
  onProgress(96)

  const blob = await canvasToBlob(canvas)
  onProgress(100)
  return blob
}
