import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type {
  CardMove,
  ChainEntry,
  Combo,
  ComboLine,
  DeckEntry,
  OpeningCard,
  OperationKind,
  Timing,
  ZoneId,
} from '@/types'
import { uid } from '@/lib/infer'
import { createSampleCombo } from '@/data/sampleCombo'

const STORAGE_KEY = 'ygo-infer-combos-v2'
const LEGACY_KEY = 'ygo-infer-combos-v1'
const MAIN_LINE = '主线'

function blankLine(name = MAIN_LINE): ComboLine {
  return {
    id: uid(),
    name,
    deckName: '',
    handSize: 5,
    goal: '',
    opening: [],
    deck: [],
    timings: [],
  }
}

function blankCombo(name = '未命名展开'): Combo {
  const line = blankLine()
  return {
    id: uid(),
    name,
    lines: [line],
    activeLineId: line.id,
    updatedAt: Date.now(),
  }
}

/* ------------------------------------------------------------------ */
/* 旧版（Step / 事件标记）→ 时序                                        */
/* ------------------------------------------------------------------ */

const LEGACY_ACTION: Record<string, OperationKind> = {
  normalSummon: 'normalSummon',
  specialSummon: 'specialSummon',
  search: 'activate',
  activate: 'activate',
  sendToGY: 'activateEffect',
  draw: 'draw',
  discard: 'activateEffect',
  tribute: 'tributeSummon',
  set: 'set',
  destroy: 'other',
  custom: 'other',
}

function legacyMove(
  cardName: string,
  from: ZoneId,
  to: ZoneId,
  phase: CardMove['phase'],
  note?: string,
): CardMove {
  return { id: uid(), cardName, from, to, phase, note }
}

/** 兼容旧数据：补齐 setup / settle，并把「发动后送墓」的伪 cost 拆成规则处理 */
function normalizeTiming(raw: Timing): Timing {
  const timing: Timing = {
    ...raw,
    setup: [...(raw.setup || [])],
    cost: [...(raw.cost || [])],
    effect: [...(raw.effect || [])],
    settle: [...(raw.settle || [])],
    chains: (raw.chains || []).map((chain) => ({
      ...chain,
      setup: [...(chain.setup || [])],
      cost: [...(chain.cost || [])],
      effect: [...(chain.effect || [])],
      settle: [...(chain.settle || [])],
    })),
    handtraps: raw.handtraps || [],
  }
  if (timing.setup.length || timing.settle.length) return timing
  if (timing.operation !== 'activate') return timing

  const index = timing.cost.findIndex(
    (move) => move.cardName === timing.cardName && (move.from === 'hand' || move.from === 'st') && move.to === 'gy',
  )
  if (index < 0) return timing

  const [moved] = timing.cost.splice(index, 1)
  if (moved.from === 'hand') {
    timing.setup.push({ ...moved, id: uid(), to: 'st', phase: 'auto', note: '发动时置入魔陷区' })
  }
  timing.settle.push({ ...moved, id: uid(), from: 'st', to: 'gy', phase: 'auto', note: '结算后送去墓地' })
  return timing
}

function migrateLegacy(raw: Record<string, unknown>): Combo | null {
  const steps = raw.steps as Record<string, unknown>[] | undefined
  if (!Array.isArray(steps)) return null

  const timings: Timing[] = []
  const chainBuckets = new Map<string, Timing>()

  for (const step of steps) {
    const cardName = String(step.cardName || '')
    if (!cardName) continue
    const action = String(step.action || 'activate')
    const from = (step.from || 'hand') as ZoneId
    const effects = (step.effects as Record<string, unknown>[] | undefined) || []
    const flags = {
      addsFromDeck: Boolean(step.addsFromDeck),
      ssFromDeck: Boolean(step.ssFromDeck),
      sendFromDeck: Boolean(step.sendFromDeck),
      monsterEffectOnField: Boolean(step.monsterEffectOnField),
      fromGYEffect: Boolean(step.fromGYEffect),
      summons: Number(step.summons || 0),
    }

    const setup: CardMove[] = []
    const settle: CardMove[] = []
    const cost: CardMove[] = []
    const effect: CardMove[] = []
    if (step.discardSelfCost) cost.push(legacyMove(cardName, 'hand', 'gy', 'cost', '旧数据：丢弃自身'))
    if (action === 'activate') {
      if (from === 'hand') setup.push(legacyMove(cardName, 'hand', 'st', 'auto', '发动时置入魔陷区'))
      settle.push(legacyMove(cardName, 'st', 'gy', 'auto', '结算后送去墓地'))
    }

    for (const eff of effects) {
      const kind = String(eff.kind)
      const name = String(eff.cardName || '')
      const start = (eff.from || step.summonFrom || step.from || 'deck') as ZoneId
      if (kind === 'search') effect.push(legacyMove(name || '检索目标', 'deck', 'hand', 'effect'))
      else if (kind === 'addToHand') effect.push(legacyMove(name || '回收目标', start, 'hand', 'effect'))
      else if (kind === 'discard') effect.push(legacyMove(name || cardName, start, 'gy', 'effect'))
      else if (kind === 'sendToGY') effect.push(legacyMove(name || '堆墓目标', start, 'gy', 'effect'))
      else if (kind === 'summon')
        effect.push(legacyMove(name || String(step.summonTarget || cardName), start, 'field', 'effect'))
      else if (kind === 'draw') effect.push(legacyMove('抽到的卡', 'deck', 'hand', 'effect'))
      else if (kind === 'set') effect.push(legacyMove(name || cardName, start, 'st', 'effect'))
      else if (kind === 'banish') effect.push(legacyMove(name || cardName, start, 'banish', 'effect'))
    }

    for (const move of effect) {
      const tags = new Set<string>()
      if (move.from === 'deck') tags.add('ash')
      if (move.from === 'deck' && move.to === 'hand') tags.add('droll')
      if (move.from === 'deck' && move.to === 'field') tags.add('fuwalos')
      if (move.from === 'gy') tags.add('belle')
      if (flags.monsterEffectOnField) {
        tags.add('veiler')
        tags.add('imperm')
        tags.add('ogre')
      }
      if (flags.summons > 0) {
        tags.add('maxx')
        tags.add('purulia')
        if (move.from === 'deck' || move.from === 'extra') tags.add('fuwalos')
        if (move.from === 'gy' || move.from === 'banish') tags.add('meowls')
      }
      if (tags.size) move.handtraps = [...tags]
    }

    const chainId = step.chainId ? String(step.chainId) : ''
    if (chainId && chainBuckets.has(chainId)) {
      const bucket = chainBuckets.get(chainId)!
      const entry: ChainEntry = {
        id: uid(),
        link: bucket.chains.length + 2,
        cardName,
        from,
        negates: false,
        setup: [],
        cost,
        effect,
        settle: [],
        note: '旧数据：连锁',
      }
      bucket.chains.push(entry)
      continue
    }

    const timing: Timing = {
      id: uid(),
      operation: LEGACY_ACTION[action] || 'activate',
      cardName,
      from,
      setup,
      cost,
      effect,
      settle,
      chains: [],
      handtraps: [],
      note: String(step.note || ''),
    }
    if (chainId) chainBuckets.set(chainId, timing)
    timings.push(timing)
  }

  if (!timings.length) return null
  const line: ComboLine = {
    id: uid(),
    name: MAIN_LINE,
    deckName: String(raw.deckName || ''),
    handSize: Number(raw.handSize || 5),
    goal: String(raw.goal || ''),
    opening: (raw.opening as OpeningCard[]) || [],
    deck: (raw.deck as DeckEntry[]) || [],
    timings,
  }
  return {
    id: String(raw.id || uid()),
    name: String(raw.name || '导入的展开'),
    lines: [line],
    activeLineId: line.id,
    updatedAt: Date.now(),
  }
}

/* ------------------------------------------------------------------ */
/* 归一化 / 副本                                                        */
/* ------------------------------------------------------------------ */

function normalizeLine(raw: Record<string, unknown>, fallbackName = MAIN_LINE): ComboLine {
  return {
    id: String(raw.id || uid()),
    name: String(raw.name || fallbackName),
    deckName: String(raw.deckName || ''),
    handSize: Number(raw.handSize || 5),
    goal: String(raw.goal || ''),
    opening: (raw.opening as OpeningCard[]) || [],
    deck: (raw.deck as DeckEntry[]) || [],
    timings: ((raw.timings as Timing[]) || []).map(normalizeTiming),
  }
}

/** 兼容三种结构：新版（lines）、旧版（timings 在顶层）、更旧的 steps */
function normalizeCombo(raw: Record<string, unknown>): Combo | null {
  const rawLines = Array.isArray(raw.lines) ? (raw.lines as Record<string, unknown>[]) : []
  let lines = rawLines.map((item, index) =>
    normalizeLine(item, index === 0 ? MAIN_LINE : `展开链 ${index + 1}`),
  )
  if (!lines.length && Array.isArray(raw.timings)) lines = [normalizeLine(raw)]
  if (!lines.length) return migrateLegacy(raw)

  const activeLineId = lines.some((line) => line.id === raw.activeLineId)
    ? String(raw.activeLineId)
    : lines[0].id
  return {
    id: String(raw.id || uid()),
    name: String(raw.name || '导入的展开'),
    lines,
    activeLineId,
    updatedAt: Number(raw.updatedAt || Date.now()),
  }
}

function cloneTiming(timing: Timing): Timing {
  const copyMove = (move: CardMove): CardMove => ({ ...move, id: uid() })
  return {
    ...timing,
    id: uid(),
    setup: (timing.setup || []).map(copyMove),
    cost: timing.cost.map(copyMove),
    effect: timing.effect.map(copyMove),
    settle: (timing.settle || []).map(copyMove),
    manualLinks: (timing.manualLinks || []).map((link) => ({ ...link, id: uid() })),
    chains: timing.chains.map((chain) => ({
      ...chain,
      id: uid(),
      setup: (chain.setup || []).map(copyMove),
      cost: (chain.cost || []).map(copyMove),
      effect: (chain.effect || []).map(copyMove),
      settle: (chain.settle || []).map(copyMove),
    })),
  }
}

/** 整条展开链的副本：时序 / 移动换新 id，手动连线重映射到新 id */
function cloneTimings(timings: Timing[]): Timing[] {
  const timingIds = new Map<string, string>()
  const moveIds = new Map<string, string>()

  const copyMove = (move: CardMove): CardMove => {
    const id = uid()
    moveIds.set(move.id, id)
    return { ...move, id }
  }

  const copies = timings.map((timing) => {
    const id = uid()
    timingIds.set(timing.id, id)
    return {
      ...timing,
      id,
      setup: (timing.setup || []).map(copyMove),
      cost: timing.cost.map(copyMove),
      effect: timing.effect.map(copyMove),
      settle: (timing.settle || []).map(copyMove),
      manualLinks: [] as Timing['manualLinks'],
      chains: timing.chains.map((chain) => ({
        ...chain,
        id: uid(),
        setup: (chain.setup || []).map(copyMove),
        cost: (chain.cost || []).map(copyMove),
        effect: (chain.effect || []).map(copyMove),
        settle: (chain.settle || []).map(copyMove),
      })),
    }
  })

  // id 映射建好后再补手动连线
  copies.forEach((timing, index) => {
    timing.manualLinks = (timings[index].manualLinks || []).map((link) => ({
      ...link,
      id: uid(),
      fromTimingId: timingIds.get(link.fromTimingId) || link.fromTimingId,
      fromMoveId: moveIds.get(link.fromMoveId) || link.fromMoveId,
    }))
  })

  return copies
}

function cloneLine(line: ComboLine, name?: string): ComboLine {
  return {
    ...line,
    id: uid(),
    name: name || `${line.name} 副本`,
    opening: line.opening.map((card) => ({ ...card })),
    deck: line.deck.map((entry) => ({ ...entry })),
    timings: cloneTimings(line.timings),
  }
}

/* ------------------------------------------------------------------ */

export const useComboStore = defineStore('combos', () => {
  const combos = ref<Combo[]>([])
  const currentId = ref('')
  const loaded = ref(false)

  const current = computed(() => combos.value.find((c) => c.id === currentId.value) || null)

  /** 当前选中的展开链 */
  const line = computed(() => {
    const combo = current.value
    if (!combo) return null
    return combo.lines.find((item) => item.id === combo.activeLineId) || combo.lines[0] || null
  })

  function readJson(key: string): unknown {
    try {
      const raw = localStorage.getItem(key)
      return raw ? JSON.parse(raw) : null
    } catch {
      return null
    }
  }

  function load() {
    if (loaded.value) return
    loaded.value = true

    const stored = readJson(STORAGE_KEY)
    if (Array.isArray(stored) && stored.length) {
      const prepared = (stored as Record<string, unknown>[])
        .map((item) => normalizeCombo(item))
        .filter((item): item is Combo => Boolean(item))
      if (prepared.length) {
        combos.value = prepared
        currentId.value = prepared[0].id
        return
      }
    }

    // 旧版数据：尽量迁移，迁移不了就退回示例
    const legacy = readJson(LEGACY_KEY)
    if (Array.isArray(legacy) && legacy.length) {
      const migrated = (legacy as Record<string, unknown>[])
        .map((item) => migrateLegacy(item))
        .filter((item): item is Combo => Boolean(item))
      if (migrated.length) {
        combos.value = migrated
        currentId.value = migrated[0].id
        return
      }
    }

    combos.value = [createSampleCombo()]
    currentId.value = combos.value[0].id
  }

  watch(
    combos,
    (value) => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
      } catch {
        /* 存储空间不足时忽略 */
      }
    },
    { deep: true },
  )

  function select(id: string) {
    if (combos.value.some((combo) => combo.id === id)) currentId.value = id
  }

  function create(name?: string) {
    const combo = blankCombo(name)
    combos.value.unshift(combo)
    currentId.value = combo.id
    return combo
  }

  function duplicate(id: string) {
    const source = combos.value.find((combo) => combo.id === id)
    if (!source) return
    const lines = source.lines.map((item) => cloneLine(item, item.name))
    const copy: Combo = {
      id: uid(),
      name: `${source.name} 副本`,
      lines,
      activeLineId: lines[0]?.id || '',
      updatedAt: Date.now(),
    }
    combos.value.unshift(copy)
    currentId.value = copy.id
  }

  function remove(id: string) {
    const index = combos.value.findIndex((combo) => combo.id === id)
    if (index < 0) return
    combos.value.splice(index, 1)
    if (currentId.value === id) currentId.value = combos.value[0]?.id || ''
  }

  function importCombo(json: string) {
    const data = JSON.parse(json) as unknown
    const list = Array.isArray(data) ? data : [data]
    const prepared = list
      .map((item) => normalizeCombo(item as Record<string, unknown>))
      .filter((item): item is Combo => Boolean(item))
      .map((combo) => ({ ...combo, id: uid(), updatedAt: Date.now() }))
    if (!prepared.length) throw new Error('无法识别的数据格式（需要 lines / timings 或旧版 steps）')
    combos.value.unshift(...prepared)
    currentId.value = prepared[0].id
  }

  function touch() {
    if (current.value) current.value.updatedAt = Date.now()
  }

  /* ---- 展开链 ---- */

  function selectLine(id: string) {
    const combo = current.value
    if (combo && combo.lines.some((item) => item.id === id)) combo.activeLineId = id
  }

  function addLine(name?: string, copyFrom?: ComboLine | null) {
    const combo = current.value
    if (!combo) return null
    const next = copyFrom
      ? cloneLine(copyFrom, name || `${copyFrom.name} 副本`)
      : blankLine(name || `展开链 ${combo.lines.length + 1}`)
    combo.lines.push(next)
    combo.activeLineId = next.id
    touch()
    return next
  }

  function duplicateLine(id: string) {
    const combo = current.value
    const source = combo?.lines.find((item) => item.id === id)
    if (!combo || !source) return
    addLine(undefined, source)
  }

  function removeLine(id: string) {
    const combo = current.value
    if (!combo) return
    const index = combo.lines.findIndex((item) => item.id === id)
    if (index < 0) return
    combo.lines.splice(index, 1)
    if (!combo.lines.length) combo.lines.push(blankLine())
    if (!combo.lines.some((item) => item.id === combo.activeLineId)) {
      combo.activeLineId = combo.lines[Math.min(index, combo.lines.length - 1)].id
    }
    touch()
  }

  function patchLine(patch: Partial<ComboLine>) {
    if (!line.value) return
    Object.assign(line.value, patch)
    touch()
  }

  /* ---- 时序 ---- */

  function addTiming(timing: Timing, afterTimingId?: string) {
    const target = line.value
    if (!target) return
    const index = afterTimingId ? target.timings.findIndex((item) => item.id === afterTimingId) : -1
    if (index >= 0) target.timings.splice(index + 1, 0, timing)
    else target.timings.push(timing)
    touch()
  }

  function updateTiming(timing: Timing) {
    const target = line.value
    if (!target) return
    const index = target.timings.findIndex((item) => item.id === timing.id)
    if (index >= 0) target.timings.splice(index, 1, timing)
    touch()
  }

  function removeTiming(id: string) {
    const target = line.value
    if (!target) return
    target.timings = target.timings.filter((timing) => timing.id !== id)
    // 清掉指向它的手动连线
    for (const timing of target.timings) {
      if (timing.manualLinks?.length) {
        timing.manualLinks = timing.manualLinks.filter((link) => link.fromTimingId !== id)
      }
    }
    touch()
  }

  function moveTiming(id: string, dir: -1 | 1) {
    const target = line.value
    if (!target) return
    const index = target.timings.findIndex((timing) => timing.id === id)
    const next = index + dir
    if (index < 0 || next < 0 || next >= target.timings.length) return
    const [item] = target.timings.splice(index, 1)
    target.timings.splice(next, 0, item)
    touch()
  }

  function duplicateTiming(id: string) {
    const target = line.value
    if (!target) return
    const index = target.timings.findIndex((timing) => timing.id === id)
    if (index < 0) return
    target.timings.splice(index + 1, 0, cloneTiming(target.timings[index]))
    touch()
  }

  /** 连锁始终按 C2、C3……连续编号 */
  function normalizeChains(timing: Timing) {
    timing.chains = [...timing.chains].sort((a, b) => a.link - b.link)
    timing.chains.forEach((chain, index) => (chain.link = index + 2))
  }

  function saveChain(timingId: string, chain: ChainEntry) {
    const timing = line.value?.timings.find((item) => item.id === timingId)
    if (!timing) return
    const index = timing.chains.findIndex((item) => item.id === chain.id)
    if (index >= 0) timing.chains.splice(index, 1, chain)
    else timing.chains.push(chain)
    normalizeChains(timing)
    touch()
  }

  function removeChain(timingId: string, chainId: string) {
    const timing = line.value?.timings.find((item) => item.id === timingId)
    if (!timing) return
    timing.chains = timing.chains.filter((item) => item.id !== chainId)
    normalizeChains(timing)
    touch()
  }

  /* ---- 卡组 / 起手 ---- */

  function addDeckCard(id: number, name: string) {
    const target = line.value
    if (!target) return
    const entry = target.deck.find((item) => item.id === id)
    if (entry) entry.count = Math.min(3, entry.count + 1)
    else target.deck.push({ id, name, count: 1 })
    touch()
  }

  function removeDeckCard(id: number) {
    if (line.value) {
      line.value.deck = line.value.deck.filter((item) => item.id !== id)
      touch()
    }
  }

  function setDeck(deck: DeckEntry[]) {
    if (line.value) {
      line.value.deck = deck
      touch()
    }
  }

  function addOpening(card: OpeningCard) {
    const target = line.value
    if (!target) return
    if (target.opening.length >= target.handSize) return
    if (target.opening.some((item) => item.id === card.id)) return
    target.opening.push(card)
    touch()
  }

  function removeOpening(id: number) {
    if (line.value) {
      line.value.opening = line.value.opening.filter((item) => item.id !== id)
      touch()
    }
  }

  function patchCurrent(patch: Partial<Combo>) {
    if (!current.value) return
    Object.assign(current.value, patch)
    touch()
  }

  return {
    combos,
    currentId,
    current,
    line,
    loaded,
    load,
    select,
    create,
    duplicate,
    remove,
    importCombo,
    selectLine,
    addLine,
    duplicateLine,
    removeLine,
    patchLine,
    addTiming,
    updateTiming,
    removeTiming,
    moveTiming,
    duplicateTiming,
    saveChain,
    removeChain,
    addDeckCard,
    removeDeckCard,
    setDeck,
    addOpening,
    removeOpening,
    patchCurrent,
  }
})
