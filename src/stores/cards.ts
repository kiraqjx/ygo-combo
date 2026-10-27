import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import type { CardData } from '@/types'
import { clearCardCache, loadCardDatabase, remoteSearch, type LoadProgress } from '@/lib/cardDb'
import { collectFacets } from '@/lib/search'

const emptyProgress: LoadProgress = { phase: 'idle', loaded: 0, total: 0, message: '' }

export const useCardStore = defineStore('cards', () => {
  const cards = shallowRef<CardData[]>([])
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

  async function init(force = false) {
    if (!force && (status.value === 'ready' || status.value === 'loading')) return loading ?? undefined
    status.value = 'loading'
    loading = (async () => {
      try {
        const data = await loadCardDatabase((p) => {
          progress.value = p
        })
        cards.value = data
        updatedAt.value = Date.now()
        status.value = 'ready'
        progress.value = { phase: 'ready', loaded: data.length, total: data.length, message: `卡库就绪 · ${data.length} 张` }
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
    cards.value = []
    status.value = 'idle'
    await init(true)
  }

  function getCard(id?: number | null): CardData | undefined {
    if (!id) return undefined
    return cardMap.value.get(id)
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
    searchRemote,
    remoteResults,
  }
})
