/**
 * 展开链长图：把一份 .yrp 录像的操作过程画成一张竖版流程图。
 *
 * 数据只有 `ReplayAnalysis`（steps / openingHand / handtrapHits），
 * 也就是「录像重放一遍拿到的内核消息」——它已经是这条展开链的完整素材：
 * 召唤、发动、检索、盖放按顺序排下来就是路线本身。
 *
 * 卡图必须走同源地址（`cardImageProxyUrl`，dev / preview 由 vite 代理），
 * 卡图 CDN 不返回 CORS 头，跨域画进 canvas 会污染画布，`toBlob` 直接抛错。
 * 取不到卡图（momobako 缺新卡、自定义卡、对手的卡）时退化成带卡名的占位块。
 */
import { cardImageProxyUrl } from './cardDb'
import type { ReplayAnalysis, ReplayStep } from './duel/replay'
import type { ReplayHandtrapHit } from './duel/replayHandtraps'
import { hitNameText } from './duel/replayHandtraps'

export interface ChainPosterInput {
  deckName: string
  /** 录像展示名，放在副标题 */
  replayName: string
  analysis: ReplayAnalysis
  /** 卡名 → 卡号，用来取卡图；取不到就画占位块 */
  cardIdOf?: (name: string) => number | undefined
  /** 卡号 → 卡名，起手展示用 */
  nameOf?: (code: number) => string
}

export interface ChainPosterOptions {
  /** 输出倍率，默认 1.6；太长的图会自动降倍率，避免画布超过浏览器上限 */
  scale?: number
  /** 进度回调，0~100 */
  onProgress?: (percent: number) => void
}

const FONT = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif'
const MONO = '"SF Mono", "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace'

const W = 1240
const PAD = 60
const RAIL_X = PAD + 26
/** 节点卡片的左边界：留在时间轴圆点右侧，圆点才不会压住卡图 */
const NODE_X = PAD + 56
const NODE_W = W - PAD - NODE_X
const HEADER_H = 256
const HAND_TITLE_H = 48
const HAND_CARD_W = 104
const HAND_CARD_H = Math.round(HAND_CARD_W * 1.458)
const HAND_GAP = 16
const HAND_ROW_GAP = 16
const HAND_BOTTOM = 30
const GROUP_H = 66
const NODE_GAP = 12
const NODE_PAD = 16
const THUMB_W = 58
const THUMB_H = 84
const TEXT_SIZE = 19
const TEXT_LINE = 27
const TEXT_MAX_LINES = 3
const HIT_ROW_H = 44
const FOOTER_H = 116
/** 单份录像最多画这么多步；再长的图既看不清也编码不动 */
const MAX_NODES = 96
const PRELOAD_CONCURRENCY = 6
/** 画布高度上限（逻辑像素 × scale），超过就降倍率 */
const MAX_CANVAS_HEIGHT = 12000
/** 画布总像素上限：移动端 Safari 对超大画布的容忍度很低 */
const MAX_CANVAS_PIXELS = 16_000_000

interface VerbStyle {
  label: string
  tone: string
}

const VERBS: { test: RegExp; style: VerbStyle }[] = [
  { test: /特殊召唤/, style: { label: '特殊召唤', tone: '#a8823a' } },
  { test: /翻转召唤/, style: { label: '翻转召唤', tone: '#d9c49a' } },
  { test: /召唤/, style: { label: '召唤', tone: '#a8823a' } },
  { test: /盖放/, style: { label: '盖放', tone: '#d9a94f' } },
  { test: /表示形式/, style: { label: '形式', tone: '#ad9c82' } },
  { test: /被无效/, style: { label: '无效', tone: '#c4564a' } },
  { test: /受到 .* 伤害/, style: { label: '伤害', tone: '#c9752f' } },
  { test: /回复 .* LP/, style: { label: '回复', tone: '#6fae7d' } },
  { test: /支付 .* LP/, style: { label: '支付', tone: '#d9a94f' } },
  { test: /^C\d+\s*发动/, style: { label: '发动', tone: '#6fae7d' } },
  { test: /发动/, style: { label: '发动', tone: '#6fae7d' } },
  { test: /抽了/, style: { label: '抽卡', tone: '#b8933f' } },
  { test: /攻击/, style: { label: '攻击', tone: '#c4564a' } },
  { test: /确认/, style: { label: '选牌', tone: '#efe3c6' } },
  { test: /LP/, style: { label: 'LP', tone: '#d9a94f' } },
]
const DEFAULT_VERB: VerbStyle = { label: '动作', tone: '#d9c49a' }

/** 系统行 / 与展开无关的行，画出来只会挤占版面 */
const NOISE = [
  /^C\d+\s*结算$/,
  /^连锁结束$/,
  /^结算$/,
  /^回放：/,
  /^内核：/,
  /^我方获胜$/,
  /^对手获胜$/,
  /^我方 LP → /,
  /^对手 LP → /,
]

interface ChainNode {
  step: ReplayStep
  /** 图里的序号（1 起） */
  order: number
  verb: VerbStyle
  /** 从「…」里抠出的卡名，用来配卡图 */
  cardName: string
  cardId?: number
  chain: string
  hits: ReplayHandtrapHit[]
}

interface HandCard {
  id: number
  name: string
}

interface LayoutRow {
  kind: 'group' | 'node' | 'hits-title' | 'hit'
  height: number
  turn: number
  phase: string
  node?: ChainNode
  hit?: ReplayHandtrapHit
  /** 画这一步时已经排到第几行（画 node 用不上，留着调试） */
  lines?: string[]
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

  await Promise.all(
    Array.from({ length: Math.min(PRELOAD_CONCURRENCY, unique.length) }, () => worker()),
  )
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

function wrapLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
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

/** 把文本切成「普通片段 / 「卡名」片段」，画的时候卡名单独上色 */
function splitRich(text: string): { text: string; card: boolean }[] {
  const parts: { text: string; card: boolean }[] = []
  const pattern = /「[^」]*」/g
  let last = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > last) parts.push({ text: text.slice(last, index), card: false })
    parts.push({ text: match[0], card: true })
    last = index + match[0].length
  }
  if (last < text.length) parts.push({ text: text.slice(last), card: false })
  return parts
}

function drawRich(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  baseColor: string,
  cardColor: string,
) {
  let cursor = x
  const limit = x + maxWidth
  for (const part of splitRich(text)) {
    ctx.fillStyle = part.card ? cardColor : baseColor
    for (const char of part.text) {
      const width = ctx.measureText(char).width
      if (cursor + width > limit) {
        ctx.fillText('…', cursor, y)
        return
      }
      ctx.fillText(char, cursor, y)
      cursor += width
    }
  }
}

function firstCardName(text: string): string {
  const match = /「([^」]+)」/.exec(text)
  return match ? match[1] : ''
}

function namesInText(text: string): string[] {
  return [...text.matchAll(/「([^」]+)」/g)].map((match) => match[1])
}

function verbOf(text: string): VerbStyle {
  for (const entry of VERBS) if (entry.test.test(text)) return entry.style
  return DEFAULT_VERB
}

function isNoise(text: string, phase: string): boolean {
  if (NOISE.some((pattern) => pattern.test(text))) return true
  // 抽卡阶段的常规抽牌对理解展开没有价值
  return phase === '抽卡阶段' && /抽了 \d+ 张卡$/.test(text)
}

/**
 * 展开步骤：滤掉「C1 结算 / 连锁结束」这类系统行与抽卡阶段的常规抽牌。
 * 展开图与手坑报告的「步数」都以它为准，两边的第 N 步才对得上。
 */
export function actionableSteps(steps: ReplayStep[]): ReplayStep[] {
  return steps.filter((step) => {
    const text = step.text.trim()
    return Boolean(text) && !isNoise(text, step.phase)
  })
}

function buildNodes(steps: ReplayStep[], cardIdOf: (name: string) => number | undefined): ChainNode[] {
  const nodes: ChainNode[] = []
  for (const step of steps) {
    const text = step.text.trim()
    const cardName = firstCardName(text)
    const chainMatch = /^C(\d+)\s/.exec(text)
    nodes.push({
      step,
      order: nodes.length + 1,
      verb: verbOf(text),
      cardName,
      cardId: cardName ? cardIdOf(cardName) : undefined,
      chain: chainMatch ? `C${chainMatch[1]}` : '',
      hits: [],
    })
  }
  return nodes
}

/**
 * 手坑点 → 具体的步骤。
 *
 * `hit.step` 是「内核动作计数」（召唤 / 发动 / 盖放都 +1，对手的也算），
 * 和图里的步骤序号不是一回事。所以按「同一回合 + 触发文本里的卡名」顺序匹配，
 * 匹配不上就退回「同一回合的第一条」，总比丢掉强。
 */
function attachHits(nodes: ChainNode[], hits: ReplayHandtrapHit[]): ReplayHandtrapHit[] {
  const orphans: ReplayHandtrapHit[] = []
  let cursor = 0
  for (const hit of hits) {
    let found = -1
    // 优先按信号下标对齐：同一张卡可能在场 / 在墓地各发动一次
    // （墓地效果不吃泡影），只按卡名找会贴到前面那次同名发动上。
    if (typeof hit.signal === 'number') {
      for (let index = cursor; index < nodes.length; index += 1) {
        const node = nodes[index]
        if (node.step.turn !== hit.turn) continue
        const signal = node.step.signal
        if (typeof signal !== 'number') continue
        if (signal > hit.signal) break
        found = index
      }
    }
    if (found < 0) {
      const names = namesInText(hit.trigger)
      for (let index = cursor; index < nodes.length; index += 1) {
        const node = nodes[index]
        if (node.step.turn !== hit.turn) continue
        if (node.cardName && names.includes(node.cardName)) {
          found = index
          break
        }
      }
    }
    if (found < 0) {
      for (let index = cursor; index < nodes.length; index += 1) {
        if (nodes[index].step.turn === hit.turn) {
          found = index
          break
        }
      }
    }
    if (found < 0) {
      orphans.push(hit)
      continue
    }
    // 触发文案里的「第 N 步」是手坑判定的计数口径，和展开图的节点序号不是一回事；
    // 贴上去以后统一成节点序号，免得第 55 个节点上写着「第 49 步」
    const node = nodes[found]
    node.hits.push({ ...hit, trigger: hit.trigger.replace(/^第 \d+ 步/, `第 ${node.order} 步`) })
    cursor = found
  }
  return orphans
}

function drawBackdrop(ctx: CanvasRenderingContext2D, width: number, height: number) {
  const bg = ctx.createLinearGradient(0, 0, width * 0.4, height)
  bg.addColorStop(0, '#090705')
  bg.addColorStop(0.45, '#100d09')
  bg.addColorStop(1, '#0a0806')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, width, height)

  const cool = ctx.createRadialGradient(width * 0.1, 60, 0, width * 0.1, 60, width * 0.95)
  cool.addColorStop(0, 'rgba(194, 162, 75, 0.22)')
  cool.addColorStop(0.5, 'rgba(194, 162, 75, 0.05)')
  cool.addColorStop(1, 'rgba(194, 162, 75, 0)')
  ctx.fillStyle = cool
  ctx.fillRect(0, 0, width, height)

  const violet = ctx.createRadialGradient(width * 0.95, height * 0.7, 0, width * 0.95, height * 0.7, width * 0.9)
  violet.addColorStop(0, 'rgba(201, 155, 60, 0.20)')
  violet.addColorStop(0.55, 'rgba(201, 155, 60, 0.04)')
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

function drawHeader(
  ctx: CanvasRenderingContext2D,
  input: ChainPosterInput,
  stats: { turns: number; actions: number; hits: number },
) {
  ctx.save()
  ctx.fillStyle = 'rgba(194, 162, 75, 0.62)'
  ctx.font = `600 12px ${MONO}`
  drawSpaced(ctx, 'COMBO LINE', PAD, 72, 4)

  const name = input.deckName?.trim() || '未命名卡组'
  const maxTitle = W - PAD * 2 - 400
  let size = 52
  for (; size >= 30; size -= 2) {
    ctx.font = `700 ${size}px ${FONT}`
    if (ctx.measureText(name).width <= maxTitle) break
  }
  ctx.font = `700 ${size}px ${FONT}`
  const title = ctx.createLinearGradient(PAD, 0, PAD + 760, 0)
  title.addColorStop(0, '#fdf6e6')
  title.addColorStop(0.55, '#f0dfba')
  title.addColorStop(1, '#c2a24b')
  ctx.fillStyle = title
  ctx.fillText(ellipsize(ctx, name, maxTitle), PAD, 76 + size)

  const subY = 76 + size + 34
  ctx.font = `500 14px ${FONT}`
  ctx.fillStyle = 'rgba(190, 174, 148, 0.72)'
  const [me, rival] = input.analysis.names
  const subtitle = `${me || '我方'} vs ${rival || '对手'} · ${input.replayName}`
  ctx.fillText(ellipsize(ctx, subtitle, W - PAD * 2 - 380), PAD, subY)

  // 右上角三个数字：回合 / 动作 / 手坑点
  const statW = 108
  const statTop = 92
  const statsList: { value: string; label: string }[] = [
    { value: String(stats.turns), label: 'TURNS' },
    { value: String(stats.actions), label: 'ACTIONS' },
    { value: String(stats.hits), label: 'HANDTRAPS' },
  ]
  statsList.forEach((item, index) => {
    const x = W - PAD - (statsList.length - index) * statW
    ctx.textAlign = 'right'
    ctx.font = `700 40px ${MONO}`
    ctx.fillStyle = index === 2 && stats.hits ? 'rgba(255, 149, 149, 0.92)' : 'rgba(248, 241, 226, 0.92)'
    ctx.fillText(item.value, x + statW - 18, statTop + 40)
    ctx.font = `600 10px ${MONO}`
    ctx.fillStyle = 'rgba(201, 155, 60, 0.5)'
    ctx.textAlign = 'left'
    drawSpaced(ctx, item.label, x + statW - 18 - measureSpaced(ctx, item.label, 2), statTop + 62, 2)
  })

  const line = ctx.createLinearGradient(PAD, 0, W - PAD, 0)
  line.addColorStop(0, 'rgba(194, 162, 75, 0.55)')
  line.addColorStop(0.45, 'rgba(194, 162, 75, 0.12)')
  line.addColorStop(1, 'rgba(201, 155, 60, 0.02)')
  ctx.fillStyle = line
  ctx.fillRect(PAD, HEADER_H - 24, W - PAD * 2, 1.5)
  ctx.restore()
}

function drawHand(
  ctx: CanvasRenderingContext2D,
  hand: HandCard[],
  images: Map<number, HTMLImageElement>,
  top: number,
) {
  ctx.save()
  ctx.fillStyle = 'rgba(240, 211, 138, 0.9)'
  ctx.font = `600 12px ${MONO}`
  drawSpaced(ctx, 'OPENING HAND', PAD, top + 20, 3)

  ctx.font = `600 17px ${FONT}`
  ctx.fillStyle = 'rgba(250, 243, 228, 0.9)'
  const label = '起手'
  const labelX = PAD + measureSpaced(ctx, 'OPENING HAND', 3) + 14
  ctx.fillText(label, labelX, top + 21)
  const labelWidth = ctx.measureText(label).width

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(labelX + labelWidth + 20, top + 15.5)
  ctx.lineTo(W - PAD, top + 15.5)
  ctx.stroke()

  const cols = Math.max(1, Math.floor((W - PAD * 2 + HAND_GAP) / (HAND_CARD_W + HAND_GAP)))
  const gridTop = top + HAND_TITLE_H
  hand.forEach((card, index) => {
    const col = index % cols
    const row = Math.floor(index / cols)
    const x = PAD + col * (HAND_CARD_W + HAND_GAP)
    const y = gridTop + row * (HAND_CARD_H + HAND_ROW_GAP)

    ctx.save()
    ctx.shadowColor = 'rgba(0, 0, 0, 0.5)'
    ctx.shadowBlur = 14
    ctx.shadowOffsetY = 6
    roundRect(ctx, x, y, HAND_CARD_W, HAND_CARD_H, 9)
    ctx.fillStyle = '#14100b'
    ctx.fill()
    ctx.restore()

    ctx.save()
    roundRect(ctx, x, y, HAND_CARD_W, HAND_CARD_H, 9)
    ctx.clip()
    const image = images.get(card.id)
    if (image) {
      ctx.drawImage(image, x, y, HAND_CARD_W, HAND_CARD_H)
    } else {
      const grad = ctx.createLinearGradient(x, y, x + HAND_CARD_W, y + HAND_CARD_H)
      grad.addColorStop(0, '#241c13')
      grad.addColorStop(1, '#110e0a')
      ctx.fillStyle = grad
      ctx.fillRect(x, y, HAND_CARD_W, HAND_CARD_H)
      ctx.fillStyle = 'rgba(224, 210, 184, 0.88)'
      ctx.font = `600 13px ${FONT}`
      const lines = wrapLines(ctx, card.name, HAND_CARD_W - 20, 3)
      lines.forEach((line, lineIndex) => {
        ctx.fillText(line, x + 10, y + HAND_CARD_H / 2 - ((lines.length - 1) * 19) / 2 + lineIndex * 19)
      })
    }
    ctx.restore()

    roundRect(ctx, x + 0.5, y + 0.5, HAND_CARD_W - 1, HAND_CARD_H - 1, 9)
    ctx.strokeStyle = 'rgba(240, 211, 138, 0.28)'
    ctx.lineWidth = 1
    ctx.stroke()
  })
  ctx.restore()
}

function drawGroupBand(
  ctx: CanvasRenderingContext2D,
  row: LayoutRow,
  y: number,
) {
  const centerY = y + GROUP_H / 2
  ctx.save()

  // 回合号做成发光胶囊，压在时间轴上
  const chip = `T${row.turn}`
  ctx.font = `700 13px ${MONO}`
  const chipW = ctx.measureText(chip).width + 22
  const chipX = RAIL_X - chipW / 2
  ctx.shadowColor = 'rgba(194, 162, 75, 0.55)'
  ctx.shadowBlur = 12
  const grad = ctx.createLinearGradient(chipX, 0, chipX + chipW, 0)
  grad.addColorStop(0, 'rgba(201, 155, 60, 0.95)')
  grad.addColorStop(1, 'rgba(201, 155, 60, 0.95)')
  roundRect(ctx, chipX, centerY - 14, chipW, 28, 14)
  ctx.fillStyle = grad
  ctx.fill()
  ctx.shadowBlur = 0

  ctx.fillStyle = '#ffffff'
  ctx.textAlign = 'center'
  ctx.fillText(chip, RAIL_X, centerY + 4.5)
  ctx.textAlign = 'left'

  ctx.font = `600 18px ${FONT}`
  ctx.fillStyle = 'rgba(246, 238, 220, 0.94)'
  const phaseName = row.phase || '展开'
  ctx.fillText(phaseName, chipX + chipW + 14, centerY + 6)
  const phaseWidth = ctx.measureText(phaseName).width

  const line = ctx.createLinearGradient(chipX + chipW + 24 + phaseWidth, 0, W - PAD, 0)
  line.addColorStop(0, 'rgba(243, 224, 173, 0.35)')
  line.addColorStop(1, 'rgba(243, 224, 173, 0)')
  ctx.fillStyle = line
  ctx.fillRect(chipX + chipW + 24 + phaseWidth, centerY - 0.5, W - PAD - (chipX + chipW + 24 + phaseWidth), 1)
  ctx.restore()
}

function drawNodeThumb(
  ctx: CanvasRenderingContext2D,
  node: ChainNode,
  images: Map<number, HTMLImageElement>,
  x: number,
  y: number,
) {
  ctx.save()
  roundRect(ctx, x, y, THUMB_W, THUMB_H, 7)
  ctx.clip()
  const image = node.cardId ? images.get(node.cardId) : undefined
  if (image) {
    ctx.drawImage(image, x, y, THUMB_W, THUMB_H)
  } else {
    const grad = ctx.createLinearGradient(x, y, x + THUMB_W, y + THUMB_H)
    grad.addColorStop(0, 'rgba(38, 30, 21, 0.95)')
    grad.addColorStop(1, 'rgba(19, 14, 10, 0.95)')
    ctx.fillStyle = grad
    ctx.fillRect(x, y, THUMB_W, THUMB_H)
    ctx.fillStyle = 'rgba(200, 184, 156, 0.8)'
    ctx.font = `600 11px ${FONT}`
    const name = node.cardName || node.verb.label
    const lines = wrapLines(ctx, name, THUMB_W - 12, 4)
    lines.forEach((line, index) => {
      ctx.fillText(line, x + 6, y + THUMB_H / 2 - ((lines.length - 1) * 15) / 2 + index * 15)
    })
  }
  ctx.restore()

  roundRect(ctx, x + 0.5, y + 0.5, THUMB_W - 1, THUMB_H - 1, 7)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)'
  ctx.lineWidth = 1
  ctx.stroke()
}

function drawNode(
  ctx: CanvasRenderingContext2D,
  node: ChainNode,
  images: Map<number, HTMLImageElement>,
  layout: LayoutRow,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const tone = node.verb.tone
  const lines = layout.lines ?? []

  // 卡片本体
  ctx.save()
  ctx.shadowColor = 'rgba(0, 0, 0, 0.38)'
  ctx.shadowBlur = 18
  ctx.shadowOffsetY = 8
  roundRect(ctx, x, y, w, h, 14)
  ctx.fillStyle = 'rgba(20, 15, 10, 0.92)'
  ctx.fill()
  ctx.restore()

  roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 14)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)'
  ctx.lineWidth = 1
  ctx.stroke()

  // 左侧动作色条
  ctx.save()
  ctx.shadowColor = hexToRgba(tone, 0.65)
  ctx.shadowBlur = 14
  const bar = ctx.createLinearGradient(0, y + 14, 0, y + h - 14)
  bar.addColorStop(0, hexToRgba(tone, 0.95))
  bar.addColorStop(1, hexToRgba(tone, 0.15))
  ctx.fillStyle = bar
  roundRect(ctx, x + 1, y + 14, 3, h - 28, 2)
  ctx.fill()
  ctx.restore()

  // 手坑条在正文下面，卡图与文字只在「正文区」里居中，否则会压到手坑条
  const textX = x + NODE_PAD + 2 + THUMB_W + 16
  const badgeW = 84
  const textW = w - (textX - x) - badgeW - NODE_PAD
  const textHeight = lines.length * TEXT_LINE
  const contentH = Math.max(THUMB_H, textHeight)
  const textTop = y + NODE_PAD + (contentH - textHeight) / 2
  drawNodeThumb(ctx, node, images, x + NODE_PAD + 2, y + NODE_PAD + (contentH - THUMB_H) / 2)
  ctx.save()
  ctx.font = `500 ${TEXT_SIZE}px ${FONT}`
  ctx.textBaseline = 'top'
  lines.forEach((line, index) => {
    drawRich(
      ctx,
      line,
      textX,
      textTop + index * TEXT_LINE,
      textW,
      'rgba(240, 230, 210, 0.94)',
      '#f3e0ad',
    )
  })
  ctx.restore()

  // 右侧：动作标签 + 连锁号
  ctx.save()
  ctx.font = `600 11px ${FONT}`
  const chipW = Math.min(badgeW - 12, ctx.measureText(node.verb.label).width + 18)
  const chipX = x + w - NODE_PAD - chipW
  const chipH = 22
  const chipY = textTop - 2
  roundRect(ctx, chipX, chipY, chipW, chipH, 6)
  ctx.fillStyle = hexToRgba(tone, 0.16)
  ctx.fill()
  roundRect(ctx, chipX + 0.5, chipY + 0.5, chipW - 1, chipH - 1, 6)
  ctx.strokeStyle = hexToRgba(tone, 0.4)
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.fillStyle = tone
  ctx.textAlign = 'center'
  ctx.fillText(node.verb.label, chipX + chipW / 2, chipY + 15)
  ctx.textAlign = 'left'

  if (node.chain) {
    ctx.font = `700 12px ${MONO}`
    ctx.fillStyle = 'rgba(255, 255, 255, 0.42)'
    ctx.textAlign = 'right'
    ctx.fillText(node.chain, x + w - NODE_PAD, chipY + chipH + 20)
    ctx.textAlign = 'left'
  }
  ctx.restore()

  // 手坑点：贴在动作下面，红 / 琥珀两色区分「能打断」和「已被自排连锁规避」
  if (node.hits.length) {
    const startY = y + NODE_PAD + Math.max(THUMB_H, textHeight) + 10
    node.hits.forEach((hit, index) => {
      const rowY = startY + index * HIT_ROW_H
      const toneHit = hit.dodged ? '#d9a94f' : '#e8887f'
      const rowW = w - NODE_PAD * 2 - 4
      roundRect(ctx, x + NODE_PAD + 2, rowY, rowW, HIT_ROW_H - 10, 8)
      ctx.fillStyle = hit.dodged ? 'rgba(246, 200, 107, 0.08)' : 'rgba(255, 110, 110, 0.09)'
      ctx.fill()
      roundRect(ctx, x + NODE_PAD + 2.5, rowY + 0.5, rowW - 1, HIT_ROW_H - 11, 8)
      ctx.strokeStyle = hexToRgba(toneHit, 0.3)
      ctx.lineWidth = 1
      ctx.stroke()

      ctx.save()
      ctx.beginPath()
      ctx.arc(x + NODE_PAD + 18, rowY + (HIT_ROW_H - 10) / 2, 3.5, 0, Math.PI * 2)
      ctx.fillStyle = toneHit
      ctx.fill()

      ctx.font = `700 12px ${FONT}`
      ctx.textBaseline = 'middle'
      ctx.fillStyle = toneHit
      const nameText = hitNameText(hit)
      ctx.fillText(nameText, x + NODE_PAD + 28, rowY + (HIT_ROW_H - 10) / 2)
      const nameWidth = ctx.measureText(nameText).width

      ctx.font = `400 12px ${FONT}`
      ctx.fillStyle = 'rgba(232, 220, 198, 0.66)'
      const noteX = x + NODE_PAD + 28 + nameWidth + 12
      const noteW = x + w - NODE_PAD - 14 - noteX
      const note = hit.dodged ? hit.dodgeNote ?? '自排连锁规避' : hit.effect.replace(/\*\*/g, '')
      ctx.fillText(ellipsize(ctx, note, noteW), noteX, rowY + (HIT_ROW_H - 10) / 2)
      ctx.restore()
    })

  }

  // 时间轴上的节点圆点
  ctx.save()
  ctx.beginPath()
  ctx.arc(RAIL_X, y + 30, 17, 0, Math.PI * 2)
  ctx.fillStyle = '#0e0b08'
  ctx.fill()
  ctx.strokeStyle = hexToRgba(tone, 0.85)
  ctx.lineWidth = 2
  ctx.stroke()
  ctx.shadowColor = hexToRgba(tone, 0.55)
  ctx.shadowBlur = 10
  ctx.beginPath()
  ctx.arc(RAIL_X, y + 30, 9, 0, Math.PI * 2)
  ctx.fillStyle = hexToRgba(tone, 0.16)
  ctx.fill()
  ctx.restore()

  ctx.save()
  ctx.font = `700 12px ${MONO}`
  ctx.fillStyle = 'rgba(246, 238, 220, 0.92)'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(String(node.order), RAIL_X, y + 30.5)
  ctx.restore()
}

function drawRail(ctx: CanvasRenderingContext2D, top: number, bottom: number) {
  ctx.save()
  const grad = ctx.createLinearGradient(0, top, 0, bottom)
  grad.addColorStop(0, 'rgba(194, 162, 75, 0.85)')
  grad.addColorStop(0.5, 'rgba(150, 130, 255, 0.6)')
  grad.addColorStop(1, 'rgba(194, 162, 75, 0.12)')
  ctx.strokeStyle = grad
  ctx.lineWidth = 2
  ctx.shadowColor = 'rgba(194, 162, 75, 0.35)'
  ctx.shadowBlur = 10
  ctx.beginPath()
  ctx.moveTo(RAIL_X, top)
  ctx.lineTo(RAIL_X, bottom)
  ctx.stroke()
  ctx.restore()
}

function drawFooter(
  ctx: CanvasRenderingContext2D,
  height: number,
  input: ChainPosterInput,
  notes: string[],
) {
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
  const brand = 'ygo-combo'
  ctx.fillText(brand, PAD, y + 46)
  const brandWidth = ctx.measureText(brand).width
  ctx.font = `400 12px ${FONT}`
  ctx.fillStyle = 'rgba(178, 163, 138, 0.42)'
  ctx.fillText('录像展开链', PAD + brandWidth + 12, y + 46)

  if (notes.length) {
    ctx.font = `400 12px ${FONT}`
    ctx.fillStyle = 'rgba(255, 186, 186, 0.55)'
    ctx.fillText(ellipsize(ctx, notes.join(' · '), W - PAD * 2), PAD, y + 70)
  }

  ctx.textAlign = 'right'
  ctx.font = `400 12px ${FONT}`
  ctx.fillStyle = 'rgba(178, 163, 138, 0.45)'
  ctx.fillText(`${input.analysis.steps.length} 条内核消息`, W - PAD, y + 44)
  const stamp = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
  ctx.fillStyle = 'rgba(178, 163, 138, 0.28)'
  ctx.fillText(stamp, W - PAD, y + 66)
  ctx.restore()
}

function drawHitsTitle(ctx: CanvasRenderingContext2D, top: number, count: number) {
  ctx.save()
  ctx.fillStyle = 'rgba(255, 149, 149, 0.9)'
  ctx.font = `600 12px ${MONO}`
  drawSpaced(ctx, 'HANDTRAP', PAD, top + 22, 3)
  ctx.font = `600 17px ${FONT}`
  ctx.fillStyle = 'rgba(255, 226, 226, 0.9)'
  const label = `未对上步骤的手坑点 ${count} 处`
  const x = PAD + measureSpaced(ctx, 'HANDTRAP', 3) + 14
  ctx.fillText(label, x, top + 23)
  const width = ctx.measureText(label).width
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(x + width + 20, top + 17.5)
  ctx.lineTo(W - PAD, top + 17.5)
  ctx.stroke()
  ctx.restore()
}

function drawHitRow(
  ctx: CanvasRenderingContext2D,
  hit: ReplayHandtrapHit,
  top: number,
) {
  const tone = hit.dodged ? '#d9a94f' : '#e8887f'
  ctx.save()
  ctx.beginPath()
  ctx.arc(PAD + 6, top + 18, 4, 0, Math.PI * 2)
  ctx.fillStyle = tone
  ctx.fill()

  ctx.font = `700 13px ${FONT}`
  ctx.textBaseline = 'middle'
  ctx.fillStyle = tone
  ctx.fillText(hitNameText(hit), PAD + 20, top + 18)
  const nameWidth = ctx.measureText(hitNameText(hit)).width

  const turnLabel = `T${hit.turn}`
  ctx.font = `500 12px ${MONO}`
  ctx.fillStyle = 'rgba(255, 255, 255, 0.38)'
  ctx.fillText(turnLabel, PAD + 30 + nameWidth, top + 18)
  const turnWidth = ctx.measureText(turnLabel).width

  ctx.font = `400 12px ${FONT}`
  ctx.fillStyle = 'rgba(232, 220, 198, 0.62)'
  const triggerX = PAD + 44 + nameWidth + turnWidth
  ctx.fillText(ellipsize(ctx, hit.trigger, W - PAD - triggerX), triggerX, top + 18)
  ctx.restore()
}

/**
 * 渲染一份录像的展开链长图。
 * 返回的 Blob 可能是 webp 或 png，调用方按 `blob.type` 取后缀即可。
 */
export async function renderComboChainPoster(
  input: ChainPosterInput,
  options: ChainPosterOptions = {},
): Promise<Blob> {
  const analysis = input.analysis
  if (!analysis.ok) throw new Error(analysis.error || '这份录像没能解析，无法生成展开图')

  const onProgress = options.onProgress ?? (() => {})
  const nameOf = input.nameOf ?? ((code: number) => `#${code}`)
  const cardIdOf = input.cardIdOf ?? (() => undefined)

  const actionable = actionableSteps(analysis.steps)
  const nodes = buildNodes(actionable.slice(0, MAX_NODES), cardIdOf)
  if (!nodes.length) throw new Error('这份录像没有可展示的展开步骤')
  const truncated = actionable.length > nodes.length

  // 展开图看完整展开：手坑点不截断到前 20 步（skill 包那边仍然只看前 20 步）
  const hits = analysis.handtrapHitsAll ?? analysis.handtrapHits ?? []
  const orphans = attachHits(nodes, hits)

  const hand: HandCard[] = analysis.openingHand.map((id) => ({ id, name: nameOf(id) }))

  const measure = document.createElement('canvas').getContext('2d')
  if (!measure) throw new Error('当前浏览器不支持 canvas，无法导出展开图')

  // 先量一遍排版（要 ctx 才能量文字），再按最终高度建画布
  measure.font = `500 ${TEXT_SIZE}px ${FONT}`
  const badgeW = 84
  const textWidth = NODE_W - (NODE_PAD + 2 + THUMB_W + 16) - badgeW - NODE_PAD

  const rows: LayoutRow[] = []
  let lastTurn = -1
  let lastPhase = ''
  for (const node of nodes) {
    if (node.step.turn !== lastTurn || node.step.phase !== lastPhase) {
      rows.push({ kind: 'group', height: GROUP_H, turn: node.step.turn, phase: node.step.phase })
      lastTurn = node.step.turn
      lastPhase = node.step.phase
    }
    const lines = wrapLines(measure, node.step.text, textWidth, TEXT_MAX_LINES)
    const textHeight = Math.max(THUMB_H, lines.length * TEXT_LINE)
    const hitHeight = node.hits.length ? node.hits.length * HIT_ROW_H + 6 : 0
    rows.push({
      kind: 'node',
      height: Math.max(THUMB_H, textHeight) + NODE_PAD * 2 + hitHeight,
      turn: node.step.turn,
      phase: node.step.phase,
      node,
      lines,
    })
  }

  const handCols = Math.max(1, Math.floor((W - PAD * 2 + HAND_GAP) / (HAND_CARD_W + HAND_GAP)))
  const handRows = Math.max(1, Math.ceil(hand.length / handCols))
  const handSectionH =
    HAND_TITLE_H + handRows * HAND_CARD_H + (handRows - 1) * HAND_ROW_GAP + HAND_BOTTOM

  const bodyH = rows.reduce((sum, row) => sum + row.height + (row.kind === 'node' ? NODE_GAP : 0), 0)
  const orphanBlockH = orphans.length
    ? 46 + orphans.length * 40 + 24
    : 0

  const height = HEADER_H + handSectionH + bodyH + orphanBlockH + FOOTER_H

  // 长图容易撞浏览器的画布上限（尤其 iOS 按总像素算），所以倍率同时受高度与像素数约束
  const baseScale = Math.max(1, options.scale ?? 1.6)
  const scale = Math.max(
    0.75,
    Math.min(baseScale, MAX_CANVAS_HEIGHT / height, Math.sqrt(MAX_CANVAS_PIXELS / (W * height))),
  )

  const imageIds = [
    ...hand.map((card) => card.id),
    ...nodes.map((node) => node.cardId).filter((id): id is number => typeof id === 'number'),
  ]
  const images = await preloadCardImages(imageIds, onProgress)
  onProgress(62)

  const canvas = document.createElement('canvas')
  canvas.width = Math.round(W * scale)
  canvas.height = Math.round(height * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前浏览器不支持 canvas，无法导出展开图')
  ctx.scale(scale, scale)

  drawBackdrop(ctx, W, height)
  drawHeader(ctx, input, { turns: analysis.turns, actions: nodes.length, hits: hits.length })
  drawHand(ctx, hand, images, HEADER_H)
  onProgress(70)

  // 时间轴从展开段开始画：起手卡片横跨左边距，线从那里穿过去会很难看
  const railTop = HEADER_H + handSectionH + 10
  const railBottom = height - FOOTER_H - 20
  drawRail(ctx, railTop, railBottom)

  let cursorY = HEADER_H + handSectionH
  rows.forEach((row, index) => {
    if (row.kind === 'group') {
      drawGroupBand(ctx, row, cursorY)
      cursorY += row.height
      return
    }
    drawNode(ctx, row.node as ChainNode, images, row, NODE_X, cursorY, NODE_W, row.height)
    cursorY += row.height + NODE_GAP
    if (index % 6 === 0) onProgress(70 + Math.round((index / rows.length) * 24))
  })

  if (orphans.length) {
    drawHitsTitle(ctx, cursorY, orphans.length)
    cursorY += 46
    orphans.forEach((hit) => {
      drawHitRow(ctx, hit, cursorY)
      cursorY += 40
    })
  }

  const notes: string[] = []
  if (truncated) notes.push(`录像共 ${actionable.length} 条动作，图里只画了前 ${nodes.length} 条`)
  if (analysis.incomplete) notes.push('录像没跑到终局')
  drawFooter(ctx, height, input, notes)
  onProgress(96)

  const blob = await canvasToBlob(canvas)
  onProgress(100)
  return blob
}

/** 导出用的文件名（去掉非法字符） */
export function chainPosterFileName(deckName: string, replayName: string, blob: Blob): string {
  const ext = blob.type === 'image/png' ? 'png' : 'webp'
  const clean = `${deckName || 'deck'}-${replayName || 'combo'}-展开链`.replace(/[\\/:*?"<>|]/g, '_')
  return `${clean}.${ext}`
}
