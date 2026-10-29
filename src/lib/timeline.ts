import type {
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

/** 怪兽区 / 魔陷区按格位记录卡名（下标 = 格位 - 1） */
interface Slots {
  field: SlotRow
  st: SlotRow
}

const isSlotZone = (zone: ZoneId): zone is 'field' | 'st' => zone === 'field' || zone === 'st'

function emptySlots(): Slots {
  return { field: Array(SLOT_COUNT).fill(null), st: Array(SLOT_COUNT).fill(null) }
}

/** 1-5 之外的格位一律夹到两端的有效格位 */
function slotIndex(slot?: number): number | null {
  if (!slot || !Number.isFinite(slot) || slot < 1) return null
  return Math.min(Math.floor(slot), SLOT_COUNT) - 1
}

/** 进场：先放指定格位，放不下（被占 / 多张）再从前往后补空位 */
function placeSlot(row: SlotRow, name: string, slot: number | undefined, count: number) {
  let placed = 0
  const preferred = slotIndex(slot)
  if (preferred !== null && (!row[preferred] || row[preferred] === name)) {
    row[preferred] = name
    placed += 1
  }
  for (let i = 0; i < SLOT_COUNT && placed < count; i += 1) {
    if (!row[i]) {
      row[i] = name
      placed += 1
    }
  }
}

/** 离场：把这张卡占用的格位清空 */
function clearSlot(row: SlotRow, name: string, count: number) {
  let cleared = 0
  for (let i = 0; i < row.length && cleared < count; i += 1) {
    if (row[i] === name) {
      row[i] = null
      cleared += 1
    }
  }
}

function slotCards(row: SlotRow): (ZoneCard | null)[] {
  return row.map((name) => (name ? { name, count: 1 } : null))
}

function snapshot(ledger: Ledger, summons: number, slots: Slots): ZoneSnapshot {
  return {
    hand: toList(ledger.hand),
    field: toList(ledger.field),
    st: toList(ledger.st),
    fieldSlots: slotCards(slots.field),
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
): number {
  const count = move.count && move.count > 0 ? move.count : 1
  const from = move.from
  const tracked = TRACKED_ZONES.includes(from)
  const unknown = Boolean(move.unknown)
  // 未知卡片共用一个占位 key，不参与按卡名连链
  const key = unknown ? UNKNOWN_CARD : move.cardName

  if (from === 'deck' || from === 'extra') {
    takeCard(ledger[from], key, count)
  } else if (tracked) {
    if (!takeCard(ledger[from], key, count)) {
      reasons.push(`${unknown ? UNKNOWN_CARD : `「${key}」`}不足（${ZONE_LABELS[from]}），已按可用处理`)
    }
  }
  if (isSlotZone(from)) clearSlot(slots[from], key, count)

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
        to: move.to,
        kind: linkKindOf(source.from, move.to),
        handtraps: source.handtraps,
        broken: false,
      })
    }
  }

  addCard(ledger[move.to], key, count)
  if (isSlotZone(move.to)) placeSlot(slots[move.to], key, move.slot, count)

  if (trackLinks && !unknown && TRACKED_ZONES.includes(move.to)) {
    origin.set(key, {
      timingId: timing.id,
      timingIndex,
      moveId: move.id,
      zone: move.to,
      from: move.from,
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
        summons += applyMove(ledger, slots, origin, move, timing, index, links, trackLinks, tags, reasons)
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

      // 4. 发动处理（手卡 → 魔陷区）：规则处理，必定发生
      applyPhase(timing.setup, 'setup', '发动处理', opts.trackLinks, [])

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
