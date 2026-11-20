import type { DeckEntry } from '@/types'
import { allPresentChance } from '@/lib/starter'
import { buildRateModel, openingChance, type RateClause, type RatePlan } from '@/lib/rates'
import type { HandtrapDef } from '@/lib/handtraps'

/**
 * 起手样本推导（对战分析的自动层）。
 *
 * 输入是卡组 + 启动率配置（RatePlan 的启动条件 / 废件，或卡组页的简易启动组），
 * 输出是六类起手的概率与「代表起手」：
 *
 *   solo      单卡启动（某个启动组只要求 1 张卡）
 *   combo     双卡 / 多卡组合（启动组要求 ≥2 张）
 *   none      无启动点
 *   handtrap  手上带手坑
 *   second    后攻（多抽 1 张）的启动样本
 *
 * 样本不是随机抽的，而是从启动条件里「反推」出来的最小可行手牌：
 * 要什么卡就放什么卡，剩下的位置用卡组里张数最多的非启动卡补满，
 * 这样每一类都能给出一个稳定、可复现、能直接写进 skill 的起手。
 */
export type SampleKind = 'solo' | 'combo' | 'none' | 'handtrap' | 'second'

export interface HandSample {
  kind: SampleKind
  /** 手牌卡号（同名卡会出现多次） */
  hand: number[]
  /** 命中的启动组 / 说明 */
  clause: string
  /** 这个起手（该启动组）成立的概率 */
  chance: number
}

export interface SampleGroup {
  kind: SampleKind
  label: string
  /** 这一类的整体概率（组间可能有重叠，不要直接相加） */
  chance: number
  samples: HandSample[]
  note?: string
}

export interface SampleReport {
  available: boolean
  handSize: number
  secondHandSize: number
  deckSize: number
  /** 卡组里张数最多、可作为「其他卡」的卡 */
  filler: string[]
  groups: SampleGroup[]
  notes: string[]
}

export interface StarterSource {
  plan?: RatePlan | null
  /** 卡组页的简易启动组：每组卡号，组内需要同时上手 */
  starterGroups?: { id: string; cards: number[] }[]
  nameOf: (code: number) => string
}

export interface SampleInput extends StarterSource {
  main: DeckEntry[]
  handtraps?: HandtrapDef[]
}

/** 启动条件：优先用启动率页的 RatePlan，退回卡组页的简易启动组 */
export function listStarterClauses(source: StarterSource): RateClause[] {
  const fromPlan = (source.plan?.starters ?? []).filter((clause) => clause.slots.length)
  if (fromPlan.length) return fromPlan
  return (source.starterGroups ?? [])
    .filter((group) => group.cards.length)
    .map((group, index) => ({
      id: group.id || `starter-${index}`,
      slots: group.cards.map((id) => ({ cardId: id, name: source.nameOf(id), min: 1, max: null })),
    }))
}

const MAX_SAMPLES = 4
const MAX_COMPROMISE_SAMPLES = 2

const KIND_LABEL: Record<SampleKind, string> = {
  solo: '单卡启动',
  combo: '双卡 / 多卡组合',
  none: '无启动点',
  handtrap: '手坑起手',
  second: '后攻起手',
}

export function buildSampleReport(input: SampleInput): SampleReport {
  const { main, nameOf } = input
  const deckSize = totalCount(main)
  const handSize = Math.max(1, Math.floor(Number(input.plan?.handSize) || 5))
  const secondHandSize = handSize + 1
  const notes: string[] = []
  const groups: SampleGroup[] = []
  const clauses = listStarterClauses(input)
  const filler = main
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((entry) => nameOf(entry.id) || entry.name)

  if (!clauses.length || deckSize <= 0) {
    return {
      available: false,
      handSize,
      secondHandSize,
      deckSize,
      filler,
      groups,
      notes: [
        '还没有配置启动条件：先在「启动率」页设置启动组 / 启动条件（或卡组页的启动组合），才能推导起手样本。',
      ],
    }
  }

  const blockers = input.plan?.blockers ?? []
  const model = buildRateModel(main, clauses, blockers)
  const allChance = openingChance(model, clauses, blockers, handSize)
  const soloClauses = clauses.filter((clause) => requiredCount(clause) === 1)
  const comboClauses = clauses.filter((clause) => requiredCount(clause) >= 2)
  const starterIds = new Set(
    clauses.flatMap((clause) => clause.slots.filter((slot) => slot.min > 0).map((slot) => slot.cardId)),
  )
  // 手坑卡同时也是启动卡时不算「额外的手坑」：这类卡按启动点讨论更准确
  const handtrapIds = handtrapCardIds(input.handtraps, main).filter((id) => !starterIds.has(id))
  const handtrapCopies = handtrapIds.reduce((sum, id) => sum + copiesOf(main, id), 0)
  const handtrapChance = atLeastOneChance(deckSize, handtrapCopies, handSize)
  const secondChance = openingChance(model, clauses, blockers, secondHandSize)

  if (soloClauses.length) {
    const ranked = rankClauses(soloClauses, main, handSize)
    groups.push({
      kind: 'solo',
      label: KIND_LABEL.solo,
      chance: openingChance(model, soloClauses, blockers, handSize),
      samples: ranked.slice(0, MAX_SAMPLES).map((item) => ({
        kind: 'solo' as const,
        hand: buildHand(item.clause, main, handSize, [], starterIds),
        clause: clauseLabel(item.clause),
        chance: item.chance,
      })),
    })
  }

  if (comboClauses.length) {
    const ranked = rankClauses(comboClauses, main, handSize)
    groups.push({
      kind: 'combo',
      label: KIND_LABEL.combo,
      chance: openingChance(model, comboClauses, blockers, handSize),
      samples: ranked.slice(0, MAX_SAMPLES).map((item) => ({
        kind: 'combo' as const,
        hand: buildHand(item.clause, main, handSize, [], starterIds),
        clause: clauseLabel(item.clause),
        chance: item.chance,
      })),
    })
  }

  const noneChance = Math.max(0, 1 - allChance)
  if (noneChance > 0) {
    const exclude = new Set([...starterIds, ...handtrapIds])
    groups.push({
      kind: 'none',
      label: KIND_LABEL.none,
      chance: noneChance,
      samples: [
        {
          kind: 'none',
          hand: buildHand({ id: 'none', slots: [] }, main, handSize, [], exclude),
          clause: '不满足任何启动组',
          chance: noneChance,
        },
      ],
      note: '这类起手只能靠抽滤 / 检索补启动点，或直接进入防守回合。',
    })
  }

  if (handtrapIds.length && handtrapChance > 0) {
    const base = rankClauses(soloClauses.length ? soloClauses : comboClauses, main, handSize)[0]
    if (base) {
      const handtrapId = handtrapIds[0]
      const hand = buildHand(base.clause, main, handSize, [handtrapId], starterIds)
      groups.push({
        kind: 'handtrap',
        label: KIND_LABEL.handtrap,
        chance: handtrapChance,
        samples: [
          {
            kind: 'handtrap',
            hand,
            clause: `${clauseLabel(base.clause)} + ${nameOf(handtrapId) || `#${handtrapId}`}`,
            chance: Math.min(base.chance, handtrapChance),
          },
        ],
        note: '手坑在场时启动点要少 1 张，注意留出防守位。',
      })
    }
  }

  if (secondChance > 0) {
    const bases = rankClauses([...soloClauses, ...comboClauses], main, secondHandSize).slice(0, MAX_COMPROMISE_SAMPLES)
    const handtrapId = handtrapIds[0]
    groups.push({
      kind: 'second',
      label: KIND_LABEL.second,
      chance: secondChance,
      samples: bases.map((item) => ({
        kind: 'second' as const,
        hand: buildHand(item.clause, main, secondHandSize, handtrapId ? [handtrapId] : [], starterIds),
        clause: clauseLabel(item.clause),
        chance: item.chance,
      })),
      note: '后攻按多抽 1 张计算；对局里还要考虑对手的阻抗。',
    })
  }

  if (groups.some((group) => group.kind === 'solo') && groups.some((group) => group.kind === 'combo')) {
    notes.push('单卡启动与多卡组合可能同时成立，两类概率不可直接相加。')
  }
  if (!input.plan?.starters.length) {
    notes.push('当前用的是卡组页的简易启动组合，若要区分「同名双卡动 / 至多几张」，请到「启动率」页配置启动条件。')
  }

  return {
    available: groups.length > 0,
    handSize,
    secondHandSize,
    deckSize,
    filler,
    groups,
    notes,
  }
}

/** 启动组里需要「至少 1 张」的卡有几张 */
function requiredCount(clause: RateClause): number {
  return clause.slots.filter((slot) => slot.min > 0).length
}

function clauseLabel(clause: RateClause): string {
  const parts = clause.slots
    .map((slot) => {
      if (slot.min <= 0) return slot.max !== null ? `${slot.name} 至多 ${slot.max}` : ''
      const range = slot.max !== null && slot.max > slot.min ? `${slot.min}~${slot.max}` : `${slot.min}`
      return `${slot.name}×${range}`
    })
    .filter(Boolean)
  return parts.join(' + ') || '（空启动组）'
}

function rankClauses(clauses: RateClause[], main: DeckEntry[], draws: number): { clause: RateClause; chance: number }[] {
  const deckSize = totalCount(main)
  return clauses
    .map((clause) => ({
      clause,
      chance: allPresentChance(
        deckSize,
        clause.slots.filter((slot) => slot.min > 0).map((slot) => copiesOf(main, slot.cardId)),
        draws,
      ),
    }))
    .sort((a, b) => b.chance - a.chance)
}

/**
 * 按启动组构造最小起手：必需的卡各放够张数，手坑按 extra 追加，
 * 剩下位置用卡组里张数最多、且不在 exclude 里的卡补满。
 */
function buildHand(
  clause: RateClause,
  main: DeckEntry[],
  size: number,
  extra: number[],
  exclude: Set<number>,
): number[] {
  const want = new Map<number, number>()
  for (const id of extra) want.set(id, (want.get(id) || 0) + 1)
  for (const slot of clause.slots) {
    if (slot.min <= 0) continue
    const need = Math.min(slot.min, copiesOf(main, slot.cardId))
    want.set(slot.cardId, Math.max(want.get(slot.cardId) || 0, need))
  }

  const hand: number[] = []
  for (const [id, count] of want) {
    for (let i = 0; i < count && hand.length < size; i += 1) hand.push(id)
  }
  return fillHand(hand, size, main, exclude)
}

function fillHand(hand: number[], size: number, main: DeckEntry[], exclude: Set<number>): number[] {
  const out = [...hand]
  const used = new Map<number, number>()
  for (const id of out) used.set(id, (used.get(id) || 0) + 1)

  const pool = [...main]
    .filter((entry) => entry.count > 0 && !exclude.has(entry.id))
    .sort((a, b) => b.count - a.count)
  let guard = 0
  while (out.length < size && guard < 400) {
    guard += 1
    // 先让每种卡各出现 1 张，再补第二、第三张：比一路填同一张更像真实起手
    const next =
      pool.find((entry) => (used.get(entry.id) || 0) === 0) ||
      pool.find((entry) => (used.get(entry.id) || 0) < entry.count)
    if (!next) break
    out.push(next.id)
    used.set(next.id, (used.get(next.id) || 0) + 1)
  }
  return out.slice(0, size)
}

function handtrapCardIds(handtraps: HandtrapDef[] | undefined, main: DeckEntry[]): number[] {
  if (!handtraps?.length) return []
  const ids = new Set<number>()
  for (const def of handtraps) {
    if (def.cardId && copiesOf(main, def.cardId) > 0) ids.add(def.cardId)
  }
  return [...ids]
}

/** 起手 n 张里至少出现 1 张手坑的概率 */
function atLeastOneChance(deckSize: number, hits: number, draws: number): number {
  if (deckSize <= 0 || hits <= 0) return 0
  const n = Math.min(Math.max(0, Math.floor(draws)), deckSize)
  const h = Math.min(hits, deckSize)
  let miss = 1
  for (let i = 0; i < n; i += 1) {
    const remain = deckSize - h - i
    if (remain <= 0) {
      miss = 0
      break
    }
    miss *= remain / (deckSize - i)
  }
  return Math.min(1, Math.max(0, 1 - miss))
}

function totalCount(list: DeckEntry[]): number {
  return list.reduce((sum, entry) => sum + Math.max(0, Math.floor(Number(entry.count) || 0)), 0)
}

function copiesOf(main: DeckEntry[], id: number): number {
  return main.filter((entry) => entry.id === id).reduce((sum, entry) => sum + Math.max(0, entry.count), 0)
}
