/**
 * 启动率内核：把「起手 → 抽滤 → 判定」看成一串**有序随机过程**。
 *
 * 模型只有三块，彼此正交：
 *
 *   1. 目标（starters）：若干「组」，组内 AND（槽位区间全满足）、组间 OR。
 *      每个槽位是一段张数区间 `min ≤ 手牌张数 ≤ max`，
 *      所以「必须上手」「同名双卡动」「手牌里最多 1 张」都用同一套判定。
 *   2. 否决（blockers）：废件。这些卡在手牌里合计超过 allowance 时——
 *      `clear: 'never'`     → 本局永久失败（之后丢牌 / 送墓也救不回）；
 *      `clear: 'leaveHand'` → 只看当前手牌，丢掉就解除。
 *   3. 转移（effects）：抽滤效果 = 一串算子，按顺序执行。
 *
 * 抽滤算子只有两种原子操作：
 *
 *   dig    ：从卡组顶看 `reveal` 张，挑 `take` 张入手，其余去 `sink`
 *   discard：从手牌丢掉 `count` 张（或全部）
 *
 * 于是：
 *   强欲之壶      = [dig 2/2]
 *   成金哥布林    = [dig 1/1]
 *   强贪壶        = [dig 10/0 → 除外] + [dig 2/2]
 *   翻 6 拿 1     = [dig 6/1 → 送墓]
 *   抽 3 丢 2     = [dig 3/3] + [discard 2]
 *   手札抹杀      = [discard 全部] + [dig 5/5]
 *
 * 求解：
 *   1. 卡组压缩成「等价类」——只有条件里出现过的卡各不相同，其余合并成 filler。
 *   2. 对**算子**做值迭代：V(i, hand, deck) 表示执行到第 i 个算子时还能启动的概率。
 *      抽到什么求期望，挑哪张 / 丢哪张取最大值，因此结果是**最优操作策略**下的启动率。
 *   3. 状态数或耗时超出预算时退回蒙特卡洛仿真，给出置信区间。
 */

import type { DeckEntry } from '@/types'

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

/** 一张卡在手牌里的数量区间 */
export interface RateSlot {
  cardId: number
  name: string
  /** 至少几张（0 = 只做上限约束） */
  min: number
  /** 至多几张；null = 不限 */
  max: number | null
}

/** 一组条件：组内 AND */
export interface RateClause {
  id: string
  slots: RateSlot[]
}

/** 若干组：组间 OR */
export type RateCondition = RateClause[]

/** 废件里的一张卡 */
export interface RateBlockerCard {
  id: number
  name: string
}

/**
 * 废件（否决项）。
 * `cards` 里的卡在手牌中合计超过 `allowance` 张时触发。
 */
export interface RateBlocker {
  id: string
  cards: RateBlockerCard[]
  /** 允许在手牌里同时存在的张数，默认 0 */
  allowance: number
  /** 生效区域；目前只有手牌 */
  zone: 'hand'
  /**
   * 解除方式：
   *   leaveHand —— 只看当前手牌，丢掉 / 送墓后失效（占位型废件）
   *   never     —— 上手即定局，本局永久失败（效果型废件）
   */
  clear: 'leaveHand' | 'never'
}

/** 没入手的牌去哪 */
export type RateSink = 'gy' | 'banish' | 'bottom'

/**
 * 一个原子算子。`kind` 决定用哪组字段：
 *   dig     → reveal / take / sink   （看 `reveal` 张，挑 `take` 张入手，其余去 `sink`）
 *   discard → count / all            （从手牌丢 `count` 张，`all` 为 true 时丢光）
 */
export interface RateOp {
  id: string
  kind: 'dig' | 'discard'
  reveal: number
  take: number
  sink: RateSink
  count: number
  all: boolean
}

export interface RateEffect {
  id: string
  /** 发动这个效果的卡；为 null 表示手动填写的假想效果 */
  sourceId: number | null
  name: string
  /** 按顺序执行的算子 */
  ops: RateOp[]
  /** 发动条件：与启动条件同构，支持「至多」 */
  requirement: RateCondition
  /** 可留手不打时为 true */
  optional: boolean
}

export interface RatePlan {
  handSize: number
  /** 启动条件：组间 OR、组内 AND */
  starters: RateCondition
  /** 废件 */
  blockers: RateBlocker[]
  effects: RateEffect[]
}

/* ------------------------------------------------------------------ */
/* 默认值与归一化                                                       */
/* ------------------------------------------------------------------ */

let seq = 0
function nextId(prefix: string): string {
  seq += 1
  return `${prefix}${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export const MAX_REVEAL = 12
export const MAX_DISCARD = 8
export const MAX_SLOT = 3

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const num = Math.floor(Number(value))
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, num))
}

export function blankPlan(): RatePlan {
  return { handSize: 5, starters: [], blockers: [], effects: [] }
}

export function blankClause(): RateClause {
  return { id: nextId('c'), slots: [] }
}

export function blankBlocker(cardId: number, name: string): RateBlocker {
  return {
    id: nextId('b'),
    cards: [{ id: cardId, name }],
    allowance: 0,
    zone: 'hand',
    clear: 'never',
  }
}

export function blankSlot(cardId: number, name: string): RateSlot {
  return { cardId, name, min: 1, max: null }
}

export function blankOp(kind: RateOp['kind'] = 'dig'): RateOp {
  return {
    id: nextId('o'),
    kind,
    reveal: kind === 'dig' ? 1 : 0,
    take: kind === 'dig' ? 1 : 0,
    sink: 'gy',
    count: kind === 'discard' ? 1 : 0,
    all: false,
  }
}

export function blankEffect(): RateEffect {
  return {
    id: nextId('e'),
    sourceId: null,
    name: '',
    ops: [blankOp('dig')],
    requirement: [],
    optional: false,
  }
}

function normalizeSlot(raw: unknown): RateSlot | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const cardId = Number(item.cardId ?? item.id)
  const name = String(item.name || '')
  if (!(cardId > 0) || !name) return null
  const min = clampInt(item.min ?? item.count, 0, MAX_SLOT, 1)
  const maxRaw = item.max
  let max: number | null = null
  if (maxRaw !== null && maxRaw !== undefined && maxRaw !== '') {
    const num = Number(maxRaw)
    if (Number.isFinite(num)) max = clampInt(num, 0, MAX_SLOT, min)
  }
  if (max !== null && max < min) max = min
  return { cardId, name, min, max }
}

function normalizeClauses(value: unknown): RateCondition {
  if (!Array.isArray(value)) return []
  const out: RateCondition = []
  for (const raw of value) {
    if (Array.isArray(raw)) {
      const slots = raw.map(normalizeSlot).filter((slot): slot is RateSlot => !!slot)
      if (slots.length) out.push({ id: nextId('c'), slots })
      continue
    }
    if (!raw || typeof raw !== 'object') continue
    const clause = raw as Partial<RateClause>
    const slots = Array.isArray(clause.slots)
      ? clause.slots.map(normalizeSlot).filter((slot): slot is RateSlot => !!slot)
      : []
    if (!slots.length) continue
    out.push({ id: String(clause.id || nextId('c')), slots })
  }
  return out
}

function normalizeBlockerCards(value: unknown): RateBlockerCard[] {
  if (!Array.isArray(value)) return []
  const out: RateBlockerCard[] = []
  const seen = new Set<number>()
  for (const raw of value) {
    if (typeof raw === 'number') {
      if (!(raw > 0) || seen.has(raw)) continue
      seen.add(raw)
      out.push({ id: raw, name: `#${raw}` })
      continue
    }
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const id = Number(item.id ?? item.cardId)
    if (!(id > 0) || seen.has(id)) continue
    seen.add(id)
    out.push({ id, name: String(item.name || `#${id}`) })
  }
  return out
}

function normalizeBlockers(value: unknown): RateBlocker[] {
  if (!Array.isArray(value)) return []
  const out: RateBlocker[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const cards = normalizeBlockerCards(item.cards)
    if (!cards.length) continue
    const key = cards
      .map((card) => card.id)
      .sort((a, b) => a - b)
      .join(',')
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      id: String(item.id || nextId('b')),
      cards,
      allowance: clampInt(item.allowance, 0, MAX_SLOT, 0),
      zone: 'hand',
      clear: item.clear === 'leaveHand' ? 'leaveHand' : 'never',
    })
  }
  return out
}

/** 旧版配置（groups + exclude）转成 starters + blockers */
function migrateLegacyPlan(data: Record<string, unknown>): {
  starters: RateCondition
  blockers: RateBlocker[]
} {
  const starters: RateCondition = []
  const banned = new Map<number, { name: string; allowance: number; clear: 'never' | 'leaveHand' }>()
  for (const raw of data.groups as Array<Record<string, unknown>>) {
    if (!raw || typeof raw !== 'object') continue
    const slots = Array.isArray(raw.cards)
      ? (raw.cards as unknown[]).map(normalizeSlot).filter((slot): slot is RateSlot => !!slot)
      : []
    if (!slots.length) continue
    starters.push({ id: String(raw.id || nextId('c')), slots })
    if (!Array.isArray(raw.exclude)) continue
    for (const card of raw.exclude as Array<Record<string, unknown>>) {
      const id = Number(card?.id)
      if (!(id > 0)) continue
      const allowance = clampInt(card?.max, 0, MAX_SLOT, 0)
      const clear: 'never' | 'leaveHand' = card?.removable ? 'leaveHand' : 'never'
      const prev = banned.get(id)
      if (!prev) {
        banned.set(id, { name: String(card?.name || `#${id}`), allowance, clear })
        continue
      }
      prev.allowance = Math.min(prev.allowance, allowance)
      if (clear === 'never') prev.clear = 'never'
    }
  }
  const blockers: RateBlocker[] = [...banned.entries()].map(([id, info]) => ({
    id: nextId('b'),
    cards: [{ id, name: info.name }],
    allowance: info.allowance,
    zone: 'hand',
    clear: info.clear,
  }))
  return { starters, blockers }
}

function normalizeEffect(raw: unknown): RateEffect | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  let ops: RateOp[] = []
  if (Array.isArray(item.ops)) {
    for (const op of item.ops) {
      const normalized = normalizeOp(op)
      if (normalized) ops.push(normalized)
    }
  }
  if (!ops.length && item.look !== undefined) ops = legacyToOps(item)
  const requirement = Array.isArray(item.requirement)
    ? normalizeClauses(item.requirement)
    : normalizeClauses(item.gate)
  return {
    id: String(item.id || nextId('e')),
    sourceId: Number(item.sourceId) > 0 ? Number(item.sourceId) : null,
    name: String(item.name || ''),
    ops,
    requirement,
    optional: Boolean(item.optional),
  }
}

function normalizeOp(raw: unknown): RateOp | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const kind = item.kind === 'discard' ? 'discard' : 'dig'
  const sink: RateSink = item.sink === 'banish' || item.sink === 'bottom' ? item.sink : 'gy'
  const reveal = clampInt(item.reveal, 0, MAX_REVEAL, 1)
  return {
    id: String(item.id || nextId('o')),
    kind,
    reveal,
    take: Math.min(reveal, clampInt(item.take, 0, MAX_REVEAL, 1)),
    sink,
    count: clampInt(item.count, 0, MAX_DISCARD, 1),
    all: Boolean(item.all),
  }
}

/**
 * 旧结构（look / keep / discard / rest）自动转成算子序列：
 *   [dig look/keep → rest] + [discard N]
 */
function legacyToOps(item: Record<string, unknown>): RateOp[] {
  const reveal = clampInt(item.look, 0, MAX_REVEAL, 1)
  const take = Math.min(reveal, clampInt(item.keep, 0, MAX_REVEAL, 1))
  const dig = blankOp('dig')
  dig.reveal = reveal
  dig.take = take
  dig.sink = item.rest === 'bottom' ? 'bottom' : 'gy'
  const ops: RateOp[] = [dig]
  const discard = clampInt(item.discard, 0, MAX_DISCARD, 0)
  if (discard > 0) {
    const drop = blankOp('discard')
    drop.count = discard
    ops.push(drop)
  }
  return ops
}

/** 读档用：任何脏数据都要能还原成合法配置 */
export function normalizePlan(raw: unknown): RatePlan {
  if (!raw || typeof raw !== 'object') return blankPlan()
  const data = raw as Record<string, unknown>
  let starters: RateCondition = []
  let blockers: RateBlocker[] = []

  if (Array.isArray(data.starters) || Array.isArray(data.blockers)) {
    starters = normalizeClauses(data.starters)
    blockers = normalizeBlockers(data.blockers)
  } else if (Array.isArray(data.groups)) {
    const migrated = migrateLegacyPlan(data)
    starters = migrated.starters
    blockers = migrated.blockers
  }

  const effects: RateEffect[] = []
  if (Array.isArray(data.effects)) {
    for (const effect of data.effects) {
      const normalized = normalizeEffect(effect)
      if (normalized) effects.push(normalized)
    }
  }

  return { handSize: clampInt(data.handSize, 1, 20, 5), starters, blockers, effects }
}

export function clonePlan(plan: RatePlan): RatePlan {
  return {
    handSize: plan.handSize,
    starters: plan.starters.map((clause) => ({
      id: clause.id,
      slots: clause.slots.map((slot) => ({ ...slot })),
    })),
    blockers: plan.blockers.map((blocker) => ({
      ...blocker,
      cards: blocker.cards.map((card) => ({ ...card })),
    })),
    effects: plan.effects.map((effect) => ({
      ...effect,
      ops: effect.ops.map((op) => ({ ...op })),
      requirement: effect.requirement.map((clause) => ({
        id: clause.id,
        slots: clause.slots.map((slot) => ({ ...slot })),
      })),
    })),
  }
}

/* ------------------------------------------------------------------ */
/* 判定                                                                */
/* ------------------------------------------------------------------ */

function slotHolds(count: number, slot: RateSlot): boolean {
  if (count < slot.min) return false
  if (slot.max !== null && count > slot.max) return false
  return true
}

/** 一组槽位是否全部满足 */
export function clauseHolds(
  hand: number[],
  clause: RateClause,
  index: Map<number, number>,
): boolean {
  for (const slot of clause.slots) {
    const at = index.get(slot.cardId)
    if (at === undefined) {
      // 卡组里没有这张牌：只要要求「至少 1 张」，就永远不成立
      if (slot.min > 0) return false
      continue
    }
    if (!slotHolds(hand[at] || 0, slot)) return false
  }
  return true
}

/** 任意一组成立即算满足 */
export function meets(
  hand: number[],
  condition: RateCondition,
  index: Map<number, number>,
): boolean {
  for (const clause of condition) {
    if (clauseHolds(hand, clause, index)) return true
  }
  return false
}

/** 某条废件当前在手牌里占了几张 */
export function blockerCount(
  hand: number[],
  blocker: RateBlocker,
  index: Map<number, number>,
): number {
  let total = 0
  for (const card of blocker.cards) {
    const at = index.get(card.id)
    if (at !== undefined) total += hand[at] || 0
  }
  return total
}

/** 软废件：当前超限，丢掉可解除 */
export function blockedSoft(
  hand: number[],
  blockers: RateBlocker[],
  index: Map<number, number>,
): boolean {
  for (const blocker of blockers) {
    if (blocker.clear !== 'leaveHand') continue
    if (blockerCount(hand, blocker, index) > blocker.allowance) return true
  }
  return false
}

/** 硬废件：一旦超限，本局永久失败 */
export function blockedHard(
  hand: number[],
  blockers: RateBlocker[],
  index: Map<number, number>,
): boolean {
  for (const blocker of blockers) {
    if (blocker.clear !== 'never') continue
    if (blockerCount(hand, blocker, index) > blocker.allowance) return true
  }
  return false
}

/**
 * 此刻算不算启动。
 * 废件超限时即使启动条件满足也不算——不可逆废件更是一票否决。
 */
export function reached(
  hand: number[],
  starters: RateCondition,
  blockers: RateBlocker[],
  index: Map<number, number>,
): boolean {
  if (!starters.length) return false
  if (!meets(hand, starters, index)) return false
  return !blockedSoft(hand, blockers, index) && !blockedHard(hand, blockers, index)
}

/* ------------------------------------------------------------------ */
/* 卡牌等价类                                                          */
/* ------------------------------------------------------------------ */

export interface RateClass {
  id: number
  name: string
  copies: number
}

export interface RateModel {
  classes: RateClass[]
  index: Map<number, number>
  size: number
  /** 条件里引用、但主卡组一张都没有的卡 */
  absent: RateBlockerCard[]
}

export function buildRateModel(
  deck: DeckEntry[],
  starters: RateCondition,
  blockers: RateBlocker[],
  extras: RateCondition[] = [],
): RateModel {
  const ids: number[] = []
  const names = new Map<number, string>()
  const seen = new Set<number>()

  const add = (id: number, name: string) => {
    if (!(id > 0)) return
    names.set(id, names.get(id) || name)
    if (seen.has(id)) return
    seen.add(id)
    ids.push(id)
  }

  const visitCondition = (condition: RateCondition) => {
    for (const clause of condition) {
      for (const slot of clause.slots) add(slot.cardId, slot.name)
    }
  }

  visitCondition(starters)
  for (const extra of extras) visitCondition(extra)
  for (const blocker of blockers) {
    for (const card of blocker.cards) add(card.id, card.name)
  }

  const copies = new Map<number, number>()
  let size = 0
  for (const entry of deck) {
    const count = Math.max(0, Math.floor(Number(entry.count) || 0))
    if (count <= 0) continue
    copies.set(entry.id, (copies.get(entry.id) || 0) + count)
    size += count
    if (!names.has(entry.id)) names.set(entry.id, entry.name)
  }

  const classes: RateClass[] = ids.map((id) => ({
    id,
    name: names.get(id) || `#${id}`,
    copies: copies.get(id) || 0,
  }))
  const absent = classes
    .filter((item) => item.copies <= 0)
    .map((item) => ({ id: item.id, name: item.name }))

  const used = classes.reduce((sum, item) => sum + item.copies, 0)
  const filler = Math.max(0, size - used)
  if (filler > 0) classes.push({ id: 0, name: '其他卡片', copies: filler })

  const index = new Map<number, number>()
  classes.forEach((item, at) => {
    if (item.id > 0) index.set(item.id, at)
  })

  return { classes, index, size, absent }
}

/* ------------------------------------------------------------------ */
/* 组合工具                                                            */
/* ------------------------------------------------------------------ */

export function comb(n: number, k: number): number {
  if (k < 0 || n < 0 || k > n) return 0
  if (k === 0 || k === n) return 1
  const kk = Math.min(k, n - k)
  let out = 1
  for (let i = 1; i <= kk; i += 1) out = (out * (n - kk + i)) / i
  return out
}

/** 在 bounds 限制下枚举所有和为 total 的非负向量 */
function forEachVector(bounds: number[], total: number, cb: (v: number[]) => void) {
  const m = bounds.length
  if (m === 0) {
    if (total === 0) cb([])
    return
  }
  let capacity = 0
  for (const bound of bounds) capacity += bound
  if (total < 0 || total > capacity) return

  const v = new Array<number>(m).fill(0)
  const walk = (i: number, left: number) => {
    if (i === m - 1) {
      if (left <= bounds[i]) {
        v[i] = left
        cb(v)
        v[i] = 0
      }
      return
    }
    const max = Math.min(left, bounds[i])
    for (let k = 0; k <= max; k += 1) {
      v[i] = k
      walk(i + 1, left - k)
    }
    v[i] = 0
  }
  walk(0, total)
}

function vectorChance(pool: number[], v: number[]): number {
  let num = 1
  let drawn = 0
  for (let i = 0; i < pool.length; i += 1) {
    num *= comb(pool[i], v[i])
    drawn += v[i]
  }
  let total = 0
  for (const count of pool) total += count
  const den = comb(total, drawn)
  return den > 0 ? num / den : 0
}

function addVec(a: number[], b: number[]): number[] {
  const out = new Array<number>(a.length)
  for (let i = 0; i < a.length; i += 1) out[i] = a[i] + (b[i] || 0)
  return out
}

function subVec(a: number[], b: number[]): number[] {
  const out = new Array<number>(a.length)
  for (let i = 0; i < a.length; i += 1) out[i] = Math.max(0, a[i] - (b[i] || 0))
  return out
}

function sumVec(a: number[]): number {
  let out = 0
  for (const value of a) out += value
  return out
}

/* ------------------------------------------------------------------ */
/* 静态起手率（解析解，任意 AND/OR 条件）                               */
/* ------------------------------------------------------------------ */

/**
 * 起手 handSize 张就满足「启动条件且没有废件超限」的概率。
 *
 * 直接在「等价类」上枚举手牌构成，等价于多元超几何：
 *   P(h) = Π C(copies_i, h_i) / C(N, n)
 */
export function openingChance(
  model: RateModel,
  starters: RateCondition,
  blockers: RateBlocker[],
  handSize: number,
): number {
  const n = Math.min(Math.max(0, Math.floor(handSize)), model.size)
  if (n <= 0 || !starters.length) return 0
  const pool = model.classes.map((item) => item.copies)
  const den = comb(model.size, n)
  if (den <= 0) return 0

  let hit = 0
  forEachVector(pool, n, (v) => {
    if (!reached(v, starters, blockers, model.index)) return
    let num = 1
    for (let i = 0; i < pool.length; i += 1) num *= comb(pool[i], v[i])
    hit += num
  })
  return Math.min(1, Math.max(0, hit / den))
}

/* ------------------------------------------------------------------ */
/* 算子展开                                                             */
/* ------------------------------------------------------------------ */

const DEFAULT_STATE_LIMIT = 120_000
/** 精确求解的时间预算，超了就退回仿真，避免界面卡死 */
const EXACT_BUDGET_MS = 1200
/** 逐算子归因是「再跑一遍」，单独给一小段预算，超了就不显示明细 */
const TRACE_BUDGET_MS = 600
/** 仿真的时间预算：状态多到必须抽样时，按时间而不是按次数收手 */
const SIM_BUDGET_MS = 900

class BudgetError extends Error {}

interface Candidate {
  p: number
  hand: number[]
  deck: number[]
}

interface Sample {
  o: number[]
  p: number
}

/** 拍平后的一个执行步：效果内部的第 k 个算子 */
interface Step {
  op: RateOp
  effect: number
  /** 该效果的第一个算子：门控与可选判断都在这里 */
  lead: boolean
  /** 跳过整个效果时跳到的下标 */
  skipTo: number
}

function buildSteps(effects: RateEffect[]): { steps: Step[]; starts: number[] } {
  const steps: Step[] = []
  const starts: number[] = []
  effects.forEach((effect, index) => {
    starts[index] = steps.length
    effect.ops.forEach((op, k) => {
      steps.push({ op, effect: index, lead: k === 0, skipTo: 0 })
    })
  })
  starts[effects.length] = steps.length
  for (const step of steps) step.skipTo = starts[step.effect + 1]
  return { steps, starts }
}

class ExactSolver {
  readonly model: RateModel
  private starters: RateCondition
  private blockers: RateBlocker[]
  private steps: Step[]
  private effects: RateEffect[]
  private memo = new Map<string, number>()
  private outcomeCache = new Map<string, Sample[]>()
  private limit: number
  private deadline: number
  private ticks = 0
  private scratch: number[] = []
  states = 0

  constructor(
    model: RateModel,
    starters: RateCondition,
    blockers: RateBlocker[],
    steps: Step[],
    effects: RateEffect[],
    limit: number,
    deadline: number,
  ) {
    this.model = model
    this.starters = starters
    this.blockers = blockers
    this.steps = steps
    this.effects = effects
    this.limit = limit
    this.deadline = deadline
  }

  /**
   * 预算检查。真正的耗时在枚举循环（抽牌结果 × 拿牌方案）而不是状态数，
   * 所以每个枚举迭代都要打点，否则一次「看 10 张」就能把主线程占住几秒。
   */
  guard(): void {
    this.ticks += 1
    if ((this.ticks & 255) !== 0) return
    if (Date.now() > this.deadline) throw new BudgetError()
  }

  /** 归因阶段可以再借一段预算；它只影响「过程展示」，不影响结论 */
  grantExtra(ms: number): void {
    this.deadline = Math.max(this.deadline, Date.now() + ms)
  }

  /** 某个类别对「凑启动条件」的紧急程度，只用于排序搜索顺序，不影响结果 */
  private keepValue(at: number, hand: number[]): number {
    let best = 0
    for (const clause of this.starters) {
      for (const slot of clause.slots) {
        if (this.model.index.get(slot.cardId) !== at) continue
        const have = hand[at] || 0
        // 已经到上限了，再拿也没用
        if (slot.max !== null && have >= slot.max) continue
        const need = Math.max(1, slot.min)
        best = Math.max(best, have < need ? 1 : 0.25)
      }
    }
    return best
  }

  private takeOptions(o: number[], take: number): number[][] {
    const total = sumVec(o)
    const want = Math.min(Math.max(0, Math.floor(take) || 0), total)
    if (want <= 0) return [o.map(() => 0)]
    if (want >= total) return [o]
    const list: number[][] = []
    forEachVector(o, want, (v) => {
      this.guard()
      list.push([...v])
    })
    list.sort((a, b) => this.takenScore(b) - this.takenScore(a))
    return list
  }

  private takenScore(v: number[]): number {
    let score = 0
    for (let i = 0; i < v.length; i += 1) score += v[i] * this.keepValue(i, this.scratch)
    return score
  }

  private discardOptions(hand: number[], discard: number): number[][] {
    const total = sumVec(hand)
    const want = Math.min(Math.max(0, Math.floor(discard) || 0), total)
    if (want <= 0) return [hand.map(() => 0)]
    const list: number[][] = []
    forEachVector(hand, want, (v) => {
      this.guard()
      list.push([...v])
    })
    // 先丢最没用的，值迭代能更早触到上界
    list.sort((a, b) => this.droppedScore(a, hand) - this.droppedScore(b, hand))
    return list
  }

  private droppedScore(v: number[], hand: number[]): number {
    let score = 0
    for (let i = 0; i < v.length; i += 1) score += v[i] * this.keepValue(i, hand)
    return score
  }

  private outcomes(deck: number[], look: number): Sample[] {
    const key = `${deck.join('.')}:${look}`
    const cached = this.outcomeCache.get(key)
    if (cached) return cached
    const out: Sample[] = []
    let total = 0
    for (const count of deck) total += count
    const den = comb(total, look)
    forEachVector(deck, look, (v) => {
      this.guard()
      let num = 1
      for (let i = 0; i < deck.length; i += 1) num *= comb(deck[i], v[i])
      out.push({ o: [...v], p: den > 0 ? num / den : 0 })
    })
    this.outcomeCache.set(key, out)
    return out
  }

  /** 执行第 i 个算子后的候选状态（每个随机结果都取最优选择） */
  expand(i: number, hand: number[], deck: number[]): Candidate[] {
    const op = this.steps[i].op
    if (op.kind === 'discard') return this.expandDiscard(i, hand, deck, op)
    return this.expandDig(i, hand, deck, op)
  }

  private expandDig(i: number, hand: number[], deck: number[], op: RateOp): Candidate[] {
    const look = Math.min(Math.max(0, Math.floor(op.reveal) || 0), sumVec(deck))
    const out: Candidate[] = []
    this.scratch = hand

    for (const sample of this.outcomes(deck, look)) {
      if (sample.p <= 0) continue
      this.guard()
      let bestHand = hand
      let bestDeck = deck
      let bestValue = -1
      // sink === 'bottom'：没入手的牌回到卡组，牌库只少 `take` 张
      const settledDeck = op.sink === 'bottom' ? null : subVec(deck, sample.o)

      for (const take of this.takeOptions(sample.o, op.take)) {
        const lifted = addVec(hand, take)
        const nextDeck = settledDeck ?? subVec(deck, take)
        const value = this.value(i + 1, lifted, nextDeck)
        if (value > bestValue) {
          bestValue = value
          bestHand = lifted
          bestDeck = nextDeck
        }
        if (bestValue >= 1 - 1e-12) break
      }
      out.push({ p: sample.p, hand: bestHand, deck: bestDeck })
    }

    if (!out.length) out.push({ p: 1, hand, deck })
    return out
  }

  private expandDiscard(i: number, hand: number[], deck: number[], op: RateOp): Candidate[] {
    const want = op.all ? sumVec(hand) : op.count
    let bestHand = hand
    let bestValue = -1
    for (const dropped of this.discardOptions(hand, want)) {
      const next = subVec(hand, dropped)
      const value = this.value(i + 1, next, deck)
      if (value > bestValue) {
        bestValue = value
        bestHand = next
      }
      if (bestValue >= 1 - 1e-12) break
    }
    return [{ p: 1, hand: bestHand, deck }]
  }

  /** 执行到第 i 个算子之前（手牌 hand / 牌库 deck）时的最终启动概率 */
  value(i: number, hand: number[], deck: number[]): number {
    if (reached(hand, this.starters, this.blockers, this.model.index)) return 1
    // 硬废件已经上手：这一局到此为止，后面的丢牌 / 送墓都不能翻盘
    if (blockedHard(hand, this.blockers, this.model.index)) return 0
    if (i >= this.steps.length) return 0

    const key = `${i}|${hand.join('.')}|${deck.join('.')}`
    const cached = this.memo.get(key)
    if (cached !== undefined) return cached

    this.states += 1
    if (this.states > this.limit) throw new BudgetError()
    this.guard()

    const step = this.steps[i]
    const effect = this.effects[step.effect]

    if (
      step.lead &&
      effect.requirement.length &&
      !meets(hand, effect.requirement, this.model.index)
    ) {
      const skipped = this.value(step.skipTo, hand, deck)
      this.memo.set(key, skipped)
      return skipped
    }

    let use = 0
    for (const candidate of this.expand(i, hand, deck)) {
      use += candidate.p * this.value(i + 1, candidate.hand, candidate.deck)
      if (use >= 1 - 1e-12) {
        use = 1
        break
      }
    }

    let result = use
    if (step.lead && effect.optional) {
      result = Math.max(use, this.value(step.skipTo, hand, deck))
    }

    const safe = Math.min(1, Math.max(0, result))
    this.memo.set(key, safe)
    return safe
  }
}

/* ------------------------------------------------------------------ */
/* 仿真（状态数超限时的兜底）                                           */
/* ------------------------------------------------------------------ */

function makeRng(seed: number): () => number {
  let a = seed >>> 0 || 1
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle(list: number[], rng: () => number) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    const swap = list[i]
    list[i] = list[j]
    list[j] = swap
  }
}

/** 这张牌对「凑启动条件」的帮助程度：0 = 没用，越大越急 */
function helpScore(
  at: number,
  hand: number[],
  starters: RateCondition,
  index: Map<number, number>,
): number {
  let best = 0
  for (const clause of starters) {
    let missing = 0
    let helps = false
    for (const slot of clause.slots) {
      const pos = index.get(slot.cardId)
      if (pos === undefined) {
        if (slot.min > 0) missing += 99
        continue
      }
      const have = hand[pos] || 0
      if (slot.max !== null && have >= slot.max) continue
      const need = Math.max(1, slot.min)
      if (have < need) {
        missing += need - have
        if (pos === at) helps = true
      }
    }
    if (helps) best = Math.max(best, 1 / (missing + 1))
  }
  return best
}

/** 丢掉一张牌的损失：越小越该丢 */
function dropScore(
  at: number,
  hand: number[],
  starters: RateCondition,
  blockers: RateBlocker[],
  index: Map<number, number>,
): number {
  // 手上有超额的废件：最先丢
  for (const blocker of blockers) {
    if (!blocker.cards.some((card) => index.get(card.id) === at)) continue
    if (blockerCount(hand, blocker, index) > blocker.allowance) return -1
  }
  let best = 0
  for (const clause of starters) {
    for (const slot of clause.slots) {
      if (index.get(slot.cardId) !== at) continue
      const need = Math.max(1, slot.min)
      const have = hand[at] || 0
      best = Math.max(best, have <= need ? 1 : 0.2)
    }
  }
  return best
}

function simulateRate(
  model: RateModel,
  plan: RatePlan,
  trials: number,
  seed: number,
  budgetMs: number = SIM_BUDGET_MS,
): Omit<RateOutcome, 'elapsed'> {
  const rng = makeRng(seed)
  const classes = model.classes.length
  const basePool: number[] = []
  model.classes.forEach((item, at) => {
    for (let i = 0; i < item.copies; i += 1) basePool.push(at)
  })

  const steps = new Array(plan.effects.length + 1).fill(0)
  const pool = [...basePool]
  const deadline = Date.now() + budgetMs
  let done = 0

  for (let trial = 0; trial < trials; trial += 1) {
    // 抽样按时间收手：宁可少抽几次，也不要占住线程
    if ((trial & 127) === 0 && trial > 0 && Date.now() > deadline) break
    done += 1
    shuffle(pool, rng)
    const deck = pool.slice()
    const hand = new Array<number>(classes).fill(0)
    const draw = Math.min(plan.handSize, deck.length)
    for (let i = 0; i < draw; i += 1) {
      const card = deck.pop()
      if (card !== undefined) hand[card] += 1
    }

    if (reached(hand, plan.starters, plan.blockers, model.index)) {
      steps[0] += 1
      continue
    }
    // 起手就带硬废件：这一局已经结束
    if (blockedHard(hand, plan.blockers, model.index)) continue

    let solvedAt = -1
    let dead = false
    for (let e = 0; e < plan.effects.length && solvedAt < 0 && !dead; e += 1) {
      const effect = plan.effects[e]
      if (
        effect.requirement.length &&
        !meets(hand, effect.requirement, model.index)
      ) {
        continue
      }

      for (const op of effect.ops) {
        if (op.kind === 'discard') {
          const total = hand.reduce((a, b) => a + b, 0)
          const want = op.all ? total : Math.min(op.count, total)
          for (let round = 0; round < want; round += 1) {
            let worstAt = -1
            let worstScore = Number.POSITIVE_INFINITY
            for (let i = 0; i < classes; i += 1) {
              if (hand[i] <= 0) continue
              const score = dropScore(i, hand, plan.starters, plan.blockers, model.index)
              if (score < worstScore) {
                worstScore = score
                worstAt = i
              }
            }
            if (worstAt < 0) break
            hand[worstAt] -= 1
          }
        } else {
          const seen: number[] = []
          const look = Math.min(Math.max(0, Math.floor(op.reveal) || 0), deck.length)
          for (let i = 0; i < look; i += 1) {
            const card = deck.pop()
            if (card !== undefined) seen.push(card)
          }

          const remain = [...seen]
          const target = Math.min(Math.max(0, Math.floor(op.take) || 0), remain.length)
          for (let round = 0; round < target; round += 1) {
            let bestAt = 0
            let bestScore = -1
            for (let i = 0; i < remain.length; i += 1) {
              const score = helpScore(remain[i], hand, plan.starters, model.index)
              if (score > bestScore) {
                bestScore = score
                bestAt = i
              }
            }
            const [picked] = remain.splice(bestAt, 1)
            hand[picked] += 1
          }
          if (op.sink === 'bottom' && remain.length) deck.unshift(...remain)
          // 抽到硬废件：这条线当场断掉，后面丢牌也救不回来
          if (blockedHard(hand, plan.blockers, model.index)) {
            dead = true
            break
          }
        }

        // 每个算子做完都重新判定：已经启动就不再执行后续算子（与精确解同口径）
        if (reached(hand, plan.starters, plan.blockers, model.index)) {
          solvedAt = e + 1
          break
        }
      }
    }

    if (!dead && solvedAt >= 0) steps[solvedAt] += 1
  }

  const runs = Math.max(1, done)
  const rates = steps.map((count) => count / runs)
  const total = rates.reduce((sum, value) => sum + value, 0)
  const error = 1.96 * Math.sqrt(Math.max(0, total * (1 - total)) / runs)

  return {
    opening: rates[0] || 0,
    total,
    steps: rates,
    method: 'sim',
    states: 0,
    censored: true,
    trials: runs,
    ci: [Math.max(0, total - error), Math.min(1, total + error)],
    traces: [],
  }
}

/* ------------------------------------------------------------------ */
/* 统一入口                                                            */
/* ------------------------------------------------------------------ */

/**
 * 抽滤过程中的一层归因记录，供界面把「这一步怎么算的」摊开给人看。
 * 所有概率质量都以「起手总组合」为 1。
 */
export interface RateOpTrace {
  /** 效果下标 */
  effect: number
  /** -1 = 该效果的入口汇总；0 起 = 效果内部的第 k 个算子 */
  op: number
  /** 这一层执行前，仍未启动的概率质量 */
  before: number
  /** 这一层直接新增的启动质量 */
  gained: number
  /** 这一层执行后，仍未启动的概率质量 */
  after: number
  /** 算子执行时，牌库的平均剩余张数（按未启动质量加权）；入口汇总行为 0 */
  deck: number
  /** 入口汇总行：发动条件不满足、整个效果被跳过的质量 */
  skipped: number
  /** 入口汇总行：可选发动但选择不发动的质量 */
  optionalSkip: number
  /** 这一层因为硬废件上手而出局的质量（后面再丢牌也救不回来） */
  dead: number
}

export interface RateOutcome {
  opening: number
  total: number
  /** steps[0] = 起手即启动；steps[k] = 第 k 个效果后新达成 */
  steps: number[]
  method: 'exact' | 'sim'
  states: number
  /** 精确求解超出预算，已退回仿真 */
  censored: boolean
  trials: number
  ci: [number, number] | null
  elapsed: number
  /** 逐算子的归因明细；仿真兜底时为空数组 */
  traces: RateOpTrace[]
}

export interface SolveOptions {
  stateLimit?: number
  trials?: number
  seed?: number
}

function emptyOutcome(effects: number, started: number): RateOutcome {
  return {
    opening: 0,
    total: 0,
    steps: new Array(effects + 1).fill(0),
    method: 'exact',
    states: 0,
    censored: false,
    trials: 0,
    ci: null,
    elapsed: Date.now() - started,
    traces: [],
  }
}

export function solveRate(deck: DeckEntry[], plan: RatePlan, options: SolveOptions = {}): RateOutcome {
  const started = Date.now()
  const extras = plan.effects.map((effect) => effect.requirement)
  const model = buildRateModel(deck, plan.starters, plan.blockers, extras)
  const opening = openingChance(model, plan.starters, plan.blockers, plan.handSize)

  if (!plan.starters.length || !model.classes.length || model.size <= 0) {
    return emptyOutcome(plan.effects.length, started)
  }

  const { steps, starts } = buildSteps(plan.effects)
  const limit = options.stateLimit ?? DEFAULT_STATE_LIMIT
  try {
    const result = solveExact(model, plan, steps, starts, opening, limit, started + EXACT_BUDGET_MS)
    return { ...result, elapsed: Date.now() - started }
  } catch (error) {
    if (!(error instanceof BudgetError)) throw error
  }

  const simulated = simulateRate(model, plan, options.trials ?? 20000, options.seed ?? 20260101)
  return { ...simulated, elapsed: Date.now() - started }
}

function initialStates(model: RateModel, handSize: number, check?: () => void): Candidate[] {
  const pool = model.classes.map((item) => item.copies)
  const n = Math.min(Math.max(0, Math.floor(handSize)), model.size)
  const out: Candidate[] = []
  forEachVector(pool, n, (v) => {
    check?.()
    const p = vectorChance(pool, v)
    if (p <= 0) return
    out.push({ p, hand: [...v], deck: subVec(pool, v) })
  })
  return out
}

function pushMerged(target: Map<string, Candidate>, hand: number[], deck: number[], p: number) {
  const key = `${hand.join('.')}|${deck.join('.')}`
  const hit = target.get(key)
  if (hit) hit.p += p
  else target.set(key, { p, hand, deck })
}

function mergeList(list: Candidate[]): Candidate[] {
  const map = new Map<string, Candidate>()
  for (const item of list) pushMerged(map, item.hand, item.deck, item.p)
  return [...map.values()]
}

function solveExact(
  model: RateModel,
  plan: RatePlan,
  steps: Step[],
  starts: number[],
  opening: number,
  limit: number,
  deadline: number,
): Omit<RateOutcome, 'elapsed'> {
  const solver = new ExactSolver(
    model,
    plan.starters,
    plan.blockers,
    steps,
    plan.effects,
    limit,
    deadline,
  )
  const start = initialStates(model, plan.handSize, () => solver.guard())

  let total = 0
  for (const state of start) total += state.p * solver.value(0, state.hand, state.deck)

  // 逐步归因：按最优策略做一次前向传播，统计「第一次达成」发生在哪个效果之后
  const steps2 = new Array(plan.effects.length + 1).fill(0)
  let alive: Candidate[] = []
  for (const state of start) {
    if (reached(state.hand, plan.starters, plan.blockers, model.index)) steps2[0] += state.p
    else if (!blockedHard(state.hand, plan.blockers, model.index)) alive.push(state)
  }

  for (let e = 0; e < plan.effects.length; e += 1) {
    const effect = plan.effects[e]
    const requirement = effect.requirement
    const next = new Map<string, Candidate>()
    let gained = 0

    for (const state of alive) {
      if (requirement.length && !meets(state.hand, requirement, model.index)) {
        pushMerged(next, state.hand, state.deck, state.p)
        continue
      }

      let layer: Candidate[] = [{ p: state.p, hand: state.hand, deck: state.deck }]
      for (let k = 0; k < effect.ops.length; k += 1) {
        const index = starts[e] + k
        const out: Candidate[] = []
        for (const item of layer) {
          for (const cand of solver.expand(index, item.hand, item.deck)) {
            const p = item.p * cand.p
            if (p <= 0) continue
            // 硬废件上手：这条线到此为止
            if (blockedHard(cand.hand, plan.blockers, model.index)) continue
            out.push({ p, hand: cand.hand, deck: cand.deck })
          }
        }
        layer = mergeList(out)
      }

      let use = 0
      for (const item of layer) {
        use += item.p * solver.value(starts[e + 1], item.hand, item.deck)
      }
      if (effect.optional && solver.value(starts[e + 1], state.hand, state.deck) >= use - 1e-12) {
        pushMerged(next, state.hand, state.deck, state.p)
        continue
      }

      for (const item of layer) {
        if (reached(item.hand, plan.starters, plan.blockers, model.index)) gained += item.p
        else pushMerged(next, item.hand, item.deck, item.p)
      }
    }

    steps2[e + 1] = gained
    alive = [...next.values()]
  }

  return {
    opening,
    total: Math.min(1, Math.max(0, total)),
    steps: steps2,
    method: 'exact',
    states: solver.states,
    censored: false,
    trials: 0,
    ci: null,
    traces: traceEffects(model, plan, starts, solver, start, steps2),
  }
}

/**
 * 归因阶段的包装：它只是「过程展示」，再单独借一小段预算。
 * 超时就返回空数组，页面退回只显示效果级增量，绝不拖累结论本身。
 */
function traceEffects(
  model: RateModel,
  plan: RatePlan,
  starts: number[],
  solver: ExactSolver,
  start: Candidate[],
  steps2: number[],
): RateOpTrace[] {
  solver.grantExtra(TRACE_BUDGET_MS)
  try {
    return traceEffectsInner(model, plan, starts, solver, start, steps2)
  } catch (error) {
    if (error instanceof BudgetError) return []
    throw error
  }
}

/**
 * 逐算子归因：再跑一遍前向传播，但把每个效果内部的算子摊开。
 * 记录每一层执行前后「仍未启动的概率质量」，用来解释数字是怎么被削下来的。
 */
function traceEffectsInner(
  model: RateModel,
  plan: RatePlan,
  starts: number[],
  solver: ExactSolver,
  start: Candidate[],
  steps2: number[],
): RateOpTrace[] {
  const traces: RateOpTrace[] = []
  let alive: Candidate[] = []
  let deadOpening = 0
  for (const state of start) {
    if (reached(state.hand, plan.starters, plan.blockers, model.index)) continue
    if (blockedHard(state.hand, plan.blockers, model.index)) {
      deadOpening += state.p
      continue
    }
    alive.push(state)
  }
  let unmet = Math.max(0, 1 - (steps2[0] ?? 0) - deadOpening)
  if (deadOpening > 0) {
    traces.push({
      effect: -1,
      op: -1,
      before: Math.max(0, 1 - (steps2[0] ?? 0)),
      gained: 0,
      after: unmet,
      deck: 0,
      skipped: 0,
      optionalSkip: 0,
      dead: deadOpening,
    })
  }

  /** 与主循环同口径：可选发动时，如果发动的期望不如跳过，就整段不发动 */
  const skipOptional = (e: number, state: Candidate): boolean => {
    const effect = plan.effects[e]
    let layer: Candidate[] = [{ p: state.p, hand: state.hand, deck: state.deck }]
    for (let k = 0; k < effect.ops.length; k += 1) {
      const index = starts[e] + k
      const out: Candidate[] = []
      for (const item of layer) {
        for (const cand of solver.expand(index, item.hand, item.deck)) {
          const p = item.p * cand.p
          if (p > 0) out.push({ p, hand: cand.hand, deck: cand.deck })
        }
      }
      layer = mergeList(out)
    }
    let use = 0
    for (const item of layer) use += item.p * solver.value(starts[e + 1], item.hand, item.deck)
    return solver.value(starts[e + 1], state.hand, state.deck) >= use - 1e-12
  }

  for (let e = 0; e < plan.effects.length; e += 1) {
    const effect = plan.effects[e]
    const requirement = effect.requirement
    const next = new Map<string, Candidate>()
    let skipped = 0
    let optionalSkip = 0
    const active: Candidate[] = []

    for (const state of alive) {
      if (requirement.length && !meets(state.hand, requirement, model.index)) {
        skipped += state.p
        pushMerged(next, state.hand, state.deck, state.p)
        continue
      }
      if (effect.optional && skipOptional(e, state)) {
        optionalSkip += state.p
        pushMerged(next, state.hand, state.deck, state.p)
        continue
      }
      active.push({ p: state.p, hand: state.hand, deck: state.deck })
    }

    traces.push({
      effect: e,
      op: -1,
      before: unmet,
      gained: 0,
      after: unmet,
      deck: 0,
      skipped,
      optionalSkip,
      dead: 0,
    })

    let layer: Candidate[] = active
    for (let k = 0; k < effect.ops.length; k += 1) {
      const index = starts[e] + k
      let gained = 0
      let dead = 0
      let mass = 0
      let deckSum = 0
      const out: Candidate[] = []
      for (const item of layer) {
        mass += item.p
        deckSum += item.p * sumVec(item.deck)
        for (const cand of solver.expand(index, item.hand, item.deck)) {
          const p = item.p * cand.p
          if (p <= 0) continue
          if (blockedHard(cand.hand, plan.blockers, model.index)) {
            dead += p
            continue
          }
          if (reached(cand.hand, plan.starters, plan.blockers, model.index)) gained += p
          else out.push({ p, hand: cand.hand, deck: cand.deck })
        }
      }
      layer = mergeList(out)
      const before = unmet
      unmet = Math.max(0, unmet - gained - dead)
      traces.push({
        effect: e,
        op: k,
        before,
        gained,
        after: unmet,
        deck: mass > 0 ? deckSum / mass : 0,
        skipped: 0,
        optionalSkip: 0,
        dead,
      })
    }

    for (const item of layer) pushMerged(next, item.hand, item.deck, item.p)
    alive = [...next.values()]
  }

  return traces
}
