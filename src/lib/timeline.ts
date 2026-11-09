import type {
  BattlePosition,
  CardMove,
  ChainEntry,
  ComboLine,
  HandtrapReport,
  Interrupt,
  LinkKind,
  PlaybackFrame,
  PlaybackPhase,
  Timing,
  TimingLink,
  TimingState,
  TimingStatus,
  TimelineAnalysis,
  ZoneCard,
  ZoneId,
  ZoneSnapshot,
} from '@/types'
import {
  OPERATION_DEFS,
  SLOT_COUNT,
  TRACKED_ZONES,
  UNKNOWN_CARD,
  ZONE_LABELS,
  ZONE_ORDER,
} from '@/types'
import { HANDTRAPS, HANDTRAP_MAP } from './handtraps'

/** 根据上游移动的起止区域判断这条链属于哪种衔接 */
export function linkKindOf(from: ZoneId, to: ZoneId): LinkKind {
  if (to === 'hand') return from === 'deck' ? 'search' : 'recover'
  if (to === 'gy') return from === 'deck' ? 'send' : 'other'
  if (to === 'field') return from === 'deck' || from === 'extra' || from === 'hand' ? 'summon' : 'other'
  if (to === 'banish') return 'banish'
  return 'other'
}

/* ------------------------------------------------------------------ */
/* 区域账本                                                             */
/* ------------------------------------------------------------------ */

type Ledger = Record<ZoneId, Map<string, number>>

interface Origin {
  timingId: string
  timingIndex: number
  moveId: string
  /** 这张卡目前所在区域 */
  zone: ZoneId
  /** 产出它的那次移动的起点，用于判断衔接方式（检索 / 堆墓 / 特召） */
  from: ZoneId
  /** 该段可被哪些手坑打断 */
  handtraps: string[]
}

function emptyLedger(): Ledger {
  return {
    hand: new Map(),
    deck: new Map(),
    extra: new Map(),
    gy: new Map(),
    banish: new Map(),
    field: new Map(),
    st: new Map(),
    // 超量素材按格位挂在怪兽下面（见 Slots.materials），这里只留一个空表保持结构一致
    material: new Map(),
  }
}

function addCard(map: Map<string, number>, name: string, n: number) {
  if (!name) return
  map.set(name, (map.get(name) || 0) + n)
}

function takeCard(map: Map<string, number>, name: string, n: number): boolean {
  const have = map.get(name) || 0
  if (have < n) return false
  if (have === n) map.delete(name)
  else map.set(name, have - n)
  return true
}

function toList(map: Map<string, number>): ZoneCard[] {
  return [...map.entries()].map(([name, count]) => ({ name, count }))
}

/* ------------------------------------------------------------------ */
/* 场上格位（怪兽区 / 魔陷区 1-5）                                        */
/* ------------------------------------------------------------------ */

type SlotRow = (string | null)[]

/** 怪兽区 / 魔陷区按格位记录卡名（下标 = 格位 - 1），怪兽格位另带素材与表示形式 */
interface Slots {
  field: SlotRow
  st: SlotRow
  /** 每个怪兽格位下面的超量素材（卡名，可重复；同名单卡分别占一条） */
  materials: string[][]
  /** 每个怪兽格位的表示形式 */
  positions: BattlePosition[]
}

const isSlotZone = (zone: ZoneId): zone is 'field' | 'st' => zone === 'field' || zone === 'st'

function emptySlots(): Slots {
  return {
    field: Array(SLOT_COUNT).fill(null),
    st: Array(SLOT_COUNT).fill(null),
    materials: Array.from({ length: SLOT_COUNT }, () => [] as string[]),
    positions: Array.from({ length: SLOT_COUNT }, () => 'attack' as BattlePosition),
  }
}

/** 1-5 之外的格位一律夹到两端的有效格位 */
function slotIndex(slot?: number): number | null {
  if (!slot || !Number.isFinite(slot) || slot < 1) return null
  return Math.min(Math.floor(slot), SLOT_COUNT) - 1
}

/** 进场：先放指定格位，放不下（被占 / 多张）再从前往后补空位；返回落到的格位下标 */
function placeSlot(row: SlotRow, name: string, slot: number | undefined, count: number): number[] {
  const placedAt: number[] = []
  const preferred = slotIndex(slot)
  if (preferred !== null && (!row[preferred] || row[preferred] === name)) {
    row[preferred] = name
    placedAt.push(preferred)
  }
  for (let i = 0; i < SLOT_COUNT && placedAt.length < count; i += 1) {
    if (!row[i]) {
      row[i] = name
      placedAt.push(i)
    }
  }
  return placedAt
}

/** 离场：把这张卡占用的格位清空；返回被清空的格位下标 */
function clearSlot(row: SlotRow, name: string, count: number): number[] {
  const cleared: number[] = []
  for (let i = 0; i < row.length && cleared.length < count; i += 1) {
    if (row[i] === name) {
      row[i] = null
      cleared.push(i)
    }
  }
  return cleared
}

function slotCards(row: SlotRow): (ZoneCard | null)[] {
  return row.map((name) => (name ? { name, count: 1 } : null))
}

/* ------------------------------------------------------------------ */
/* 超量素材                                                             */
/* ------------------------------------------------------------------ */

/** 怪兽离场：它下面的超量素材按规则送去墓地 */
function dumpMaterials(slots: Slots, ledger: Ledger, indexes: number[]) {
  for (const index of indexes) {
    for (const name of slots.materials[index]) addCard(ledger.gy, name, 1)
    slots.materials[index] = []
  }
}

/** 把素材叠到某个格位的怪兽下面 */
function attachMaterials(slots: Slots, index: number, name: string, count: number) {
  for (let i = 0; i < count; i += 1) slots.materials[index].push(name)
}

/** 素材该挂到哪个格位：指定格位 > 本时序主卡所在的场上格位 */
function attachTarget(slots: Slots, slot: number | undefined, cardName: string): number | null {
  const fixed = slotIndex(slot)
  if (fixed !== null) return fixed
  if (cardName) {
    const index = slots.field.indexOf(cardName)
    if (index >= 0) return index
  }
  return null
}

/** 取除素材时优先从哪只怪兽身上取：指定格位 > 本时序主卡 > 其他带素材的怪兽 */
function detachOrder(slots: Slots, slot: number | undefined, cardName: string): number[] {
  const fixed = slotIndex(slot)
  if (fixed !== null) return [fixed]
  const order = Array.from({ length: SLOT_COUNT }, (_, i) => i)
  const own = cardName ? slots.field.indexOf(cardName) : -1
  if (own >= 0) {
    order.splice(order.indexOf(own), 1)
    order.unshift(own)
  }
  return order
}

function snapshot(ledger: Ledger, summons: number, slots: Slots): ZoneSnapshot {
  const materialMap = new Map<string, number>()
  for (const list of slots.materials) {
    for (const name of list) addCard(materialMap, name, 1)
  }
  return {
    hand: toList(ledger.hand),
    field: toList(ledger.field),
    st: toList(ledger.st),
    material: toList(materialMap),
    fieldSlots: slots.field.map((name, index) =>
      name
        ? {
            name,
            count: 1,
            materials: [...slots.materials[index]],
            position: slots.positions[index],
          }
        : null,
    ),
    stSlots: slotCards(slots.st),
    gy: toList(ledger.gy),
    banish: toList(ledger.banish),
    extra: toList(ledger.extra),
    deck: toList(ledger.deck),
    summons,
  }
}

/** 起手在手上，同时从卡组余量里扣除；未录满的部分按未知手牌补足 */
export function initialLedger(combo: ComboLine): Ledger {
  const ledger = emptyLedger()
  for (const entry of combo.deck) addCard(ledger.deck, entry.name, entry.count)
  for (const card of combo.opening) {
    addCard(ledger.hand, card.name, 1)
    takeCard(ledger.deck, card.name, 1)
  }
  const unknown = Math.max(0, (combo.handSize || 0) - combo.opening.length)
  if (unknown) addCard(ledger.hand, UNKNOWN_CARD, unknown)
  return ledger
}

export function startingZones(combo: ComboLine): ZoneSnapshot {
  return snapshot(initialLedger(combo), 0, emptySlots())
}

/* ------------------------------------------------------------------ */
/* 手坑 → 被封锁的效果段                                                */
/* ------------------------------------------------------------------ */

interface Cancels {
  /** 整段效果被无效的时序 */
  negatedTimings: Set<string>
  /** 被单独封锁的效果段 */
  canceledMoves: Set<string>
  /** 时序 → 命中的手坑 */
  byTiming: Map<string, string>
  /** 效果段 → 命中的手坑 */
  byMove: Map<string, string>
}

function negateTagsOf(timing: Timing): string[] {
  const out = new Set<string>()
  for (const move of timing.effect) {
    for (const id of move.handtraps || []) {
      if (HANDTRAP_MAP[id]?.category === 'negate') out.add(id)
    }
  }
  return [...out]
}

/** 一张卡产出后，可打断这条链的手坑 */
function effectiveTags(move: CardMove, negateTags: string[]): string[] {
  const set = new Set<string>(move.phase === 'effect' ? move.handtraps || [] : [])
  for (const id of negateTags) set.add(id)
  return [...set]
}

function buildCancels(combo: ComboLine, interrupts: Interrupt[]): Cancels {
  const cancels: Cancels = {
    negatedTimings: new Set(),
    canceledMoves: new Set(),
    byTiming: new Map(),
    byMove: new Map(),
  }

  const apply = (timingId: string, handtrapId: string) => {
    const def = HANDTRAP_MAP[handtrapId]
    if (!def || def.category === 'draw' || def.category === 'nuke') return
    const timing = combo.timings.find((item) => item.id === timingId)
    if (!timing) return
    const hits = timing.effect.filter((move) => move.handtraps?.includes(handtrapId))
    const timingLevel = (timing.handtraps || []).includes(handtrapId)
    // 只挂在时序级上的无效类手坑，按整段无效处理
    if (!hits.length && !(timingLevel && def.category === 'negate')) return

    cancels.byTiming.set(timingId, handtrapId)
    if (def.category === 'negate') {
      // 无效类：整段效果全部不结算
      cancels.negatedTimings.add(timingId)
      for (const move of timing.effect) {
        cancels.canceledMoves.add(move.id)
        cancels.byMove.set(move.id, handtrapId)
      }
    } else {
      // 封锁 / 区域类：只封锁被标记的那几段
      for (const move of hits) {
        cancels.canceledMoves.add(move.id)
        cancels.byMove.set(move.id, handtrapId)
      }
    }
  }

  for (const item of interrupts) apply(item.timingId, item.handtrapId)
  return cancels
}

/* ------------------------------------------------------------------ */
/* 推演                                                                 */
/* ------------------------------------------------------------------ */

interface RunOptions {
  cancels: Cancels
  /** 基准推演得到的链，用于判断"上游被无效导致下游断链" */
  baseline?: TimingLink[]
  trackLinks: boolean
}

interface RunResult {
  states: TimingState[]
  links: TimingLink[]
  frames: PlaybackFrame[]
}

const isSummonMove = (move: CardMove) => move.to === 'field' && move.from !== 'field'

/** 还没确定挂到哪只怪兽下面的素材（本时序后面才把怪兽放到场上） */
interface PendingMaterial {
  move: CardMove
  count: number
}

/** 从账本里取卡；卡组 / 额外卡组不校验余量，其他区域不足只记 reason 不中断 */
function takeFromLedger(
  ledger: Ledger,
  from: ZoneId,
  key: string,
  count: number,
  unknown: boolean,
  reasons: string[],
) {
  if (from === 'deck' || from === 'extra') {
    takeCard(ledger[from], key, count)
    return
  }
  if (!TRACKED_ZONES.includes(from)) return
  const available = ledger[from].get(key) || 0
  if (!takeCard(ledger[from], key, count)) {
    reasons.push(
      `${unknown ? UNKNOWN_CARD : `「${key}」`}不足（${ZONE_LABELS[from]}）：需要 ${count}，只有 ${available}，已按可用处理`,
    )
  }
}

/**
 * 从场上 / 魔陷区撤掉卡。
 * 怪兽离场时它下面的超量素材送墓；`inheritTo` 有值时改为转移到该格位（叠放继承）。
 */
function leaveSlots(
  ledger: Ledger,
  slots: Slots,
  from: ZoneId,
  key: string,
  count: number,
  inheritTo?: number,
) {
  if (from === 'field') {
    const cleared = clearSlot(slots.field, key, count)
    for (const index of cleared) slots.positions[index] = 'attack'
    if (inheritTo === undefined) {
      dumpMaterials(slots, ledger, cleared)
      return
    }
    for (const index of cleared) {
      const kept = slots.materials[index]
      slots.materials[index] = []
      for (const name of kept) attachMaterials(slots, inheritTo, name, 1)
    }
  } else if (from === 'st') {
    clearSlot(slots.st, key, count)
  }
}

/** 本时序的超量素材处理状态 */
interface MaterialFlow {
  /** 先挂起、等怪兽落地再叠上去的素材 */
  pending: PendingMaterial[]
  /** 本时序是叠放召唤：被叠成素材的怪兽，它下面的素材要继承而不是送墓 */
  inherit: boolean
  /**
   * 叠放目标格位：本时序里「被叠成素材的那只怪兽」原来站的位置。
   * 只有牌手显式指定了素材行（旧怪兽 → 超量素材）时才知道叠在哪只怪兽上。
   */
  baseSlot: number | null
}

/**
 * 叠放召唤时素材先挂到哪个格位：显式格位 > 被叠成素材的怪兽位置 > 场上唯一一只有素材的怪兽。
 * 只用于给「挂起中的素材」找落点；真正的「叠在谁身上 / 新怪兽放哪」由 placeFieldCard 决定。
 */
function overlayTarget(slots: Slots, move: CardMove, baseSlot: number | null): number | null {
  const fixed = slotIndex(move.slot)
  if (fixed !== null) return fixed
  if (baseSlot !== null) return baseSlot
  const withMaterials: number[] = []
  slots.materials.forEach((list, index) => {
    if (list.length) withMaterials.push(index)
  })
  return withMaterials.length === 1 ? withMaterials[0] : null
}

/**
 * 放到怪兽区。overlay 时「谁被叠放」和「新怪兽放几号位」是两件事：
 * 被叠放的旧怪兽送墓、它的素材转到新怪兽所在格位；新怪兽按自己的格位摆放。
 */
function placeFieldCard(
  ledger: Ledger,
  slots: Slots,
  name: string,
  move: CardMove,
  count: number,
  baseSlot: number | null,
  reasons: string[],
): number[] {
  const explicit = slotIndex(move.slot)
  if (!move.overlay) return placeSlot(slots.field, name, move.slot, count)

  // 谁被叠放：素材行指定的位置 > 显式格位上的怪兽 > 场上唯一一只有素材的怪兽
  let base = baseSlot
  if (base === null && explicit !== null && slots.field[explicit]) base = explicit
  if (base === null) {
    const withMaterials: number[] = []
    slots.materials.forEach((list, index) => {
      if (list.length) withMaterials.push(index)
    })
    if (withMaterials.length === 1) base = withMaterials[0]
  }
  if (base === null) {
    reasons.push('叠放目标不明确：请给这一行指定格位，或在规则处理段加一行「旧怪兽 → 超量素材」')
    return placeSlot(slots.field, name, move.slot, count)
  }

  // 旧怪兽离场（同名也是另一张卡，照样送墓），素材先接住再转到新位置
  const occupant = slots.field[base]
  if (occupant) {
    takeCard(ledger.field, occupant, 1)
    addCard(ledger.gy, occupant, 1)
  }
  const inherited = slots.materials[base]
  slots.field[base] = null
  slots.materials[base] = []
  slots.positions[base] = 'attack'

  // 新怪兽放哪：显式格位 > 旧怪兽腾出来的位置
  const dest = explicit ?? base
  if (slots.field[dest]) {
    const other = slots.field[dest] as string
    takeCard(ledger.field, other, 1)
    addCard(ledger.gy, other, 1)
    // 被顶掉的怪兽自己的素材送墓
    dumpMaterials(slots, ledger, [dest])
    slots.positions[dest] = 'attack'
  }
  slots.field[dest] = name
  for (const material of inherited) attachMaterials(slots, dest, material, 1)
  return [dest]
}

/**
 * 怪兽即将落地时，先算出素材要叠到哪个格位：
 * 显式格位 > 本时序主卡已在场的格位 > 叠放目标 > 第一个空位
 * （即将被收为素材的怪兽算作空位，所以超量召唤不会因为“怪兽区放不下”而失败）
 */
function projectedFieldSlot(
  slots: Slots,
  move: CardMove,
  cardName: string,
  flow: MaterialFlow,
): number | null {
  if (move.overlay) return overlayTarget(slots, move, flow.baseSlot)
  const fixed = slotIndex(move.slot)
  if (fixed !== null) return fixed
  const own = cardName ? slots.field.indexOf(cardName) : -1
  if (own >= 0) return own
  const freeing = new Set<string>()
  for (const item of flow.pending) {
    if (item.move.from === 'field' && !item.move.unknown) freeing.add(item.move.cardName)
  }
  for (let i = 0; i < SLOT_COUNT; i += 1) {
    const name = slots.field[i]
    if (!name || freeing.has(name)) return i
  }
  return null
}

/** 把先记下的素材从原区域收走，叠到目标格位的怪兽下面 */
function flushMaterials(
  ledger: Ledger,
  slots: Slots,
  flow: MaterialFlow,
  target: number | null,
  reasons: string[],
) {
  const pending = flow.pending
  if (!pending.length) return
  if (target === null) {
    for (const item of pending) {
      const name = item.move.unknown ? UNKNOWN_CARD : item.move.cardName
      reasons.push(`「${name || '素材'}」没有可叠放的怪兽，已留在原区域`)
    }
    pending.length = 0
    return
  }
  // 先全部从原区域收走，再统一叠上去：素材本身占了目标格位时，
  // 撤走它会顺带清掉这个格位上的素材列表，边收边叠会把刚叠上去的素材冲掉
  const sources: number[] = []
  for (const item of pending) {
    const unknown = Boolean(item.move.unknown)
    const key = unknown ? UNKNOWN_CARD : item.move.cardName
    const sourceSlot = item.move.from === 'field' ? slots.field.indexOf(key) : -1
    takeFromLedger(ledger, item.move.from, key, item.count, unknown, reasons)
    leaveSlots(ledger, slots, item.move.from, key, item.count, flow.inherit ? target : undefined)
    if (flow.inherit && sourceSlot >= 0) sources.push(sourceSlot)
  }
  for (const item of pending) {
    attachMaterials(slots, target, item.move.unknown ? UNKNOWN_CARD : item.move.cardName, item.count)
  }
  if (flow.inherit && flow.baseSlot === null && sources.length) flow.baseSlot = sources[0]
  pending.length = 0
}

function applyMove(
  ledger: Ledger,
  slots: Slots,
  origin: Map<string, Origin>,
  move: CardMove,
  timing: Timing,
  timingIndex: number,
  links: TimingLink[],
  trackLinks: boolean,
  negateTags: string[],
  reasons: string[],
  flow: MaterialFlow,
): number {
  const count = move.count && move.count > 0 ? move.count : 1
  const from = move.from
  const to = move.to
  const tracked = TRACKED_ZONES.includes(from)
  const unknown = Boolean(move.unknown)
  // 未知卡片共用一个占位 key，不参与按卡名连链
  const key = unknown ? UNKNOWN_CARD : move.cardName

  // 作为超量素材：从原区域叠到某只怪兽下面（怪物还没落地时先挂起）
  if (to === 'material') {
    const target = attachTarget(slots, move.slot, timing.cardName)
    if (target === null) {
      flow.pending.push({ move, count })
      return 0
    }
    const sourceSlot = from === 'field' ? slots.field.indexOf(key) : -1
    takeFromLedger(ledger, from, key, count, unknown, reasons)
    // 叠放时序里把怪兽叠成素材：它自己的素材要继承下来，而不是送墓
    leaveSlots(ledger, slots, from, key, count, flow.inherit ? target : undefined)
    attachMaterials(slots, target, key, count)
    if (flow.inherit && sourceSlot >= 0 && flow.baseSlot === null) flow.baseSlot = sourceSlot
    return 0
  }

  // 取除超量素材：那只怪兽 → 墓地 / 除外 / 手卡……
  if (from === 'material') {
    const order = detachOrder(slots, move.slot, timing.cardName)
    // 按卡名取：优先取用户指定的那张
    const take = (match: (name: string) => boolean): string[] => {
      const taken: string[] = []
      for (const index of order) {
        const pool = slots.materials[index]
        for (let i = pool.length - 1; i >= 0 && taken.length < count; i -= 1) {
          if (!match(pool[i])) continue
          taken.push(...pool.splice(i, 1))
        }
        if (taken.length >= count) break
      }
      return taken
    }
    let removed: string[] = []
    if (unknown || !key) removed = take(() => true)
    else removed = take((name) => name === key)
    // 指定了具体素材却找不到时，规则占位行退化为「取最上面一张」
    if (!removed.length && move.auto) removed = take(() => true)
    if (!removed.length) {
      reasons.push(
        `${unknown ? UNKNOWN_CARD : `「${key || '超量素材'}」`}不在超量素材中（${
          slotIndex(move.slot) !== null ? `${slotIndex(move.slot)! + 1} 号位` : '场上'
        }），已跳过`,
      )
      return 0
    }
    for (const name of removed) {
      addCard(ledger[to], name, 1)
      if (isSlotZone(to)) placeSlot(slots[to], name, move.slot, 1)
    }
    return 0
  }

  takeFromLedger(ledger, from, key, count, unknown, reasons)
  leaveSlots(ledger, slots, from, key, count)

  // 使用上游产出的卡 → 记一条链（必须来自同一个区域，避免同名卡错连）
  if (trackLinks && tracked && !unknown) {
    const source = origin.get(key)
    if (source && source.timingId !== timing.id && source.zone === from) {
      links.push({
        id: `${source.timingId}->${timing.id}:${key}`,
        fromTimingId: source.timingId,
        toTimingId: timing.id,
        fromIndex: source.timingIndex,
        toIndex: timingIndex,
        fromMoveId: source.moveId,
        toMoveId: move.id,
        cardName: key,
        to,
        kind: linkKindOf(source.from, to),
        handtraps: source.handtraps,
        broken: false,
      })
    }
  }

  addCard(ledger[to], key, count)
  if (to === 'field') {
    // 素材先收下来叠好：它们腾出的格位正好给这只怪兽，超量召唤不会因“怪兽区已满”失败
    if (flow.pending.length) {
      flushMaterials(
        ledger,
        slots,
        flow,
        projectedFieldSlot(slots, move, timing.cardName, flow),
        reasons,
      )
    }
    const placedAt = placeFieldCard(ledger, slots, key, move, count, flow.baseSlot, reasons)
    const position = move.position || 'attack'
    for (const index of placedAt) slots.positions[index] = position
  } else if (to === 'st') {
    placeSlot(slots.st, key, move.slot, count)
  }

  if (trackLinks && !unknown && TRACKED_ZONES.includes(to)) {
    origin.set(key, {
      timingId: timing.id,
      timingIndex,
      moveId: move.id,
      zone: to,
      from,
      handtraps: effectiveTags(move, negateTags),
    })
  }

  return isSummonMove(move) ? count : 0
}

function run(combo: ComboLine, opts: RunOptions): RunResult {
  const ledger = initialLedger(combo)
  const slots = emptySlots()
  const origin = new Map<string, Origin>()
  const links: TimingLink[] = []
  const states: TimingState[] = []
  const frames: PlaybackFrame[] = []
  const brokenTimings = new Set<string>()
  let summons = 0

  combo.timings.forEach((timing, index) => {
    const before = snapshot(ledger, summons, slots)
    /** 发动处理 + cost 已结算、效果还没处理的场面 */
    let activated = before
    const reasons: string[] = []
    let status: TimingStatus = 'ok'
    /** 本时序的超量素材处理状态（挂起、叠放继承、叠放目标） */
    const flow: MaterialFlow = {
      pending: [],
      // 本时序有「在超量怪兽上叠放」：被叠成素材的怪兽，它的素材要继承下来
      inherit: timing.effect.some((move) => move.overlay && move.to === 'field'),
      baseSlot: null,
    }

    /**
     * 同一阶段的移动一起落账、只产一帧：
     * 一个效果里有多段移动时它们是同时处理的，没有先后顺序。
     */
    const applyPhase = (
      moves: CardMove[],
      phase: PlaybackPhase,
      label: string,
      trackLinks: boolean,
      tags: string[],
      chains?: { link: number; name: string }[],
    ) => {
      if (!moves.length) return
      for (const move of moves) {
        summons += applyMove(
          ledger,
          slots,
          origin,
          move,
          timing,
          index,
          links,
          trackLinks,
          tags,
          reasons,
          flow,
        )
      }
      frames.push({
        id: `${timing.id}:${phase}`,
        timingId: timing.id,
        timingIndex: index,
        phase,
        label,
        moves,
        chains,
        snapshot: snapshot(ledger, summons, slots),
      })
    }

    // 1. 上游断链：基准推演里"这条链本该把卡送到"，但产出那一段被拦，或上游整步断链
    if (opts.baseline) {
      const cut = opts.baseline.find(
        (link) =>
          link.toTimingId === timing.id &&
          (opts.cancels.byMove.has(link.fromMoveId) || brokenTimings.has(link.fromTimingId)),
      )
      if (cut) {
        status = 'broken'
        const hitName =
          opts.cancels.byMove.get(cut.fromMoveId) || opts.cancels.byTiming.get(cut.fromTimingId)
        reasons.push(
          hitName
            ? `链路断裂：第 ${cut.fromIndex + 1} 时序的「${cut.cardName}」被「${handtrapName(hitName)}」拦下，未能送到${ZONE_LABELS[cut.to]}`
            : `链路断裂：第 ${cut.fromIndex + 1} 时序已断链，「${cut.cardName}」没有送到${ZONE_LABELS[cut.to]}`,
        )
      }
    }

    // 2. 本时序被封锁 / 无效
    const hit = opts.cancels.byTiming.get(timing.id)
    if (status === 'ok' && hit) {
      status = opts.cancels.negatedTimings.has(timing.id) ? 'negated' : 'partial'
      const blocked = timing.effect.filter((move) => opts.cancels.canceledMoves.has(move.id))
      reasons.push(
        opts.cancels.negatedTimings.has(timing.id)
          ? `「${timing.cardName}」的效果被「${handtrapName(hit)}」整段无效`
          : `「${handtrapName(hit)}」封锁了 ${blocked.length} 段效果：${blocked
              .map((move) => `${move.cardName} → ${ZONE_LABELS[move.to]}`)
              .join('、')}`,
      )
    }

    if (status !== 'broken') {
      const negateTags = negateTagsOf(timing)

      // 3. 主卡本身也是资源：没有被任何移动段引用时，补一条"进入链"
      if (opts.trackLinks && timing.cardName && timing.from && TRACKED_ZONES.includes(timing.from)) {
        const referenced = [...timing.cost, ...timing.effect].some(
          (move) => move.cardName === timing.cardName && move.from === timing.from,
        )
        const source = origin.get(timing.cardName)
        if (!referenced && source && source.timingId !== timing.id && source.zone === timing.from) {
          links.push({
            id: `${source.timingId}->${timing.id}:${timing.cardName}:${timing.from}`,
            fromTimingId: source.timingId,
            toTimingId: timing.id,
            fromIndex: source.timingIndex,
            toIndex: index,
            fromMoveId: source.moveId,
            cardName: timing.cardName,
            to: timing.from,
            kind: linkKindOf(source.from, timing.from),
            handtraps: source.handtraps,
            broken: false,
          })
        }
      }

      // 4. 前置处理（发动置入魔陷区 / 额外卡组召唤的素材）：规则处理，必定发生
      const setupLabel = timing.operation === 'specialSummon' ? '召唤素材' : '发动处理'
      applyPhase(timing.setup, 'setup', setupLabel, opts.trackLinks, [])

      // 5. cost 必定成功（即使效果随后被无效）
      applyPhase(timing.cost, 'cost', '支付 cost', opts.trackLinks, [])

      // 6. 连锁的发动（我方 2 速以上卡片）：C2 → Cn 的发动处理与 cost
      const chainList = [...timing.chains].sort((a, b) => a.link - b.link)
      const chainNames = chainList.map((chain) => `C${chain.link}`).join('/')
      const chainBadges = chainList.map((chain) => ({ link: chain.link, name: chain.cardName }))
      applyPhase(
        chainList.flatMap((chain) => [...(chain.setup || []), ...chain.cost]),
        'chainActivate',
        `${chainNames} 发动`,
        false,
        [],
        chainBadges,
      )

      // 7. 主卡效果段：一个效果里的多段移动同时处理，被封锁的段直接跳过
      applyPhase(
        timing.effect.filter((move) => !opts.cancels.canceledMoves.has(move.id)),
        'effect',
        '效果处理',
        opts.trackLinks,
        negateTags,
      )

      // 8. 连锁的结算：所有效果处理完之后统一结算
      applyPhase(
        chainList.flatMap((chain) => [...chain.effect, ...(chain.settle || [])]),
        'chainResolve',
        `${chainNames} 结算`,
        false,
        [],
      )

      // 发动后：主卡效果与连锁结算都已处理完，只剩送墓 / 回额外这类结算后去向
      activated = snapshot(ledger, summons, slots)

      // 9. 结算后（魔陷区 → 墓地 / 额外）：规则处理，效果被无效也照常
      applyPhase(timing.settle, 'settle', '结算后去向', opts.trackLinks, [])

      // 10. 场景里没有怪兽落地：挂起的素材留在原区域（记一条说明）
      flushMaterials(ledger, slots, flow, null, reasons)
    }

    if (status === 'broken') brokenTimings.add(timing.id)

    states.push({
      timingId: timing.id,
      index,
      status,
      reasons,
      before,
      activated: status === 'broken' ? before : activated,
      after: status === 'broken' ? before : snapshot(ledger, summons, slots),
      summonsAfter: summons,
    })
  })

  return { states, links: dedupeLinks(links), frames }
}

function dedupeLinks(links: TimingLink[]): TimingLink[] {
  const seen = new Set<string>()
  return links.filter((link) => {
    if (seen.has(link.id)) return false
    seen.add(link.id)
    return true
  })
}

export function handtrapName(id?: string): string {
  return id ? HANDTRAP_MAP[id]?.name || id : '未知手坑'
}

/** 把用户手动声明的依赖转成与自动链路同构的 TimingLink */
function resolveManualLinks(combo: ComboLine): TimingLink[] {
  const indexOf = new Map(combo.timings.map((timing, index) => [timing.id, index]))
  const out: TimingLink[] = []

  for (const timing of combo.timings) {
    if (!timing.manualLinks?.length) continue
    const toIndex = indexOf.get(timing.id) ?? 0

    for (const manual of timing.manualLinks) {
      const source = combo.timings.find((item) => item.id === manual.fromTimingId)
      if (!source) continue
      const moves: CardMove[] = [...source.setup, ...source.cost, ...source.effect, ...source.settle]
      for (const chain of source.chains) {
        moves.push(...(chain.setup || []), ...chain.cost, ...chain.effect, ...(chain.settle || []))
      }
      const move = moves.find((item) => item.id === manual.fromMoveId)
      if (!move) continue

      out.push({
        id: `manual:${timing.id}:${manual.fromMoveId}`,
        fromTimingId: source.id,
        toTimingId: timing.id,
        fromIndex: indexOf.get(source.id) ?? 0,
        toIndex,
        fromMoveId: move.id,
        cardName: move.cardName || timing.cardName,
        to: move.to,
        kind: linkKindOf(move.from, move.to),
        handtraps: move.handtraps || [],
        broken: false,
      })
    }
  }

  return out
}

export function analyzeTimeline(combo: ComboLine, interrupts: Interrupt[] = []): TimelineAnalysis {
  const cancels = buildCancels(combo, interrupts)
  const base = run(combo, {
    cancels: buildCancels(combo, []),
    trackLinks: true,
  })
  const hasEffect = cancels.canceledMoves.size > 0
  const live = hasEffect
    ? run(combo, { cancels, baseline: base.links, trackLinks: false })
    : base
  const statusOf = new Map(live.states.map((state) => [state.timingId, state.status]))

  const links = dedupeLinks([...base.links, ...resolveManualLinks(combo)]).map((link) => ({
    ...link,
    broken:
      cancels.byMove.has(link.fromMoveId) ||
      statusOf.get(link.fromTimingId) === 'broken' ||
      statusOf.get(link.toTimingId) === 'broken',
  }))

  const responses: Record<string, string[]> = {}
  for (const timing of combo.timings) responses[timing.id] = handtrapsAt(timing)

  return {
    states: live.states,
    frames: live.frames,
    links,
    totalSummons: live.states.at(-1)?.summonsAfter || 0,
    responses,
    canceledMoves: Object.fromEntries(cancels.byMove),
  }
}

/* ------------------------------------------------------------------ */
/* 手坑                                                                 */
/* ------------------------------------------------------------------ */

/** 某个时序上记录的全部可响应手坑（效果段 + 时序级 + 连锁） */
export function handtrapsAt(timing: Timing): string[] {
  const set = new Set<string>(timing.handtraps || [])
  for (const move of timing.effect) for (const id of move.handtraps || []) set.add(id)
  return [...set]
}

export function handtrapSites(combo: ComboLine, handtrapId: string): number[] {
  return combo.timings
    .map((timing, index) => (handtrapsAt(timing).includes(handtrapId) ? index : -1))
    .filter((index) => index >= 0)
}

function buildReport(defId: string, combo: ComboLine): HandtrapReport {
  const def = HANDTRAP_MAP[defId]
  const sites = handtrapSites(combo, defId)
  const base: HandtrapReport = {
    id: defId,
    sites,
    effective: false,
    negates: def.category !== 'draw' && def.category !== 'nuke',
    deadAt: null,
    broken: [],
    draws: 0,
    headline: def.category === 'nuke' ? '未达到发动条件' : '无法命中本线',
    verdict: 'inactive',
  }
  if (!sites.length) return base

  if (def.category === 'nuke') {
    return {
      ...base,
      effective: true,
      headline: `手动标注：第 ${sites[0] + 1} 时序`,
      verdict: 'warning',
    }
  }

  if (def.category === 'draw') {
    const draws = sites.length
    return {
      ...base,
      effective: true,
      draws,
      headline: `对手 +${draws} 张`,
      verdict: draws <= 2 ? 'warning' : draws <= 4 ? 'danger' : 'lethal',
    }
  }

  // 逐个时点应用，取对展开最不利的结果
  let worst: { deadAt: number | null; broken: number[]; site: number } | null = null
  for (const site of sites) {
    const timing = combo.timings[site]
    const sim = analyzeTimeline(combo, [{ timingId: timing.id, handtrapId: defId }])
    const broken = sim.states.filter((state) => state.status === 'broken').map((state) => state.index)
    const deadAt = broken.length ? Math.min(...broken) : null
    const better =
      !worst ||
      (deadAt ?? 99) < (worst.deadAt ?? 99) ||
      ((deadAt ?? 99) === (worst.deadAt ?? 99) && broken.length > worst.broken.length)
    if (better) worst = { deadAt, broken, site }
  }

  const deadAt = worst?.deadAt ?? null
  const site = worst?.site ?? sites[0]
  return {
    ...base,
    effective: true,
    deadAt,
    broken: worst?.broken || [],
    headline:
      deadAt !== null
        ? `断线于第 ${deadAt + 1} 时序`
        : `第 ${site + 1} 时序被拦，主线仍可继续`,
    verdict: deadAt !== null ? 'lethal' : 'warning',
  }
}

export function handtrapReports(combo: ComboLine): HandtrapReport[] {
  return HANDTRAPS.map((def) => buildReport(def.id, combo))
}

export interface ComboAnalysis extends TimelineAnalysis {
  reports: HandtrapReport[]
}

export function analyzeCombo(combo: ComboLine, interrupts: Interrupt[] = []): ComboAnalysis {
  const analysis = analyzeTimeline(combo, interrupts)
  return { ...analysis, reports: handtrapReports(combo) }
}

/* ------------------------------------------------------------------ */
/* 展示辅助                                                             */
/* ------------------------------------------------------------------ */

export function operationLabel(timing: { operation: Timing['operation'] }): string {
  return OPERATION_DEFS.find((def) => def.id === timing.operation)?.label || timing.operation
}

export function operationTone(timing: { operation: Timing['operation'] }): string {
  return OPERATION_DEFS.find((def) => def.id === timing.operation)?.tone || 'neutral'
}

export function timingTitle(timing: Timing): string {
  const label = timing.label?.trim()
  if (label) return label
  return timing.cardName ? `${operationLabel(timing)} · ${timing.cardName}` : operationLabel(timing)
}

export function chainSummary(chain: ChainEntry): string {
  return `卡片效果「${chain.cardName}」`
}

export function zoneSummary(snapshot: ZoneSnapshot): string {
  return ZONE_ORDER.filter((zone) => zone !== 'deck' && zone !== 'extra')
    .map((zone) => `${ZONE_LABELS[zone]} ${snapshot[zone].reduce((n, card) => n + card.count, 0)}`)
    .join(' · ')
}
