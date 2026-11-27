/**
 * 启动率一图流：把「卡组 + 先手后手 + 各启动组概率 + 抽滤收益 + 废件 / 手坑上手率」
 * 画成一张竖版图，方便发群 / 存档。
 *
 * 纯 canvas 绘制，不加载卡图（启动率页本来就没有卡图），因此不存在跨域污染画布的问题。
 */

const FONT = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif'
const MONO = '"SF Mono", "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace'

const W = 1100
const PAD = 52
const HEADER_H = 222
const FOOTER_H = 92
const SECTION_TITLE_H = 62
const SECTION_GAP = 30
const STARTER_ROW_H = 66
const EFFECT_ROW_H = 58
const TABLE_ROW_H = 38
const EMPTY_ROW_H = 44

const ACCENT = {
  starter: '#a8823a',
  effect: '#a8823a',
  brick: '#c4564a',
  handtrap: '#d9a94f',
}

/** 一个启动组：组内卡名 + 只靠这组达成的概率 */
export interface RatesPosterStarter {
  /** 已拼好的卡名文案，例如「灰流丽 ×3 ＋ 增援 ×1」 */
  cards: string
  chance: number
}

export interface RatesPosterEffect {
  name: string
  detail: string
  /** 该效果带来的新增启动率（小数）；null = 还没算 */
  gain: number | null
}

export interface RatesPosterHand {
  count: number
  /** 恰好上手 k 张的概率 */
  rows: Array<{ k: number; p: number }>
  atLeastOne: number
}

export interface RatesPosterInput {
  deckName: string
  /** 起手张数：5 = 先手，6 = 后手，其余按「起手 N 张」写 */
  handSize: number
  deckSize: number
  /** 起手即启动（不含抽滤） */
  opening: number | null
  /** 含抽滤后的总启动率 */
  total: number | null
  /** 求解方式 / 状态补充说明 */
  method: string
  starters: RatesPosterStarter[]
  effects: RatesPosterEffect[]
  brick: RatesPosterHand | null
  handtrap: RatesPosterHand | null
}

export interface RatesPosterOptions {
  /** 输出倍率，默认 2（逻辑宽 1100 → 2200px） */
  scale?: number
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text
  let out = text
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) out = out.slice(0, -1)
  return `${out}…`
}

function percentText(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0%'
  const percent = value * 100
  if (percent < 0.1) return '<0.1%'
  return `${percent.toFixed(1)}%`
}

function drawSpaced(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, spacing: number) {
  let cursor = x
  for (const char of text) {
    ctx.fillText(char, cursor, y)
    cursor += ctx.measureText(char).width + spacing
  }
}

function drawBackdrop(ctx: CanvasRenderingContext2D, width: number, height: number) {
  const bg = ctx.createLinearGradient(0, 0, width * 0.5, height)
  bg.addColorStop(0, '#0b0806')
  bg.addColorStop(0.5, '#100d09')
  bg.addColorStop(1, '#0a0806')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, width, height)

  const cool = ctx.createRadialGradient(width * 0.1, 30, 0, width * 0.1, 30, width)
  cool.addColorStop(0, 'rgba(194, 162, 75, 0.18)')
  cool.addColorStop(0.5, 'rgba(194, 162, 75, 0.04)')
  cool.addColorStop(1, 'rgba(194, 162, 75, 0)')
  ctx.fillStyle = cool
  ctx.fillRect(0, 0, width, height)

  const violet = ctx.createRadialGradient(width * 0.9, height * 0.8, 0, width * 0.9, height * 0.8, width * 0.9)
  violet.addColorStop(0, 'rgba(201, 155, 60, 0.16)')
  violet.addColorStop(0.6, 'rgba(201, 155, 60, 0.03)')
  violet.addColorStop(1, 'rgba(201, 155, 60, 0)')
  ctx.fillStyle = violet
  ctx.fillRect(0, 0, width, height)

  ctx.save()
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.02)'
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

function drawHeader(ctx: CanvasRenderingContext2D, input: RatesPosterInput) {
  ctx.save()
  ctx.fillStyle = 'rgba(194, 162, 75, 0.62)'
  ctx.font = `600 12px ${MONO}`
  drawSpaced(ctx, 'START RATE', PAD, 72, 4)

  const name = input.deckName.trim() || '未命名卡组'
  let size = 46
  for (; size >= 26; size -= 2) {
    ctx.font = `700 ${size}px ${FONT}`
    if (ctx.measureText(name).width <= W - PAD * 2 - 300) break
  }
  ctx.font = `700 ${size}px ${FONT}`
  const title = ctx.createLinearGradient(PAD, 0, PAD + 760, 0)
  title.addColorStop(0, '#fdf7e9')
  title.addColorStop(1, '#c2a24b')
  ctx.fillStyle = title
  ctx.fillText(ellipsize(ctx, name, W - PAD * 2 - 300), PAD, 72 + size + 12)

  // 先手 / 后手徽标
  const turn = input.handSize === 5 ? '先手' : input.handSize === 6 ? '后手' : '起手'
  const badge = `${turn} · 起手 ${input.handSize} 张 · 卡组 ${input.deckSize} 张`
  ctx.font = `600 15px ${FONT}`
  const badgeW = ctx.measureText(badge).width + 32
  const badgeY = 72 + size + 34
  roundRect(ctx, PAD, badgeY, badgeW, 36, 18)
  ctx.fillStyle = 'rgba(194, 162, 75, 0.1)'
  ctx.fill()
  ctx.strokeStyle = 'rgba(194, 162, 75, 0.32)'
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.fillStyle = 'rgba(243, 224, 173, 0.92)'
  ctx.fillText(badge, PAD + 16, badgeY + 24)

  // 右侧总启动率
  const main = input.total ?? input.opening
  ctx.textAlign = 'right'
  if (main !== null) {
    ctx.font = `700 52px ${MONO}`
    ctx.fillStyle = 'rgba(248, 241, 226, 0.95)'
    ctx.fillText(percentText(main), W - PAD, 118)
    ctx.font = `500 13px ${FONT}`
    ctx.fillStyle = 'rgba(201, 155, 60, 0.62)'
    ctx.fillText(input.total !== null ? '含抽滤总启动率' : '起手即启动', W - PAD, 148)
  } else {
    ctx.font = `600 14px ${FONT}`
    ctx.fillStyle = 'rgba(201, 155, 60, 0.55)'
    ctx.fillText('尚未计算', W - PAD, 110)
  }

  // 起手即启动的副数字
  if (input.total !== null && input.opening !== null) {
    ctx.font = `500 14px ${MONO}`
    ctx.fillStyle = 'rgba(201, 155, 60, 0.62)'
    ctx.fillText(`起手即启动 ${percentText(input.opening)}`, W - PAD, 174)
  }
  ctx.textAlign = 'left'

  const line = ctx.createLinearGradient(PAD, 0, W - PAD, 0)
  line.addColorStop(0, 'rgba(194, 162, 75, 0.5)')
  line.addColorStop(0.45, 'rgba(194, 162, 75, 0.12)')
  line.addColorStop(1, 'rgba(201, 155, 60, 0.02)')
  ctx.fillStyle = line
  ctx.fillRect(PAD, HEADER_H - 24, W - PAD * 2, 1.5)
  ctx.restore()
}

function drawSectionTitle(
  ctx: CanvasRenderingContext2D,
  title: string,
  note: string,
  accent: string,
  y: number,
) {
  ctx.save()
  const bar = ctx.createLinearGradient(0, y, 0, y + 28)
  bar.addColorStop(0, accent)
  bar.addColorStop(1, 'rgba(255, 255, 255, 0)')
  ctx.fillStyle = bar
  roundRect(ctx, PAD, y + 2, 4, 28, 2)
  ctx.fill()

  ctx.fillStyle = 'rgba(250, 243, 228, 0.94)'
  ctx.font = `600 21px ${FONT}`
  ctx.fillText(title, PAD + 16, y + 24)
  const titleW = ctx.measureText(title).width

  if (note) {
    ctx.font = `500 13px ${FONT}`
    ctx.fillStyle = 'rgba(176, 158, 130, 0.6)'
    ctx.fillText(ellipsize(ctx, note, W - PAD * 2 - titleW - 40), PAD + 28 + titleW, y + 23)
  }
  ctx.restore()
}

function drawBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  ratio: number,
  accent: string,
) {
  roundRect(ctx, x, y, w, h, h / 2)
  ctx.fillStyle = 'rgba(255, 255, 255, 0.07)'
  ctx.fill()
  const clamped = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0))
  if (clamped <= 0) return
  const grad = ctx.createLinearGradient(x, 0, x + w, 0)
  grad.addColorStop(0, accent)
  grad.addColorStop(1, 'rgba(255, 255, 255, 0.72)')
  ctx.save()
  roundRect(ctx, x, y, Math.max(h, w * clamped), h, h / 2)
  ctx.fillStyle = grad
  ctx.fill()
  ctx.restore()
}

/** 第一部分：每个启动组的卡与概率，按概率从高到低 */
function drawStarters(ctx: CanvasRenderingContext2D, input: RatesPosterInput, y: number): number {
  drawSectionTitle(
    ctx,
    '能启动的情况',
    '按概率从高到低 · 组间满足其一，各组概率有重叠',
    ACCENT.starter,
    y,
  )
  let cursor = y + SECTION_TITLE_H
  const rows = [...input.starters].sort((a, b) => b.chance - a.chance)

  if (!rows.length) {
    ctx.save()
    ctx.font = `500 15px ${FONT}`
    ctx.fillStyle = 'rgba(176, 158, 130, 0.5)'
    ctx.fillText('还没有配置启动条件', PAD + 4, cursor + 24)
    ctx.restore()
    return cursor + EMPTY_ROW_H
  }

  rows.forEach((row, index) => {
    ctx.save()
    const top = cursor
    ctx.font = `600 12px ${MONO}`
    ctx.fillStyle = 'rgba(194, 162, 75, 0.78)'
    ctx.fillText(`启动 ${index + 1}`, PAD, top + 26)

    ctx.font = `600 17px ${FONT}`
    ctx.fillStyle = 'rgba(244, 236, 218, 0.92)'
    ctx.fillText(ellipsize(ctx, row.cards, W - PAD * 2 - 250), PAD + 88, top + 26)

    ctx.textAlign = 'right'
    ctx.font = `700 24px ${MONO}`
    ctx.fillStyle = 'rgba(248, 241, 226, 0.95)'
    ctx.fillText(percentText(row.chance), W - PAD, top + 28)
    ctx.textAlign = 'left'

    drawBar(ctx, PAD, top + 46, W - PAD * 2, 6, row.chance, ACCENT.starter)
    ctx.restore()
    cursor += STARTER_ROW_H
  })

  return cursor
}

/** 第二部分：抽滤组件与各自带来的 pp */
function drawEffects(ctx: CanvasRenderingContext2D, input: RatesPosterInput, y: number): number {
  const totalGain =
    input.total !== null && input.opening !== null ? input.total - input.opening : null
  const note =
    totalGain !== null ? `合计 +${(totalGain * 100).toFixed(2)}pp` : '尚未计算，pp 暂缺'
  drawSectionTitle(ctx, '抽滤组件', note, ACCENT.effect, y)

  let cursor = y + SECTION_TITLE_H
  input.effects.forEach((effect, index) => {
    ctx.save()
    const top = cursor
    ctx.font = `600 12px ${MONO}`
    ctx.fillStyle = 'rgba(194, 162, 75, 0.8)'
    ctx.fillText(`${index + 1}`, PAD, top + 20)

    ctx.font = `600 17px ${FONT}`
    ctx.fillStyle = 'rgba(244, 236, 218, 0.92)'
    ctx.fillText(ellipsize(ctx, effect.name || '假想效果', W - PAD * 2 - 220), PAD + 26, top + 20)

    if (effect.detail) {
      ctx.font = `500 12.5px ${FONT}`
      ctx.fillStyle = 'rgba(176, 158, 130, 0.6)'
      ctx.fillText(ellipsize(ctx, effect.detail, W - PAD * 2 - 220), PAD + 26, top + 40)
    }

    ctx.textAlign = 'right'
    ctx.font = `700 19px ${MONO}`
    if (effect.gain === null) {
      ctx.fillStyle = 'rgba(176, 158, 130, 0.45)'
      ctx.fillText('—', W - PAD, top + 26)
    } else {
      ctx.fillStyle = effect.gain > 0.0005 ? '#6fae7d' : 'rgba(176, 158, 130, 0.5)'
      ctx.fillText(
        effect.gain > 0.0005 ? `+${(effect.gain * 100).toFixed(2)}pp` : '无新增',
        W - PAD,
        top + 26,
      )
    }
    ctx.textAlign = 'left'
    ctx.restore()
    cursor += EFFECT_ROW_H
  })

  return cursor
}

/** 第三 / 四部分：上手 k 张的概率表 */
function drawHandTable(
  ctx: CanvasRenderingContext2D,
  title: string,
  note: string,
  accent: string,
  hand: RatesPosterHand,
  y: number,
): number {
  drawSectionTitle(ctx, title, note, accent, y)
  let cursor = y + SECTION_TITLE_H

  hand.rows.forEach((row) => {
    ctx.save()
    ctx.font = `500 14px ${FONT}`
    ctx.fillStyle = 'rgba(220, 206, 182, 0.78)'
    ctx.fillText(`恰好 ${row.k} 张`, PAD, cursor + 19)

    drawBar(ctx, PAD + 96, cursor + 12, W - PAD * 2 - 96 - 92, 7, row.p, accent)

    ctx.textAlign = 'right'
    ctx.font = `600 15px ${MONO}`
    ctx.fillStyle = 'rgba(240, 232, 214, 0.9)'
    ctx.fillText(percentText(row.p), W - PAD, cursor + 20)
    ctx.textAlign = 'left'
    ctx.restore()
    cursor += TABLE_ROW_H
  })

  // 「至少 1 张」是这块工具真正要看的数字
  ctx.save()
  const top = cursor + 6
  roundRect(ctx, PAD, top, W - PAD * 2, 52, 10)
  ctx.fillStyle = 'rgba(255, 255, 255, 0.035)'
  ctx.fill()
  ctx.font = `600 15px ${FONT}`
  ctx.fillStyle = 'rgba(240, 232, 214, 0.9)'
  ctx.fillText(`至少上手 1 张（共 ${hand.count} 张）`, PAD + 18, top + 33)
  ctx.textAlign = 'right'
  ctx.font = `700 24px ${MONO}`
  ctx.fillStyle = accent
  ctx.fillText(percentText(hand.atLeastOne), W - PAD - 18, top + 35)
  ctx.textAlign = 'left'
  ctx.restore()

  return top + 52
}

function drawFooter(ctx: CanvasRenderingContext2D, height: number, input: RatesPosterInput) {
  const y = height - FOOTER_H
  ctx.save()
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(PAD, y + 1)
  ctx.lineTo(W - PAD, y + 1)
  ctx.stroke()

  ctx.font = `600 13px ${FONT}`
  ctx.fillStyle = 'rgba(240, 211, 138, 0.75)'
  ctx.fillText('ygo-combo', PAD, y + 44)
  ctx.font = `400 12px ${FONT}`
  ctx.fillStyle = 'rgba(178, 163, 138, 0.42)'
  ctx.fillText('启动率推算', PAD + 76, y + 44)

  ctx.textAlign = 'right'
  ctx.fillStyle = 'rgba(178, 163, 138, 0.4)'
  if (input.method) ctx.fillText(input.method, W - PAD, y + 36)
  const stamp = new Date().toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  ctx.fillStyle = 'rgba(178, 163, 138, 0.28)'
  ctx.fillText(stamp, W - PAD, y + 58)
  ctx.textAlign = 'left'
  ctx.restore()
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob)
        return
      }
      canvas.toBlob((png) => {
        if (png) resolve(png)
        else reject(new Error('导出失败，当前浏览器可能不支持 canvas 编码'))
      }, 'image/png')
    }, 'image/webp', 0.95)
  })
}

/** 渲染启动率长图，返回的 Blob 可能是 webp 或 png */
export async function renderRatesPoster(
  input: RatesPosterInput,
  options: RatesPosterOptions = {},
): Promise<Blob> {
  const scale = Math.max(1, options.scale ?? 2)

  const starterH =
    SECTION_TITLE_H + (input.starters.length ? input.starters.length * STARTER_ROW_H : EMPTY_ROW_H)
  const effectH = input.effects.length
    ? SECTION_GAP + SECTION_TITLE_H + input.effects.length * EFFECT_ROW_H
    : 0
  const handH = (hand: RatesPosterHand | null) =>
    hand ? SECTION_GAP + SECTION_TITLE_H + hand.rows.length * TABLE_ROW_H + 58 : 0
  const brickH = handH(input.brick)
  const handtrapH = handH(input.handtrap)

  const height = HEADER_H + starterH + effectH + brickH + handtrapH + SECTION_GAP + FOOTER_H

  const canvas = document.createElement('canvas')
  canvas.width = Math.round(W * scale)
  canvas.height = Math.round(height * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前浏览器不支持 canvas，无法导出长图')
  ctx.scale(scale, scale)

  drawBackdrop(ctx, W, height)
  drawHeader(ctx, input)

  let cursor = HEADER_H
  cursor = drawStarters(ctx, input, cursor)
  if (input.effects.length) cursor = drawEffects(ctx, input, cursor + SECTION_GAP)
  if (input.brick) {
    cursor = drawHandTable(
      ctx,
      '废件上手率',
      '各行「恰好 k 张」互不累计 · 独立查表，不计入启动率',
      ACCENT.brick,
      input.brick,
      cursor + SECTION_GAP,
    )
  }
  if (input.handtrap) {
    cursor = drawHandTable(
      ctx,
      '手坑上手率',
      '各行「恰好 k 张」互不累计 · 独立查表，不计入启动率',
      ACCENT.handtrap,
      input.handtrap,
      cursor + SECTION_GAP,
    )
  }

  drawFooter(ctx, height, input)
  return canvasToBlob(canvas)
}
