import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { CardData, DeckEntry } from '@/types'
import { uid } from '@/lib/infer'

export type DeckSection = 'main' | 'extra' | 'side'

export interface DeckSectionMeta {
  id: DeckSection
  label: string
  limit: number
}

/** 主卡组 60、额外卡组 15、副卡组 15 */
export const DECK_SECTIONS: DeckSectionMeta[] = [
  { id: 'main', label: '主卡组', limit: 60 },
  { id: 'extra', label: '额外卡组', limit: 15 },
  { id: 'side', label: '副卡组', limit: 15 },
]

export const DECK_LIMITS: Record<DeckSection, number> = { main: 60, extra: 15, side: 15 }

/** 同名卡在三个区域合计最多 3 张 */
export const MAX_COPIES = 3

const EXTRA_KINDS = ['融合', '同调', '超量', '连接']
const STORAGE_KEY = 'ygo-deck-builder-v2'
/** 旧版只存单套卡组 */
const LEGACY_KEY = 'ygo-deck-builder-v1'
const DEFAULT_NAME = '我的卡组'

export interface SavedDeck {
  id: string
  name: string
  main: DeckEntry[]
  extra: DeckEntry[]
  side: DeckEntry[]
  updatedAt: number
}

interface StoredState {
  decks: SavedDeck[]
  currentId: string
}

/** 融合 / 同调 / 超量 / 连接 怪兽默认进额外卡组 */
export function isExtraDeckCard(card: CardData): boolean {
  return card.frame === 'monster' && card.kinds.some((kind) => EXTRA_KINDS.includes(kind))
}

function normalizeEntries(value: unknown): DeckEntry[] {
  if (!Array.isArray(value)) return []
  const out: DeckEntry[] = []
  for (const item of value as Partial<DeckEntry>[]) {
    const id = Number(item?.id)
    const name = String(item?.name || '')
    const count = Math.max(1, Math.floor(Number(item?.count) || 1))
    if (id > 0 && name) out.push({ id, name, count })
  }
  return out
}

function blankDeck(name = DEFAULT_NAME): SavedDeck {
  return { id: uid(), name, main: [], extra: [], side: [], updatedAt: Date.now() }
}

function normalizeDeck(raw: Partial<SavedDeck>, fallbackName = DEFAULT_NAME): SavedDeck {
  return {
    id: String(raw.id || uid()),
    name: String(raw.name || fallbackName),
    main: normalizeEntries(raw.main),
    extra: normalizeEntries(raw.extra),
    side: normalizeEntries(raw.side),
    updatedAt: Number(raw.updatedAt || Date.now()),
  }
}

function readStored(): StoredState {
  // 新版：多套卡组
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const data = JSON.parse(raw) as Partial<StoredState>
      const decks = Array.isArray(data.decks)
        ? data.decks.map((item) => normalizeDeck(item as Partial<SavedDeck>))
        : []
      if (decks.length) {
        const currentId = decks.some((deck) => deck.id === data.currentId)
          ? String(data.currentId)
          : decks[0].id
        return { decks, currentId }
      }
    }
  } catch {
    /* 数据损坏时退回默认 */
  }

  // 旧版：单套卡组，迁移成第一套
  try {
    const raw = localStorage.getItem(LEGACY_KEY)
    if (raw) {
      const deck = normalizeDeck(JSON.parse(raw) as Partial<SavedDeck>, DEFAULT_NAME)
      return { decks: [deck], currentId: deck.id }
    }
  } catch {
    /* 忽略 */
  }

  const deck = blankDeck()
  return { decks: [deck], currentId: deck.id }
}

export interface DeckActionResult {
  ok: boolean
  message: string
}

export const useDeckStore = defineStore('deck', () => {
  const initial = readStored()

  const decks = ref<SavedDeck[]>(initial.decks)
  const currentDeckId = ref(initial.currentId)

  function persist(value: StoredState) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
    } catch {
      /* 存储空间不足时忽略 */
    }
  }

  // 首次读取（含旧版单卡组迁移）后立刻落库，避免每次进页面都重新生成 id
  persist({ decks: decks.value, currentId: currentDeckId.value })

  const current = computed(
    () => decks.value.find((deck) => deck.id === currentDeckId.value) || decks.value[0] || null,
  )

  /** 当前卡组名称（可写，用于重命名） */
  const name = computed({
    get: () => current.value?.name ?? '',
    set: (value: string) => {
      if (!current.value) return
      current.value.name = value
      touch()
    },
  })

  const lists = computed<Record<DeckSection, DeckEntry[]>>(() => ({
    main: current.value?.main || [],
    extra: current.value?.extra || [],
    side: current.value?.side || [],
  }))

  const counts = computed<Record<DeckSection, number>>(() => {
    const deck = current.value
    const sum = (list?: DeckEntry[]) => (list || []).reduce((total, entry) => total + entry.count, 0)
    return { main: sum(deck?.main), extra: sum(deck?.extra), side: sum(deck?.side) }
  })

  const total = computed(() => counts.value.main + counts.value.extra + counts.value.side)

  /** 卡号 → 三个区域合计张数 */
  const copyIndex = computed(() => {
    const map = new Map<number, number>()
    for (const list of [lists.value.main, lists.value.extra, lists.value.side]) {
      for (const entry of list) map.set(entry.id, (map.get(entry.id) || 0) + entry.count)
    }
    return map
  })

  function copiesOf(id: number): number {
    return copyIndex.value.get(id) || 0
  }

  function totalOf(deck: SavedDeck): number {
    return [...deck.main, ...deck.extra, ...deck.side].reduce((sum, entry) => sum + entry.count, 0)
  }

  function sectionLabel(section: DeckSection): string {
    return DECK_SECTIONS.find((item) => item.id === section)?.label || ''
  }

  function touch() {
    if (current.value) current.value.updatedAt = Date.now()
  }

  function uniqueName(base: string): string {
    const names = new Set(decks.value.map((deck) => deck.name))
    if (!names.has(base)) return base
    let index = 2
    while (names.has(`${base} ${index}`)) index += 1
    return `${base} ${index}`
  }

  /* ---- 卡组管理 ---- */

  function select(id: string) {
    if (decks.value.some((deck) => deck.id === id)) currentDeckId.value = id
  }

  function create(name?: string): SavedDeck {
    const deck = blankDeck(uniqueName(name?.trim() || '未命名卡组'))
    decks.value.unshift(deck)
    currentDeckId.value = deck.id
    return deck
  }

  function duplicate(id = currentDeckId.value): SavedDeck | null {
    const source = decks.value.find((deck) => deck.id === id)
    if (!source) return null
    const copy: SavedDeck = {
      id: uid(),
      name: uniqueName(`${source.name} 副本`),
      main: source.main.map((entry) => ({ ...entry })),
      extra: source.extra.map((entry) => ({ ...entry })),
      side: source.side.map((entry) => ({ ...entry })),
      updatedAt: Date.now(),
    }
    decks.value.unshift(copy)
    currentDeckId.value = copy.id
    return copy
  }

  /** 删除整套卡组；删空后自动补一套空白卡组 */
  function removeDeck(id: string) {
    const index = decks.value.findIndex((deck) => deck.id === id)
    if (index < 0) return
    decks.value.splice(index, 1)
    if (!decks.value.length) {
      const deck = blankDeck()
      decks.value.push(deck)
      currentDeckId.value = deck.id
      return
    }
    if (currentDeckId.value === id) {
      currentDeckId.value = decks.value[Math.min(index, decks.value.length - 1)].id
    }
  }

  /* ---- 卡片 ---- */

  /**
   * 区域限制：主卡组只收主卡组卡，额外卡组只收融合 / 同调 / 超量 / 连接怪兽；
   * 副卡组按规则可以放任意卡（包括额外卡组怪兽）。
   */
  function placementError(card: CardData, section: DeckSection): string | null {
    const extra = isExtraDeckCard(card)
    if (section === 'extra' && !extra) {
      return `${card.name} 不是额外卡组怪兽，只有融合 / 同调 / 超量 / 连接怪兽能放入额外卡组`
    }
    if (section === 'main' && extra) {
      return `${card.name} 是额外卡组怪兽，不能放入主卡组`
    }
    return null
  }

  function add(card: CardData, section?: DeckSection): DeckActionResult {
    if (!current.value) return { ok: false, message: '请先新建一套卡组' }

    const target = section || (isExtraDeckCard(card) ? 'extra' : 'main')
    const label = sectionLabel(target)

    const invalid = placementError(card, target)
    if (invalid) return { ok: false, message: invalid }

    if (copiesOf(card.id) >= MAX_COPIES) {
      return { ok: false, message: `${card.name} 最多只能放 ${MAX_COPIES} 张` }
    }
    if (counts.value[target] >= DECK_LIMITS[target]) {
      return { ok: false, message: `${label}已满 ${DECK_LIMITS[target]} 张` }
    }

    const list = lists.value[target]
    const entry = list.find((item) => item.id === card.id)
    if (entry) entry.count += 1
    else list.push({ id: card.id, name: card.name, count: 1 })
    return { ok: true, message: `已加入${label}：${card.name}` }
  }

  /** 移除一张；all 为 true 时移除该卡在本区域的全部张数 */
  function remove(id: number, section: DeckSection, all = false) {
    if (!current.value) return
    const list = lists.value[section]
    const index = list.findIndex((item) => item.id === id)
    if (index < 0) return
    const entry = list[index]
    if (!all && entry.count > 1) {
      entry.count -= 1
      return
    }
    list.splice(index, 1)
  }

  function clear(section: DeckSection) {
    if (!current.value) return
    lists.value[section].splice(0, lists.value[section].length)
  }

  function clearAll() {
    clear('main')
    clear('extra')
    clear('side')
  }

  watch(
    () => ({ decks: decks.value, currentId: currentDeckId.value }),
    (value) => persist(value),
    { deep: true },
  )

  return {
    decks,
    currentDeckId,
    current,
    name,
    lists,
    counts,
    total,
    copyIndex,
    copiesOf,
    totalOf,
    select,
    create,
    duplicate,
    removeDeck,
    add,
    remove,
    clear,
    clearAll,
  }
})
