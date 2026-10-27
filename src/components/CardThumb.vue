<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { CardData } from '@/types'
import { cardImageFallback, cardImageUrl } from '@/lib/cardDb'

const props = withDefaults(
  defineProps<{
    card: CardData
    showName?: boolean
    showBadges?: boolean
  }>(),
  { showName: true, showBadges: true },
)

const src = ref(cardImageUrl(props.card.id))
const loaded = ref(false)
const failed = ref(false)

watch(
  () => props.card.id,
  (id) => {
    src.value = cardImageUrl(id)
    loaded.value = false
    failed.value = false
  },
)

function onError() {
  if (src.value !== cardImageFallback(props.card.id)) {
    src.value = cardImageFallback(props.card.id)
  } else {
    failed.value = true
  }
}

const kindLabel = computed(() => {
  const c = props.card
  if (c.frame === 'monster') {
    const special = c.kinds.find((k) => ['融合', '同调', '超量', '连接', '灵摆', '仪式', '调整', '反转'].includes(k))
    return special || (c.kinds.includes('通常') ? '通常' : '效果')
  }
  return c.kinds.filter((k) => k !== '魔法' && k !== '陷阱').join(' ') || (c.frame === 'spell' ? '魔法' : '陷阱')
})

const levelLabel = computed(() => {
  const c = props.card
  if (!c.level) return ''
  if (c.rankLabel === 'LINK') return `LINK-${c.level}`
  if (c.rankLabel === 'RANK') return `R${c.level}`
  return `★${c.level}`
})
</script>

<template>
  <div class="card-tile" :title="`${card.name}${card.enName ? ' / ' + card.enName : ''}`">
    <div class="card-img">
      <img
        v-if="!failed"
        :src="src"
        :alt="card.name"
        loading="lazy"
        :class="{ loaded }"
        @load="loaded = true"
        @error="onError"
      />
      <div v-else class="empty" style="padding: 20px 6px; font-size: 11px">{{ card.name }}</div>
      <div v-if="showBadges" class="card-badges">
        <span class="card-badge">{{ kindLabel }}</span>
        <span v-if="card.attribute" class="card-badge">{{ card.attribute }}</span>
      </div>
      <span v-if="showBadges && levelLabel" class="card-badge level">{{ levelLabel }}</span>
    </div>
    <div v-if="showName" class="card-name">{{ card.name }}</div>
  </div>
</template>
