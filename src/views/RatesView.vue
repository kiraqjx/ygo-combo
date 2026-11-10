<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { cardImageUrl } from '@/lib/cardDb'
import { inferRateOps, type InferredOp } from '@/lib/infer'
import { formatChance } from '@/lib/odds'
import {
  MAX_DISCARD,
  MAX_REVEAL,
  MAX_SLOT,
  blankBlocker,
  blankClause,
  blankEffect,
  blankOp,
  blankPlan,
  buildRateModel,
  clonePlan,
  comb,
  openingChance,
  solveRate,
  type RateBlocker,
  type RateClause,
  type RateCondition,
  type RateEffect,
  type RateOp,
  type RateOutcome,
  type RatePlan,
  type RateSlot,
} from '@/lib/rates'
import type { RateWorkerResponse } from '@/lib/ratesWorker'
import type { DeckEntry } from '@/types'
import { useCardStore } from '@/stores/cards'
import { useDeckStore } from '@/stores/deck'

const deck = useDeckStore()
const cards = useCardStore()

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
}

function freeCards(clause: RateClause) {
  return mainEntries.value.filter(
    (entry) => !clause.slots.some((slot) => slot.cardId === entry.id),
  )
}

function cardName(id: number): string {
  return (
    mainEntries.value.find((entry) => entry.id === id)?.name ||
    cards.getCard(id)?.name ||
    `#${id}`
  )
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

function addSlot(clauseId: string, event: Event) {
  const select = event.target as HTMLSelectElement
  const id = Number(select.value)
  select.value = ''
  if (!(id > 0)) return
  const entry = mainEntries.value.find((item) => item.id === id)
  if (!entry) return
  mutate((target) => {
    const clause = target.starters.find((item) => item.id === clauseId)
    if (!clause) return
    if (clause.slots.some((slot) => slot.cardId === id)) return
    clause.slots.push({ cardId: id, name: entry.name, min: 1, max: null })
  })
}

function removeSlot(clauseId: string, cardId: number) {
  mutate((target) => {
    const clause = target.starters.find((item) => item.id === clauseId)
    if (!clause) return
    clause.slots = clause.slots.filter((slot) => slot.cardId !== cardId)
  })
}

function setSlotMin(clauseId: string, cardId: number, min: number) {
  mutate((target) => {
    const clause = target.starters.find((item) => item.id === clauseId)
    const slot = clause?.slots.find((item) => item.cardId === cardId)
    if (!slot) return
    slot.min = Math.min(MAX_SLOT, Math.max(0, Math.floor(min) || 0))
    if (slot.max !== null && slot.max < slot.min) slot.max = slot.min
  })
}

function setSlotMax(clauseId: string, cardId: number, raw: string) {
  mutate((target) => {
    const clause = target.starters.find((item) => item.id === clauseId)
    const slot = clause?.slots.find((item) => item.cardId === cardId)
    if (!slot) return
    if (raw === '') {
      slot.max = null
      return
    }
    const value = Math.min(MAX_SLOT, Math.max(0, Math.floor(Number(raw)) || 0))
    slot.max = Math.max(value, slot.min)
  })
}

/* ---------------- 废件 ---------------- */

const blockerCandidates = computed(() => {
  const used = new Set(plan.value.blockers.flatMap((blocker) => blocker.cards.map((card) => card.id)))
  return mainEntries.value.filter((entry) => !used.has(entry.id))
})

function addBlocker(event: Event) {
  const select = event.target as HTMLSelectElement
  const id = Number(select.value)
  select.value = ''
  if (!(id > 0)) return
  const entry = mainEntries.value.find((item) => item.id === id)
  if (!entry) return
  mutate((target) => {
    if (target.blockers.some((blocker) => blocker.cards.some((card) => card.id === id))) return
    target.blockers.push(blankBlocker(id, entry.name))
  })
}

function addBlockerCard(blockerId: string, event: Event) {
  const select = event.target as HTMLSelectElement
  const id = Number(select.value)
  select.value = ''
  if (!(id > 0)) return
  mutate((target) => {
    const blocker = target.blockers.find((item) => item.id === blockerId)
    if (!blocker) return
    if (blocker.cards.some((card) => card.id === id)) return
    blocker.cards.push({ id, name: cardName(id) })
  })
}

function removeBlockerCard(blockerId: string, cardId: number) {
  mutate((target) => {
    const blocker = target.blockers.find((item) => item.id === blockerId)
    if (!blocker) return
    blocker.cards = blocker.cards.filter((card) => card.id !== cardId)
    if (!blocker.cards.length) {
      target.blockers = target.blockers.filter((item) => item.id !== blockerId)
    }
  })
}

function removeBlocker(blockerId: string) {
  mutate((target) => {
    target.blockers = target.blockers.filter((item) => item.id !== blockerId)
  })
}

function setBlockerAllowance(blockerId: string, value: number) {
  mutate((target) => {
    const blocker = target.blockers.find((item) => item.id === blockerId)
    if (!blocker) return
    blocker.allowance = Math.min(MAX_SLOT, Math.max(0, Math.floor(value) || 0))
  })
}

function toggleBlockerClear(blockerId: string) {
  mutate((target) => {
    const blocker = target.blockers.find((item) => item.id === blockerId)
    if (!blocker) return
    blocker.clear = blocker.clear === 'leaveHand' ? 'never' : 'leaveHand'
  })
}

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

/** 选一张主卡组里的卡作为效果来源，并把效果文本拆成算子 */
function pickEffectCard(effect: RateEffect, event: Event) {
  const select = event.target as HTMLSelectElement
  const id = Number(select.value)
  if (!(id > 0)) {
    mutate((target) => {
      const found = target.effects.find((item) => item.id === effect.id)
      if (found) found.sourceId = null
    })
    return
  }
  const entry = mainEntries.value.find((item) => item.id === id)
  if (!entry) return
  const card = cards.getCard(id)
  const inferred = card ? inferRateOps(card) : null
  const ops = inferred && inferred.ops.length ? toOps(inferred.ops) : null
  mutate((target) => {
    const found = target.effects.find((item) => item.id === effect.id)
    if (!found) return
    found.sourceId = id
    found.name = entry.name
    if (ops) found.ops = ops
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

/** 效果下拉：把「文本里能拆出算子」的卡排到前面 */
const digCandidates = computed(() => {
  const recommended: DeckEntry[] = []
  const others: DeckEntry[] = []
  for (const entry of mainEntries.value) {
    const card = cards.getCard(entry.id)
    const hit = card ? inferRateOps(card) : null
    if (hit && hit.ops.length) recommended.push(entry)
    else others.push(entry)
  }
  return { recommended, others }
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
 * 发动条件同样是「组间 OR、组内 AND」：
 *   or:xx → 新开一组（满足任意一组就能发动）
 *   and:xx → 追加到最后一组（必须同时上手）
 */
function pickRequirement(effect: RateEffect, event: Event) {
  const select = event.target as HTMLSelectElement
  const raw = select.value
  select.value = ''
  const [mode, idText] = raw.split(':')
  const id = Number(idText)
  if (!(id > 0)) return
  const entry = mainEntries.value.find((item) => item.id === id)
  if (!entry) return
  mutate((target) => {
    const found = target.effects.find((item) => item.id === effect.id)
    if (!found) return
    if (found.requirement.some((clause) => clause.slots.some((slot) => slot.cardId === id))) return
    const slot: RateSlot = { cardId: id, name: entry.name, min: 1, max: null }
    if (mode === 'and' && found.requirement.length) {
      found.requirement[found.requirement.length - 1].slots.push(slot)
    } else {
      found.requirement.push({ id: `req-${id}-${Date.now().toString(36)}`, slots: [slot] })
    }
  })
}

/** 追加到最后一组时，排除该组已有的卡 */
function requirementFree(effect: RateEffect) {
  const last = effect.requirement[effect.requirement.length - 1]
  const used = new Set(last?.slots.map((slot) => slot.cardId) ?? [])
  return mainEntries.value.filter((entry) => !used.has(entry.id))
}

/** 主卡组里的速攻魔法：作为「需要另一张速攻」这类门控的快捷入口 */
const quickPlayEntries = computed(() =>
  mainEntries.value.filter((entry) => {
    const card = cards.getCard(entry.id)
    return card?.frame === 'spell' && card.kinds.includes('速攻')
  }),
)

function addQuickPlayGate(effect: RateEffect) {
  const pool = quickPlayEntries.value
  if (!pool.length) return
  mutate((target) => {
    const found = target.effects.find((item) => item.id === effect.id)
    if (!found) return
    for (const entry of pool) {
      if (found.requirement.some((clause) => clause.slots.some((slot) => slot.cardId === entry.id))) {
        continue
      }
      found.requirement.push({ id: `req-${entry.id}-${Date.now().toString(36)}`, slots: [
        { cardId: entry.id, name: entry.name, min: 1, max: null },
      ] })
    }
  })
}

function removeRequirementClause(effect: RateEffect, index: number) {
  mutate((target) => {
    const found = target.effects.find((item) => item.id === effect.id)
    if (!found) return
    found.requirement.splice(index, 1)
  })
}

function removeRequirementSlot(effect: RateEffect, clauseIndex: number, cardId: number) {
  mutate((target) => {
    const found = target.effects.find((item) => item.id === effect.id)
    const clause = found?.requirement[clauseIndex]
    if (!found || !clause) return
    const next = clause.slots.filter((slot) => slot.cardId !== cardId)
    if (next.length) clause.slots = next
    else found.requirement.splice(clauseIndex, 1)
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

/** 槽位的可读形式：≥1 省略、≥2 写成 ×2、有上限写成 ≤N */
function describeSlot(slot: RateSlot): string {
  const least = slot.min === 1 ? '' : slot.min === 0 ? '' : `×${slot.min}`
  const most = slot.max === null ? '' : slot.max === 0 ? '（不上手）' : `≤${slot.max}`
  return `${slot.name}${least}${most}`
}

function describeCondition(condition: RateCondition): string {
  return condition
    .map((clause) => clause.slots.map(describeSlot).join(' + '))
    .join(' 或 ')
}

function describeBlocker(blocker: RateBlocker): string {
  const names = blocker.cards.map((card) => card.name).join(' / ')
  const cap = `≤${blocker.allowance}`
  return `${names} ${cap}${blocker.clear === 'never' ? '' : '（可解除）'}`
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
    blockers: snap.blockers.map((blocker) => ({
      key: blocker.id,
      label: describeBlocker(blocker),
    })),
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
      if (slot.min > 0 && !known.has(slot.cardId)) missingStarter.push(slot.name)
    }
  }
  if (missingStarter.length) {
    list.push(`${[...new Set(missingStarter)].join('、')} 已不在主卡组里，条件永远不会成立。`)
  }

  const missingBlocker: string[] = []
  for (const blocker of plan.value.blockers) {
    for (const card of blocker.cards) {
      if (!known.has(card.id)) missingBlocker.push(card.name)
    }
  }
  if (missingBlocker.length) {
    list.push(`废件 ${[...new Set(missingBlocker)].join('、')} 不在主卡组里，这条上限不会生效。`)
  }

  for (const effect of plan.value.effects) {
    const useful = effect.ops.some((op) =>
      op.kind === 'discard' ? op.all || op.count > 0 : op.reveal > 0,
    )
    if (!useful) list.push(`效果「${effect.name || '未命名'}」没有任何算子，等于空操作。`)
  }
  return list
})

/* ---------------- 求解：优先放进 Worker ---------------- */

interface PendingJob {
  id: number
  deck: DeckEntry[]
  plan: RatePlan
  version: number
}

let worker: Worker | null = null
let workerBroken = false
let requestSeq = 0
let pending: PendingJob | null = null

function settle(outcome: RateOutcome | null, error: string, version: number) {
  busy.value = false
  if (error) {
    failure.value = error
    result.value = null
    return
  }
  result.value = outcome
  stale.value = editVersion.value !== version
}

/** Worker 不可用时退回主线程同步求解（只会在老浏览器 / 打包异常时走到） */
function runInline(job: PendingJob) {
  try {
    settle(solveRate(job.deck, job.plan), '', job.version)
  } catch (error) {
    settle(null, error instanceof Error ? error.message : String(error), job.version)
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
      settle(data.outcome, data.error, job.version)
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
  worker?.terminate()
  worker = null
}

function compute() {
  if (!activeDeck.value || busy.value) return
  const job: PendingJob = {
    id: (requestSeq += 1),
    deck: mainEntries.value.map((entry) => ({ ...entry })),
    plan: clonePlan(plan.value),
    version: editVersion.value,
  }
  busy.value = true
  failure.value = ''
  snapshot.value = job.plan

  const instance = ensureWorker()
  if (!instance) {
    // 让「计算中」先渲染出来再做同步求解
    setTimeout(() => runInline(job), 16)
    return
  }
  pending = job
  instance.postMessage({ id: job.id, deck: job.deck, plan: job.plan })
}

watch(
  () => JSON.stringify({ deck: activeDeck.value?.main, plan: plan.value }),
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
    if (plan.value.starters.length) compute()
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
      slots: group.cards.map((id) => ({
        cardId: id,
        name:
          target.main.find((entry) => entry.id === id)?.name || cards.getCard(id)?.name || `#${id}`,
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
  seedFromStarters()
  if (plan.value.starters.length) compute()
})

onUnmounted(() => {
  worker?.terminate()
  worker = null
  pending = null
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
      <div class="rates-head-badges">
        <span class="chip cyan">等价类压缩</span>
        <span class="chip violet">值迭代求最优策略</span>
        <span class="chip amber">逐步归因</span>
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
                  <input
                    class="input rate-mini"
                    type="number"
                    min="1"
                    max="20"
                    :value="handSize"
                    aria-label="起手张数"
                    @change="setHandSize(Number(($event.target as HTMLInputElement).value))"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head">
            <span class="panel-title">启动条件</span>
            <span class="inline-note">组内每张都满足 · 组间满足其一</span>
          </div>
          <div class="panel-body rate-block">
            <div v-for="(clause, index) in plan.starters" :key="clause.id" class="rate-group">
              <div class="rate-group-head">
                <span class="rate-group-title">启动 {{ index + 1 }}</span>
                <span class="rate-group-chance">{{ formatChance(clauseChances[index] || 0) }}</span>
                <button class="icon-btn" title="删除这一组" @click="removeClause(clause.id)">✕</button>
              </div>
              <div class="rate-chips">
                <span v-for="slot in clause.slots" :key="slot.cardId" class="rate-chip">
                  {{ slot.name }}
                  <select
                    class="rate-mini"
                    :value="slot.min"
                    :title="`手牌里至少 ${slot.min} 张`"
                    @change="setSlotMin(clause.id, slot.cardId, Number(($event.target as HTMLSelectElement).value))"
                  >
                    <option :value="0">≥0</option>
                    <option :value="1">≥1</option>
                    <option :value="2">≥2</option>
                    <option :value="3">≥3</option>
                  </select>
                  <select
                    class="rate-mini"
                    :value="slot.max === null ? '' : slot.max"
                    :title="slot.max === null ? '不限制上限' : `手牌里最多 ${slot.max} 张`"
                    @change="setSlotMax(clause.id, slot.cardId, ($event.target as HTMLSelectElement).value)"
                  >
                    <option value="">≤∞</option>
                    <option :value="0">≤0</option>
                    <option :value="1">≤1</option>
                    <option :value="2">≤2</option>
                    <option :value="3">≤3</option>
                  </select>
                  <button title="移出这一组" @click="removeSlot(clause.id, slot.cardId)">✕</button>
                </span>
                <span v-if="!clause.slots.length" class="inline-note">还没选卡</span>
              </div>
              <select class="select rate-pick" @change="addSlot(clause.id, $event)">
                <option value="">＋ 从主卡组选择一张卡</option>
                <option v-for="entry in freeCards(clause)" :key="entry.id" :value="entry.id">
                  {{ entry.name }} ×{{ entry.count }}
                </option>
              </select>
            </div>

            <div v-if="!plan.starters.length" class="empty">还没有启动条件</div>
            <button class="btn ghost sm" style="width: 100%; margin-top: 8px" @click="addClause()">
              ＋ 新建启动组
            </button>
            <div class="inline-note" style="margin-top: 6px">
              组内要求「同时上手」，多组之间是「任意一组成立即算启动」。
              张数用 ≥N / ≤N 表示：同名双卡动设 ≥2；想要求「恰好 1 张」就 ≥1 且 ≤1。
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head">
            <span class="panel-title">废件</span>
            <span class="inline-note">上手超过额度就卡住 · 丢牌能否解除可配</span>
          </div>
          <div class="panel-body rate-block">
            <div v-for="blocker in plan.blockers" :key="blocker.id" class="rate-exclude">
              <div class="rate-blocker-head">
                <div class="rate-chips">
                  <span v-for="card in blocker.cards" :key="card.id" class="rate-chip exclude">
                    {{ card.name }}
                    <button title="移出这条废件" @click="removeBlockerCard(blocker.id, card.id)">✕</button>
                  </span>
                </div>
                <div class="row wrap" style="gap: 6px; align-items: center">
                  <span class="rate-field-label">合计最多</span>
                  <select
                    class="rate-mini"
                    :value="blocker.allowance"
                    :title="`手牌里这些卡合计最多 ${blocker.allowance} 张`"
                    @change="setBlockerAllowance(blocker.id, Number(($event.target as HTMLSelectElement).value))"
                  >
                    <option :value="0">≤0</option>
                    <option :value="1">≤1</option>
                    <option :value="2">≤2</option>
                    <option :value="3">≤3</option>
                  </select>
                  <button
                    class="rate-removable"
                    :class="{ on: blocker.clear === 'leaveHand' }"
                    :title="
                      blocker.clear === 'leaveHand'
                        ? '当前：丢掉废件后可以重新判定（占位型废件）'
                        : '当前：上手即定局，丢牌 / 送墓也救不回来'
                    "
                    @click="toggleBlockerClear(blocker.id)"
                  >
                    {{ blocker.clear === 'leaveHand' ? '可解除' : '不可逆' }}
                  </button>
                  <button class="icon-btn" title="删除这条废件" @click="removeBlocker(blocker.id)">✕</button>
                </div>
              </div>
              <select class="select rate-pick" @change="addBlockerCard(blocker.id, $event)">
                <option value="">＋ 加入同一额度（合计计算）</option>
                <option v-for="entry in mainEntries" :key="entry.id" :value="entry.id">
                  {{ entry.name }} ×{{ entry.count }}
                </option>
              </select>
            </div>

            <div v-if="!plan.blockers.length" class="empty">还没有配置废件。没有废件时，只看启动条件是否满足。</div>
            <select class="select rate-pick" style="margin-top: 8px" @change="addBlocker($event)">
              <option value="">＋ 添加一张会卡手的废件</option>
              <option v-for="entry in blockerCandidates" :key="entry.id" :value="entry.id">
                {{ entry.name }} ×{{ entry.count }}
              </option>
            </select>
            <div class="inline-note" style="margin-top: 6px">
              「最多 ≤N」是容差：带 2 张同名废件、上手 1 张还能展开，就设 ≤1。
              默认「不可逆」——废件上手那一刻展开就断了，后面丢牌 / 送墓也救不回；
              如果只是占手牌位、丢掉就没事，点成「可解除」。
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
                <img
                  v-if="effect.sourceId"
                  class="rate-effect-thumb"
                  :src="sourceThumb(effect)"
                  :alt="effect.name"
                  loading="lazy"
                />
                <select
                  class="select rate-pick"
                  style="flex: 1 1 auto; min-width: 0"
                  :value="effect.sourceId ?? ''"
                  @change="pickEffectCard(effect, $event)"
                >
                  <option value="">－ 不指定卡片（手动配置算子）－</option>
                  <optgroup v-if="digCandidates.recommended.length" label="能抽牌 / 翻牌的卡">
                    <option v-for="entry in digCandidates.recommended" :key="`r-${entry.id}`" :value="entry.id">
                      {{ entry.name }} ×{{ entry.count }}
                    </option>
                  </optgroup>
                  <optgroup label="其他主卡组卡片">
                    <option v-for="entry in digCandidates.others" :key="`o-${entry.id}`" :value="entry.id">
                      {{ entry.name }} ×{{ entry.count }}
                    </option>
                  </optgroup>
                </select>
                <button class="icon-btn" title="删除这个效果" @click="removeEffect(effect.id)">✕</button>
              </div>

              <input
                v-if="!effect.sourceId"
                v-model="effect.name"
                class="input"
                style="width: 100%"
                placeholder="或者只写个名字（假想效果）"
              />

              <div v-if="effectHints.get(effect.id)?.length" class="rate-effect-hint">
                <span v-for="(hint, hintIndex) in effectHints.get(effect.id)" :key="hintIndex">· {{ hint }}</span>
              </div>

              <div class="rate-ops">
                <div v-for="(op, opIndex) in effect.ops" :key="op.id" class="rate-op">
                  <span class="rate-op-index">{{ index + 1 }}.{{ opIndex + 1 }}</span>

                  <template v-if="op.kind === 'dig'">
                    <label class="rate-field">
                      <span>看</span>
                      <input
                        v-model.number="op.reveal"
                        class="input rate-mini"
                        type="number"
                        min="0"
                        :max="MAX_REVEAL"
                        @change="clampOp(effect, op)"
                      />
                    </label>
                    <label class="rate-field">
                      <span>拿</span>
                      <input
                        v-model.number="op.take"
                        class="input rate-mini"
                        type="number"
                        min="0"
                        :max="MAX_REVEAL"
                        @change="clampOp(effect, op)"
                      />
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
                      <input
                        v-model.number="op.count"
                        class="input rate-mini"
                        type="number"
                        min="0"
                        :max="MAX_DISCARD"
                        :disabled="op.all"
                        @change="clampOp(effect, op)"
                      />
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
                <button
                  v-if="effect.sourceId"
                  class="btn xs ghost"
                  title="按卡面效果文本重新拆算子"
                  @click="reapplyInference(effect)"
                >
                  ↻ 重新识别
                </button>
              </div>

              <div class="rate-gate">
                <span class="rate-field-label">发动条件</span>
                <div class="rate-chips">
                  <span
                    v-for="(clause, clauseIndex) in effect.requirement"
                    :key="clause.id"
                    class="rate-chip gate"
                  >
                    <template v-for="(slot, slotIndex) in clause.slots" :key="slot.cardId">
                      <span v-if="slotIndex > 0" class="rate-and">＋</span>
                      <span>
                        {{ slot.name }}
                        <button
                          v-if="clause.slots.length > 1"
                          title="从这一组里移除"
                          @click="removeRequirementSlot(effect, clauseIndex, slot.cardId)"
                        >
                          ✕
                        </button>
                      </span>
                    </template>
                    <button title="移除这一组条件" @click="removeRequirementClause(effect, clauseIndex)">✕</button>
                  </span>
                  <span v-if="!effect.requirement.length" class="inline-note">无，随时可以发动</span>
                </div>
                <div class="row wrap" style="gap: 6px">
                  <select class="select rate-pick" @change="pickRequirement(effect, $event)">
                    <option value="">＋ 添加发动条件</option>
                    <optgroup label="新的一组（满足任意一组就能发动）">
                      <option v-for="entry in mainEntries" :key="`or-${entry.id}`" :value="`or:${entry.id}`">
                        {{ entry.name }} ×{{ entry.count }}
                      </option>
                    </optgroup>
                    <optgroup v-if="effect.requirement.length" label="与上一组同时上手（且）">
                      <option v-for="entry in requirementFree(effect)" :key="`and-${entry.id}`" :value="`and:${entry.id}`">
                        {{ entry.name }} ×{{ entry.count }}
                      </option>
                    </optgroup>
                  </select>
                  <button
                    v-if="quickPlayEntries.length"
                    class="btn xs ghost"
                    title="把主卡组里的速攻魔法都加成「任意一张即可」"
                    @click="addQuickPlayGate(effect)"
                  >
                    ＋ 速攻魔法 ×{{ quickPlayEntries.length }}
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

            <button
              class="btn primary rate-run"
              :disabled="busy || !activeDeck || !plan.starters.length"
              @click="compute()"
            >
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
                    <div v-for="blocker in processInfo.blockers" :key="blocker.key" class="rate-derive-sub">
                      <span class="rate-derive-sub-label" :title="blocker.label">废件 · {{ blocker.label }}</span>
                      <span class="rate-derive-sub-value mute">约束</span>
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
                      <div
                        v-if="row.trace.gateSkip > 0.0005 || row.trace.optionalSkip > 0.0005"
                        class="rate-trace-head"
                      >
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
          <div class="panel-head"><span class="panel-title">结果怎么读</span></div>
          <div class="panel-body rate-explain">
            <p>
              <b>起手</b>是抽 {{ snapshot?.handSize ?? handSize }} 张直接满足条件的概率，和常规工具一致。
            </p>
            <p>
              <b>启动条件</b>是「组间或、组内且」。组里每张卡都有张数区间：≥1 表示必须上手，
              ≥2 表示同名双卡动，≤N 表示手牌里最多 N 张（设成 ≥1 且 ≤1 就是「恰好 1 张」）。
            </p>
            <p>
              <b>废件</b>是独立的否决项：这些卡在手牌里合计超过额度，就不算启动。
              它不再挂在某个启动组上，所以「废件」与「走哪条线路」无关。
              额度 ≤0 就是一张都不能上手；带 2 张、上手 1 张还能展开就设 ≤1。
            </p>
            <p>
              <b>不可逆 / 可解除</b>决定废件上手后还能不能救。默认「不可逆」：废件进手牌的那一刻这条展开线就断了，
              后面再用效果把牌丢掉、送墓也不会重新算启动；标成「可解除」则只看当前手牌，丢掉后条件可以重新满足
              （比如抽 3 丢 2 把废件丢掉）。
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
              <b>注意</b>：来源卡本身占的手牌位与发动后的消耗没有自动扣掉——需要的话写进「发动条件」，
              再用「丢手牌」算子体现。
            </p>
            <p class="mute">
              精确解基于「等价类压缩 + 对算子做值迭代」，同一份配置的数字可复现；仿真解会显示置信区间。
            </p>
          </div>
        </div>
      </aside>
    </div>
  </div>
</template>
