import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import type { CardData } from '@/types'
import {
  clearCardCache,
  loadCardDatabase,
  normalizeAltArtId,
  remoteSearch,
  type LoadProgress,
} from '@/lib/cardDb'
import {
  buildCustomCard,
  loadCustomCards,
  nextCustomId,
  parseCardId,
  persistCustomCards,
  type CustomCardDraft,
} from '@/lib/customCards'
import { collectFacets } from '@/lib/search'
import { useDeckStore } from '@/stores/deck'

const emptyProgress: LoadProgress = { phase: 'idle', loaded: 0, total: 0, message: '' }

export interface AddCustomResult {
  ok: boolean
  message: string
  card: CardData | null
}

export const useCardStore = defineStore('cards', () => {
  /** 下载来的卡库 */
  const library = shallowRef<CardData[]>([])
  /** 本地手动录入的卡（先行服 / 未收录） */
  const custom = shallowRef<CardData[]>(loadCustomCards())
  /** 检索与查卡统一走合并后的列表，自定义卡优先，保证同名时先命中用户录入的那张 */
  const cards = computed(() => (custom.value.length ? [...custom.value, ...library.value] : library.value))
  const status = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const progress = ref<LoadProgress>({ ...emptyProgress })
  const error = ref('')
  const remoteResults = shallowRef<CardData[]>([])

  const cardMap = computed(() => {
    const map = new Map<number, CardData>()
    for (const c of cards.value) map.set(c.id, c)
    return map
  })
  const nameMap = computed(() => {
    const map = new Map<string, CardData>()
    for (const c of cards.value) map.set(c.name, c)
    return map
  })
  const facets = computed(() => collectFacets(cards.value))
  const updatedAt = ref<number | null>(null)

  let loading: Promise<void> | null = null

  /**
   * 异画卡编号（本体密码 + 1..9）折回本体密码；本体已收录的卡 / 真正未收录的卡原样返回。
   * 外部系统导出的卡组常常带着异画自己的编号，正式服卡库里查不到。
   */
  function normalizeCardId(id: number): number {
    return normalizeAltArtId(id, (code) => cardMap.value.has(code))
  }

  /** 卡库 / 自定义卡变化后，把卡组与启动率里的异画编号、占位名换回本体卡 */
  function syncDeckNames() {
    useDeckStore().resolveNames((id) => cardMap.value.get(normalizeCardId(id)))
  }

  async function init(force = false) {
    if (!force && (status.value === 'ready' || status.value === 'loading')) return loading ?? undefined
    status.value = 'loading'
    loading = (async () => {
      try {
        const data = await loadCardDatabase((p) => {
          progress.value = p
        })
        library.value = data
        updatedAt.value = Date.now()
        status.value = 'ready'
        progress.value = { phase: 'ready', loaded: data.length, total: data.length, message: `卡库就绪 · ${data.length} 张` }
        syncDeckNames()
      } catch (e) {
        error.value = e instanceof Error ? e.message : '卡库加载失败'
        status.value = 'error'
        progress.value = { phase: 'error', loaded: 0, total: 0, message: error.value }
      }
    })()
    return loading
  }

  async function refresh() {
    await clearCardCache()
    library.value = []
    status.value = 'idle'
    await init(true)
  }

  /* ---- 自定义卡 ---- */

  function isCustomCard(id: number): boolean {
    return custom.value.some((card) => card.id === id)
  }

  function addCustomCard(draft: CustomCardDraft): AddCustomResult {
    const name = draft.name.trim()
    if (!name) return { ok: false, message: '先填一个卡名', card: null }

    const inLibrary = library.value.find((card) => card.name === name)
    if (inLibrary) {
      return { ok: false, message: `卡库里已经有「${name}」了，直接搜索添加即可`, card: null }
    }
    if (custom.value.some((card) => card.name === name)) {
      return { ok: false, message: `已经添加过自定义卡「${name}」`, card: null }
    }

    const typedId = parseCardId(draft.id)
    if (typedId !== null) {
      const taken = cards.value.find((card) => card.id === typedId)
      if (taken) return { ok: false, message: `卡号 ${typedId} 已经被「${taken.name}」占用`, card: null }
    }

    const used = new Set(cards.value.map((card) => card.id))
    const id = typedId ?? nextCustomId(used)
    const card = buildCustomCard(draft, id)
    custom.value = [...custom.value, card]
    persistCustomCards(custom.value)
    syncDeckNames()
    return { ok: true, message: `已添加自定义卡「${name}」`, card }
  }

  function removeCustomCard(id: number): void {
    custom.value = custom.value.filter((card) => card.id !== id)
    persistCustomCards(custom.value)
  }

  /** 按卡号查卡；异画编号会先折回本体密码，所以拿异画 id 也能查到卡 */
  function getCard(id?: number | null): CardData | undefined {
    if (!id) return undefined
    return cardMap.value.get(normalizeCardId(id))
  }

  /** 只存了卡名、没有 cardId 时按名字回查卡种 */
  function getCardByName(name?: string | null): CardData | undefined {
    const key = name?.trim()
    if (!key) return undefined
    return nameMap.value.get(key)
  }

  async function searchRemote(keyword: string) {
    try {
      remoteResults.value = await remoteSearch(keyword)
    } catch {
      remoteResults.value = []
    }
    return remoteResults.value
  }

  return {
    cards,
    library,
    custom,
    status,
    progress,
    error,
    cardMap,
    nameMap,
    facets,
    updatedAt,
    init,
    refresh,
    getCard,
    getCardByName,
    normalizeCardId,
    searchRemote,
    remoteResults,
    isCustomCard,
    addCustomCard,
    removeCustomCard,
  }
})
