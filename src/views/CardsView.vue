<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import type { CardData } from '@/types'
import { useCardStore } from '@/stores/cards'
import { useComboStore } from '@/stores/combos'
import {
  collectFacets,
  countActiveFilters,
  createFilters,
  MONSTER_KINDS,
  SPELL_KINDS,
  TRAP_KINDS,
  searchCards,
} from '@/lib/search'
import { makeTiming } from '@/lib/infer'
import { toast } from '@/lib/toast'
import CardThumb from '@/components/CardThumb.vue'
import CardDetail from '@/components/CardDetail.vue'

const store = useCardStore()
const comboStore = useComboStore()
comboStore.load()

const filters = reactive(createFilters())
const rankOptions = [
  { value: 'all', label: '全部' },
  { value: '★', label: '等级' },
  { value: 'RANK', label: '阶级' },
  { value: 'LINK', label: '连接' },
] as const
const keyword = ref('')
const limit = ref(60)
const selected = ref<CardData | null>(null)
const showFilters = ref(typeof window === 'undefined' ? true : window.innerWidth > 1080)

let timer: number | undefined
watch(keyword, (v) => {
  window.clearTimeout(timer)
  timer = window.setTimeout(() => {
    filters.keyword = v
    limit.value = 60
  }, 200)
})

watch(
  () => [filters.frame, filters.kinds, filters.races, filters.attributes, filters.rankLabel, filters.levelMin, filters.levelMax, filters.atkMin, filters.atkMax, filters.defMin, filters.defMax, filters.scaleMin, filters.scaleMax, filters.sort, filters.desc],
  () => {
    limit.value = 60
  },
)

const facets = computed(() => {
  const fromCards = collectFacets(store.cards)
  return fromCards.races.length ? fromCards : { races: [], attributes: [] }
})

const kindPool = computed(() => {
  if (filters.frame === 'monster') return MONSTER_KINDS
  if (filters.frame === 'spell') return SPELL_KINDS
  if (filters.frame === 'trap') return TRAP_KINDS
  return [...new Set([...MONSTER_KINDS, ...SPELL_KINDS, ...TRAP_KINDS])]
})

const result = computed(() => {
  if (store.status !== 'ready') return { items: [] as CardData[], total: 0 }
  return searchCards(store.cards, filters, limit.value)
})

const activeCount = computed(() => countActiveFilters(filters))

function toggle(list: string[], value: string) {
  const idx = list.indexOf(value)
  if (idx >= 0) list.splice(idx, 1)
  else list.push(value)
}

function setFrame(frame: 'all' | 'monster' | 'spell' | 'trap') {
  filters.frame = frame
  filters.kinds = filters.kinds.filter((k) => kindPool.value.includes(k))
}

function reset() {
  Object.assign(filters, createFilters())
  keyword.value = ''
}

const numberOrNull = (v: string) => (v === '' || v === null || Number.isNaN(Number(v)) ? null : Number(v))

function addToDeck(card: CardData) {
  comboStore.addDeckCard(card.id, card.name)
  toast(`已加入推演卡组：${card.name}`)
}

function addToOpening(card: CardData) {
  comboStore.addOpening({ id: card.id, name: card.name })
  toast(`已设为已知起手：${card.name}`)
}

function addToStep(card: CardData) {
  const combo = comboStore.current
  if (!combo) return
  comboStore.addTiming(makeTiming(card))
  toast(`已添加为时序：${card.name}`)
}
</script>

<template>
  <div class="page">
    <div class="search-bar">
      <div class="search-input-wrap">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          v-model="keyword"
          class="input search-input"
          placeholder="搜索卡名或效果文本，例如：灰流丽 / 从卡组加入手卡"
          spellcheck="false"
        />
      </div>
      <div class="seg">
        <button :class="{ on: filters.searchIn === 'all' }" @click="filters.searchIn = 'all'">全部</button>
        <button :class="{ on: filters.searchIn === 'name' }" @click="filters.searchIn = 'name'">卡名</button>
        <button :class="{ on: filters.searchIn === 'text' }" @click="filters.searchIn = 'text'">效果</button>
      </div>
      <button class="btn sm ghost only-mobile" @click="showFilters = !showFilters">
        {{ showFilters ? '收起筛选' : '筛选' }}{{ activeCount ? ` · ${activeCount}` : '' }}
      </button>
      <button v-if="activeCount || keyword" class="btn sm ghost" @click="reset">清空</button>
      <span class="chip plain">{{ store.status === 'ready' ? `卡库 ${store.cards.length.toLocaleString()} 张` : store.progress.message }}</span>
    </div>

    <div class="cards-layout">
      <aside class="panel filter-panel" :class="{ collapsed: !showFilters }">
        <div class="panel-head">
          <span class="panel-title">筛选</span>
          <span v-if="activeCount" class="chip gold">{{ activeCount }} 项</span>
        </div>
        <div class="filter-body">
          <div class="filter-group">
            <div class="label">卡片种类</div>
            <div class="seg" style="width: 100%">
              <button style="flex: 1" :class="{ on: filters.frame === 'all' }" @click="setFrame('all')">全部</button>
              <button style="flex: 1" :class="{ on: filters.frame === 'monster' }" @click="setFrame('monster')">怪兽</button>
              <button style="flex: 1" :class="{ on: filters.frame === 'spell' }" @click="setFrame('spell')">魔法</button>
              <button style="flex: 1" :class="{ on: filters.frame === 'trap' }" @click="setFrame('trap')">陷阱</button>
            </div>
            <div class="chip-set" style="margin-top: 8px">
              <button
                v-for="k in kindPool"
                :key="k"
                class="chip clickable"
                :class="{ on: filters.kinds.includes(k) }"
                @click="toggle(filters.kinds, k)"
              >
                {{ k }}
              </button>
            </div>
          </div>

          <div class="filter-group">
            <div class="label">属性</div>
            <div class="chip-set">
              <button
                v-for="a in facets.attributes"
                :key="a"
                class="chip clickable"
                :class="{ on: filters.attributes.includes(a) }"
                @click="toggle(filters.attributes, a)"
              >
                {{ a }}
              </button>
              <span v-if="!facets.attributes.length" class="inline-note">卡库载入后显示</span>
            </div>
          </div>

          <div class="filter-group">
            <div class="label">种族</div>
            <div class="chip-set">
              <button
                v-for="r in facets.races"
                :key="r"
                class="chip clickable"
                :class="{ on: filters.races.includes(r) }"
                @click="toggle(filters.races, r)"
              >
                {{ r }}
              </button>
              <span v-if="!facets.races.length" class="inline-note">卡库载入后显示</span>
            </div>
          </div>

          <div class="filter-group">
            <div class="label">等级 / 阶级 / 连接</div>
            <div class="row wrap" style="gap: 4px; margin-bottom: 8px">
              <button
                v-for="r in rankOptions"
                :key="r.value"
                class="chip clickable"
                :class="{ on: filters.rankLabel === r.value }"
                @click="filters.rankLabel = r.value"
              >
                {{ r.label }}
              </button>
            </div>
            <div class="range-row">
              <input class="input" type="number" placeholder="最小" :value="filters.levelMin ?? ''" @input="filters.levelMin = numberOrNull(($event.target as HTMLInputElement).value)" />
              <span class="mute">—</span>
              <input class="input" type="number" placeholder="最大" :value="filters.levelMax ?? ''" @input="filters.levelMax = numberOrNull(($event.target as HTMLInputElement).value)" />
            </div>
          </div>

          <div class="filter-group">
            <div class="label">攻击力</div>
            <div class="range-row">
              <input class="input" type="number" placeholder="最小" :value="filters.atkMin ?? ''" @input="filters.atkMin = numberOrNull(($event.target as HTMLInputElement).value)" />
              <span class="mute">—</span>
              <input class="input" type="number" placeholder="最大" :value="filters.atkMax ?? ''" @input="filters.atkMax = numberOrNull(($event.target as HTMLInputElement).value)" />
            </div>
          </div>

          <div class="filter-group">
            <div class="label">守备力</div>
            <div class="range-row">
              <input class="input" type="number" placeholder="最小" :value="filters.defMin ?? ''" @input="filters.defMin = numberOrNull(($event.target as HTMLInputElement).value)" />
              <span class="mute">—</span>
              <input class="input" type="number" placeholder="最大" :value="filters.defMax ?? ''" @input="filters.defMax = numberOrNull(($event.target as HTMLInputElement).value)" />
            </div>
          </div>

          <div class="filter-group">
            <div class="label">灵摆刻度</div>
            <div class="range-row">
              <input class="input" type="number" placeholder="最小" :value="filters.scaleMin ?? ''" @input="filters.scaleMin = numberOrNull(($event.target as HTMLInputElement).value)" />
              <span class="mute">—</span>
              <input class="input" type="number" placeholder="最大" :value="filters.scaleMax ?? ''" @input="filters.scaleMax = numberOrNull(($event.target as HTMLInputElement).value)" />
            </div>
          </div>

          <div class="filter-group">
            <div class="label">排序</div>
            <select v-model="filters.sort" class="select">
              <option value="name">卡名</option>
              <option value="atk">攻击力</option>
              <option value="def">守备力</option>
              <option value="level">等级 / 连接</option>
              <option value="id">卡号</option>
            </select>
            <button class="btn sm ghost" style="width: 100%; margin-top: 6px" @click="filters.desc = !filters.desc">
              {{ filters.desc ? '降序 ↓' : '升序 ↑' }}
            </button>
          </div>
        </div>
      </aside>

      <section>
        <div class="result-meta">
          <span>
            <template v-if="store.status === 'ready'">共 <b class="mono gold">{{ result.total.toLocaleString() }}</b> 张 · 已显示 {{ result.items.length }} 张</template>
            <template v-else-if="store.status === 'loading'">{{ store.progress.message }}</template>
            <template v-else-if="store.status === 'error'">{{ store.error }} · 可尝试刷新卡库</template>
            <template v-else>等待卡库载入</template>
          </span>
          <div class="row" style="gap: 6px">
            <span class="inline-note">数据源 ygocdb · 中文卡库</span>
            <button class="btn xs ghost" :disabled="store.status === 'loading'" @click="store.refresh()">刷新卡库</button>
          </div>
        </div>

        <div v-if="store.status === 'loading' && !result.items.length" class="card-grid">
          <div v-for="i in 12" :key="i" class="card-img" style="opacity: 0.35" />
        </div>
        <div v-else-if="store.status === 'error'" class="panel">
          <div class="empty">
            <p>{{ store.error }}</p>
            <p style="margin-top: 6px">卡库需要一次性下载约 2.4MB 的中文卡片数据。</p>
            <button class="btn primary sm" style="margin-top: 12px" @click="store.init(true)">重试</button>
          </div>
        </div>
        <div v-else-if="!result.items.length" class="empty">没有符合条件的卡片，试试放宽筛选。</div>
        <div v-else class="card-grid">
          <CardThumb v-for="c in result.items" :key="c.id" :card="c" @click="selected = c" />
        </div>

        <div v-if="result.items.length < result.total" class="row" style="justify-content: center; margin-top: 24px">
          <button class="btn" @click="limit += 60">加载更多（{{ result.total - result.items.length }}）</button>
        </div>
      </section>
    </div>

    <CardDetail v-if="selected" :card="selected" @close="selected = null">
      <template #actions>
        <button class="btn sm primary" @click="addToStep(selected!)">加为时序</button>
        <button class="btn sm" @click="addToDeck(selected!)">加入推演卡组</button>
        <button class="btn sm ghost" @click="addToOpening(selected!)">设为已知起手</button>
        <a class="btn sm ghost" :href="`https://ygocdb.com/card/${selected.id}`" target="_blank" rel="noreferrer">在 ygocdb 查看</a>
      </template>
    </CardDetail>
  </div>
</template>
