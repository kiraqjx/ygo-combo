<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { CardData } from '@/types'
import { useCardStore } from '@/stores/cards'
import { createFilters, searchCards } from '@/lib/search'
import { HANDTRAPS } from '@/lib/handtraps'
import { cardImageUrl } from '@/lib/cardDb'

const props = withDefaults(defineProps<{ title?: string; hint?: string }>(), {
  title: '选择卡片',
  hint: '支持中文 / 日文 / 英文卡名与效果文本',
})
const emit = defineEmits<{ close: []; pick: [card: CardData] }>()

const store = useCardStore()
const keyword = ref('')
const frame = ref<'all' | 'monster' | 'spell' | 'trap'>('all')
const input = ref<HTMLInputElement | null>(null)
const remoteLoading = ref(false)
const remoteList = ref<CardData[]>([])

const quick = computed(() =>
  HANDTRAPS.map((h) => store.getCard(h.cardId)).filter((c): c is CardData => Boolean(c)).slice(0, 8),
)

const results = computed(() => {
  if (!keyword.value.trim()) return []
  if (store.status === 'ready') {
    const f = { ...createFilters(), keyword: keyword.value, frame: frame.value }
    return searchCards(store.cards, f, 40).items
  }
  return remoteList.value
})

let timer: number | undefined
watch([keyword, frame], () => {
  window.clearTimeout(timer)
  if (store.status === 'ready' || !keyword.value.trim()) return
  timer = window.setTimeout(async () => {
    remoteLoading.value = true
    remoteList.value = await store.searchRemote(keyword.value)
    remoteLoading.value = false
  }, 320)
})

onMounted(() => input.value?.focus())

function pick(card: CardData) {
  emit('pick', card)
  emit('close')
}
</script>

<template>
  <div class="overlay center" @click.self="emit('close')">
    <div class="modal" style="width: min(560px, 100%)">
      <div class="modal-head">
        <div>
          <div style="font-size: 14px; font-weight: 600">{{ props.title }}</div>
          <div class="inline-note">{{ props.hint }}</div>
        </div>
        <button class="icon-btn" aria-label="关闭" @click="emit('close')">✕</button>
      </div>
      <div class="modal-body">
        <input ref="input" v-model="keyword" class="input" placeholder="输入卡名或效果关键词，例如：灰流丽 / 检索 / 特殊召唤" />
        <div class="row wrap" style="margin-top: 10px; gap: 6px">
          <div class="seg">
            <button :class="{ on: frame === 'all' }" @click="frame = 'all'">全部</button>
            <button :class="{ on: frame === 'monster' }" @click="frame = 'monster'">怪兽</button>
            <button :class="{ on: frame === 'spell' }" @click="frame = 'spell'">魔法</button>
            <button :class="{ on: frame === 'trap' }" @click="frame = 'trap'">陷阱</button>
          </div>
          <span v-if="store.status === 'loading'" class="chip amber">{{ store.progress.message }}</span>
          <span v-else-if="store.status === 'error'" class="chip red">卡库离线，使用在线检索</span>
        </div>

        <div v-if="!keyword.trim()" style="margin-top: 16px">
          <div class="label" style="margin-bottom: 8px">常见手坑</div>
          <div class="row wrap" style="gap: 7px">
            <button v-for="c in quick" :key="c.id" class="chip clickable" @click="pick(c)">{{ c.name }}</button>
          </div>
        </div>

        <div v-if="keyword.trim()" class="picker-list">
          <div v-if="remoteLoading || (store.status === 'loading' && !results.length)" class="empty" style="padding: 22px">
            卡库载入中，正在检索…
          </div>
          <div v-else-if="!results.length" class="empty" style="padding: 22px">没有找到匹配的卡片</div>
          <button v-for="c in results" :key="c.id" class="picker-row" type="button" @click="pick(c)">
            <img :src="cardImageUrl(c.id)" :alt="c.name" loading="lazy" />
            <span class="grow" style="min-width: 0">
              <span class="pn" style="display: block">{{ c.name }}</span>
              <span class="pt">{{ c.typeLine }}</span>
            </span>
            <span class="mono mute" style="font-size: 10.5px">{{ c.id }}</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
