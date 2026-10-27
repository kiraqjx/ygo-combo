import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type {
  CardMove,
  ChainEntry,
  Combo,
  DeckEntry,
  OpeningCard,
  OperationKind,
  Timing,
  ZoneId,
} from '@/types'
import { uid } from '@/lib/infer'
import { SAMPLE_COMBO_ID, createSampleCombo } from '@/data/sampleCombo'

const STORAGE_KEY = 'ygo-infer-combos-v2'
const LEGACY_KEY = 'ygo-infer-combos-v1'

function blankCombo(name = '未命名展开'): Combo {
  return {
    id: uid(),
    name,
    deckName: '',
    handSize: 5,
    goal: '',
    opening: [],
    deck: [],
    timings: [],
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
  return {
    id: String(raw.id || uid()),
    name: String(raw.name || '导入的展开'),
    deckName: String(raw.deckName || ''),
    handSize: Number(raw.handSize || 5),
    goal: String(raw.goal || ''),
    opening: (raw.opening as OpeningCard[]) || [],
    deck: (raw.deck as DeckEntry[]) || [],
    timings,
    updatedAt: Date.now(),
  }
}

/* ------------------------------------------------------------------ */
/* 副本                                                                 */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */

export const useComboStore = defineStore('combos', () => {
  const combos = ref<Combo[]>([])
  const currentId = ref('')
  const loaded = ref(false)

  const current = computed(() => combos.value.find((c) => c.id === currentId.value) || null)

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
      combos.value = (stored as Combo[]).map((combo) => ({
        ...combo,
        timings: (combo.timings || []).map(normalizeTiming),
      }))
      currentId.value = combos.value[0].id
      return
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
    const copy: Combo = {
      ...JSON.parse(JSON.stringify(source)),
      id: uid(),
      name: `${source.name} 副本`,
      timings: source.timings.map(cloneTiming),
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
    if (!combos.value.length) {
      const sample = createSampleCombo()
      combos.value.push(sample)
      currentId.value = sample.id
    }
  }

  function restoreDemo() {
    const existing = combos.value.find((combo) => combo.id === SAMPLE_COMBO_ID)
    if (existing) {
      currentId.value = existing.id
      return existing
    }
    const sample = createSampleCombo()
    combos.value.unshift(sample)
    currentId.value = sample.id
    return sample
  }

  function importCombo(json: string) {
    const data = JSON.parse(json) as unknown
    const list = Array.isArray(data) ? data : [data]
    const prepared = list
      .map((item) => {
        const raw = item as Record<string, unknown>
        if (Array.isArray(raw.timings)) {
          const combo = raw as unknown as Combo
          return { ...blankCombo(combo.name), ...combo, id: uid(), updatedAt: Date.now() }
        }
        return migrateLegacy(raw)
      })
      .filter((item): item is Combo => Boolean(item))
    if (!prepared.length) throw new Error('无法识别的数据格式（需要 timings 或旧版 steps）')
    combos.value.unshift(...prepared)
    currentId.value = prepared[0].id
  }

  function touch() {
    if (current.value) current.value.updatedAt = Date.now()
  }

  /* ---- 时序 ---- */

  function addTiming(timing: Timing, afterTimingId?: string) {
    const combo = current.value
    if (!combo) return
    const index = afterTimingId ? combo.timings.findIndex((item) => item.id === afterTimingId) : -1
    if (index >= 0) combo.timings.splice(index + 1, 0, timing)
    else combo.timings.push(timing)
    touch()
  }

  function updateTiming(timing: Timing) {
    const combo = current.value
    if (!combo) return
    const index = combo.timings.findIndex((item) => item.id === timing.id)
    if (index >= 0) combo.timings.splice(index, 1, timing)
    touch()
  }

  function removeTiming(id: string) {
    const combo = current.value
    if (!combo) return
    combo.timings = combo.timings.filter((timing) => timing.id !== id)
    // 清掉指向它的手动连线
    for (const timing of combo.timings) {
      if (timing.manualLinks?.length) {
        timing.manualLinks = timing.manualLinks.filter((link) => link.fromTimingId !== id)
      }
    }
    touch()
  }

  function moveTiming(id: string, dir: -1 | 1) {
    const combo = current.value
    if (!combo) return
    const index = combo.timings.findIndex((timing) => timing.id === id)
    const next = index + dir
    if (index < 0 || next < 0 || next >= combo.timings.length) return
    const [item] = combo.timings.splice(index, 1)
    combo.timings.splice(next, 0, item)
    touch()
  }

  function duplicateTiming(id: string) {
    const combo = current.value
    if (!combo) return
    const index = combo.timings.findIndex((timing) => timing.id === id)
    if (index < 0) return
    combo.timings.splice(index + 1, 0, cloneTiming(combo.timings[index]))
    touch()
  }

  /** 连锁始终按 C2、C3……连续编号 */
  function normalizeChains(timing: Timing) {
    timing.chains = [...timing.chains].sort((a, b) => a.link - b.link)
    timing.chains.forEach((chain, index) => (chain.link = index + 2))
  }

  function saveChain(timingId: string, chain: ChainEntry) {
    const timing = current.value?.timings.find((item) => item.id === timingId)
    if (!timing) return
    const index = timing.chains.findIndex((item) => item.id === chain.id)
    if (index >= 0) timing.chains.splice(index, 1, chain)
    else timing.chains.push(chain)
    normalizeChains(timing)
    touch()
  }

  function removeChain(timingId: string, chainId: string) {
    const timing = current.value?.timings.find((item) => item.id === timingId)
    if (!timing) return
    timing.chains = timing.chains.filter((item) => item.id !== chainId)
    normalizeChains(timing)
    touch()
  }

  /* ---- 卡组 / 起手 ---- */

  function addDeckCard(id: number, name: string) {
    const combo = current.value
    if (!combo) return
    const entry = combo.deck.find((item) => item.id === id)
    if (entry) entry.count = Math.min(3, entry.count + 1)
    else combo.deck.push({ id, name, count: 1 })
    touch()
  }

  function removeDeckCard(id: number) {
    if (current.value) {
      current.value.deck = current.value.deck.filter((item) => item.id !== id)
      touch()
    }
  }

  function setDeck(deck: DeckEntry[]) {
    if (current.value) {
      current.value.deck = deck
      touch()
    }
  }

  function addOpening(card: OpeningCard) {
    const combo = current.value
    if (!combo) return
    if (combo.opening.length >= combo.handSize) return
    if (combo.opening.some((item) => item.id === card.id)) return
    combo.opening.push(card)
    touch()
  }

  function removeOpening(id: number) {
    if (current.value) {
      current.value.opening = current.value.opening.filter((item) => item.id !== id)
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
    loaded,
    load,
    select,
    create,
    duplicate,
    remove,
    restoreDemo,
    importCombo,
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
