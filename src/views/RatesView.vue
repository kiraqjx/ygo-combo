<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch, type Ref } from 'vue'
import CardPicker from '@/components/CardPicker.vue'
import { cardImageUrl } from '@/lib/cardDb'
import { copyImageToClipboard } from '@/lib/clipboard'
import { downloadBlob } from '@/lib/download'
import { inferRateOps, type InferredOp } from '@/lib/infer'
import { formatChance } from '@/lib/odds'
import {
  renderRatesPoster,
  type RatesPosterEffect,
  type RatesPosterHand,
  type RatesPosterStarter,
} from '@/lib/ratesPoster'
import { toast } from '@/lib/toast'
import {
  DEFAULT_SEED,
  DEFAULT_TRIALS,
  MAX_DISCARD,
  MAX_REVEAL,
  MAX_SLOT,
  blankClause,
  blankEffect,
  blankOp,
  blankPlan,
  buildRateModel,
  clauseHolds,
  clonePlan,
  comb,
  hypergeometricChance,
  openingChance,
  reached,
  slotHolds,
  slotLabel,
  solveRate,
  type RateClause,
  type RateCondition,
  type RateEffect,
  type RateOp,
  type RateOutcome,
  type RatePlan,
  type RateSlot,
  type SolveOptions,
} from '@/lib/rates'
import type { RateWorkerResponse } from '@/lib/ratesWorker'
import type { DeckEntry } from '@/types'
import { useCardStore } from '@/stores/cards'
import { useDeckStore } from '@/stores/deck'

const deck = useDeckStore()
const cards = useCardStore()

/** 「合计 ≥N / ≤N」的下拉选项 */
const SLOT_VALUES = Array.from({ length: MAX_SLOT + 1 }, (_, index) => index)

const EMPTY_PLAN = blankPlan()

const activeDeck = computed(() => deck.current)
const plan = computed<RatePlan>(() => activeDeck.value?.plan ?? EMPTY_PLAN)
const mainEntries = computed(() => activeDeck.value?.main ?? [])
const deckSize = computed(() => mainEntries.value.reduce((sum, entry) => sum + entry.count, 0))
const handSize = computed(() => plan.value.handSize)

const selectedId = computed({
  get: () => deck.currentDeckId,
  set: (id: string) => deck.select(id),
})

function setHandSize(value: number) {
  mutate((target) => {
    target.handSize = Math.min(20, Math.max(1, Math.floor(value) || 5))
  })
}

/* ---------------- 配置修改 ---------------- */

function mutate(fn: (target: RatePlan) => void) {
  deck.patchPlan(fn)
  stale.value = true
  // 配置一变，上一次的交叉校验结果就对不上了
  cross.value = null
  crossFailure.value = ''
}

/** 组里任意一条检查都用过的卡，不能再拿来新建检查 */
function freeCards(clause: RateClause) {
  const used = new Set(clause.slots.flatMap((slot) => slot.cards.map((card) => card.id)))
  return mainEntries.value.filter((entry) => !used.has(entry.id))
}

function cardName(id: number): string {
  return (
    mainEntries.value.find((entry) => entry.id === id)?.name ||
    cards.getCard(id)?.name ||
    `#${id}`
  )
}

let checkSeq = 0
function nextCheckId(): string {
  checkSeq += 1
  return `k${Date.now().toString(36)}${checkSeq}`
}

/* ---------------- 启动条件 ---------------- */

function addClause() {
  mutate((target) => {
    target.starters.push(blankClause())
  })
}

function removeClause(id: string) {
  mutate((target) => {
    target.starters = target.starters.filter((clause) => clause.id !== id)
  })
}

/** 新建一条检查：默认「至少 1 张」；废件模式则是「合计 = 0」 */
function addCheck(clauseId: string, cardId: number) {
  if (!(cardId > 0)) return
  const entry = mainEntries.value.find((item) => item.id === cardId)
  if (!entry) return
  const ban = Boolean(slotBan.value[clauseId])
  mutate((target) => {
    const clause = target.starters.find((item) => item.id === clauseId)
    if (!clause) return
    if (clause.slots.some((slot) => slot.cards.some((card) => card.id === cardId))) return
    clause.slots.push({
      id: nextCheckId(),
      cards: [{ id: cardId, name: entry.name }],
      min: ban ? 0 : 1,
      max: ban ? 0 : null,
    })
  })
}

/** 把一张卡并入已有的检查：多张卡时约束的是它们的合计张数 */
function addCardToCheck(clauseId: string, slotId: string, cardId: number) {
  if (!(cardId > 0)) return
  mutate((target) => {
    const clause = target.starters.find((item) => item.id === clauseId)
    const slot = clause?.slots.find((item) => item.id === slotId)
    if (!clause || !slot) return
    if (clause.slots.some((item) => item.cards.some((card) => card.id === cardId))) return
    slot.cards.push({ id: cardId, name: cardName(cardId) })
  })
}

function removeCardFromCheck(clauseId: string, slotId: string, cardId: number) {
  mutate((target) => {
    const clause = target.starters.find((item) => item.id === clauseId)
    const slot = clause?.slots.find((item) => item.id === slotId)
    if (!clause || !slot) return
    slot.cards = slot.cards.filter((card) => card.id !== cardId)
    if (!slot.cards.length) clause.slots = clause.slots.filter((item) => item.id !== slotId)
  })
}

function removeCheck(clauseId: string, slotId: string) {
  mutate((target) => {
    const clause = target.starters.find((item) => item.id === clauseId)
    if (!clause) return
    clause.slots = clause.slots.filter((slot) => slot.id !== slotId)
  })
}

function setCheckMin(clauseId: string, slotId: string, min: number) {
  mutate((target) => {
    const clause = target.starters.find((item) => item.id === clauseId)
    const slot = clause?.slots.find((item) => item.id === slotId)
    if (!slot) return
    slot.min = Math.min(MAX_SLOT, Math.max(0, Math.floor(min) || 0))
    if (slot.max !== null && slot.max < slot.min) slot.max = slot.min
  })
}

function setCheckMax(clauseId: string, slotId: string, raw: string) {
  mutate((target) => {
    const clause = target.starters.find((item) => item.id === clauseId)
    const slot = clause?.slots.find((item) => item.id === slotId)
    if (!slot) return
    if (raw === '') {
      slot.max = null
      return
    }
    const value = Math.min(MAX_SLOT, Math.max(0, Math.floor(Number(raw)) || 0))
    slot.max = Math.max(value, slot.min)
  })
}

/** 主卡组条目 → 选卡器选项 */
function pickerCards(entries: DeckEntry[], hint?: string) {
  return entries.map((entry) => ({ id: entry.id, name: entry.name, count: entry.count, hint }))
}

/* ---------------- 废件：并入启动条件 ---------------- */

/** 启动组的「下一张卡」模式：必须上手 / 不能上手 */
const slotBan = ref<Record<string, boolean>>({})

function toggleSlotBan(clauseId: string) {
  slotBan.value = { ...slotBan.value, [clauseId]: !slotBan.value[clauseId] }
}

/* ---------------- 上手率小工具（废件 / 手坑，超几何纯手填） ---------------- */

/**
 * 两块都是「起手 N 张里，M 张目标卡恰好上手 k 张」的超几何查表。
 * 张数刻意不从启动条件反推：检查行写的是「这组卡合计 ≤N」，≤1 表示上手 1 张仍能启动，
 * 和「这几张一张都不想上手」不是一回事，自动带入会算出 0 张，反而误导。
 */
function useHandTable(target: Ref<number>) {
  const count = computed(() => {
    const value = Math.floor(Number(target.value) || 0)
    return Math.min(Math.max(0, value), deckSize.value)
  })

  /** 1~5 张的概率；张数不够或起手装不下时该行为空 */
  const rows = computed(() => {
    const total = deckSize.value
    const hand = handSize.value
    return [1, 2, 3, 4, 5].map((k) => ({
      k,
      available: total > 0 && k <= count.value && k <= hand,
      p: hypergeometricChance(total, hand, count.value, k),
    }))
  })

  /** 至少上手 1 张（= 1 - 一张都不上手） */
  const atLeastOne = computed(() => {
    if (deckSize.value <= 0) return 0
    return 1 - hypergeometricChance(deckSize.value, handSize.value, count.value, 0)
  })

  function onInput(event: Event) {
    const input = event.target as HTMLInputElement
    const value = Math.floor(Number(input.value) || 0)
    target.value = Math.min(deckSize.value, Math.max(0, value))
  }

  return { count, rows, atLeastOne, onInput }
}

/**
 * 张数存在卡组的 plan 里：跟这套构筑一起落盘、一起备份。
 * 走 patchPlan 而不是 mutate()，因为它不影响启动率求解，不该把结果标成过期。
 */
const brickCount = computed({
  get: () => plan.value.brickCount ?? 0,
  set: (value: number) => {
    deck.patchPlan((target) => {
      target.brickCount = Math.max(0, Math.floor(value) || 0)
    })
  },
})

const handtrapCount = computed({
  get: () => plan.value.handtrapCount ?? 0,
  set: (value: number) => {
    deck.patchPlan((target) => {
      target.handtrapCount = Math.max(0, Math.floor(value) || 0)
    })
  },
})

const brickTable = useHandTable(brickCount)
const {
  count: bricks,
  rows: brickRows,
  atLeastOne: brickAtLeastOne,
  onInput: onBrickInput,
} = brickTable

const handtrapTable = useHandTable(handtrapCount)
const {
  count: handtraps,
  rows: handtrapRows,
  atLeastOne: handtrapAtLeastOne,
  onInput: onHandtrapInput,
} = handtrapTable

/* ---------------- 抽滤效果 ---------------- */

function addEffect() {
  mutate((target) => {
    target.effects.push(blankEffect())
  })
}

function removeEffect(id: string) {
  mutate((target) => {
    target.effects = target.effects.filter((effect) => effect.id !== id)
  })
}

/** 推断结果 → 内核算子（补 id、夹紧范围） */
function toOps(inferred: InferredOp[]): RateOp[] {
  return inferred.map((item) => {
    const op = blankOp(item.kind)
    if (item.kind === 'dig') {
      op.reveal = Math.min(MAX_REVEAL, Math.max(0, item.reveal))
      op.take = Math.min(op.reveal, Math.max(0, item.take))
      op.sink = item.sink
    } else {
      op.count = Math.min(MAX_DISCARD, Math.max(0, item.count))
      op.all = item.all
    }
    return op
  })
}

/** 自动补的那种「单卡 ≥1」检查：换源卡时要能认回来摘掉 */
function isSourceGate(slot: RateSlot, cardId: number): boolean {
  return slot.cards.length === 1 && slot.cards[0]?.id === cardId && slot.min === 1 && slot.max === null
}

/** 选一张主卡组里的卡作为效果来源，并把效果文本拆成算子 */
function pickEffectCard(effect: RateEffect, cardId: number | null) {
  if (!cardId || !(cardId > 0)) {
    mutate((target) => {
      const found = target.effects.find((item) => item.id === effect.id)
      if (found) found.sourceId = null
    })
    return
  }
  const entry = mainEntries.value.find((item) => item.id === cardId)
  if (!entry) return
  const card = cards.getCard(cardId)
  const inferred = card ? inferRateOps(card) : null
  const ops = inferred && inferred.ops.length ? toOps(inferred.ops) : null
  mutate((target) => {
    const found = target.effects.find((item) => item.id === effect.id)
    if (!found) return
    const previous = found.sourceId
    found.sourceId = cardId
    found.name = entry.name
    if (ops) found.ops = ops

    // 换源卡时把上一张自动补的那条摘掉，否则换一次攒一条
    if (previous !== null && previous !== cardId) {
      found.requirement = found.requirement
        .map((clause) => ({
          ...clause,
          slots: clause.slots.filter((slot) => !isSourceGate(slot, previous)),
        }))
        .filter((clause) => clause.slots.length)
    }

    // 没上手就发动不了：默认补一条「这张卡 ≥1」。从墓地 / 除外发动的效果可以手动删掉
    const gated = found.requirement.some((clause) =>
      clause.slots.some((slot) => slot.cards.some((item) => item.id === cardId)),
    )
    if (!gated) {
      found.requirement = [
        ...found.requirement,
        {
          id: nextCheckId(),
          slots: [{ id: nextCheckId(), cards: [{ id: cardId, name: entry.name }], min: 1, max: null }],
        },
      ]
    }
  })
}

/** 参数被改乱之后，按卡面文本重新拆一次算子 */
function reapplyInference(effect: RateEffect) {
  if (!effect.sourceId) return
  const card = cards.getCard(effect.sourceId)
  if (!card) return
  const inferred = inferRateOps(card)
  if (!inferred.ops.length) return
  const ops = toOps(inferred.ops)
  mutate((target) => {
    const found = target.effects.find((item) => item.id === effect.id)
    if (found) found.ops = ops
  })
}

function addOp(effect: RateEffect, kind: RateOp['kind']) {
  mutate((target) => {
    const found = target.effects.find((item) => item.id === effect.id)
    if (found) found.ops.push(blankOp(kind))
  })
}

function removeOp(effect: RateEffect, opId: string) {
  mutate((target) => {
    const found = target.effects.find((item) => item.id === effect.id)
    if (found) found.ops = found.ops.filter((op) => op.id !== opId)
  })
}

/** 改完数字后夹紧，保证 take ≤ reveal */
function clampOp(effect: RateEffect, op: RateOp) {
  mutate((target) => {
    const found = target.effects.find((item) => item.id === effect.id)
    const current = found?.ops.find((item) => item.id === op.id)
    if (!current) return
    if (current.kind === 'dig') {
      current.reveal = Math.min(MAX_REVEAL, Math.max(0, Math.floor(current.reveal) || 0))
      current.take = Math.min(current.reveal, Math.max(0, Math.floor(current.take) || 0))
    } else {
      current.count = Math.min(MAX_DISCARD, Math.max(0, Math.floor(current.count) || 0))
    }
  })
}

function sourceThumb(effect: RateEffect): string {
  return effect.sourceId ? cardImageUrl(effect.sourceId) : ''
}

/** 效果选择器：把「文本里能拆出算子」的卡分组排到前面 */
const digGroups = computed(() => {
  const recommended: DeckEntry[] = []
  const others: DeckEntry[] = []
  for (const entry of mainEntries.value) {
    const card = cards.getCard(entry.id)
    const hit = card ? inferRateOps(card) : null
    if (hit && hit.ops.length) recommended.push(entry)
    else others.push(entry)
  }
  return [
    { label: '能抽牌 / 翻牌的卡', items: pickerCards(recommended, '可自动识别算子') },
    { label: '其他主卡组卡片', items: pickerCards(others) },
  ]
})

/** 每个已选卡的效果对应的识别说明 */
const effectHints = computed(() => {
  const map = new Map<string, string[]>()
  for (const effect of plan.value.effects) {
    if (!effect.sourceId) continue
    const card = cards.getCard(effect.sourceId)
    if (card) map.set(effect.id, inferRateOps(card).hints)
  }
  return map
})

/**
 * 发动条件是 `clause₁ OR clause₂ …`，每个 clause 是 `slot₁ AND slot₂ …`，
 * 而同一个 slot 里的多张卡算「合计张数」，也就是这几张任意一张就够。
 * 所以 A AND (B 或 C 或 D) 要写成两个 slot：[A≥1] 且 [B,C,D 合计 ≥1]。
 *
 * 三种追加方式对应三种语义：
 *   or    → 新开一组（组间 OR，任一组成立即可发动）
 *   and   → 组内再加一条检查（两个 slot 都要满足）
 *   merge → 并入上一条检查（变成「这几张合计 ≥1」，任意一张即可）
 */
type RequirementMode = 'or' | 'and' | 'merge'

const requirementMode = ref<Record<string, RequirementMode>>({})

function requirementModeOf(effect: RateEffect): RequirementMode {
  return requirementMode.value[effect.id] ?? 'or'
}

function setRequirementMode(effectId: string, mode: RequirementMode) {
  requirementMode.value = { ...requirementMode.value, [effectId]: mode }
}

/** 一条检查里合并了十几张卡时先折叠，展开状态按检查 id 记 */
const GATE_PREVIEW = 6
const gateOpen = ref<Record<string, boolean>>({})

function toggleGate(slotId: string) {
  gateOpen.value = { ...gateOpen.value, [slotId]: !gateOpen.value[slotId] }
}

function gateCards(slot: RateSlot): Array<{ id: number; name: string }> {
  return gateOpen.value[slot.id] ? slot.cards : slot.cards.slice(0, GATE_PREVIEW)
}

function pickRequirement(effect: RateEffect, cardId: number, mode: RequirementMode) {
  if (!(cardId > 0)) return
  const entry = mainEntries.value.find((item) => item.id === cardId)
  if (!entry) return
  mutate((target) => {
    const found = target.effects.find((item) => item.id === effect.id)
    if (!found) return
    // 同一张卡在一个效果的条件里只出现一次
    if (
      found.requirement.some((clause) =>
        clause.slots.some((slot) => slot.cards.some((card) => card.id === cardId)),
      )
    ) {
      return
    }
    const card = { id: cardId, name: entry.name }
    const last = found.requirement[found.requirement.length - 1]

    if (mode === 'and' && last) {
      // 组内 AND：另起一条检查，两张都要上手
      last.slots.push({ id: nextCheckId(), cards: [card], min: 1, max: null })
      return
    }
    if (mode === 'merge' && last && last.slots.length) {
      // 并入上一条检查：这几张算合计，任意一张即可
      const slot = last.slots[last.slots.length - 1]
      slot.cards.push(card)
      return
    }
    // 新开一组：组间 OR
    found.requirement.push({
      id: `req-${cardId}-${Date.now().toString(36)}`,
      slots: [{ id: nextCheckId(), cards: [card], min: 1, max: null }],
    })
  })
}

/** 追加到最后一组 / 上一条检查时，排除已经用掉的卡 */
function requirementFree(effect: RateEffect, mode: RequirementMode) {
  const last = effect.requirement[effect.requirement.length - 1]
  if (!last) return mainEntries.value
  const cards =
    mode === 'merge'
      ? (last.slots[last.slots.length - 1]?.cards ?? [])
      : last.slots.flatMap((slot) => slot.cards)
  const used = new Set(cards.map((card) => card.id))
  return mainEntries.value.filter((entry) => !used.has(entry.id))
}

/** 发动条件候选项：与追加模式（组间或 / 组内且 / 并入上一条）联动 */
function requirementOptions(effect: RateEffect) {
  const mode = requirementModeOf(effect)
  const pool =
    mode !== 'or' && effect.requirement.length ? requirementFree(effect, mode) : mainEntries.value
  return pickerCards(
    pool.filter(
      (entry) =>
        !effect.requirement.some((clause) =>
          clause.slots.some((slot) => slot.cards.some((card) => card.id === entry.id)),
        ),
    ),
  )
}

/** 主卡组里的速攻魔法：作为「需要另一张速攻」这类门控的快捷入口 */
const quickPlayEntries = computed(() =>
  mainEntries.value.filter((entry) => {
    const card = cards.getCard(entry.id)
    return card?.frame === 'spell' && card.kinds.includes('速攻')
  }),
)

/** 主卡组里的全部魔法 / 陷阱：作为「手上还有任意一张魔陷」这类门控 */
const spellTrapEntries = computed(() =>
  mainEntries.value.filter((entry) => {
    const card = cards.getCard(entry.id)
    return card?.frame === 'spell' || card?.frame === 'trap'
  }),
)

/**
 * 快捷门控：把一整类卡合成一条「这些卡合计 ≥1」的检查，追加到最后一组里（组内 AND）。
 * 也就是「还要有任意一张速攻 / 魔陷才能发动」，不需要逐张点进 picker。
 */
function addGateGroup(effect: RateEffect, pool: DeckEntry[]) {
  if (!pool.length) return
  mutate((target) => {
    const found = target.effects.find((item) => item.id === effect.id)
    if (!found) return
    const used = new Set(
      found.requirement.flatMap((clause) => clause.slots.flatMap((slot) => slot.cards.map((card) => card.id))),
    )
    const cards = pool
      .filter((entry) => !used.has(entry.id))
      .map((entry) => ({ id: entry.id, name: entry.name }))
    if (!cards.length) return
    const slot = { id: nextCheckId(), cards, min: 1, max: null }
    const last = found.requirement[found.requirement.length - 1]
    if (last) last.slots.push(slot)
    else found.requirement.push({ id: `req-g-${Date.now().toString(36)}`, slots: [slot] })
  })
}

function addQuickPlayGate(effect: RateEffect) {
  addGateGroup(effect, quickPlayEntries.value)
}

function addSpellTrapGate(effect: RateEffect) {
  addGateGroup(effect, spellTrapEntries.value)
}

function removeRequirementClause(effect: RateEffect, index: number) {
  mutate((target) => {
    const found = target.effects.find((item) => item.id === effect.id)
    if (!found) return
    found.requirement.splice(index, 1)
  })
}

function removeRequirementCard(effect: RateEffect, clauseIndex: number, cardId: number) {
  mutate((target) => {
    const found = target.effects.find((item) => item.id === effect.id)
    const clause = found?.requirement[clauseIndex]
    if (!found || !clause) return
    for (const slot of clause.slots) {
      slot.cards = slot.cards.filter((card) => card.id !== cardId)
    }
    clause.slots = clause.slots.filter((slot) => slot.cards.length)
    if (!clause.slots.length) found.requirement.splice(clauseIndex, 1)
  })
}

/* ---------------- 计算 ---------------- */

const result = ref<RateOutcome | null>(null)
const snapshot = ref<RatePlan | null>(null)
const busy = ref(false)
const stale = ref(true)
const failure = ref('')
/** 配置版本号：用来判断「结果回来时配置是不是又被改过」 */
const editVersion = ref(0)

/** 单个启动组的静态上手率（含废件约束），给配置面板做即时反馈 */
const clauseChances = computed(() => {
  const starters = plan.value.starters
  if (!deckSize.value) return starters.map(() => 0)
  const blockers = plan.value.blockers
  return starters.map((clause) => {
    const model = buildRateModel(mainEntries.value, [clause], blockers)
    return openingChance(model, [clause], blockers, handSize.value)
  })
})

const funnel = computed(() => {
  const data = result.value
  if (!data) return []
  const names = snapshot.value?.effects ?? []
  const opening = snapshot.value?.handSize ?? handSize.value
  let cum = 0
  return data.steps.map((gain, index) => {
    cum += gain
    const effect = names[index - 1]
    const label =
      index === 0 ? `起手 ${opening} 张` : `效果 ${index} · ${effect?.name || describeEffect(effect)}`
    return { key: `${index}`, label, gain, cum }
  })
})

function describeOp(op: RateOp): string {
  if (op.kind === 'discard') return op.all ? '丢光手牌' : `丢 ${op.count} 张`
  if (op.take <= 0) {
    const where = op.sink === 'banish' ? '除外' : op.sink === 'bottom' ? '放回' : '送墓'
    return `顶 ${op.reveal} 张${where}`
  }
  if (op.take >= op.reveal) return `抽 ${op.reveal} 张`
  return `看 ${op.reveal} 拿 ${op.take}`
}

function describeEffect(effect?: RateEffect): string {
  if (!effect || !effect.ops.length) return '空效果'
  return effect.ops.map(describeOp).join(' → ')
}

/** 槽位的可读形式：必须上手 / ×N / 至多 N / 不能上手 */
function describeSlot(slot: RateSlot): string {
  return slotLabel(slot) || '（空检查）'
}

function describeCondition(condition: RateCondition): string {
  return condition
    .map((clause) => clause.slots.map(describeSlot).join(' + '))
    .join(' 或 ')
}

const totalDelta = computed(() => {
  const data = result.value
  return data ? data.total - data.opening : 0
})

const stepSum = computed(() => (result.value ? result.value.steps.reduce((a, b) => a + b, 0) : 0))

const methodLabel = computed(() => {
  const data = result.value
  if (!data) return ''
  if (data.method === 'exact') {
    return data.states > 0 ? `精确求解 · ${data.states.toLocaleString('zh-CN')} 个状态` : '精确求解'
  }
  return `蒙特卡洛 ${data.trials.toLocaleString('zh-CN')} 次`
})

const ciLabel = computed(() => {
  const data = result.value
  if (!data?.ci) return ''
  return `95% 区间 ${formatChance(data.ci[0])} ~ ${formatChance(data.ci[1])}`
})

/* ---------------- 导出长图 ---------------- */

const posterBusy = ref(false)
const posterCopying = ref(false)
const posterOpen = ref(false)
const posterUrl = ref('')
const posterBlob = ref<Blob | null>(null)

const posterMeta = computed(() => {
  const blob = posterBlob.value
  if (!blob) return ''
  return `${Math.round(blob.size / 1024)} KB · ${blob.type.replace('image/', '').toUpperCase()}`
})

/** 一个启动组的卡名文案：组内用「＋」表示合计，多条检查用「｜」隔开 */
function starterCardsText(clause: RateClause): string {
  return clause.slots
    .map((slot) => slot.cards.map((card) => card.name).join(' ＋ '))
    .filter(Boolean)
    .join(' ｜ ')
}

function posterStarters(): RatesPosterStarter[] {
  return plan.value.starters.map((clause, index) => ({
    cards: starterCardsText(clause) || `启动组 ${index + 1}`,
    chance: clauseChances.value[index] ?? 0,
  }))
}

function posterEffects(): RatesPosterEffect[] {
  // 结果和当前配置对不上时 pp 不可信，只画效果描述
  const fresh = stale.value ? null : result.value
  return plan.value.effects.map((effect, index) => {
    const detail = describeEffect(effect)
    return {
      name: effect.name || '假想效果',
      detail: detail === '空效果' ? '' : detail,
      gain: fresh ? (fresh.steps[index + 1] ?? 0) : null,
    }
  })
}

/** 没有计算结果时，至少把「起手即启动」现算出来（纯解析解，很快） */
function liveOpeningChance(): number | null {
  const starters = plan.value.starters
  if (!deckSize.value || !starters.length) return null
  try {
    const model = buildRateModel(mainEntries.value, starters, plan.value.blockers)
    return openingChance(model, starters, plan.value.blockers, handSize.value)
  } catch {
    return null
  }
}

function posterHand(
  count: number,
  rows: Array<{ k: number; p: number; available: boolean }>,
  atLeastOne: number,
): RatesPosterHand | null {
  if (count <= 0) return null
  return {
    count,
    rows: rows.filter((row) => row.available).map((row) => ({ k: row.k, p: row.p })),
    atLeastOne,
  }
}

function posterMethod(): string {
  const data = stale.value ? null : result.value
  if (!data) return plan.value.effects.length ? '抽滤收益尚未计算' : ''
  return ciLabel.value ? `${methodLabel.value} · ${ciLabel.value}` : methodLabel.value
}

function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned || 'deck'
}

/** 画一张启动率长图；没算过启动率就先算一次，保证图里有 pp */
async function buildPosterBlob(): Promise<Blob | null> {
  if (!deckSize.value) {
    toast('先把卡组配好再导出', true)
    return null
  }
  if (!result.value || stale.value) await compute()
  const data = stale.value ? null : result.value
  return renderRatesPoster({
    deckName: activeDeck.value?.name || '未命名卡组',
    handSize: handSize.value,
    deckSize: deckSize.value,
    opening: data ? data.opening : liveOpeningChance(),
    total: data ? data.total : null,
    method: posterMethod(),
    starters: posterStarters(),
    effects: posterEffects(),
    brick: posterHand(bricks.value, brickRows.value, brickAtLeastOne.value),
    handtrap: posterHand(handtraps.value, handtrapRows.value, handtrapAtLeastOne.value),
  })
}

function posterFileName(blob: Blob): string {
  const suffix = blob.type === 'image/png' ? 'png' : 'webp'
  return `${safeFileName(activeDeck.value?.name || 'deck')}-启动率.${suffix}`
}

/** 生成并打开预览弹窗：下载 / 复制都在弹窗里做 */
async function openPoster() {
  if (posterBusy.value) return
  posterBusy.value = true
  try {
    const blob = await buildPosterBlob()
    if (!blob) return
    if (posterUrl.value) URL.revokeObjectURL(posterUrl.value)
    posterBlob.value = blob
    posterUrl.value = URL.createObjectURL(blob)
    posterOpen.value = true
  } catch (error) {
    toast(error instanceof Error ? error.message : '导出启动率长图失败', true)
  } finally {
    posterBusy.value = false
  }
}

function closePoster() {
  posterOpen.value = false
  if (posterUrl.value) {
    URL.revokeObjectURL(posterUrl.value)
    posterUrl.value = ''
  }
  posterBlob.value = null
}

function downloadPoster() {
  const blob = posterBlob.value
  if (!blob) return
  downloadBlob(blob, posterFileName(blob))
  toast(`已保存启动率长图（${Math.round(blob.size / 1024)} KB）`)
}

async function copyPoster() {
  const blob = posterBlob.value
  if (!blob || posterCopying.value) return
  posterCopying.value = true
  try {
    await copyImageToClipboard(blob)
    toast('已复制到剪贴板，可以直接粘贴发送')
  } catch (error) {
    toast(error instanceof Error ? error.message : '复制失败，请改用下载', true)
  } finally {
    posterCopying.value = false
  }
}

/** 推导面板的静态部分：卡组规模、等价类数量、各启动组的起手率 */
const processInfo = computed(() => {
  const snap = snapshot.value
  if (!snap) return null
  const deck = mainEntries.value.map((entry) => ({ ...entry }))
  const extras = snap.effects.map((effect) => effect.requirement)
  const model = buildRateModel(deck, snap.starters, snap.blockers, extras)
  const hand = Math.min(Math.max(0, snap.handSize), model.size)
  return {
    deckSize: model.size,
    handSize: hand,
    totalHands: comb(model.size, hand),
    classes: model.classes.length,
    namedClasses: model.classes.filter((item) => item.id > 0).length,
    groups: snap.starters.map((clause, index) => {
      const chance = openingChance(
        buildRateModel(deck, [clause], snap.blockers),
        [clause],
        snap.blockers,
        hand,
      )
      const label = clause.slots.map(describeSlot).join(' + ') || `启动组 ${index + 1}`
      return { key: clause.id, label, chance }
    }),
  }
})

/** 推导面板的逐步部分：每个效果带来的新增达成率，以及效果内部逐算子的明细 */
const processEffectRows = computed(() => {
  const snap = snapshot.value
  if (!snap) return []
  const traces = result.value?.traces ?? []
  const rows: Array<{
    key: string
    step: number
    label: string
    detail: string
    gain: number
    cum: number
    trace: {
      gateSkip: number
      optionalSkip: number
      ops: Array<{
        key: string
        index: number
        label: string
        before: number
        after: number
        gain: number
        dead: number
        deck: number
      }>
    } | null
  }> = []
  funnel.value.forEach((row, index) => {
    const effect = snap.effects[index - 1]
    if (!effect) return
    const effectIndex = index - 1
    const summary = traces.find((item) => item.effect === effectIndex && item.op === -1)
    const ops = traces
      .filter((item) => item.effect === effectIndex && item.op >= 0)
      .map((item) => ({
        key: `${effectIndex}-${item.op}`,
        index: item.op,
        label: describeOp(effect.ops[item.op]),
        before: item.before,
        after: item.after,
        gain: item.gained,
        dead: item.dead,
        deck: item.deck,
      }))
    rows.push({
      key: row.key,
      step: index,
      label: `效果 ${index} · ${effect.name || '未命名'}`,
      detail: summary
        ? [
          effect.requirement.length ? `发动需 ${describeCondition(effect.requirement)}` : '无条件，直接执行',
          effect.optional ? '可选发动（发动更差时整段跳过）' : '',
        ]
          .filter(Boolean)
          .join(' · ')
        : [describeEffect(effect), effect.requirement.length ? `需 ${describeCondition(effect.requirement)}` : '']
          .filter(Boolean)
          .join(' · '),
      gain: row.gain,
      cum: row.cum,
      trace: summary ? { gateSkip: summary.skipped, optionalSkip: summary.optionalSkip, ops } : null,
    })
  })
  return rows
})

/** 起手就带硬废件、直接出局的质量 */
const openingDead = computed(() => result.value?.traces.find((item) => item.effect === -1)?.dead ?? 0)

/** 推导面板尾部：求解方法与精度说明 */
const processNotes = computed(() => {
  const data = result.value
  const info = processInfo.value
  if (!data || !info) return []
  const notes: string[] = []
  if (data.method === 'exact') {
    notes.push(
      `精确解：同名卡压成等价类（共 ${info.classes} 类），对每个中间手牌做值迭代，展开 ${data.states.toLocaleString('zh-CN')} 个状态，无采样误差。`,
    )
    notes.push(
      '每个算子下方是「执行前 → 执行后仍未启动的概率」，差值会分成两部分：右边是新增启动率，废件上手导致出局的会单独标出来；牌库张数按未启动质量加权平均。',
    )
  } else {
    notes.push(
      `精确枚举超出状态预算，改用 ${data.trials.toLocaleString('zh-CN')} 次蒙特卡洛抽样（启发式出牌），只给效果级增量，不提供逐算子明细。`,
    )
    if (data.ci) {
      notes.push(`95% 置信区间 ${formatChance(data.ci[0])} ~ ${formatChance(data.ci[1])}，重新计算会在此区间内波动。`)
    }
  }
  notes.push(`逐步归因：第一次达成的步骤相加 = ${formatChance(stepSum.value)}。`)
  notes.push(
    `自检：下方「起手核对器」可以挑一手具体的牌、逐项核对判定；「交叉校验」会用同一份配置再跑 ${DEFAULT_TRIALS.toLocaleString('zh-CN')} 次蒙特卡洛（种子 ${DEFAULT_SEED}）与精确解对照。`,
  )
  return notes
})

const warnings = computed(() => {
  const list: string[] = []
  if (!activeDeck.value) list.push('还没有卡组，先去「卡组构建」建一套。')
  else if (deckSize.value <= 0) list.push('这套卡组的主卡组是空的。')
  if (!plan.value.starters.length) list.push('还没有配置启动条件，先加一条「启动组」。')

  const known = new Set(mainEntries.value.map((entry) => entry.id))
  const missingStarter: string[] = []
  for (const clause of plan.value.starters) {
    for (const slot of clause.slots) {
      if (slot.min <= 0) continue
      for (const card of slot.cards) {
        if (!known.has(card.id)) missingStarter.push(card.name)
      }
    }
  }
  if (missingStarter.length) {
    list.push(`${[...new Set(missingStarter)].join('、')} 已不在主卡组里，条件永远不会成立。`)
  }

  for (const effect of plan.value.effects) {
    const useful = effect.ops.some((op) =>
      op.kind === 'discard' ? op.all || op.count > 0 : op.reveal > 0,
    )
    if (!useful) list.push(`效果「${effect.name || '未命名'}」没有任何算子，等于空操作。`)
    // 选了发动卡却没配发动条件：模型会当成「每局都能发动」，收益严重高估
    if (useful && effect.sourceId !== null && !effect.requirement.length) {
      list.push(
        `效果「${effect.name || '未命名'}」没配发动条件，模型按「必定能发动」计算；如果它要那张卡上手才能发动，收益会被明显高估。`,
      )
    }
  }
  return list
})

/* ---------------- 起手核对器 ---------------- */

interface VerifyEntry {
  id: number
  count: number
}

const verifyHand = ref<VerifyEntry[]>([])

function addVerifyCard(cardId: number) {
  const entry = mainEntries.value.find((item) => item.id === cardId)
  if (!entry) return
  const hit = verifyHand.value.find((item) => item.id === cardId)
  if (hit) {
    if (hit.count >= entry.count) return
    verifyHand.value = verifyHand.value.map((item) =>
      item.id === cardId ? { ...item, count: item.count + 1 } : item,
    )
    return
  }
  verifyHand.value = [...verifyHand.value, { id: cardId, count: 1 }]
}

function incVerifyCard(cardId: number) {
  addVerifyCard(cardId)
}

function decVerifyCard(cardId: number) {
  verifyHand.value = verifyHand.value
    .map((item) => (item.id === cardId ? { ...item, count: item.count - 1 } : item))
    .filter((item) => item.count > 0)
}

function clearVerify() {
  verifyHand.value = []
}

/**
 * 挑一手具体的牌，把判定规则一项项摊开：
 * 每一组的每个槽位差多少、每条废件是超限还是被豁免、最后为什么成立 / 不成立。
 * 它是「人工核对模型」的入口，不参与概率计算。
 */
const verifyInfo = computed(() => {
  const entries = verifyHand.value
  if (!entries.length) return null

  // 把核对用到的卡也塞进等价类，否则没被条件引用的卡会被并进 filler
  const verifyCondition: RateCondition = [
    {
      id: 'verify',
      slots: entries.map((entry) => ({
        id: `verify-${entry.id}`,
        cards: [{ id: entry.id, name: cardName(entry.id) }],
        min: 0,
        max: null,
      })),
    },
  ]
  const model = buildRateModel(
    mainEntries.value,
    plan.value.starters,
    plan.value.blockers,
    [...plan.value.effects.map((effect) => effect.requirement), verifyCondition],
  )

  const hand = new Array<number>(model.classes.length).fill(0)
  for (const entry of entries) {
    const at = model.index.get(entry.id)
    if (at !== undefined) hand[at] = entry.count
  }

  const clauses = plan.value.starters.map((clause, index) => ({
    key: clause.id,
    label: clause.slots.map(describeSlot).join(' + ') || `启动组 ${index + 1}`,
    holds: clauseHolds(hand, clause, model.index),
    parts: clause.slots.map((slot) => {
      let have = 0
      for (const card of slot.cards) {
        const at = model.index.get(card.id)
        if (at !== undefined) have += hand[at] || 0
      }
      const banned = slot.min <= 0 && slot.max === 0
      return {
        key: `${clause.id}-${slot.id}`,
        name: describeSlot(slot),
        have,
        banned,
        needText: banned
          ? '不上手'
          : `≥${slot.min}${slot.max !== null ? ` 且 ≤${slot.max}` : ''}`,
        ok: slotHolds(have, slot),
      }
    }),
  }))

  const total = entries.reduce((sum, entry) => sum + entry.count, 0)
  const started = reached(hand, plan.value.starters, plan.value.blockers, model.index)
  const anyClause = clauses.some((clause) => clause.holds)

  let verdict = ''
  let tone: 'ok' | 'warn' | 'bad' = 'bad'
  if (started) {
    verdict = '算启动：这手牌满足判定。'
    tone = 'ok'
  } else if (!plan.value.starters.length) {
    verdict = '还没配置启动条件。'
  } else if (!anyClause) {
    verdict = '没有任何启动组成立。'
  } else {
    verdict = '判定不成立（检查一下启动条件与卡组是否一致）。'
    tone = 'warn'
  }

  return {
    total,
    handSize: plan.value.handSize,
    clauses,
    verdict,
    tone,
  }
})

/* ---------------- 求解：优先放进 Worker ---------------- */

type JobKind = 'main' | 'cross'

interface PendingJob {
  id: number
  kind: JobKind
  deck: DeckEntry[]
  plan: RatePlan
  version: number
  options?: SolveOptions
}

let worker: Worker | null = null
let workerBroken = false
let requestSeq = 0
let pending: PendingJob | null = null

/** 等「这一次计算跑完」的 resolve 队列：导出图片前要先拿到 result 才能画 pp */
let computeWaiters: Array<() => void> = []

function flushComputeWaiters() {
  const waiters = computeWaiters
  computeWaiters = []
  for (const resolve of waiters) resolve()
}

/* 交叉校验：同一份配置强制跑蒙特卡洛，和精确解对照 */
const cross = ref<RateOutcome | null>(null)
const crossBusy = ref(false)
const crossFailure = ref('')

function settle(outcome: RateOutcome | null, error: string, version: number) {
  busy.value = false
  if (error) {
    failure.value = error
    result.value = null
    flushComputeWaiters()
    return
  }
  result.value = outcome
  stale.value = editVersion.value !== version
  cross.value = null
  crossFailure.value = ''
  flushComputeWaiters()
}

function settleCross(outcome: RateOutcome | null, error: string) {
  crossBusy.value = false
  if (error) {
    crossFailure.value = error
    cross.value = null
    return
  }
  crossFailure.value = ''
  cross.value = outcome
}

function handleOutcome(job: PendingJob, outcome: RateOutcome | null, error: string) {
  if (job.kind === 'cross') settleCross(outcome, error)
  else settle(outcome, error, job.version)
}

/** Worker 不可用时退回主线程同步求解（只会在老浏览器 / 打包异常时走到） */
function runInline(job: PendingJob) {
  try {
    handleOutcome(job, solveRate(job.deck, job.plan, job.options), '')
  } catch (error) {
    handleOutcome(job, null, error instanceof Error ? error.message : String(error))
  }
}

function ensureWorker(): Worker | null {
  if (workerBroken) return null
  if (worker) return worker
  try {
    const instance = new Worker(new URL('../lib/ratesWorker.ts', import.meta.url), {
      type: 'module',
    })
    instance.addEventListener('message', (event: MessageEvent<RateWorkerResponse>) => {
      const data = event.data
      if (!pending || data.id !== pending.id) return
      const job = pending
      pending = null
      handleOutcome(job, data.outcome, data.error)
    })
    instance.addEventListener('error', () => {
      // Worker 起不来（或算到一半崩了）：标记坏掉，剩下的任务回主线程
      workerBroken = true
      instance.terminate()
      worker = null
      const job = pending
      pending = null
      if (job) runInline(job)
    })
    worker = instance
    return instance
  } catch {
    workerBroken = true
    return null
  }
}

/** 换卡组时把在途任务作废：Worker 算到一半也能直接掐掉重来 */
function resetWorker() {
  pending = null
  busy.value = false
  crossBusy.value = false
  cross.value = null
  crossFailure.value = ''
  worker?.terminate()
  worker = null
  // 任务被掐掉了，等待方不能一直挂着
  flushComputeWaiters()
}

function dispatch(job: PendingJob) {
  const instance = ensureWorker()
  if (!instance) {
    // 让「计算中」先渲染出来再做同步求解
    setTimeout(() => runInline(job), 16)
    return
  }
  pending = job
  instance.postMessage({ id: job.id, deck: job.deck, plan: job.plan, options: job.options })
}

/**
 * 跑一次启动率求解。返回的 Promise 在这次计算结束（成功或失败）后 resolve，
 * 「导出图片」靠它确保拿得到抽滤 pp。
 */
function compute(): Promise<void> {
  if (!activeDeck.value) return Promise.resolve()
  // 已经在算：等那一次结束就行，不重复派发
  if (busy.value) return new Promise((resolve) => computeWaiters.push(resolve))
  // 交叉校验占着 Worker：不排队，导出先用现有结果
  if (crossBusy.value) return Promise.resolve()
  const job: PendingJob = {
    id: (requestSeq += 1),
    kind: 'main',
    deck: mainEntries.value.map((entry) => ({ ...entry })),
    plan: clonePlan(plan.value),
    version: editVersion.value,
  }
  busy.value = true
  failure.value = ''
  snapshot.value = job.plan
  dispatch(job)
  return new Promise((resolve) => computeWaiters.push(resolve))
}

/**
 * 用同一份配置（上一次算出结论的那份 snapshot）强制跑蒙特卡洛。
 * 精确解是最优策略下的上界，仿真用启发式出牌，所以仿真应当略低或相当；
 * 两者差得离谱就说明实现有问题。这是用户能自己动手的验证手段。
 */
function crossCheck() {
  const snap = snapshot.value
  if (!snap || !result.value || result.value.method !== 'exact') return
  if (busy.value || crossBusy.value || pending) return
  const job: PendingJob = {
    id: (requestSeq += 1),
    kind: 'cross',
    deck: mainEntries.value.map((entry) => ({ ...entry })),
    plan: clonePlan(snap),
    version: editVersion.value,
    options: { forceSim: true, trials: DEFAULT_TRIALS, seed: DEFAULT_SEED },
  }
  crossBusy.value = true
  cross.value = null
  crossFailure.value = ''
  dispatch(job)
}

/** 交叉校验的差值（pp）与结论：仿真不应显著高于精确解 */
const crossDelta = computed(() => {
  if (!cross.value || !result.value) return 0
  return cross.value.total - result.value.total
})

const crossVerdict = computed(() => {
  const data = cross.value
  const base = result.value
  if (!data || !base) return null
  const delta = data.total - base.total
  const margin = data.ci ? Math.max(0.002, data.ci[1] - data.total) : 0.002
  if (delta > margin) {
    return {
      tone: 'bad',
      text: `仿真比精确解高 ${(delta * 100).toFixed(2)}pp，超出抽样误差，可能实现有问题。`,
    }
  }
  if (Math.abs(delta) <= margin) {
    return { tone: 'ok', text: '两套口径在抽样误差内一致。' }
  }
  return {
    tone: 'warn',
    text: `仿真比精确解低 ${Math.abs(delta * 100).toFixed(2)}pp：精确解取最优操作，仿真用启发式选牌，偏低属正常。`,
  }
})

watch(
  () =>
    JSON.stringify({
      deck: activeDeck.value?.main,
      // 只放真正影响求解的字段：废件 / 手坑张数只是查表参数，改它不该让已算出的结果失效
      plan: {
        handSize: plan.value.handSize,
        starters: plan.value.starters,
        blockers: plan.value.blockers,
        effects: plan.value.effects,
      },
    }),
  () => {
    editVersion.value += 1
    stale.value = true
  },
)

// 换卡组时结果作废，并把新卡组在卡组构建页里配过的启动组合搬过来
watch(
  () => activeDeck.value?.id,
  () => {
    resetWorker()
    result.value = null
    snapshot.value = null
    stale.value = true
    seedFromStarters()
    // 废件 / 手坑张数存在各自的 plan 里，换卡组自动跟着走
    // 也不自动计算：结果回到空态，等用户点按钮或导出
  },
)

/** 第一次进来时，把卡组构建页里已经配好的启动组合搬过来 */
function seedFromStarters() {
  const target = activeDeck.value
  if (!target || target.plan.starters.length) return
  const starters: RateCondition = target.starters
    .filter((group) => group.cards.length)
    .map((group) => ({
      id: group.id,
      slots: group.cards.map((id, slotIndex) => ({
        id: `${group.id}-${slotIndex}`,
        cards: [
          {
            id,
            name:
              target.main.find((entry) => entry.id === id)?.name ||
              cards.getCard(id)?.name ||
              `#${id}`,
          },
        ],
        min: 1,
        max: null,
      })),
    }))
  if (!starters.length) return
  deck.patchPlan((value) => {
    value.starters = starters
  })
}

onMounted(() => {
  void cards.init()
  // 只把卡组构建页配好的启动组合搬过来，不自动算：要等用户点「开始计算」或导出
  seedFromStarters()
})

onUnmounted(() => {
  worker?.terminate()
  worker = null
  pending = null
  if (posterUrl.value) URL.revokeObjectURL(posterUrl.value)
})
</script>

<template>
  <div class="page rates-page">
    <header class="rates-head">
      <div>
        <span class="eyebrow">CONSISTENCY ENGINE</span>
        <h1>启动率</h1>
        <p>
          常规工具只算「起手 5 张里有没有」。这里把抽滤也算进去：任何效果都拆成
          「看 N 张 → 拿 M 张 → 其余去哪」和「丢 N 张」两种算子，按顺序执行，
          所以启动率是一条逐步推进的随机过程，而不是一个静态公式。
        </p>
      </div>
      <div class="rates-head-actions">
        <div class="rates-head-badges">
          <span class="chip cyan">等价类压缩</span>
          <span class="chip violet">值迭代求最优策略</span>
          <span class="chip amber">逐步归因</span>
        </div>
        <button class="btn ghost sm" :disabled="posterBusy" @click="openPoster">
          {{ posterBusy ? '生成中…' : '导出图片' }}
        </button>
      </div>
    </header>

    <div class="rates-layout">
      <section class="rates-col">
        <div class="panel">
          <div class="panel-head">
            <span class="panel-title">卡组与起手</span>
            <span class="inline-note">{{ deckSize }} 张主卡组</span>
          </div>
          <div class="panel-body rate-block">
            <div class="row wrap" style="gap: 10px">
              <div class="field" style="flex: 1 1 220px; min-width: 180px">
                <label>选择卡组</label>
                <select v-model="selectedId" class="select">
                  <option v-for="item in deck.decks" :key="item.id" :value="item.id">{{ item.name }}</option>
                </select>
              </div>
              <div class="field" style="flex: 0 0 auto">
                <label>起手</label>
                <div class="row" style="gap: 8px">
                  <div class="seg">
                    <button :class="{ on: handSize === 5 }" @click="setHandSize(5)">先手 5</button>
                    <button :class="{ on: handSize === 6 }" @click="setHandSize(6)">后手 6</button>
                  </div>
                  <input class="input rate-mini" type="number" min="1" max="20" :value="handSize" aria-label="起手张数"
                    @change="setHandSize(Number(($event.target as HTMLInputElement).value))" />
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head">
            <span class="panel-title">启动条件</span>
            <span class="inline-note">组内全部满足 · 组间满足其一</span>
          </div>
          <div class="panel-body rate-block">
            <div v-for="(clause, index) in plan.starters" :key="clause.id" class="rate-group">
              <div class="rate-group-head">
                <span class="rate-group-title">启动 {{ index + 1 }}</span>
                <span class="rate-group-chance">{{ formatChance(clauseChances[index] || 0) }}</span>
                <button class="icon-btn" title="删除这一组" @click="removeClause(clause.id)">✕</button>
              </div>
              <div v-for="slot in clause.slots" :key="slot.id" class="rate-check-row"
                :class="{ ban: slot.min <= 0 && slot.max === 0 }">
                <div class="rate-chips">
                  <span v-for="card in slot.cards" :key="card.id" class="rate-chip"
                    :class="{ ban: slot.min <= 0 && slot.max === 0 }">
                    {{ card.name }}
                    <button title="移出这条检查" @click="removeCardFromCheck(clause.id, slot.id, card.id)">
                      ✕
                    </button>
                  </span>
                  <CardPicker :options="pickerCards(freeCards(clause))" placeholder="＋ 并入这条检查"
                    @pick="(cardId) => addCardToCheck(clause.id, slot.id, cardId)" />
                </div>
                <div class="row wrap" style="gap: 6px; align-items: center">
                  <span class="rate-field-label">合计</span>
                  <select class="rate-mini" :value="slot.min" :title="`这些卡合计至少 ${slot.min} 张`"
                    @change="setCheckMin(clause.id, slot.id, Number(($event.target as HTMLSelectElement).value))">
                    <option v-for="n in SLOT_VALUES" :key="`min-${n}`" :value="n">≥{{ n }}</option>
                  </select>
                  <select class="rate-mini" :value="slot.max === null ? '' : slot.max"
                    :title="slot.max === null ? '不限制上限' : `这些卡合计最多 ${slot.max} 张`"
                    @change="setCheckMax(clause.id, slot.id, ($event.target as HTMLSelectElement).value)">
                    <option value="">≤∞</option>
                    <option v-for="n in SLOT_VALUES" :key="`max-${n}`" :value="n">≤{{ n }}</option>
                  </select>
                  <button class="icon-btn" title="删除这条检查" @click="removeCheck(clause.id, slot.id)">✕</button>
                </div>
              </div>
              <div v-if="!clause.slots.length" class="inline-note">还没配置检查</div>
              <div class="row wrap" style="gap: 6px; align-items: center">
                <button class="rate-mode-toggle" :class="{ on: slotBan[clause.id], ban: slotBan[clause.id] }" :title="slotBan[clause.id]
                    ? '当前：新建的检查要求这些卡合计 0 张（废件）'
                    : '当前：新建的检查要求这些卡合计至少 1 张'
                  " @click="toggleSlotBan(clause.id)">
                  {{ slotBan[clause.id] ? '快捷配置：合计 0（废件）' : '快捷配置：至少 1 张' }}
                </button>
                <CardPicker :options="pickerCards(freeCards(clause))" :placeholder="slotBan[clause.id]
                    ? '＋ 新建一条「合计 0」检查（废件）'
                    : '＋ 新建一条检查'
                  " @pick="(cardId) => addCheck(clause.id, cardId)" />
              </div>
            </div>

            <div v-if="!plan.starters.length" class="empty">还没有启动条件</div>
            <button class="btn ghost sm" style="width: 100%; margin-top: 8px" @click="addClause()">
              ＋ 新建启动组
            </button>
            <div class="inline-note" style="margin-top: 6px">
              每条检查算的是「这些卡的合计张数」：单卡就是那张卡；把多张卡并进同一条就是算总数，
              例如「A、B、C 合计 ≤1」「栗球守卫 + 两颗心灵 合计 ≥1」。
              组内所有检查都要满足，组间满足任意一组就启动。
              废件新建成「合计 0」的检查：这一组只在手里没有它们时成立，其他组不受影响。
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head">
            <span class="panel-title">抽滤效果</span>
            <span class="inline-note">按顺序执行</span>
          </div>
          <div class="panel-body rate-block">
            <div class="rate-presets">
              <button class="btn xs ghost" @click="addEffect()">＋ 添加效果</button>
              <span class="inline-note">选卡会自动识别算子，也可以自己加减</span>
            </div>

            <div v-for="(effect, index) in plan.effects" :key="effect.id" class="rate-effect">
              <div class="rate-effect-head">
                <span class="rate-effect-index">{{ index + 1 }}</span>
                <img v-if="effect.sourceId" class="rate-effect-thumb" :src="sourceThumb(effect)" :alt="effect.name"
                  loading="lazy" />
                <CardPicker class="rate-effect-pick" :groups="digGroups"
                  :placeholder="effect.sourceId ? effect.name : '－ 不指定卡片（手动配置算子）'" allow-clear
                  clear-label="－ 不指定卡片（手动配置算子）" @pick="(cardId) => pickEffectCard(effect, cardId)"
                  @clear="pickEffectCard(effect, null)" />
                <button class="icon-btn" title="删除这个效果" @click="removeEffect(effect.id)">✕</button>
              </div>

              <input v-if="!effect.sourceId" v-model="effect.name" class="input" style="width: 100%"
                placeholder="或者只写个名字（假想效果）" />

              <div v-if="effectHints.get(effect.id)?.length" class="rate-effect-hint">
                <span v-for="(hint, hintIndex) in effectHints.get(effect.id)" :key="hintIndex">· {{ hint }}</span>
              </div>

              <div class="rate-ops">
                <div v-for="(op, opIndex) in effect.ops" :key="op.id" class="rate-op">
                  <span class="rate-op-index">{{ index + 1 }}.{{ opIndex + 1 }}</span>

                  <template v-if="op.kind === 'dig'">
                    <label class="rate-field">
                      <span>看</span>
                      <input v-model.number="op.reveal" class="input rate-mini" type="number" min="0" :max="MAX_REVEAL"
                        @change="clampOp(effect, op)" />
                    </label>
                    <label class="rate-field">
                      <span>拿</span>
                      <input v-model.number="op.take" class="input rate-mini" type="number" min="0" :max="MAX_REVEAL"
                        @change="clampOp(effect, op)" />
                    </label>
                    <div class="seg" v-if="op.take < op.reveal" title="没拿走的牌去哪">
                      <button :class="{ on: op.sink === 'gy' }" @click="op.sink = 'gy'">送墓</button>
                      <button :class="{ on: op.sink === 'banish' }" @click="op.sink = 'banish'">除外</button>
                      <button :class="{ on: op.sink === 'bottom' }" @click="op.sink = 'bottom'">回底</button>
                    </div>
                  </template>

                  <template v-else>
                    <label class="rate-field">
                      <span>丢</span>
                      <input v-model.number="op.count" class="input rate-mini" type="number" min="0" :max="MAX_DISCARD"
                        :disabled="op.all" @change="clampOp(effect, op)" />
                    </label>
                    <label class="rate-field rate-check">
                      <input v-model="op.all" type="checkbox" />
                      <span>全部</span>
                    </label>
                  </template>

                  <span class="rate-op-desc">{{ describeOp(op) }}</span>
                  <button class="icon-btn" title="删除这个算子" @click="removeOp(effect, op.id)">✕</button>
                </div>
              </div>

              <div class="row wrap" style="gap: 6px">
                <button class="btn xs ghost" @click="addOp(effect, 'dig')">＋ 看牌 / 抽牌</button>
                <button class="btn xs ghost" @click="addOp(effect, 'discard')">＋ 丢手牌</button>
                <label class="rate-field rate-check">
                  <input v-model="effect.optional" type="checkbox" />
                  <span>可选发动</span>
                </label>
                <button v-if="effect.sourceId" class="btn xs ghost" title="按卡面效果文本重新拆算子"
                  @click="reapplyInference(effect)">
                  ↻ 重新识别
                </button>
              </div>

              <div class="rate-gate">
                <span class="rate-field-label">发动条件</span>
                <div class="rate-chips">
                  <template v-for="(clause, clauseIndex) in effect.requirement" :key="clause.id">
                    <span v-if="clauseIndex > 0" class="rate-or">或</span>
                    <span class="rate-chip gate">
                      <template v-for="(slot, slotIndex) in clause.slots" :key="slot.id">
                        <span v-if="slotIndex > 0" class="rate-and">且</span>
                        <span v-for="(card, cardIndex) in gateCards(slot)" :key="card.id">
                          <span v-if="cardIndex > 0" class="rate-or">/</span>
                          {{ card.name }}
                          <button v-if="clause.slots.length > 1 || slot.cards.length > 1" title="从这一组里移除"
                            @click="removeRequirementCard(effect, clauseIndex, card.id)">
                            ✕
                          </button>
                        </span>
                        <button v-if="slot.cards.length > GATE_PREVIEW" class="rate-gate-more"
                          @click="toggleGate(slot.id)">
                          {{ gateOpen[slot.id] ? '收起' : `＋${slot.cards.length - GATE_PREVIEW} 张` }}
                        </button>
                      </template>
                      <button title="移除这一组条件" @click="removeRequirementClause(effect, clauseIndex)">✕</button>
                    </span>
                  </template>
                  <span v-if="!effect.requirement.length" class="inline-note">无，随时可以发动</span>
                </div>
                <div class="row wrap" style="gap: 6px; align-items: center">
                  <div class="seg">
                    <button :class="{ on: requirementModeOf(effect) === 'or' }" title="新开一组：满足任意一组就能发动"
                      @click="setRequirementMode(effect.id, 'or')">
                      新开一组（或）
                    </button>
                    <button :class="{ on: requirementModeOf(effect) === 'and' }" :disabled="!effect.requirement.length"
                      title="组内再加一条检查：两张都要上手" @click="setRequirementMode(effect.id, 'and')">
                      组内且
                    </button>
                    <button :class="{ on: requirementModeOf(effect) === 'merge' }" :disabled="!effect.requirement.length"
                      title="并入上一条检查：这几张任意一张即可（合计 ≥1）"
                      @click="setRequirementMode(effect.id, 'merge')">
                      并入上一条（或）
                    </button>
                  </div>
                  <CardPicker :options="requirementOptions(effect)" placeholder="＋ 添加发动条件" @pick="
                    (cardId) => pickRequirement(effect, cardId, requirementModeOf(effect))
                  " />
                  <button v-if="quickPlayEntries.length" class="btn xs ghost"
                    title="在最后一组里加一条检查：手上还有任意一张速攻魔法即可" @click="addQuickPlayGate(effect)">
                    ＋ 速攻魔法 ×{{ quickPlayEntries.length }}
                  </button>
                  <button v-if="spellTrapEntries.length" class="btn xs ghost"
                    title="在最后一组里加一条检查：手上还有任意一张魔法 / 陷阱即可" @click="addSpellTrapGate(effect)">
                    ＋ 魔法陷阱 ×{{ spellTrapEntries.length }}
                  </button>
                </div>
              </div>
            </div>

            <div v-if="!plan.effects.length" class="empty">
              还没有效果。没有抽滤时，结果就是纯粹的起手率。
            </div>
          </div>
        </div>
      </section>

      <aside class="rates-col rates-aside">
        <div class="panel rate-result">
          <div class="panel-head">
            <span class="panel-title">结论</span>
            <span v-if="result" class="chip" :class="result.method === 'exact' ? 'green' : 'amber'">
              {{ methodLabel }}
            </span>
          </div>
          <div class="panel-body">
            <template v-if="result">
              <div class="rate-hero">
                <span class="rate-value">{{ formatChance(result.total) }}</span>
                <span v-if="totalDelta > 0.0005" class="rate-delta">+{{ (totalDelta * 100).toFixed(1) }}pp</span>
              </div>
              <div class="rate-caption">
                起手 {{ formatChance(result.opening) }} · 走完全部
                {{ snapshot?.effects.length ?? 0 }} 个效果之后
              </div>

              <div class="rate-funnel">
                <div v-for="row in funnel" :key="row.key" class="rate-row">
                  <span class="rate-row-label" :title="row.label">{{ row.label }}</span>
                  <span class="rate-row-bar"><i :style="{ width: `${Math.min(100, row.cum * 100)}%` }" /></span>
                  <span class="rate-row-value">{{ formatChance(row.cum) }}</span>
                  <span class="rate-row-gain" :class="{ zero: row.gain < 0.0005 }">
                    {{ row.gain > 0.0005 ? `+${(row.gain * 100).toFixed(1)}` : '—' }}
                  </span>
                </div>
              </div>

              <div class="rate-meta">
                <span>{{ ciLabel || `耗时 ${result.elapsed} ms` }}</span>
                <span v-if="result.method === 'exact'">
                  起手解析 {{ formatChance(result.opening) }} · 逐步累加 {{ formatChance(stepSum) }}
                </span>
              </div>

              <div v-if="result.censored" class="rate-note amber">
                配置的组合数过多，已自动切换到蒙特卡洛仿真，数字带统计误差（{{ ciLabel }}）。
              </div>
              <div class="rate-note">
                结果按「最优操作」计算：抽到什么之后，选择拿哪张、丢哪张都会取对启动最有利的一步。
              </div>

              <div v-if="result.method === 'exact'" class="rate-cross">
                <button class="btn ghost sm" :disabled="busy || crossBusy || !snapshot" @click="crossCheck()">
                  {{ crossBusy ? '校验中…' : '蒙特卡洛交叉校验' }}
                </button>
                <span class="inline-note">
                  同一份配置再抽 {{ DEFAULT_TRIALS.toLocaleString('zh-CN') }} 次（种子 {{ DEFAULT_SEED }}）
                </span>
                <div v-if="cross" class="rate-cross-result">
                  <div class="rate-cross-line">
                    精确 {{ formatChance(result.total) }} · 仿真 {{ formatChance(cross.total) }}
                    <span class="mute">（{{ cross.trials.toLocaleString('zh-CN') }} 次，{{ cross.elapsed }} ms）</span>
                  </div>
                  <div class="rate-cross-line mute">
                    仿真 95% 区间 {{ formatChance(cross.ci?.[0] ?? 0) }} ~ {{ formatChance(cross.ci?.[1] ?? 0) }}
                  </div>
                  <div v-if="crossVerdict" class="rate-note"
                    :class="crossVerdict.tone === 'ok' ? 'green' : crossVerdict.tone === 'bad' ? 'red' : 'amber'">
                    {{ crossVerdict.text }}
                  </div>
                </div>
                <div v-if="crossFailure" class="rate-note red">{{ crossFailure }}</div>
              </div>
            </template>

            <div v-else class="rate-placeholder">
              <div class="rate-placeholder-icon">◈</div>
              <p>配置好启动条件与抽滤效果后，点下面的按钮开始计算。</p>
            </div>

            <div v-if="warnings.length" class="rate-warn">
              <span v-for="(item, index) in warnings" :key="index">· {{ item }}</span>
            </div>
            <div v-if="stale && result" class="rate-note amber">配置已改动，当前结果还是上一次的。</div>
            <div v-if="failure" class="rate-note red">{{ failure }}</div>

            <button class="btn primary rate-run" :disabled="busy || crossBusy || !activeDeck || !plan.starters.length"
              @click="compute()">
              {{ busy ? '计算中…' : stale ? '开始计算' : '重新计算' }}
            </button>
          </div>
        </div>

        <div class="panel rate-process">
          <div class="panel-head">
            <span class="panel-title">计算过程</span>
            <span v-if="result" class="inline-note">
              {{
                result.method === 'exact'
                  ? `精确 · ${result.states.toLocaleString('zh-CN')} 态`
                  : `仿真 · ${result.trials.toLocaleString('zh-CN')} 次`
              }}
            </span>
          </div>
          <div class="panel-body">
            <template v-if="result && processInfo">
              <div class="rate-derive">
                <div class="rate-derive-step">
                  <span class="rate-derive-no">0</span>
                  <div class="rate-derive-main">
                    <div class="rate-derive-head">
                      <span class="rate-derive-title">
                        起手 {{ processInfo.handSize }} 张 · 卡组 {{ processInfo.deckSize }} 张
                      </span>
                      <span class="rate-derive-value">{{ formatChance(result.opening) }}</span>
                    </div>
                    <div class="rate-derive-detail">
                      C({{ processInfo.deckSize }}, {{ processInfo.handSize }}) =
                      {{ processInfo.totalHands.toLocaleString('zh-CN') }} 种等概率起手 · 未启动
                      {{ formatChance(1 - result.opening) }}
                      <template v-if="openingDead > 0.0005">
                        ，其中 {{ formatChance(openingDead) }} 起手就因废件出局
                      </template>
                    </div>
                    <div v-for="group in processInfo.groups" :key="group.key" class="rate-derive-sub">
                      <span class="rate-derive-sub-label" :title="group.label">{{ group.label }}</span>
                      <span class="rate-derive-sub-value">{{ formatChance(group.chance) }}</span>
                    </div>
                  </div>
                </div>

                <div v-for="row in processEffectRows" :key="row.key" class="rate-derive-step">
                  <span class="rate-derive-no">{{ row.step }}</span>
                  <div class="rate-derive-main">
                    <div class="rate-derive-head">
                      <span class="rate-derive-title">{{ row.label }}</span>
                      <span class="rate-derive-value">{{ formatChance(row.cum) }}</span>
                    </div>
                    <div class="rate-derive-detail">{{ row.detail }}</div>
                    <div class="rate-derive-gain" :class="{ zero: row.gain < 0.0005 }">
                      {{ row.gain > 0.0005 ? `本步 +${(row.gain * 100).toFixed(2)}pp` : '本步无新增' }}
                    </div>

                    <div v-if="row.trace?.ops.length" class="rate-trace">
                      <div v-if="row.trace.gateSkip > 0.0005 || row.trace.optionalSkip > 0.0005"
                        class="rate-trace-head">
                        <span v-if="row.trace.gateSkip > 0.0005">
                          发动条件不满足，跳过 {{ formatChance(row.trace.gateSkip) }}
                        </span>
                        <span v-if="row.trace.optionalSkip > 0.0005">
                          选择不发动，跳过 {{ formatChance(row.trace.optionalSkip) }}
                        </span>
                      </div>
                      <div v-for="op in row.trace.ops" :key="op.key" class="rate-trace-op">
                        <div class="rate-trace-op-head">
                          <span class="rate-trace-op-label">{{ op.index + 1 }}. {{ op.label }}</span>
                          <span v-if="op.deck >= 1" class="rate-trace-deck">
                            牌库 ≈ {{ Math.round(op.deck) }} 张
                          </span>
                        </div>
                        <div class="rate-trace-op-flow">
                          <span>
                            未启动 {{ formatChance(op.before) }} → {{ formatChance(op.after) }}
                            <em v-if="op.dead > 0.0005" class="rate-trace-dead">
                              · 废件出局 {{ formatChance(op.dead) }}
                            </em>
                          </span>
                          <b :class="{ zero: op.gain < 0.0005 }">
                            {{ op.gain > 0.0005 ? `+${(op.gain * 100).toFixed(2)}pp` : '±0' }}
                          </b>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div class="rate-derive-total">
                  <span>
                    合计
                    <template v-if="Math.abs(stepSum - result.total) > 0.0005">
                      （逐步相加 {{ formatChance(stepSum) }}）
                    </template>
                  </span>
                  <span class="rate-derive-value">{{ formatChance(result.total) }}</span>
                </div>
              </div>

              <div class="rate-derive-foot">
                <p v-for="(note, index) in processNotes" :key="index">{{ note }}</p>
              </div>
            </template>
            <div v-else class="empty">
              算出结果后，这里会列出起手概率、每个效果带来的新增达成率，以及求解方法。
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head">
            <span class="panel-title">起手核对器</span>
            <span class="inline-note">挑一手具体的牌，逐项核对判定</span>
          </div>
          <div class="panel-body rate-block">
            <div class="rate-chips">
              <span v-for="entry in verifyHand" :key="entry.id" class="rate-chip verify">
                {{ cardName(entry.id) }} ×{{ entry.count }}
                <button title="少一张" @click="decVerifyCard(entry.id)">−</button>
                <button title="多一张" @click="incVerifyCard(entry.id)">＋</button>
              </span>
              <CardPicker :options="pickerCards(mainEntries)" placeholder="＋ 加入一张牌" stay-open @pick="addVerifyCard" />
            </div>
            <div class="inline-note">
              手牌 {{ verifyInfo?.total ?? 0 }} / {{ verifyInfo?.handSize ?? handSize }} 张
              <template v-if="verifyInfo && verifyInfo.total !== verifyInfo.handSize">
                · 张数与起手不一致，只做规则核对
              </template>
            </div>

            <template v-if="verifyInfo">
              <div class="rate-verify-block">
                <div class="rate-verify-title">启动条件</div>
                <div v-for="clause in verifyInfo.clauses" :key="clause.key" class="rate-verify-row"
                  :class="{ ok: clause.holds }">
                  <span class="rate-verify-label">{{ clause.label }}</span>
                  <span class="rate-verify-state">{{ clause.holds ? '成立' : '不成立' }}</span>
                  <div class="rate-verify-parts">
                    <span v-for="part in clause.parts" :key="part.key" class="rate-verify-part"
                      :class="{ ok: part.ok, ban: part.banned }">
                      {{ part.name }} · 现有 {{ part.have }} 张
                      <em v-if="!part.ok">（需 {{ part.needText }}）</em>
                    </span>
                  </div>
                </div>
                <div v-if="!verifyInfo.clauses.length" class="inline-note">还没有启动组</div>
              </div>

              <div class="rate-note"
                :class="verifyInfo.tone === 'ok' ? 'green' : verifyInfo.tone === 'warn' ? 'amber' : 'red'">
                {{ verifyInfo.verdict }}
              </div>
            </template>
            <div v-else class="empty">从主卡组挑几张牌，开始核对。</div>
            <button v-if="verifyHand.length" class="btn xs ghost" @click="clearVerify()">清空</button>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head"><span class="panel-title">结果怎么读</span></div>
          <div class="panel-body rate-explain">
            <p>
              <b>起手</b>是抽 {{ snapshot?.handSize ?? handSize }} 张直接满足条件的概率，和常规工具一致。
            </p>
            <p>
              <b>启动条件</b>是「组间或、组内且」。每条检查是一组卡（可以只有一张，也可以多张）的
              <b>合计张数区间</b>：≥1 表示这几张里至少上手 1 张，≥2 表示合计至少 2 张，
              ≤N 表示合计最多 N 张（≥1 且 ≤1 就是「恰好 1 张」），合计 ≤0 就是一张都不能上手（废件）。
            </p>
            <p>
              多张卡并进同一条检查时算的是<b>总数</b>：<b>A、B 合计 ≥1</b> 是「A 或 B 任意一张」，
              <b>A、B、C 合计 ≤1</b> 是「这几张废件加起来最多 1 张」。同名卡按实际张数计入合计。
            </p>
            <p>
              <b>废件写在启动条件里</b>：同一张废件对某条路线致命、对另一条无所谓，就分别建组——
              带它的手牌满足不了「合计 0」的那一组，但可以满足另一组。组内可以同时有多条检查。
            </p>
            <p>
              旧存档里的全局废件会在读取配置时自动并入启动条件：
              每条废件变成一条「这些卡合计 ≤N」的检查，带豁免的按「或」拆成多个启动组。
            </p>
            <p>
              <b>效果 = 算子序列</b>。「看 N 张 → 拿 M 张 → 其余去哪」是挖牌，「丢 N 张」是消耗。
              抽 2 就是「看 2 拿 2」，翻 6 拿 1 就是「看 6 拿 1，其余送墓」，抽 3 丢 2 就是「看 3 拿 3」+「丢 2」。
            </p>
            <p>
              算子是<b>按顺序</b>执行的，所以强贪壶这种「顶 10 除外，再抽 2」、手札抹杀这种
              「先丢光手牌，再抽 5」都能直接拼出来。
            </p>
            <p>
              <b>发动条件</b>（速攻 2 卡动）只有在手牌满足时才会执行，不满足时整个效果被跳过。
            </p>
            <p>
              <b>发动条件怎么拼</b>：追加方式三选一 ——
              「新开一组」是组间<b>或</b>（任意一组成立就能发动）；
              「组内且」是在最后一组里再<b>加一条检查</b>（两条都要满足）；
              「并入上一条」是把卡并进最后一条检查（这几张算合计，<b>任意一张</b>即可）。
              所以「A 且（B 或 C 或 D）」= 一组里两条检查：<code>A ≥1</code> 且 <code>B、C、D 合计 ≥1</code>，
              先加 A，切「组内且」加 B，再切「并入上一条」把 C、D 并进去。
            </p>
            <p>
              <b>来源卡会自动进发动条件</b>：选中效果来源时会默认补一条「这张卡 ≥1」，因为没上手就发动不了；
              从墓地 / 除外发动的效果不需要这条，删掉即可。发动后的消耗（丢手牌）仍要用「丢手牌」算子体现。
            </p>
            <p>
              <b>公式</b>：起手启动率是对所有满足条件的起手构成求和
              <code>Σ Πᵢ C(nᵢ, hᵢ) / C(N, n)</code>（nᵢ 是这张卡的投入张数，hᵢ 是抽到的张数）；
              加入抽滤后按
              <code>V(k) = Σ 抽牌结果概率 × max(拿哪几张 / 丢哪几张) V(k+1)</code>
              做值迭代，所以拿牌 / 丢牌都取「最优操作」，得到的是这条路线能打出的上界。
            </p>
            <p>
              <b>怎么验证</b>：「起手核对器」可以挑一手具体的牌，看到每一组差哪些检查、
              合计区间有没有踩线，用来人工核对规则；「蒙特卡洛交叉校验」会用同一份配置强制再抽
              {{ DEFAULT_TRIALS.toLocaleString('zh-CN') }} 次（固定种子），和精确解对照。
              精确解是最优操作下的结果，仿真用启发式出牌，所以仿真略低属正常；显著更高才说明实现有问题。
            </p>
            <p class="mute">
              精确解基于「等价类压缩 + 对算子做值迭代」，状态上限 12 万、单次预算 1200ms 内跑完，同一份配置的数字可复现；
              仿真解会显示置信区间。
            </p>
          </div>
        </div>
      </aside>
    </div>

    <section class="rates-tools">
      <div class="panel">
        <div class="panel-head">
          <span class="panel-title">辅助工具 · 废件上手率</span>
          <span class="rate-hand-stat brick">
            至少 1 张<b>{{ bricks > 0 ? formatChance(brickAtLeastOne) : '—' }}</b>
          </span>
        </div>
        <div class="panel-body rate-block">
          <div class="row wrap" style="gap: 10px; align-items: center">
            <label class="rate-field">
              <span>废件张数</span>
              <input class="input rate-mini" type="number" min="0" :max="deckSize" :value="bricks" aria-label="废件张数"
                @input="onBrickInput" />
              <span>张</span>
            </label>
            <span class="inline-note">
              手填 · 随这套卡组保存，不影响启动率结果
            </span>
          </div>

          <div class="inline-note">
            下面各行是「恰好上手 k 张」，互不累计；要看的「至少 1 张」在右上角
          </div>

          <div class="rate-brick">
            <div v-for="row in brickRows" :key="row.k" class="rate-brick-row">
              <span class="rate-brick-label">上手 {{ row.k }} 张</span>
              <span class="rate-brick-bar"><i :style="{ width: `${Math.min(100, row.p * 100)}%` }" /></span>
              <span class="rate-brick-value" :class="{ mute: !row.available }">
                {{ row.available ? formatChance(row.p) : '—' }}
              </span>
            </div>
          </div>

          <div class="inline-note">
            独立查表 · 不参与上面的启动率计算，按起手 {{ handSize }} 张算
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head">
          <span class="panel-title">辅助工具 · 手坑上手率</span>
          <span class="rate-hand-stat handtrap">
            至少 1 张<b>{{ handtraps > 0 ? formatChance(handtrapAtLeastOne) : '—' }}</b>
          </span>
        </div>
        <div class="panel-body rate-block">
          <div class="row wrap" style="gap: 10px; align-items: center">
            <label class="rate-field">
              <span>手坑张数</span>
              <input class="input rate-mini" type="number" min="0" :max="deckSize" :value="handtraps"
                aria-label="手坑张数" @input="onHandtrapInput" />
              <span>张</span>
            </label>
            <span class="inline-note">
              手填 · 随这套卡组保存，只查起手有没有抽到
            </span>
          </div>

          <div class="inline-note">
            下面各行是「恰好上手 k 张」，互不累计；要看的「至少 1 张」在右上角
          </div>

          <div class="rate-brick">
            <div v-for="row in handtrapRows" :key="row.k" class="rate-brick-row">
              <span class="rate-brick-label">上手 {{ row.k }} 张</span>
              <span class="rate-brick-bar"><i :style="{ width: `${Math.min(100, row.p * 100)}%` }" /></span>
              <span class="rate-brick-value" :class="{ mute: !row.available }">
                {{ row.available ? formatChance(row.p) : '—' }}
              </span>
            </div>
          </div>

          <div class="inline-note">
            独立查表 · 不参与上面的启动率计算，按起手 {{ handSize }} 张算
          </div>
        </div>
      </div>
    </section>

    <div v-if="posterOpen" class="overlay center" @click.self="closePoster">
      <div class="modal poster-modal">
        <div class="modal-head">
          <div>
            <div style="font-size: 14px; font-weight: 600">启动率长图</div>
            <div class="inline-note">{{ posterMeta }} · 复制后可直接粘进微信</div>
          </div>
          <button class="icon-btn" aria-label="关闭" @click="closePoster">✕</button>
        </div>
        <div class="modal-body poster-body">
          <div class="poster-preview">
            <img v-if="posterUrl" :src="posterUrl" alt="启动率长图预览" />
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn ghost" @click="closePoster">关闭</button>
          <button class="btn" @click="downloadPoster">下载图片</button>
          <button class="btn primary" :disabled="posterCopying" @click="copyPoster">
            {{ posterCopying ? '复制中…' : '复制到剪贴板' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
