<script setup lang="ts">
import { computed } from 'vue'
import type { CardData } from '@/types'
import { cardImageUrl } from '@/lib/cardDb'

const props = defineProps<{
  card: CardData | null
  /** 只有卡名、卡库查不到时的兜底展示 */
  fallbackName?: string
}>()

const emit = defineEmits<{ close: [] }>()

const image = computed(() => (props.card ? cardImageUrl(props.card.id) : ''))
const stats = computed(() => {
  const card = props.card
  if (!card) return []
  const out: string[] = []
  if (card.rankLabel === 'LINK') {
    if (card.atk != null) out.push(`ATK ${card.atk}`)
    if (card.linkMarkers?.length) out.push(card.linkMarkers.join(' '))
  } else if (card.rankLabel === 'RANK') {
    if (card.level != null) out.push(`RANK ${card.level}`)
  } else if (card.rankLabel === '★') {
    if (card.level != null) out.push(`${'★'.repeat(Math.min(card.level, 12))}`)
  }
  if (card.atk != null && card.rankLabel !== 'LINK') out.push(`ATK ${card.atk}`)
  if (card.def != null) out.push(`DEF ${card.def}`)
  if (card.scale != null) out.push(`P ${card.scale}`)
  return out
})

const desc = computed(() => {
  const card = props.card
  if (!card) return ''
  return [card.desc, card.pendDesc ? `【灵摆】${card.pendDesc}` : ''].filter(Boolean).join('\n')
})
</script>

<template>
  <div class="card-detail">
    <button class="icon-btn card-detail-close" aria-label="关闭" @click="emit('close')">✕</button>

    <div class="card-detail-body">
      <div class="card-detail-art">
        <img v-if="image" :src="image" :alt="card?.name || fallbackName" />
        <div v-else class="card-detail-art-empty">无卡图</div>
      </div>

      <div class="card-detail-info">
        <div class="card-detail-name">{{ card?.name || fallbackName || '未知卡片' }}</div>
        <div v-if="card?.typeLine" class="card-detail-type">{{ card.typeLine }}</div>
        <div v-if="card && (card.race || card.attribute)" class="card-detail-meta">
          <span v-if="card.attribute">{{ card.attribute }}</span>
          <span v-if="card.race">{{ card.race }}</span>
        </div>
        <div v-if="stats.length" class="card-detail-stats">
          <span v-for="item in stats" :key="item">{{ item }}</span>
        </div>
        <p v-if="desc" class="card-detail-desc">{{ desc }}</p>
        <p v-else-if="!card" class="card-detail-desc muted">
          卡库里没有「{{ fallbackName }}」，可能只是配置里随手写的占位名。
        </p>
      </div>
    </div>
  </div>
</template>
