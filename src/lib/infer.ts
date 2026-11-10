import type { CardData, CardMove, OperationKind, Timing, ZoneId } from '@/types'
import { UNKNOWN_CARD } from '@/types'

export const uid = () => Math.random().toString(36).slice(2, 10)

/** 额外卡组怪兽（融合 / 同调 / 超量 / 连接） */
export function isExtraDeckCard(card?: CardData | null): boolean {
  if (!card || card.frame !== 'monster') return false
  return card.kinds.some((k) => ['融合', '同调', '超量', '连接'].includes(k))
}

/** 超量怪兽：召唤素材会叠在怪兽下面，发动效果通常要取除素材 */
export function isXyzCard(card?: CardData | null): boolean {
  if (!card || card.frame !== 'monster') return false
  return card.kinds.includes('超量') || card.rankLabel === 'RANK'
}

const TEST = {
  addFromDeck: /从卡组[^。；]{0,50}?(?:加入手卡|加入手牌|加入手札)/,
  addFromDeckMixed: /从(?:手卡·卡组|卡组·手卡|手卡或卡组|卡组或手卡)[^。；]{0,40}?(?:加入手卡|加入手牌)/,
  ssFromDeck: /从卡组[^。；]{0,50}?特殊召唤/,
  ssFromExtra: /从额外卡组[^。；]{0,40}?特殊召唤/,
  ssFromHand: /从手卡把[^。；]{0,40}?(?:仪式召唤|特殊召唤)/,
  sendFromDeck: /从卡组[^。；]{0,50}?(?:送去墓地|送入墓地)/,
  fromGY: /从墓地[^。；]{0,50}?(?:加入手卡|加入手牌|特殊召唤|除外)/,
  draw: /抽[0-9一二三四五六七八九十两]+张/,
  fieldNeed: /自己场上[^。；]{0,20}(?:怪兽|卡)(?:存在|的场合|数量)/,
  ss: /特殊召唤/,
  setToField: /(?:盖放|盖到|SET)/i,
  discardOther: /(?:那之后|然后|之后)[^。；]{0,40}?(?:丢弃|舍弃)|(?:选|选择)[^。；]{0,16}手卡[^。；]{0,16}?(?:丢弃|舍弃)/,
  discardSelf: /把这张卡从(?:手卡|手牌)(?:丢弃|送去墓地|舍弃)|这张卡从(?:手卡|手牌)(?:丢弃|送去墓地)/,
  gyTrigger: /被送去墓地|被送入墓地|被丢弃|在墓地存在|送去墓地的场合|被除外的场合/,
  setThenUsable: /盖放的?卡?在盖放的回合也能发动|盖放的回合也能发动/,
}

/** 一张卡可能有 ①②③ 多个效果，选出本次要建模的那一段（优先墓地/丢弃触发段，否则①） */
export function pickEffectSegment(card: CardData): string {
  const text = `${card.desc || ''}\n${card.pendDesc || ''}`.replace(/\r/g, '')
  const segments = text.split(/(?=[①②③④⑤⑥])/).filter((s) => /[①②③④⑤⑥]/.test(s.trim()))
  if (!segments.length) return text
  const trigger = segments.find((s) => TEST.gyTrigger.test(s))
  return (trigger || segments[0]).trim()
}

/* ------------------------------------------------------------------ */
/* 手坑建议（只做提示，模型本身不依赖事件类型）                          */
/* ------------------------------------------------------------------ */

export function suggestHandtraps(
  move: Pick<CardMove, 'from' | 'to' | 'phase'>,
  timing: Pick<Timing, 'operation' | 'from'>,
): string[] {
  if (move.phase !== 'effect') return []
  const out = new Set<string>()
  const fieldEffect = timing.operation === 'activateEffect' && timing.from === 'field'

  if (move.from === 'deck' && move.to === 'hand') {
    out.add('ash')
    out.add('droll')
  }
  if (move.from === 'deck' && move.to === 'gy') out.add('ash')
  if (move.from === 'deck' && move.to === 'field') {
    out.add('ash')
    out.add('maxx')
    out.add('fuwalos')
  }
  if (move.from === 'extra' && move.to === 'field') {
    out.add('maxx')
    out.add('fuwalos')
  }
  if (move.from === 'hand' && move.to === 'field') {
    out.add('maxx')
    out.add('purulia')
  }
  if ((move.from === 'gy' || move.from === 'banish') && (move.to === 'hand' || move.to === 'field')) {
    out.add('belle')
    if (move.to === 'field') {
      out.add('maxx')
      out.add('meowls')
    }
  }
  if (fieldEffect && move.to !== 'st') {
    out.add('veiler')
    out.add('imperm')
    out.add('ogre')
  }
  return [...out]
}

/* ------------------------------------------------------------------ */
/* 卡片 → 时序草稿                                                      */
/* ------------------------------------------------------------------ */

export interface TimingInference {
  operation: OperationKind
  from: ZoneId
  setup: CardMove[]
  cost: CardMove[]
  effect: CardMove[]
  settle: CardMove[]
  handtraps: string[]
  hints: string[]
}

const STAY_KINDS = ['永续', '装备', '场地']

/** 规则处理生成的四个段落 */
export interface RuleMoves {
  setup: CardMove[]
  cost: CardMove[]
  effect: CardMove[]
  settle: CardMove[]
}

export interface RuleInput {
  operation: OperationKind
  card?: CardData | null
  cardName: string
  from?: ZoneId
}

const emptyRules = (): RuleMoves => ({ setup: [], cost: [], effect: [], settle: [] })

function ruleMove(
  cardName: string,
  from: ZoneId,
  to: ZoneId,
  phase: CardMove['phase'],
  note?: string,
  count?: number,
): CardMove {
  return { id: uid(), cardName, from, to, phase, count, note, auto: true }
}

/** 上级召唤需要的祭品数：5·6 星 1 只，7 星以上 2 只 */
export function tributeCount(card?: CardData | null): number {
  const level = card?.level ?? 0
  if (level >= 7) return 2
  if (level >= 5) return 1
  return 1
}

/**
 * 额外卡组召唤（融合 / 同调 / 超量 / 连接）预计消耗的素材数：
 * - 连接：连接标记数 = 连接值
 * - 超量：阶级
 * - 融合 / 同调：至少 2 只
 * 只用于提示，不写进素材行：素材行按「一行一张卡」记录，数量由牌手按实际填。
 */
export function materialCount(card?: CardData | null): number {
  if (!card) return 1
  if (card.rankLabel === 'LINK' || card.kinds.includes('连接')) {
    return Math.max(1, card.linkMarkers?.length || card.level || 1)
  }
  if (card.rankLabel === 'RANK' || card.kinds.includes('超量')) return Math.max(1, card.level || 1)
  if (card.kinds.includes('融合') || card.kinds.includes('同调')) return 2
  return 1
}

/**
 * 规则处理自动生成：按操作类型 + 卡种 + 起始区域，给出「必定发生」的移动。
 * - 召唤 / 特召 / 盖放：主移动（手卡 → 场上 / 魔陷区）
 * - 上级召唤：额外生成祭品解放（场上 → 墓地，记在 cost）
 * - 额外卡组召唤：额外生成素材（场上 → 墓地；超量召唤则叠到怪兽下面）
 * - 超量怪兽在场上发动效果：额外生成「取除超量素材」cost
 * - 魔法 / 陷阱发动：置入魔陷区，结算后送墓 / 去额外 / 留场
 * - 其他怪兽效果发动：不产生规则移动
 */
export function autoRuleMoves({ operation, card, cardName, from }: RuleInput): RuleMoves {
  const out = emptyRules()
  if (!cardName.trim()) return out

  const zone = from || 'hand'
  const kinds = card?.kinds || []
  const isMonster = card?.frame === 'monster'
  const isSpell = card?.frame === 'spell'
  const isTrap = card?.frame === 'trap'
  const isSpellTrap = isSpell || isTrap
  const isPendulumSpell = isSpell && kinds.includes('灵摆')
  const stays = kinds.some((kind) => STAY_KINDS.includes(kind))

  switch (operation) {
    case 'normalSummon':
      out.effect.push(ruleMove(cardName, zone, 'field', 'effect', '召唤到场上'))
      return out

    case 'tributeSummon': {
      const count = tributeCount(card)
      out.cost.push(
        ruleMove('解放的怪兽', 'field', 'gy', 'cost', `解放 ${count} 只怪兽作为祭品`, count),
      )
      out.effect.push(ruleMove(cardName, zone, 'field', 'effect', '上级召唤到场上'))
      return out
    }

    case 'specialSummon': {
      // 魔法 / 陷阱卡靠效果特召：它同样是"发动"，有置入魔陷区与结算后去向
      if (isSpellTrap) {
        if (zone !== 'st') out.setup.push(ruleMove(cardName, zone, 'st', 'auto', '发动时置入魔陷区'))
        if (isPendulumSpell) {
          out.settle.push(ruleMove(cardName, 'st', 'extra', 'auto', '灵摆魔法结算后表侧加入额外卡组'))
          return out
        }
        if (!stays) out.settle.push(ruleMove(cardName, 'st', 'gy', 'auto', '结算后送去墓地'))
        return out
      }
      // 额外卡组召唤：素材是召唤手续的一部分，必定发生，记在规则处理段
      // 一行 = 一张素材卡，不带数量与说明；超量召唤的素材挂在怪兽下面，其他召唤送墓
      if (zone === 'extra' && isExtraDeckCard(card)) {
        out.setup.push(
          ruleMove('作为素材的怪兽', 'field', isXyzCard(card) ? 'material' : 'gy', 'auto'),
        )
      }
      out.effect.push(ruleMove(cardName, zone, 'field', 'effect', '特殊召唤到场上'))
      return out
    }

    case 'set':
      // 怪兽盖放 = 里侧守备表示放到怪兽区；魔陷盖放到魔陷区
      if (isMonster) {
        out.effect.push({
          ...ruleMove(cardName, zone, 'field', 'effect', '盖放怪兽（里侧守备）'),
          position: 'set',
        })
        return out
      }
      out.effect.push(ruleMove(cardName, zone, 'st', 'effect', '盖放到魔陷区'))
      return out

    case 'draw':
      out.effect.push(ruleMove(UNKNOWN_CARD, 'deck', 'hand', 'effect', '抽 1 张（未知卡片）'))
      return out

    case 'activate': {
      // 怪兽没有魔陷区规则处理
      if (isMonster) return out
      if (zone !== 'st') out.setup.push(ruleMove(cardName, zone, 'st', 'auto', '发动时置入魔陷区'))

      if (isPendulumSpell) {
        out.settle.push(ruleMove(cardName, 'st', 'extra', 'auto', '灵摆魔法结算后表侧加入额外卡组'))
        return out
      }
      if (isSpellTrap && stays) return out
      out.settle.push(ruleMove(cardName, 'st', 'gy', 'auto', '结算后送去墓地'))
      return out
    }

    case 'activateEffect': {
      // 魔陷在魔陷区发动效果：结算后送墓（永续 / 装备 / 场地留场）
      if (isSpellTrap && zone === 'st' && !stays && !isPendulumSpell) {
        out.settle.push(ruleMove(cardName, 'st', 'gy', 'auto', '结算后送去墓地'))
      }
      // 超量怪兽在场上发动效果：取除超量素材是发动代价
      if (isXyzCard(card) && zone === 'field') {
        out.cost.push(ruleMove('取除的素材', 'material', 'gy', 'cost'))
      }
      return out
    }

    default:
      return out
  }
}

/** 重算规则段时复用旧行的 id，避免已建立的跨时序连线失效 */
export function reuseAutoIds(next: CardMove[], prev: CardMove[]): CardMove[] {
  return next.map((item) => {
    if (!item.auto) return item
    const old = prev.find(
      (candidate) =>
        candidate.auto &&
        candidate.cardName === item.cardName &&
        candidate.from === item.from &&
        candidate.to === item.to &&
        candidate.note === item.note,
    )
    // 复用 id 时保留用户为这一行选过的格位
    return old ? { ...item, id: old.id, slot: old.slot } : item
  })
}

function move(
  cardName: string,
  from: ZoneId,
  to: ZoneId,
  phase: CardMove['phase'],
  note?: string,
  count?: number,
): CardMove {
  return { id: uid(), cardName, from, to, phase, count, note }
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

export interface InferOptions {
  /** 限定操作类别：选了「卡片操作」时不再推断召唤 / 盖放这类牌手操作 */
  kind?: 'player' | 'card'
}

export function inferTiming(card: CardData, options: InferOptions = {}): TimingInference {
  const text = pickEffectSegment(card)
  const extra = isExtraDeckCard(card)
  const normal = card.frame === 'monster' && card.kinds.includes('通常')
  const hints: string[] = []

  const gyTrigger = TEST.gyTrigger.test(text)
  const discardSelf = TEST.discardSelf.test(text)
  const addsFromDeck = TEST.addFromDeck.test(text) || TEST.addFromDeckMixed.test(text)
  const ssFromDeck = TEST.ssFromDeck.test(text)
  const ssFromExtra = TEST.ssFromExtra.test(text)
  const ssFromHand = TEST.ssFromHand.test(text)
  const sendFromDeck = TEST.sendFromDeck.test(text)
  const fromGY = TEST.fromGY.test(text)
  const discardOther = TEST.discardOther.test(text) && !discardSelf
  const setToField = TEST.setToField.test(text)

  let operation: OperationKind = 'activate'
  let from: ZoneId = card.frame === 'monster' ? 'field' : 'hand'

  if (options.kind === 'card') {
    // 卡片操作：只可能是「发动卡片效果」（超量 / 额外卡组怪兽也按场上发动处理）
    operation = 'activateEffect'
    from = card.frame === 'monster' ? (gyTrigger ? 'gy' : 'field') : gyTrigger ? 'gy' : 'st'
  } else if (card.frame === 'monster') {
    if (normal) {
      if ((card.level ?? 0) >= 5) {
        operation = 'tributeSummon'
        from = 'hand'
        hints.push('5 星以上通常召唤需要解放怪兽，祭品已记在 cost 段')
      } else {
        operation = 'normalSummon'
        from = 'hand'
      }
    } else if (extra) {
      operation = 'specialSummon'
      from = 'extra'
    } else if (gyTrigger) {
      operation = 'activateEffect'
      from = 'gy'
      hints.push('墓地发动：需要先让它进入墓地')
    } else if (TEST.ss.test(text) && !ssFromDeck) {
      operation = 'specialSummon'
      from = 'hand'
    } else {
      operation = 'activateEffect'
    }
  } else if (setToField) {
    operation = 'set'
  }

  const setup: CardMove[] = []
  const settle: CardMove[] = []
  const cost: CardMove[] = []
  const effect: CardMove[] = []

  if (discardSelf) {
    cost.push(move(card.name, 'hand', 'gy', 'cost', '从手卡丢弃自身'))
    hints.push('丢弃自身是 cost：必定成功，不吃手坑')
  }

  // 规则处理：召唤 / 盖放 / 发动的主移动与结算去向，全部由卡种和操作推导
  const rules = autoRuleMoves({ operation, card, cardName: card.name, from })
  setup.push(...rules.setup)
  cost.push(...rules.cost)
  effect.push(...rules.effect)
  settle.push(...rules.settle)
  if (operation === 'activate') hints.push('发动：置入魔陷区；结算后按卡种送墓或留场')
  if (operation === 'tributeSummon') hints.push('祭品记在 cost 段，可改成具体的怪兽')
  if (operation === 'specialSummon' && from === 'extra' && rules.setup.length) {
    hints.push(
      isXyzCard(card)
        ? '超量召唤的素材记在规则处理段，会叠在这只怪兽下面'
        : '额外卡组召唤的素材记在规则处理段：可改成除外 / 具体怪兽',
    )
  }
  if (operation === 'activateEffect' && isXyzCard(card) && from === 'field') {
    hints.push('超量怪兽发动效果：取除素材已记入 cost')
  }

  if (addsFromDeck) {
    effect.push(move('检索目标', 'deck', 'hand', 'effect', '从卡组加入手卡'))
    hints.push('卡组 → 手卡：灰流丽 / 锁鸟 可响应')
  }
  if (sendFromDeck) {
    effect.push(move('堆墓目标', 'deck', 'gy', 'effect', '从卡组送去墓地'))
    hints.push('卡组 → 墓地：灰流丽可响应')
  }
  if (ssFromDeck) {
    effect.push(move('特召目标', 'deck', 'field', 'effect', '从卡组特殊召唤'))
    hints.push('卡组 → 场上：灰流丽 / 山雀 可响应')
  } else if (ssFromExtra) {
    effect.push(move('额外特召目标', 'extra', 'field', 'effect', '从额外卡组特殊召唤'))
  } else if (ssFromHand) {
    effect.push(move('仪式召唤目标', 'hand', 'field', 'effect', '从手卡特殊召唤'))
  }
  if (discardOther) {
    effect.push({
      id: uid(),
      cardName: UNKNOWN_CARD,
      unknown: true,
      from: 'hand',
      to: 'gy',
      phase: 'effect',
      note: '那之后丢弃 1 张手卡（未知）',
    })
  }
  const drawMatch = /抽([0-9一二三四五六七八九十两]+)张/.exec(text)
  if (drawMatch) {
    const count = parseCount(drawMatch[1])
    effect.push({
      id: uid(),
      cardName: UNKNOWN_CARD,
      unknown: true,
      count,
      from: 'deck',
      to: 'hand',
      phase: 'effect',
      note: `抽 ${count} 张（未知卡片）`,
    })
    hints.push('未知抽卡不计入具名链路，只影响手卡数量')
  }

  // 默认手坑建议
  for (const item of effect) item.handtraps = suggestHandtraps(item, { operation, from })

  if (fromGY) hints.push('墓地取牌 / 特召：屋敷童可响应')
  if (setToField) hints.push('可以从卡组盖放')
  hints.push('cost 与效果已分开记录，可逐段改')

  return { operation, from, setup, cost, effect, settle, handtraps: [], hints }
}

export function makeTiming(card: CardData): Timing {
  const inferred = inferTiming(card)
  return {
    id: uid(),
    cardId: card.id,
    operation: inferred.operation,
    cardName: card.name,
    from: inferred.from,
    setup: inferred.setup,
    cost: inferred.cost,
    effect: inferred.effect,
    settle: inferred.settle,
    chains: [],
    handtraps: inferred.handtraps,
    note: '',
  }
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

/* ------------------------------------------------------------------ */
/* 检索目标建议                                                         */
/* ------------------------------------------------------------------ */

const RACES = [
  '战士', '魔法师', '天使', '恶魔', '不死', '机械', '水', '炎', '岩石', '鸟兽', '植物', '昆虫',
  '雷', '龙', '兽', '兽战士', '恐龙', '鱼', '海龙', '爬虫类', '念动力', '幻龙', '电子界', '幻想魔',
]

export function suggestTargets(source: CardData, deck: CardData[]): CardData[] {
  const text = pickEffectSegment(source)
  if (!deck.length) return []
  const quoted = [...text.matchAll(/「([^」]{1,12})」/g)].map((m) => m[1])
  const levelMax = /(\d{1,2})星以下/.exec(text)?.[1]
  const levelMin = /(\d{1,2})星以上/.exec(text)?.[1]
  const race = RACES.find((r) => text.includes(`${r}族`))
  const attributes = ['光', '暗', '地', '水', '炎', '风', '神']
  const attribute = attributes.find((a) => text.includes(`${a}属性`))
  const wantsSpell = text.includes('魔法卡')
  const wantsTrap = text.includes('陷阱卡')

  if (!quoted.length && !levelMax && !levelMin && !race && !attribute && !wantsSpell && !wantsTrap) return []

  const filtered = deck.filter((c) => {
    if (quoted.length && !quoted.some((q) => c.name.includes(q))) return false
    if (levelMax && (c.level ?? 99) > Number(levelMax)) return false
    if (levelMin && (c.level ?? 0) < Number(levelMin)) return false
    if (race && c.race !== race) return false
    if (attribute && c.attribute !== attribute) return false
    if (wantsSpell && c.frame !== 'spell') return false
    if (wantsTrap && c.frame !== 'trap') return false
    return true
  })

  return filtered.slice(0, 8)
}
