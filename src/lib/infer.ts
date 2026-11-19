import type { CardData } from '@/types'

/**
 * 文本推断（只保留「启动率」用的部分）。
 *
 * 原来的「卡片 → 时序草稿」（inferTiming / autoRuleMoves / suggestHandtraps…）
 * 是 combo 工坊的输入辅助，工坊废弃后一并删除。这里只剩下：
 *   - `uid()`：deck / handtrap / replay store 的本地 id
 *   - `inferRateOps()`：从卡效文本抽抽滤算子，供「启动率」页自动填算子
 */

export const uid = () => Math.random().toString(36).slice(2, 10)

/** 墓地 / 丢弃触发段：这类效果通常是这张卡在主卡组里的真正用途 */
const GY_TRIGGER = /被送去墓地|被送入墓地|被丢弃|在墓地存在|送去墓地的场合|被除外的场合/

/** 一张卡可能有 ①②③ 多个效果，选出本次要建模的那一段（优先墓地 / 丢弃触发段，否则①） */
export function pickEffectSegment(card: CardData): string {
  const text = `${card.desc || ''}\n${card.pendDesc || ''}`.replace(/\r/g, '')
  const segments = text.split(/(?=[①②③④⑤⑥])/).filter((s) => /[①②③④⑤⑥]/.test(s.trim()))
  if (!segments.length) return text
  const trigger = segments.find((s) => GY_TRIGGER.test(s))
  return (trigger || segments[0]).trim()
}

/* ------------------------------------------------------------------ */
/* 抽滤效果推断（启动率用）                                             */
/* ------------------------------------------------------------------ */

const NUM = '0-9一二三四五六七八九十两'

const DIG = {
  /** 从卡组上面把 N 张卡翻开 / 确认 */
  reveal: new RegExp(
    `从卡组(?:上面|上方|顶部|最上面|顶端)?把?\\s*([${NUM}]+)\\s*张卡\\s*(?:翻开|确认|观看|查看|公开)`,
  ),
  /** 从那之中选 N 张 */
  take: new RegExp(`(?:从那之中|从那些卡之中|从翻开的卡之中|其中)(?:选|选择)\\s*([${NUM}]+)\\s*张`),
  /** 选出 N 张加入手卡 */
  takeDirect: new RegExp(`(?:选|选择)\\s*([${NUM}]+)\\s*张(?:卡)?(?:加入手卡|加入手牌|加入手札)`),
  /** 卡组顶 N 张送墓 / 除外 */
  mill: new RegExp(
    `从卡组(?:上面|上方|顶部|最上面)?把?\\s*([${NUM}]+)\\s*张卡[^。]{0,8}?(除外|送去墓地|送入墓地)`,
  ),
  /** 抽 N 张 */
  draw: new RegExp(`抽(?:卡)?\\s*([${NUM}]+)\\s*张`),
  /** 丢全部手卡 */
  discardAll: /(?:手卡|手牌)全部[^。]{0,6}?(?:丢弃|舍弃|送去墓地)/,
  /** 丢 N 张手卡（三种语序） */
  discardA: new RegExp(`(?:丢弃|舍弃)\\s*([${NUM}]+)\\s*张(?:手卡|手牌)`),
  discardB: new RegExp(`([${NUM}]+)\\s*张(?:手卡|手牌)[^。]{0,6}?(?:丢弃|舍弃)`),
  discardC: new RegExp(`(?:手卡|手牌)\\s*([${NUM}]+)\\s*张[^。]{0,8}?(?:丢弃|舍弃)`),
  /** 剩余卡的去向 */
  sinkBanish: /(?:剩下|其余|其他|剩余的)[^。]{0,20}?除外/,
  sinkBottom: /(?:剩下|其余|其他|剩余的)[^。]{0,20}?(?:最下面|下面|底部|回到|返回|洗回)/,
  sinkGrave: /(?:剩下|其余|其他|剩余的)[^。]{0,20}?(?:送去墓地|送入墓地|丢弃)/,
}

export interface InferredDig {
  kind: 'dig'
  reveal: number
  take: number
  sink: 'gy' | 'banish' | 'bottom'
}

export interface InferredDiscard {
  kind: 'discard'
  count: number
  all: boolean
}

export type InferredOp = InferredDig | InferredDiscard

export interface RateOpInference {
  ops: InferredOp[]
  hints: string[]
}

const CN_NUM: Record<string, number> = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
}

function parseCount(raw?: string): number {
  if (!raw) return 1
  if (/^\d+$/.test(raw)) return Math.max(1, Number(raw))
  if (raw === '十') return 10
  if (raw.startsWith('十')) return 10 + (CN_NUM[raw.slice(1)] || 0)
  return CN_NUM[raw] || 1
}

/**
 * 从效果文本里抽出一串**算子**，不做「这张卡叫什么」的判断。
 *
 * 语法只有三层：
 *   1. 数量 + 区域 + 动作  → 产生一个 dig / mill / discard
 *   2. 「从那之中选 M 张」   → 回填上一个 dig 的 take
 *   3. 「剩下的卡…」        → 回填上一个 dig 的 sink
 *
 * 所以强欲之壶、成金、强贪壶、手札抹杀、翻 6 拿 1 全都由同一套规则拼出来。
 */
export function inferRateOps(card: CardData): RateOpInference {
  const text = pickEffectSegment(card).replace(/\r/g, '')
  const hints: string[] = []

  // 按句切开，句内再按出现位置排序，保证算子顺序和卡面顺序一致
  const clauses = text
    .split(/[。；\n]/)
    .map((clause) => clause.trim())
    .filter(Boolean)

  const ops: InferredOp[] = []
  let lastDig: InferredDig | null = null

  for (const clause of clauses) {
    const hits: { at: number; op: InferredDig | InferredDiscard }[] = []

    const reveal = DIG.reveal.exec(clause)
    if (reveal) {
      lastDig = { kind: 'dig', reveal: parseCount(reveal[1]), take: 1, sink: 'gy' }
      hits.push({ at: reveal.index, op: lastDig })
      hints.push(`看牌库顶 ${lastDig.reveal} 张`)
    }

    if (lastDig) {
      const take = DIG.take.exec(clause) || DIG.takeDirect.exec(clause)
      if (take) {
        lastDig.take = Math.min(lastDig.reveal, parseCount(take[1]))
        hints.push(`其中拿 ${lastDig.take} 张`)
      }
      if (DIG.sinkBanish.test(clause)) {
        lastDig.sink = 'banish'
        hints.push('其余卡除外：牌库会变薄')
      } else if (DIG.sinkBottom.test(clause)) {
        lastDig.sink = 'bottom'
        hints.push('其余卡回卡组：牌库张数不变')
      } else if (DIG.sinkGrave.test(clause)) {
        lastDig.sink = 'gy'
        hints.push('其余卡送墓：牌库会变薄')
      }
    }

    const draw = DIG.draw.exec(clause)
    if (draw) {
      const n = parseCount(draw[1])
      hits.push({ at: draw.index, op: { kind: 'dig', reveal: n, take: n, sink: 'gy' } })
      hints.push(`抽 ${n} 张`)
    }

    const mill = DIG.mill.exec(clause)
    if (mill) {
      const n = parseCount(mill[1])
      const sink = mill[2] === '除外' ? 'banish' : 'gy'
      hits.push({ at: mill.index, op: { kind: 'dig', reveal: n, take: 0, sink } })
      hints.push(`牌库顶 ${n} 张${mill[2] === '除外' ? '除外' : '送墓'}：牌库变薄`)
    }

    if (DIG.discardAll.test(clause)) {
      const at = clause.search(/丢弃|舍弃/)
      hits.push({ at: at >= 0 ? at : 0, op: { kind: 'discard', count: 0, all: true } })
      hints.push('丢弃全部手卡')
    } else {
      const discard = DIG.discardA.exec(clause) || DIG.discardB.exec(clause) || DIG.discardC.exec(clause)
      if (discard) {
        const n = parseCount(discard[1])
        hits.push({ at: discard.index, op: { kind: 'discard', count: n, all: false } })
        hints.push(`丢弃 ${n} 张手卡`)
      }
    }

    hits.sort((a, b) => a.at - b.at)
    for (const hit of hits) ops.push(hit.op)
  }

  if (!ops.length) hints.push('没识别到抽牌 / 翻牌，请手动加算子')

  return { ops, hints }
}
