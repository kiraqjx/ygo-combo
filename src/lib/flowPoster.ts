/**
 * 检索网络图：把一套卡组在若干份录像里出现过的「卡 → 卡」区域转移画成一张圆图。
 *
 * 数据来自 `ReplayAnalysis.flows`（`replayFlows.ts` 从事件流归因出来的
 * 「哪张卡把哪张卡从哪个区域挪到哪个区域」）。同一份卡组的多份录像会先按
 * 「来源 + 目标 + 起止区域」合并计数，再上色：
 * **颜色代表区域转移类型**（卡组→手卡 / 卡组→墓地 / 手卡→墓地 …），
 * 图例放在图顶部，统计（份数 / 连线数 / 参与张数）写在标题下方。
 *
 * 卡图必须走同源地址（`cardImageProxyUrl`），跨域画进 canvas 会污染画布。
 */
import { cardImageProxyUrl } from './cardDb'
import { ZONE_LABELS, zoneKeyOf, type ReplayFlow } from './duel/replayFlows'

export interface FlowCard {
  id: number
  name: string
}

export interface FlowPosterInput {
  deckName: string
  /** 卡组里的卡（主 + 额外），围绕成环 */
  cards: FlowCard[]
  /** 多份录像合并后的关系（count 已累加） */
  flows: ReplayFlow[]
  /** 参与统计的录像份数 */
  replayCount: number
}

export interface FlowPosterOptions {
  /** 输出倍率，默认 1.3；大图会自动降倍率，避免画布超过浏览器上限 */
  scale?: number
  /** 进度回调，0~100 */
  onProgress?: (percent: number) => void
}

const FONT = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif'
const MONO = '"SF Mono", "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace'

const PAD = 56
const CARD_W = 72
const CARD_H = Math.round(CARD_W * 1.458)
/** 相邻两张卡至少占用的弧长（太挤会看不清卡图） */
const MIN_ARC = 142
/** 环外留给卡名与呼吸感的空间 */
const OUTER_MARGIN = 122
const HEADER_TITLE_TOP = 60
const LEGEND_TOP = 190
const LEGEND_ROW_H = 32
const FOOTER_H = 108
const MAX_CANVAS_PIXELS = 16_000_000
const MAX_CANVAS_HEIGHT = 12000
const PRELOAD_CONCURRENCY = 8
/** 超过这么多种区域转移，剩下的合并成「其他」灰色 */
const MAX_CATEGORIES = 9

const PALETTE = [
  '#a8823a',
  '#8a3327',
  '#6fae7d',
  '#d9a94f',
  '#a8823a',
  '#c9752f',
  '#7fc0a8',
  '#b8933f',
  '#d68a6a',
]
const OTHER_COLOR = '#948871'

/** 区域转移的语义标签（图例上的小字） */
const SEMANTICS: Record<string, string> = {
  'deck:hand': '检索',
  'deck:grave': '堆墓',
  'deck:monster': '特召',
  'deck:spell': '盖放',
  'deck:removed': '除外',
  'extra:monster': '特召',
  'hand:grave': '弃手卡',
  'hand:monster': '召唤',
  'hand:spell': '盖放',
  'hand:removed': '除外',
  'grave:hand': '回收',
  'grave:deck': '洗回卡组',
  'grave:removed': '除外',
  'grave:monster': '特召',
  'monster:grave': '送墓',
  'monster:hand': '弹回手卡',
  'monster:deck': '回到卡组',
  'monster:removed': '除外',
  'spell:grave': '送墓',
  'removed:hand': '回收',
  'removed:grave': '送去墓地',
  'removed:deck': '回到卡组',
}

interface Category {
  key: string
  label: string
  color: string
  count: number
}

interface Edge {
  source: string
  target: string
  category: string
  count: number
}

interface PlacedNode {
  card: FlowCard
  index: number
  x: number
  y: number
  angle: number
  color: string
  /** 卡名可用宽度（按相邻卡的弧长算，避免名字互相压住） */
  nameWidth: number
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

function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace('#', '')
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value
  const num = Number.parseInt(full, 16)
  const r = (num >> 16) & 255
  const g = (num >> 8) & 255
  const b = num & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

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

function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text
  let out = text
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) out = out.slice(0, -1)
  return out.length ? `${out}…` : ''
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const all: string[] = []
  let line = ''
  for (const char of text) {
    const next = line + char
    if (ctx.measureText(next).width > maxWidth && line) {
      all.push(line)
      line = char
    } else {
      line = next
    }
  }
  if (line) all.push(line)
  if (all.length <= maxLines) return all
  const kept = all.slice(0, maxLines)
  kept[maxLines - 1] = ellipsize(ctx, `${kept[maxLines - 1]}…`, maxWidth)
  return kept
}

function loadImage(url: string, timeout = 3500): Promise<HTMLImageElement | null> {
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

async function preloadCardImages(
  ids: number[],
  onProgress: (percent: number) => void,
): Promise<Map<number, HTMLImageElement>> {
  const unique = [...new Set(ids)].filter((id) => Number.isFinite(id) && id > 0)
  const images = new Map<number, HTMLImageElement>()
  if (!unique.length) {
    onProgress(58)
    return images
  }
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
      onProgress(Math.round((done / unique.length) * 58))
    }
  }
  await Promise.all(Array.from({ length: Math.min(PRELOAD_CONCURRENCY, unique.length) }, () => worker()))
  return images
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob)
          return
        }
        canvas.toBlob((png) => {
          if (png) resolve(png)
          else reject(new Error('导出失败，当前浏览器可能不支持 canvas 编码'))
        }, 'image/png')
      },
      'image/webp',
      0.94,
    )
  })
}

/** `deck:hand` → 「检索 · 卡组 → 手卡」 */
function categoryLabel(key: string): string {
  const [fromKey, toKey] = key.split(':')
  const semantic = SEMANTICS[key]
  const arrow = `${ZONE_LABELS[fromKey] ?? '？'} → ${ZONE_LABELS[toKey] ?? '？'}`
  return semantic ? `${semantic} · ${arrow}` : arrow
}

/**
 * 节点排序：从连接最多的卡开始广度优先铺开，
 * 让有关系的卡落在相邻弧段上，连线就不会全挤成一条条长弦。
 */
function orderCards(cards: FlowCard[], edges: Edge[]): FlowCard[] {
  const degree = new Map<string, number>()
  const adjacency = new Map<string, Map<string, number>>()
  const known = new Set(cards.map((card) => card.name))

  for (const edge of edges) {
    if (!known.has(edge.source) || !known.has(edge.target)) continue
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + edge.count)
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + edge.count)
    const forward = adjacency.get(edge.source) ?? new Map<string, number>()
    forward.set(edge.target, (forward.get(edge.target) ?? 0) + edge.count)
    adjacency.set(edge.source, forward)
    const backward = adjacency.get(edge.target) ?? new Map<string, number>()
    backward.set(edge.source, (backward.get(edge.source) ?? 0) + edge.count)
    adjacency.set(edge.target, backward)
  }

  const byName = new Map(cards.map((card) => [card.name, card]))
  const visited = new Set<string>()
  const ordered: FlowCard[] = []

  const seeds = [...cards]
    .filter((card) => (degree.get(card.name) ?? 0) > 0)
    .sort((a, b) => (degree.get(b.name) ?? 0) - (degree.get(a.name) ?? 0))

  for (const seed of seeds) {
    if (visited.has(seed.name)) continue
    visited.add(seed.name)
    const queue = [seed.name]
    while (queue.length) {
      const name = queue.shift() as string
      const card = byName.get(name)
      if (card) ordered.push(card)
      const links = [...(adjacency.get(name) ?? new Map<string, number>())]
        .sort((a, b) => b[1] - a[1])
        .map(([next]) => next)
      for (const next of links) {
        if (visited.has(next)) continue
        visited.add(next)
        queue.push(next)
      }
    }
  }

  for (const card of cards) if (!visited.has(card.name)) ordered.push(card)
  return ordered
}

function drawBackdrop(ctx: CanvasRenderingContext2D, width: number, height: number) {
  const bg = ctx.createLinearGradient(0, 0, width * 0.45, height)
  bg.addColorStop(0, '#080605')
  bg.addColorStop(0.45, '#0f0b08')
  bg.addColorStop(1, '#0a0806')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, width, height)

  const cool = ctx.createRadialGradient(width * 0.5, height * 0.42, 0, width * 0.5, height * 0.42, width * 0.75)
  cool.addColorStop(0, 'rgba(194, 162, 75, 0.16)')
  cool.addColorStop(0.55, 'rgba(194, 162, 75, 0.05)')
  cool.addColorStop(1, 'rgba(194, 162, 75, 0)')
  ctx.fillStyle = cool
  ctx.fillRect(0, 0, width, height)

  const violet = ctx.createRadialGradient(width * 0.9, height * 0.85, 0, width * 0.9, height * 0.85, width * 0.7)
  violet.addColorStop(0, 'rgba(201, 155, 60, 0.16)')
  violet.addColorStop(1, 'rgba(201, 155, 60, 0)')
  ctx.fillStyle = violet
  ctx.fillRect(0, 0, width, height)

  ctx.save()
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.018)'
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
  input: FlowPosterInput,
  stats: { edges: number; involved: number },
  width: number,
  legendRows: Category[][],
) {
  ctx.save()
  ctx.fillStyle = 'rgba(194, 162, 75, 0.62)'
  ctx.font = `600 12px ${MONO}`
  drawSpaced(ctx, 'SEARCH MAP', PAD, HEADER_TITLE_TOP, 4)

  const title = input.deckName?.trim() || '未命名卡组'
  const maxTitle = width - PAD * 2 - 260
  let size = 50
  for (; size >= 28; size -= 2) {
    ctx.font = `700 ${size}px ${FONT}`
    if (ctx.measureText(title).width <= maxTitle) break
  }
  ctx.font = `700 ${size}px ${FONT}`
  const grad = ctx.createLinearGradient(PAD, 0, PAD + 760, 0)
  grad.addColorStop(0, '#fdf6e6')
  grad.addColorStop(0.55, '#f2e3c2')
  grad.addColorStop(1, '#c2a24b')
  ctx.fillStyle = grad
  ctx.fillText(ellipsize(ctx, title, maxTitle), PAD, HEADER_TITLE_TOP + 12 + size)

  ctx.font = `500 14px ${FONT}`
  ctx.fillStyle = 'rgba(190, 174, 148, 0.72)'
  const subtitle = `${input.replayCount} 份录像 · ${stats.edges} 条连线 · ${stats.involved} 张牌参与`
  ctx.fillText(subtitle, PAD, HEADER_TITLE_TOP + 42 + size)

  // 图例：颜色 = 区域转移类型
  const rowH = LEGEND_ROW_H
  legendRows.forEach((row, rowIndex) => {
    let x = PAD
    const y = LEGEND_TOP + rowIndex * rowH
    for (const item of row) {
      ctx.font = `600 12px ${FONT}`
      const labelWidth = ctx.measureText(item.label).width
      ctx.font = `600 11px ${MONO}`
      const countText = String(item.count)
      const countWidth = ctx.measureText(countText).width
      const boxW = 20 + 10 + labelWidth + 10 + countWidth + 14

      roundRect(ctx, x - 6, y - 14, boxW, 24, 6)
      ctx.fillStyle = 'rgba(255, 255, 255, 0.035)'
      ctx.fill()

      ctx.strokeStyle = item.color
      ctx.lineWidth = 2.4
      ctx.shadowColor = hexToRgba(item.color, 0.7)
      ctx.shadowBlur = 8
      ctx.beginPath()
      ctx.moveTo(x, y - 2)
      ctx.lineTo(x + 14, y - 2)
      ctx.stroke()
      ctx.shadowBlur = 0

      ctx.font = `600 12px ${FONT}`
      ctx.fillStyle = 'rgba(240, 230, 210, 0.92)'
      ctx.textBaseline = 'middle'
      ctx.fillText(item.label, x + 22, y - 1)

      ctx.font = `600 11px ${MONO}`
      ctx.fillStyle = hexToRgba(item.color, 0.9)
      ctx.textAlign = 'right'
      ctx.fillText(countText, x + boxW - 18, y - 1)
      ctx.textAlign = 'left'
      ctx.textBaseline = 'alphabetic'

      x += boxW + 14
    }
  })

  const line = ctx.createLinearGradient(PAD, 0, width - PAD, 0)
  line.addColorStop(0, 'rgba(194, 162, 75, 0.5)')
  line.addColorStop(0.5, 'rgba(194, 162, 75, 0.1)')
  line.addColorStop(1, 'rgba(201, 155, 60, 0.02)')
  ctx.fillStyle = line
  ctx.fillRect(PAD, LEGEND_TOP + legendRows.length * rowH + 6, width - PAD * 2, 1.2)
  ctx.restore()
}

/** 聚焦一张卡时的节点状态：聚焦卡 / 相邻卡 / 无关卡 */
type NodeState = 'normal' | 'focus' | 'near' | 'dim'

function drawNodeCard(
  ctx: CanvasRenderingContext2D,
  node: PlacedNode,
  image: HTMLImageElement | undefined,
  state: NodeState,
) {
  const x = node.x - CARD_W / 2
  const y = node.y - CARD_H / 2
  const dim = state === 'dim'
  const focused = state === 'focus'

  ctx.save()
  ctx.globalAlpha = dim ? 0.16 : 1
  ctx.shadowColor = hexToRgba(node.color, focused ? 0.85 : 0.5)
  ctx.shadowBlur = focused ? 32 : 16
  roundRect(ctx, x, y, CARD_W, CARD_H, 8)
  ctx.fillStyle = '#140f0a'
  ctx.fill()
  ctx.restore()

  ctx.save()
  ctx.globalAlpha = dim ? 0.16 : 1
  roundRect(ctx, x, y, CARD_W, CARD_H, 8)
  ctx.clip()
  if (image) {
    ctx.drawImage(image, x, y, CARD_W, CARD_H)
  } else {
    const grad = ctx.createLinearGradient(x, y, x, y + CARD_H)
    grad.addColorStop(0, '#251d13')
    grad.addColorStop(1, '#110d09')
    ctx.fillStyle = grad
    ctx.fillRect(x, y, CARD_W, CARD_H)
    ctx.fillStyle = 'rgba(214, 200, 176, 0.85)'
    ctx.font = `600 10px ${FONT}`
    const lines = wrapLines(ctx, node.card.name, CARD_W - 10, 4)
    lines.forEach((line, index) => {
      ctx.fillText(line, x + 5, y + CARD_H / 2 - ((lines.length - 1) * 13) / 2 + index * 13)
    })
  }
  ctx.restore()

  ctx.save()
  ctx.globalAlpha = dim ? 0.16 : 1
  roundRect(ctx, x + 0.5, y + 0.5, CARD_W - 1, CARD_H - 1, 8)
  ctx.strokeStyle = focused
    ? '#ffffff'
    : hexToRgba(node.color, state === 'near' ? 0.8 : 0.5)
  ctx.lineWidth = focused ? 2.2 : state === 'near' ? 1.6 : 1
  ctx.stroke()

  // 聚焦卡再套一圈发光，点哪张一眼就能看出来
  if (focused) {
    ctx.shadowColor = hexToRgba(node.color, 0.9)
    ctx.shadowBlur = 26
    roundRect(ctx, x - 5, y - 5, CARD_W + 10, CARD_H + 10, 12)
    ctx.strokeStyle = hexToRgba(node.color, 0.85)
    ctx.lineWidth = 2
    ctx.stroke()
  }

  // 卡名当卡图下方的标签：上下半边分别留在环外，左右两端也不会顶出画布
  const above = Math.sin(node.angle) <= 0
  const nameY = node.y + (above ? -1 : 1) * (CARD_H / 2 + 15)
  ctx.font = `500 12px ${FONT}`
  ctx.fillStyle = focused ? '#ffffff' : 'rgba(240, 230, 210, 0.9)'
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  ctx.fillText(ellipsize(ctx, node.card.name, node.nameWidth), node.x, nameY)
  ctx.restore()
}

/** 同一对卡之间的连线固定偏移：重画（聚焦 / 取消聚焦）时线不会跳位 */
function edgeJitter(edge: Edge): number {
  let sum = 0
  for (const char of `${edge.source}>${edge.target}`) sum = (sum * 31 + char.charCodeAt(0)) % 9973
  return (sum % 43) - 21
}

function drawEdges(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  radius: number,
  nodes: Map<string, PlacedNode>,
  edges: Edge[],
  colors: Map<string, string>,
  focus = '',
) {
  const isRelated = (edge: Edge) => !focus || edge.source === focus || edge.target === focus
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  // 次数少的先画，热门的压在上面；聚焦时先铺无关的线，再把相关的盖上去
  const ordered = [...edges].sort((a, b) => a.count - b.count)
  const drawOrder = focus
    ? [...ordered.filter((edge) => !isRelated(edge)), ...ordered.filter(isRelated)]
    : ordered
  drawOrder.forEach((edge) => {
    const from = nodes.get(edge.source)
    const to = nodes.get(edge.target)
    if (!from || !to) return
    const color = colors.get(edge.category) ?? OTHER_COLOR
    const inner = radius - CARD_H / 2 - 8
    const p1 = {
      x: center.x + Math.cos(from.angle) * inner,
      y: center.y + Math.sin(from.angle) * inner,
    }
    const p2 = {
      x: center.x + Math.cos(to.angle) * inner,
      y: center.y + Math.sin(to.angle) * inner,
    }

    const midX = (p1.x + p2.x) / 2
    const midY = (p1.y + p2.y) / 2
    // 控制点朝圆心收一点，再把重叠的线错开（按卡名取固定偏移，重画时线不会跳）
    const jitter = edgeJitter(edge)
    const dx = p2.x - p1.x
    const dy = p2.y - p1.y
    const length = Math.hypot(dx, dy) || 1
    const nx = -dy / length
    const ny = dx / length
    const ctrl = {
      x: midX * 0.62 + center.x * 0.38 + nx * jitter,
      y: midY * 0.62 + center.y * 0.38 + ny * jitter,
    }

    const related = isRelated(edge)
    const alpha = related
      ? 0.14 + Math.min(0.32, edge.count * 0.07) + (focus ? 0.15 : 0)
      : 0.045
    ctx.strokeStyle = hexToRgba(color, alpha)
    ctx.lineWidth = related ? 1.1 + Math.min(3, edge.count * 0.7) + (focus ? 1.3 : 0) : 0.8
    ctx.beginPath()
    ctx.moveTo(p1.x, p1.y)
    ctx.quadraticCurveTo(ctrl.x, ctrl.y, p2.x, p2.y)
    ctx.stroke()
  })
  ctx.restore()

  // 箭头单独画（普通混合模式，避免发光把方向糊掉）；聚焦时无关的线不画箭头
  ordered.forEach((edge) => {
    if (!isRelated(edge)) return
    const from = nodes.get(edge.source)
    const to = nodes.get(edge.target)
    if (!from || !to) return
    const color = colors.get(edge.category) ?? OTHER_COLOR
    const inner = radius - CARD_H / 2 - 8
    const p2 = {
      x: center.x + Math.cos(to.angle) * inner,
      y: center.y + Math.sin(to.angle) * inner,
    }
    const p1 = {
      x: center.x + Math.cos(from.angle) * inner,
      y: center.y + Math.sin(from.angle) * inner,
    }
    const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x)
    const size = 7 + Math.min(4, edge.count)
    ctx.save()
    ctx.translate(p2.x, p2.y)
    ctx.rotate(angle)
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.lineTo(-size, size * 0.42)
    ctx.lineTo(-size, -size * 0.42)
    ctx.closePath()
    ctx.fillStyle = hexToRgba(color, 0.85)
    ctx.fill()
    ctx.restore()
  })
}

function drawFooter(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  notes: string[],
) {
  const y = height - FOOTER_H
  ctx.save()
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(PAD, y + 1)
  ctx.lineTo(width - PAD, y + 1)
  ctx.stroke()

  ctx.font = `600 13px ${FONT}`
  ctx.fillStyle = 'rgba(240, 211, 138, 0.75)'
  const brand = 'ygo-combo'
  ctx.fillText(brand, PAD, y + 42)
  const brandWidth = ctx.measureText(brand).width
  ctx.font = `400 12px ${FONT}`
  ctx.fillStyle = 'rgba(178, 163, 138, 0.42)'
  ctx.fillText('录像检索网络', PAD + brandWidth + 12, y + 42)

  if (notes.length) {
    ctx.fillStyle = 'rgba(255, 200, 150, 0.5)'
    ctx.fillText(ellipsize(ctx, notes.join(' · '), width - PAD * 2), PAD, y + 66)
  }

  const stamp = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
  ctx.textAlign = 'right'
  ctx.fillStyle = 'rgba(178, 163, 138, 0.28)'
  ctx.fillText(stamp, width - PAD, y + 42)
  ctx.restore()
}

/** 把图例按宽度折行 */
function layoutLegend(
  ctx: CanvasRenderingContext2D,
  categories: Category[],
  width: number,
): Category[][] {
  const rows: Category[][] = []
  let row: Category[] = []
  let x = PAD
  for (const item of categories) {
    ctx.font = `600 12px ${FONT}`
    const labelWidth = ctx.measureText(item.label).width
    ctx.font = `600 11px ${MONO}`
    const countWidth = ctx.measureText(String(item.count)).width
    const boxW = 20 + 10 + labelWidth + 10 + countWidth + 14
    if (row.length && x + boxW > width - PAD) {
      rows.push(row)
      row = []
      x = PAD
    }
    row.push(item)
    x += boxW + 14
  }
  if (row.length) rows.push(row)
  return rows
}

/**
 * 画好布局的检索图：卡图只加载一次，之后按聚焦状态反复重画即可
 * （点击卡片看关联时不必重新拉图）。
 */
export interface FlowPosterScene {
  canvas: HTMLCanvasElement
  /** 逻辑尺寸（未乘 scale），页面里按 CSS 缩放显示 */
  width: number
  height: number
  /** 重画整张图；传卡名则聚焦那张卡，传空串恢复全图 */
  render(focus?: string): void
  /**
   * 命中测试：x / y 是相对 canvas 左上角的 0~1 坐标。
   * 页面里的 canvas 会被 CSS 缩放，用 `getBoundingClientRect()` 归一化最稳。
   */
  cardAt(x: number, y: number): string
  /** 把当前画面导出成图片 */
  toBlob(): Promise<Blob>
}

/**
 * 布局 + 预加载卡图，得到一个可反复重画的场景。
 * 只画不影响交互的部分，第一帧由调用方 `render()` 决定（通常是全图）。
 */
export async function prepareFlowPoster(
  input: FlowPosterInput,
  options: FlowPosterOptions = {},
): Promise<FlowPosterScene> {
  const cards = input.cards.filter((card) => card.name)
  if (cards.length < 2) throw new Error('卡组里至少要有两张卡才能画检索图')

  const onProgress = options.onProgress ?? (() => {})
  const known = new Set(cards.map((card) => card.name))

  let dropped = 0
  const edges: Edge[] = []
  const totals = new Map<string, number>()
  for (const flow of input.flows) {
    if (flow.source === flow.target) continue
    if (!known.has(flow.source) || !known.has(flow.target)) {
      dropped += flow.count
      continue
    }
    const fromKey = zoneKeyOf(flow.from)
    const toKey = zoneKeyOf(flow.to)
    if (!fromKey || !toKey || fromKey === toKey) continue
    const key = `${fromKey}:${toKey}`
    edges.push({ source: flow.source, target: flow.target, category: key, count: flow.count })
    totals.set(key, (totals.get(key) ?? 0) + flow.count)
  }

  if (!edges.length) {
    throw new Error('这几份录像里没抓到卡与卡之间的区域转移：先确认录像能解析成功，或换一份真正打到检索 / 堆墓的录像')
  }

  // 按出现次数排序上色，超出的合并成灰色「其他」
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1])
  const categories: Category[] = ranked.slice(0, MAX_CATEGORIES).map(([key, count], index) => ({
    key,
    label: categoryLabel(key),
    color: PALETTE[index],
    count,
  }))
  const overflow = ranked.slice(MAX_CATEGORIES)
  if (overflow.length) {
    categories.push({
      key: 'other',
      label: `其他区域转移（${overflow.length} 类）`,
      color: OTHER_COLOR,
      count: overflow.reduce((sum, [, count]) => sum + count, 0),
    })
  }

  const colors = new Map<string, string>()
  for (const category of categories) colors.set(category.key, category.color)

  // 只画参与过连线的卡：没连线的卡只会把环撑大、把有关系的卡挤在一堆
  const involved = new Set<string>()
  for (const edge of edges) {
    involved.add(edge.source)
    involved.add(edge.target)
  }
  const involvedCards = cards.filter((card) => involved.has(card.name))
  const nodesOrdered = orderCards(involvedCards, edges)

  // 每张卡的主色 = 它最常出现的连线的颜色
  const primaryColor = new Map<string, string>()
  for (const edge of [...edges].sort((a, b) => b.count - a.count)) {
    const color = colors.get(edge.category) ?? OTHER_COLOR
    if (!primaryColor.has(edge.source)) primaryColor.set(edge.source, color)
    if (!primaryColor.has(edge.target)) primaryColor.set(edge.target, color)
  }

  // 半径跟着节点数走：只有几张卡的网络不该被撑成一张大圆
  const radius = Math.max(320, (nodesOrdered.length * MIN_ARC) / (Math.PI * 2))
  const width = Math.round(2 * (radius + OUTER_MARGIN))

  const measure = document.createElement('canvas').getContext('2d')
  if (!measure) throw new Error('当前浏览器不支持 canvas，无法导出检索图')
  const legendRows = layoutLegend(measure, categories, width)
  const headerH = LEGEND_TOP + legendRows.length * LEGEND_ROW_H + 26
  const height = headerH + width + FOOTER_H

  const images = await preloadCardImages(
    nodesOrdered.map((card) => card.id),
    onProgress,
  )
  onProgress(62)

  const baseScale = Math.max(1, options.scale ?? 1.3)
  const scale = Math.max(
    0.8,
    Math.min(baseScale, MAX_CANVAS_HEIGHT / height, Math.sqrt(MAX_CANVAS_PIXELS / (width * height))),
  )

  const canvas = document.createElement('canvas')
  canvas.width = Math.round(width * scale)
  canvas.height = Math.round(height * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前浏览器不支持 canvas，无法导出检索图')

  const center = { x: width / 2, y: headerH + width / 2 }
  const step = (Math.PI * 2) / nodesOrdered.length
  // 相邻两张卡之间的弧长决定卡名能写多宽
  const nameWidth = Math.max(78, Math.min(170, step * radius - 14))

  const placed: PlacedNode[] = nodesOrdered.map((card, index) => {
    const angle = -Math.PI / 2 + index * step
    return {
      card,
      index,
      angle,
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
      color: primaryColor.get(card.name) ?? OTHER_COLOR,
      nameWidth,
    }
  })
  const nodeMap = new Map(placed.map((node) => [node.card.name, node]))

  const notes: string[] = []
  const hidden = cards.length - involvedCards.length
  if (hidden) notes.push(`另有 ${hidden} 张没参与过连线的卡未画出`)
  if (dropped) notes.push(`${dropped} 次移动的另一端不在当前卡组里，已忽略`)
  if (overflow.length) notes.push(`另有 ${overflow.length} 类区域转移合并成灰色`)

  // 聚焦时「相邻卡」= 有直接连线的卡
  const neighbors = new Map<string, Set<string>>()
  const link = (a: string, b: string) => {
    const set = neighbors.get(a) ?? new Set<string>()
    set.add(b)
    neighbors.set(a, set)
  }
  for (const edge of edges) {
    link(edge.source, edge.target)
    link(edge.target, edge.source)
  }

  const stateOf = (name: string, focus: string): NodeState => {
    if (!focus) return 'normal'
    if (name === focus) return 'focus'
    return neighbors.get(focus)?.has(name) ? 'near' : 'dim'
  }

  const render = (focus = '') => {
    // 只认图里真有的卡：传进来的旧卡名作废，按全图处理
    const active = nodeMap.has(focus) ? focus : ''
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.scale(scale, scale)

    drawBackdrop(ctx, width, height)
    drawHeader(ctx, input, { edges: edges.length, involved: involved.size }, width, legendRows)

    // 卡片所在的环 + 一点装饰内环
    ctx.save()
    ctx.strokeStyle = 'rgba(194, 162, 75, 0.09)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(center.x, center.y, radius, 0, Math.PI * 2)
    ctx.stroke()
    ctx.strokeStyle = 'rgba(201, 155, 60, 0.07)'
    ctx.lineWidth = 1
    ctx.setLineDash([4, 10])
    ctx.beginPath()
    ctx.arc(center.x, center.y, radius * 0.62, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()

    drawEdges(ctx, center, radius, nodeMap, edges, colors, active)
    placed.forEach((node) => drawNodeCard(ctx, node, images.get(node.card.id), stateOf(node.card.name, active)))
    drawFooter(ctx, width, height, notes)
  }

  const cardAt = (x: number, y: number): string => {
    const px = x * width
    const py = y * height
    let hit = ''
    let best = Number.POSITIVE_INFINITY
    for (const node of placed) {
      // 卡图有巴掌大，点击给一圈容差；命中多张时取最近的那个
      if (Math.abs(px - node.x) > CARD_W / 2 + 12) continue
      if (Math.abs(py - node.y) > CARD_H / 2 + 12) continue
      const distance = Math.hypot(px - node.x, py - node.y)
      if (distance < best) {
        best = distance
        hit = node.card.name
      }
    }
    return hit
  }

  onProgress(68)
  return {
    canvas,
    width,
    height,
    render,
    cardAt,
    toBlob: () => canvasToBlob(canvas),
  }
}

/**
 * 渲染检索网络图（静态导出）。
 * 返回的 Blob 可能是 webp 或 png，调用方按 `blob.type` 取后缀即可。
 */
export async function renderFlowPoster(
  input: FlowPosterInput,
  options: FlowPosterOptions = {},
): Promise<Blob> {
  const onProgress = options.onProgress ?? (() => {})
  const scene = await prepareFlowPoster(input, options)
  scene.render()
  onProgress(96)
  const blob = await scene.toBlob()
  onProgress(100)
  return blob
}

export function flowPosterFileName(deckName: string, blob: Blob): string {
  const ext = blob.type === 'image/png' ? 'png' : 'webp'
  const clean = `${deckName || 'deck'}-检索图`.replace(/[\\/:*?"<>|]/g, '_')
  return `${clean}.${ext}`
}
