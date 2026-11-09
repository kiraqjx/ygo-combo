import type { ZoneCard, ZoneId, ZoneSnapshot } from '@/types'

/**
 * 纯 canvas 的决斗盘渲染：给「导出动图」用。
 * 不加载任何外部卡图（跨域会污染 canvas），卡片一律画成带卡名的色块。
 */

export type CardKind = 'monster' | 'spell' | 'trap' | 'other'

export interface BoardFramePaint {
  snapshot: ZoneSnapshot
  /** 左上角标题，如「第 3 / 7 时序 · 效果处理」 */
  title?: string
  /** 标题下方的小字，如「「增援」 手卡 → 魔陷区」 */
  subtitle?: string
  /** 本帧变化的区域，画金色描边 */
  highlight?: ZoneId[]
  /** 按卡名判断卡种（决定配色），缺省用中性色 */
  kindOf?: (name: string) => CardKind
  /** 按卡名取卡图（同源图片）；取不到就退回文字卡牌 */
  imageOf?: (name: string) => CanvasImageSource | null
  /** 卡片角标：连锁发动时在对应卡片上标 C2 / C3 */
  badges?: { name: string; label: string; zone?: ZoneId | null }[]
  /** 里侧表示用的标准卡背图；取不到就画成渐变卡背 */
  cardBack?: CanvasImageSource | null
}

const PAD = 12
const GAP = 6
const LABEL_W = 40
const COUNT_W = 18
const CARD_RATIO = 614 / 421
const ROW_HEAD_H = 14
const SLOT_ROWS = 2
const SLOTS_PER_ROW = 5
const MINI_W = 26
const HAND_W = 40

/* 十字卡位（与 style.css 的 .duel-slot 同一套比例）：横竖两臂等长 */
const CROSS_ARM = 0.718
const CROSS_INSET = 0.016
/** 卡在十字竖臂里的占比，421:614 正好落在臂内 */
const CARD_W = 0.642
const CARD_H = 0.936

const C = {
  bg: '#0d1117',
  panel: '#161b22',
  empty: 'rgba(255, 255, 255, 0.03)',
  line: '#30363d',
  text: '#e6edf3',
  dim: '#9aa4b2',
  mute: '#6e7781',
  gold: '#d9a336',
}

const KIND_COLORS: Record<CardKind, string> = {
  monster: '#a371f7',
  spell: '#3fb950',
  trap: '#f85149',
  other: '#8b949e',
}

const FONT_FAMILY = '"PingFang SC", "Microsoft YaHei", system-ui, -apple-system, sans-serif'
const font = (size: number, weight = 400) => `${weight} ${size}px ${FONT_FAMILY}`

export interface BoardLayout {
  width: number
  height: number
  headerH: number
  fieldTop: number
  fieldH: number
  slotW: number
  slotH: number
  slotsX: number
  countX: number
  pilesTop: number
  pilesH: number
  miniW: number
  miniH: number
  handTop: number
  handH: number
  handCardW: number
  handCardH: number
}

/** 布局固定尺寸：同一段动画每帧画布大小必须一致 */
export function layoutBoard(width = 480): BoardLayout {
  const inner = width - PAD * 2
  const slotRoom = inner - LABEL_W - COUNT_W - GAP * 2
  const slotW = Math.max(40, Math.min(96, Math.floor((slotRoom - GAP * (SLOTS_PER_ROW - 1)) / SLOTS_PER_ROW)))
  // 十字卡位横竖两臂等长，所以格子是正方形
  const slotH = slotW
  const miniH = Math.round(MINI_W * CARD_RATIO)
  const handCardH = Math.round(HAND_W * CARD_RATIO)

  const headerH = 38
  const fieldTop = PAD + headerH
  const fieldH = 10 + slotH * SLOT_ROWS + GAP + 10
  const pilesTop = fieldTop + fieldH + 8
  const pilesH = 8 + ROW_HEAD_H + miniH * SLOT_ROWS + 4 + 8
  const handTop = pilesTop + pilesH + 8
  const handH = 8 + ROW_HEAD_H + handCardH * SLOT_ROWS + 4 + 8
  const height = handTop + handH + PAD

  return {
    width,
    height,
    headerH,
    fieldTop,
    fieldH,
    slotW,
    slotH,
    slotsX: PAD + LABEL_W + GAP,
    countX: width - PAD - COUNT_W,
    pilesTop,
    pilesH,
    miniW: MINI_W,
    miniH,
    handTop,
    handH,
    handCardW: HAND_W,
    handCardH,
  }
}

/* ------------------------------------------------------------------ */
/* 基础绘制                                                             */
/* ------------------------------------------------------------------ */

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

function panel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  hot = false,
) {
  rr(ctx, x, y, w, h, 7)
  ctx.fillStyle = C.panel
  ctx.fill()
  ctx.strokeStyle = hot ? C.gold : C.line
  ctx.lineWidth = hot ? 1.6 : 1
  ctx.stroke()
}

/** 按字符折行，超出 maxLines 用省略号收尾 */
function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number) {
  const chars = [...text]
  const lines: string[] = []
  let cur = ''
  let i = 0
  while (i < chars.length && lines.length < maxLines) {
    const next = cur + chars[i]
    if (cur && ctx.measureText(next).width > maxWidth) {
      lines.push(cur)
      cur = ''
      continue
    }
    cur = next
    i += 1
  }
  if (cur && lines.length < maxLines) lines.push(cur)
  if (i < chars.length && lines.length) {
    let last = lines[lines.length - 1]
    while (last && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1)
    lines[lines.length - 1] = `${last}…`
  }
  return lines
}

function ellipsis(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
  if (ctx.measureText(text).width <= maxWidth) return text
  let out = text
  while (out && ctx.measureText(`${out}…`).width > maxWidth) out = out.slice(0, -1)
  return `${out}…`
}

/** 溢出的卡片不再画，最后一格画「+N」 */
function drawMoreCell(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  rest: number,
) {
  ctx.save()
  rr(ctx, x, y, w, h, 3)
  ctx.fillStyle = C.empty
  ctx.fill()
  ctx.setLineDash([3, 3])
  ctx.strokeStyle = C.line
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.setLineDash([])
  ctx.font = font(Math.max(8, Math.min(11, Math.round(w / 3))))
  ctx.fillStyle = C.dim
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(`+${rest}`, x + w / 2, y + h / 2)
  ctx.restore()
}

/** 卡片右上角的连锁角标（C2 / C3） */
function drawBadge(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
) {
  if (!label) return
  const size = w >= 52 ? 9 : 7
  ctx.save()
  ctx.font = font(size, 700)
  const padX = size >= 9 ? 3 : 2
  const bw = ctx.measureText(label).width + padX * 2
  const bh = size + 3
  const bx = x + w - bw - 2
  const by = y + 2
  rr(ctx, bx, by, bw, bh, 3)
  ctx.fillStyle = C.gold
  ctx.fill()
  ctx.fillStyle = '#1a1206'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, bx + bw / 2, by + bh / 2 + 0.5)
  ctx.restore()
}

/** 超量素材数量角标：画在怪兽卡左下角 */
function drawMaterialBadge(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  count: number,
) {
  if (!count) return
  const label = `素材×${count}`
  const size = Math.max(7, Math.min(9, Math.round(w / 11)))
  ctx.save()
  ctx.font = font(size, 700)
  const bw = Math.min(w - 6, ctx.measureText(label).width + 8)
  const bh = size + 4
  rr(ctx, x + 3, y + h - bh - 3, bw, bh, 3)
  ctx.fillStyle = 'rgba(8, 10, 16, 0.78)'
  ctx.fill()
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)'
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.fillStyle = C.text
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, x + 3 + bw / 2, y + h - bh / 2 - 3)
  ctx.restore()
}

/** 展开 ×N，方便按格位摆放 */
function expand(cards: ZoneCard[] = []): string[] {
  const out: string[] = []
  for (const card of cards) {
    const count = Math.max(1, card.count)
    for (let i = 0; i < count; i += 1) out.push(card.name)
  }
  return out
}

/** 有格位记录时按格位排列（空位画空槽），否则退回顺排 */
function slotNames(cards: ZoneCard[], slots?: (ZoneCard | null)[]): (string | null)[] {
  if (!slots?.length) return expand(cards)
  const row: (string | null)[] = slots.map((card) => card?.name || null)
  const rest = expand(cards)
  for (const name of row) {
    if (!name) continue
    const index = rest.indexOf(name)
    if (index >= 0) rest.splice(index, 1)
  }
  row.push(...rest)
  return row
}

const countOf = (cards: ZoneCard[] = []) => cards.reduce((sum, card) => sum + card.count, 0)

function drawCard(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  name: string,
  kind: CardKind,
  highlight: boolean,
) {
  const color = KIND_COLORS[kind]
  ctx.save()
  rr(ctx, x, y, w, h, 5)
  ctx.fillStyle = highlight ? 'rgba(217, 163, 54, 0.14)' : C.empty
  ctx.fill()
  ctx.lineWidth = highlight ? 2 : 1
  ctx.strokeStyle = highlight ? C.gold : color
  ctx.globalAlpha = highlight ? 1 : 0.6
  ctx.stroke()
  ctx.globalAlpha = 1

  const size = Math.max(8, Math.min(11, Math.round(w / 6.4)))
  ctx.font = font(size)
  ctx.fillStyle = C.text
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const lines = wrapLines(ctx, name, w - 8, 3)
  const lineH = size + 2
  const startY = y + h / 2 - ((lines.length - 1) * lineH) / 2
  lines.forEach((line, i) => ctx.fillText(line, x + w / 2, startY + i * lineH))
  ctx.restore()
}

/** 按 object-fit: cover 的方式把卡图铺满格子 */
function drawCover(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const iw = Number((image as HTMLImageElement).width) || w
  const ih = Number((image as HTMLImageElement).height) || h
  const scale = Math.max(w / iw, h / ih)
  const sw = w / scale
  const sh = h / scale
  ctx.drawImage(image, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h)
}

/** 卡图卡片：图片铺满 + 底部一条半透明卡名 */
function drawImageCard(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  name: string,
  image: CanvasImageSource,
  highlight: boolean,
) {
  ctx.save()
  rr(ctx, x, y, w, h, 5)
  ctx.clip()
  ctx.fillStyle = C.empty
  ctx.fillRect(x, y, w, h)
  drawCover(ctx, image, x, y, w, h)

  if (w >= 44) {
    const stripH = Math.min(15, Math.round(h * 0.2))
    ctx.fillStyle = 'rgba(0, 0, 0, 0.62)'
    ctx.fillRect(x, y + h - stripH, w, stripH)
    ctx.font = font(Math.max(8, Math.min(10, Math.round(w / 8))))
    ctx.fillStyle = C.text
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(ellipsis(ctx, name, w - 6), x + w / 2, y + h - stripH / 2)
  }
  ctx.restore()

  ctx.save()
  rr(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 5)
  ctx.lineWidth = highlight ? 2 : 1
  ctx.strokeStyle = highlight ? C.gold : 'rgba(0, 0, 0, 0.5)'
  ctx.stroke()
  ctx.restore()
}

/** 里侧守备：优先画标准卡背图，取不到才退回渐变卡背 */
function drawCardBack(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  highlight: boolean,
  back: CanvasImageSource | null,
) {
  const cx = x + w / 2
  const cy = y + h / 2
  const landscape = w > h

  if (back) {
    ctx.save()
    // 卡背图是竖版，横置时整张转 90°，否则会被裁成中间一条
    if (landscape) {
      ctx.translate(cx, cy)
      ctx.rotate(-Math.PI / 2)
      ctx.translate(-cx, -cy)
    }
    const rw = landscape ? h : w
    const rh = landscape ? w : h
    const rx = cx - rw / 2
    const ry = cy - rh / 2
    rr(ctx, rx, ry, rw, rh, 5)
    ctx.clip()
    ctx.fillStyle = '#1b1630'
    ctx.fillRect(rx, ry, rw, rh)
    drawCover(ctx, back, rx, ry, rw, rh)
    ctx.restore()
  } else {
    ctx.save()
    rr(ctx, x, y, w, h, 5)
    ctx.clip()
    ctx.fillStyle = '#1b1630'
    ctx.fillRect(x, y, w, h)
    const grad = ctx.createLinearGradient(x, y, x + w, y + h)
    grad.addColorStop(0, 'rgba(120, 90, 200, 0.5)')
    grad.addColorStop(1, 'rgba(18, 14, 30, 0.95)')
    ctx.fillStyle = grad
    ctx.fillRect(x, y, w, h)
    ctx.restore()

    ctx.save()
    ctx.beginPath()
    ctx.arc(cx, cy, Math.min(w, h) * 0.22, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(201, 166, 255, 0.35)'
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.restore()
  }

  ctx.save()
  rr(ctx, x, y, w, h, 5)
  ctx.lineWidth = highlight ? 2 : 1
  ctx.strokeStyle = highlight ? C.gold : 'rgba(163, 113, 247, 0.6)'
  ctx.stroke()
  ctx.restore()
}

/** 十字路径：arm 是臂宽占格子的比例，inset 是四条边整体向内收缩的比例 */
function crossPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  arm: number,
  inset: number,
) {
  const band = size * (arm - inset * 2)
  const span = size * (1 - inset * 2)
  const cx = x + size / 2
  const cy = y + size / 2
  ctx.beginPath()
  ctx.rect(cx - band / 2, cy - span / 2, band, span)
  ctx.rect(cx - span / 2, cy - band / 2, span, band)
}

/** 卡位：外圈描边 + 内圈底色，中间留出 1.6% 的边框 */
function drawSlotFrame(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  line: string,
  fill: string,
) {
  ctx.save()
  crossPath(ctx, x, y, size, CROSS_ARM, 0)
  ctx.fillStyle = line
  ctx.fill()
  crossPath(ctx, x, y, size, CROSS_ARM, CROSS_INSET)
  ctx.fillStyle = fill
  ctx.fill()
  ctx.restore()
}

/* ------------------------------------------------------------------ */
/* 区域绘制                                                             */
/* ------------------------------------------------------------------ */

function drawSlotRow(
  ctx: CanvasRenderingContext2D,
  l: BoardLayout,
  y: number,
  zone: ZoneId,
  label: string,
  cards: ZoneCard[],
  slots: (ZoneCard | null)[] | undefined,
  highlight: boolean,
  kindOf: (name: string) => CardKind,
  imageOf: (name: string) => CanvasImageSource | null,
  badgeOf: (zone: ZoneId, name: string) => string,
  back: CanvasImageSource | null,
) {
  const items = slotNames(cards, slots)
  const rowX = l.slotsX
  const rowY = y

  ctx.save()
  ctx.font = font(11)
  ctx.fillStyle = highlight ? C.gold : C.mute
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, PAD + 2, y + l.slotH / 2)

  ctx.textAlign = 'right'
  ctx.font = font(12)
  ctx.fillStyle = highlight ? C.gold : C.dim
  ctx.fillText(String(countOf(cards)), l.countX + COUNT_W, y + l.slotH / 2)
  ctx.restore()

  for (let i = 0; i < SLOTS_PER_ROW; i += 1) {
    const x = rowX + i * (l.slotW + GAP)
    const size = l.slotW
    const name = items[i]
    const filled = Boolean(name)
    drawSlotFrame(ctx, x, rowY, size, highlight ? C.gold : filled ? '#3d444d' : C.line, filled ? 'rgba(0, 0, 0, 0.16)' : C.empty)

    if (!name) {
      ctx.save()
      ctx.beginPath()
      ctx.arc(x + size / 2, rowY + size / 2, 2, 0, Math.PI * 2)
      ctx.fillStyle = C.line
      ctx.fill()
      ctx.restore()
      continue
    }

    const slotCard = zone === 'field' ? slots?.find((card) => card?.name === name) || null : null
    const position = slotCard?.position || 'attack'
    const image = imageOf(name)

    // 卡落在十字的竖臂里；守备 / 里侧时横过来落在横臂里
    const cw = size * CARD_W
    const ch = size * CARD_H
    const landscape = position !== 'attack'
    const boxW = landscape ? size * CARD_H : cw
    const boxH = landscape ? size * CARD_W : ch
    const boxX = x + (size - boxW) / 2
    const boxY = rowY + (size - boxH) / 2

    if (position === 'set') {
      drawCardBack(ctx, boxX, boxY, boxW, boxH, highlight, back)
    } else if (position === 'defense') {
      ctx.save()
      ctx.translate(x + size / 2, rowY + size / 2)
      ctx.rotate(-Math.PI / 2)
      if (image) drawImageCard(ctx, -cw / 2, -ch / 2, cw, ch, name, image, highlight)
      else drawCard(ctx, -cw / 2, -ch / 2, cw, ch, name, kindOf(name), highlight)
      ctx.restore()
    } else if (image) {
      drawImageCard(ctx, boxX, boxY, boxW, boxH, name, image, highlight)
    } else {
      drawCard(ctx, boxX, boxY, boxW, boxH, name, kindOf(name), highlight)
    }

    drawBadge(ctx, boxX, boxY, boxW, boxH, badgeOf(zone, name))
    if (zone === 'field') {
      drawMaterialBadge(ctx, boxX, boxY, boxW, boxH, slotCard?.materials?.length || 0)
    }
  }
}

function drawPiles(
  ctx: CanvasRenderingContext2D,
  l: BoardLayout,
  piles: { zone: ZoneId; label: string; cards: ZoneCard[] }[],
  highlight: ZoneId[],
  kindOf: (name: string) => CardKind,
  imageOf: (name: string) => CanvasImageSource | null,
  badgeOf: (zone: ZoneId, name: string) => string,
) {
  const inner = l.width - PAD * 2
  const colW = (inner - GAP * (piles.length - 1)) / piles.length
  const perRow = Math.max(1, Math.floor((colW - 16 + GAP) / (l.miniW + GAP)))
  const capacity = perRow * SLOT_ROWS

  piles.forEach((pile, index) => {
    const x = PAD + index * (colW + GAP)
    const hot = highlight.includes(pile.zone)
    panel(ctx, x, l.pilesTop, colW, l.pilesH, hot)

    ctx.save()
    ctx.font = font(11)
    ctx.fillStyle = hot ? C.gold : C.mute
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(pile.label, x + 8, l.pilesTop + 8 + ROW_HEAD_H / 2)
    ctx.textAlign = 'right'
    ctx.font = font(11)
    ctx.fillStyle = C.dim
    ctx.fillText(String(countOf(pile.cards)), x + colW - 8, l.pilesTop + 8 + ROW_HEAD_H / 2)
    ctx.restore()

    const items = expand(pile.cards)
    const gridTop = l.pilesTop + 8 + ROW_HEAD_H + 2
    const overflow = items.length > capacity
    const shown = items.slice(0, overflow ? capacity - 1 : items.length)
    shown.forEach((name, i) => {
      const cx = x + 8 + (i % perRow) * (l.miniW + GAP)
      const cy = gridTop + Math.floor(i / perRow) * (l.miniH + 3)
      const image = imageOf(name)
      ctx.save()
      rr(ctx, cx, cy, l.miniW, l.miniH, 3)
      if (image) {
        ctx.clip()
        ctx.fillStyle = C.empty
        ctx.fillRect(cx, cy, l.miniW, l.miniH)
        drawCover(ctx, image, cx, cy, l.miniW, l.miniH)
      } else {
        ctx.fillStyle = C.empty
        ctx.fill()
        ctx.strokeStyle = KIND_COLORS[kindOf(name)]
        ctx.globalAlpha = 0.5
        ctx.lineWidth = 1
        ctx.stroke()
        ctx.globalAlpha = 1
        ctx.font = font(7)
        ctx.fillStyle = C.dim
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(name.slice(0, 1), cx + l.miniW / 2, cy + l.miniH / 2)
      }
      ctx.restore()
      drawBadge(ctx, cx, cy, l.miniW, l.miniH, badgeOf(pile.zone, name))
    })

    if (overflow) {
      const i = shown.length
      const cx = x + 8 + (i % perRow) * (l.miniW + GAP)
      const cy = gridTop + Math.floor(i / perRow) * (l.miniH + 3)
      drawMoreCell(ctx, cx, cy, l.miniW, l.miniH, items.length - shown.length)
    }
  })
}

function drawHand(
  ctx: CanvasRenderingContext2D,
  l: BoardLayout,
  cards: ZoneCard[],
  highlight: boolean,
  kindOf: (name: string) => CardKind,
  imageOf: (name: string) => CanvasImageSource | null,
  badgeOf: (zone: ZoneId, name: string) => string,
) {
  const inner = l.width - PAD * 2
  panel(ctx, PAD, l.handTop, inner, l.handH, highlight)

  ctx.save()
  ctx.font = font(11)
  ctx.fillStyle = highlight ? C.gold : C.mute
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText('手卡', PAD + 8, l.handTop + 8 + ROW_HEAD_H / 2)
  ctx.textAlign = 'right'
  ctx.fillStyle = C.dim
  ctx.fillText(String(countOf(cards)), PAD + inner - 8, l.handTop + 8 + ROW_HEAD_H / 2)
  ctx.restore()

  const perRow = Math.max(1, Math.floor((inner - 16 + GAP) / (l.handCardW + GAP)))
  const capacity = perRow * SLOT_ROWS
  const items = expand(cards)
  const overflow = items.length > capacity
  const shown = items.slice(0, overflow ? capacity - 1 : items.length)
  const top = l.handTop + 8 + ROW_HEAD_H + 2

  shown.forEach((name, i) => {
    const x = PAD + 8 + (i % perRow) * (l.handCardW + GAP)
    const y = top + Math.floor(i / perRow) * (l.handCardH + 3)
    const image = imageOf(name)
    if (image) drawImageCard(ctx, x, y, l.handCardW, l.handCardH, name, image, false)
    else drawCard(ctx, x, y, l.handCardW, l.handCardH, name, kindOf(name), false)
    drawBadge(ctx, x, y, l.handCardW, l.handCardH, badgeOf('hand', name))
  })

  if (overflow) {
    const i = shown.length
    const x = PAD + 8 + (i % perRow) * (l.handCardW + GAP)
    const y = top + Math.floor(i / perRow) * (l.handCardH + 3)
    drawMoreCell(ctx, x, y, l.handCardW, l.handCardH, items.length - shown.length)
  }
}

/* ------------------------------------------------------------------ */
/* 对外接口                                                             */
/* ------------------------------------------------------------------ */

/** 把一帧场面画到 canvas 上，画布尺寸由 layoutBoard 决定 */
export function drawBoardFrame(
  ctx: CanvasRenderingContext2D,
  paint: BoardFramePaint,
  width = 480,
): BoardLayout {
  const l = layoutBoard(width)
  const kindOf = paint.kindOf || (() => 'other' as CardKind)
  const imageOf = paint.imageOf || (() => null)
  const highlight = paint.highlight || []
  const badges = paint.badges || []
  const badgeOf = (zone: ZoneId, name: string) => {
    const hit = badges.find((item) => item.name === name && (!item.zone || item.zone === zone))
    return hit?.label || ''
  }

  ctx.save()
  ctx.fillStyle = C.bg
  ctx.fillRect(0, 0, l.width, l.height)

  // 标题
  ctx.font = font(12, 600)
  ctx.fillStyle = C.text
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(ellipsis(ctx, paint.title || '', l.width - PAD * 2), PAD, PAD + 10)

  if (paint.subtitle) {
    ctx.font = font(10.5)
    ctx.fillStyle = C.dim
    ctx.fillText(ellipsis(ctx, paint.subtitle, l.width - PAD * 2), PAD, PAD + 26)
  }

  // 场上
  panel(ctx, PAD, l.fieldTop, l.width - PAD * 2, l.fieldH)
  const rowY = l.fieldTop + 10
  drawSlotRow(
    ctx,
    l,
    rowY,
    'field',
    '怪兽区',
    paint.snapshot.field,
    paint.snapshot.fieldSlots,
    highlight.includes('field'),
    kindOf,
    imageOf,
    badgeOf,
    paint.cardBack || null,
  )
  drawSlotRow(
    ctx,
    l,
    rowY + l.slotH + GAP,
    'st',
    '魔陷区',
    paint.snapshot.st,
    paint.snapshot.stSlots,
    highlight.includes('st'),
    kindOf,
    imageOf,
    badgeOf,
    paint.cardBack || null,
  )

  // 资源区
  drawPiles(
    ctx,
    l,
    [
      { zone: 'extra', label: '额外', cards: paint.snapshot.extra },
      { zone: 'gy', label: '墓地', cards: paint.snapshot.gy },
      { zone: 'banish', label: '除外', cards: paint.snapshot.banish },
      { zone: 'deck', label: '卡组', cards: paint.snapshot.deck },
    ],
    highlight,
    kindOf,
    imageOf,
    badgeOf,
  )

  // 手卡
  drawHand(ctx, l, paint.snapshot.hand, highlight.includes('hand'), kindOf, imageOf, badgeOf)

  ctx.restore()
  return l
}
