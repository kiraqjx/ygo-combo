<script setup lang="ts">
import { computed, ref } from 'vue'
import type { CardData, ZoneCard, ZoneId, ZoneSnapshot } from '@/types'
import { SLOT_COUNT, ZONE_LABELS } from '@/types'
import { cardImageUrl } from '@/lib/cardDb'
import { useCardStore } from '@/stores/cards'
import CardDetail from './CardDetail.vue'

const props = defineProps<{
  snapshot: ZoneSnapshot
  /** 怪兽区 / 魔陷区槽位数 */
  slots?: number
  /** 资源区最多平铺几张 */
  pileLimit?: number
  /** 高亮刚发生变化的区域 */
  highlight?: ZoneId[]
  /** 卡片角标：连锁发动 / 结算时在对应卡片上显示 C2、C3 */
  badges?: { name: string; label: string; zone?: ZoneId | null }[]
}>()

/** 某张卡在某个区域上要显示的角标 */
function badgeOf(zone: ZoneId, name: string): string {
  const hit = props.badges?.find((item) => item.name === name && (!item.zone || item.zone === zone))
  return hit?.label || ''
}

const store = useCardStore()
const inspecting = ref<{ card: CardData | null; name: string } | null>(null)

const PILE_ZONES: ZoneId[] = ['extra', 'gy', 'banish', 'deck']

function cardsOf(zone: ZoneId): ZoneCard[] {
  return props.snapshot[zone] || []
}

/** 把 ×N 展开成单张，方便画成格子 */
function expanded(zone: ZoneId): ZoneCard[] {
  const out: ZoneCard[] = []
  for (const card of cardsOf(zone)) {
    const count = Math.max(1, card.count)
    for (let i = 0; i < count; i += 1) out.push({ name: card.name, count: 1 })
  }
  return out
}

function countOf(zone: ZoneId): number {
  return cardsOf(zone).reduce((sum, card) => sum + card.count, 0)
}

function imageOf(name: string): string {
  const card = store.getCardByName(name)
  return card ? cardImageUrl(card.id) : ''
}

function inspect(card: ZoneCard) {
  inspecting.value = { card: store.getCardByName(card.name) || null, name: card.name }
}

const limit = computed(() => props.pileLimit ?? 8)
const hand = computed(() => expanded('hand'))

/** 按账本记下的格位摆放；格位放不下的卡（同格多张 / 溢出）顺排补在末尾 */
function slotRow(zone: 'field' | 'st') {
  const slots = (zone === 'field' ? props.snapshot.fieldSlots : props.snapshot.stSlots) || []
  const row: (ZoneCard | null)[] = slots.length ? [...slots] : []
  const rest = expanded(zone)
  for (const card of row) {
    if (!card) continue
    const index = rest.findIndex((item) => item.name === card.name)
    if (index >= 0) rest.splice(index, 1)
  }
  row.push(...rest)
  const size = Math.max(props.slots ?? SLOT_COUNT, row.length)
  return Array.from({ length: size }, (_, index) => row[index] || null)
}

const fieldSlots = computed(() => slotRow('field'))
const stSlots = computed(() => slotRow('st'))
</script>

<template>
  <div class="duel-board-wrap">
    <div class="duel-board">
      <!-- 场上：怪兽区在上、魔陷区在下，和线下决斗盘一致 -->
      <div class="duel-mat">
        <div class="duel-zone-row" :class="{ changed: highlight?.includes('field') }">
          <span class="duel-zone-name">怪兽区</span>
          <div class="duel-slots">
            <button
              v-for="(card, index) in fieldSlots"
              :key="`field-${index}`"
              class="duel-slot"
              :class="{ filled: Boolean(card) }"
              :title="card?.name || '空'"
              @click="card && inspect(card)"
            >
              <template v-if="card">
                <img v-if="imageOf(card.name)" :src="imageOf(card.name)" :alt="card.name" loading="lazy" />
                <span v-else class="duel-slot-fallback">{{ card.name }}</span>
                <span v-if="badgeOf('field', card.name)" class="duel-badge">
                  {{ badgeOf('field', card.name) }}
                </span>
              </template>
              <span v-else class="duel-slot-empty" />
            </button>
          </div>
          <span class="duel-zone-count">{{ countOf('field') }}</span>
        </div>

        <div class="duel-zone-row" :class="{ changed: highlight?.includes('st') }">
          <span class="duel-zone-name">魔陷区</span>
          <div class="duel-slots">
            <button
              v-for="(card, index) in stSlots"
              :key="`st-${index}`"
              class="duel-slot"
              :class="{ filled: Boolean(card) }"
              :title="card?.name || '空'"
              @click="card && inspect(card)"
            >
              <template v-if="card">
                <img v-if="imageOf(card.name)" :src="imageOf(card.name)" :alt="card.name" loading="lazy" />
                <span v-else class="duel-slot-fallback">{{ card.name }}</span>
                <span v-if="badgeOf('st', card.name)" class="duel-badge">
                  {{ badgeOf('st', card.name) }}
                </span>
              </template>
              <span v-else class="duel-slot-empty" />
            </button>
          </div>
          <span class="duel-zone-count">{{ countOf('st') }}</span>
        </div>
      </div>

      <!-- 资源区 -->
      <div class="duel-piles">
        <div v-for="zone in PILE_ZONES" :key="zone" class="duel-pile" :class="{ changed: highlight?.includes(zone) }">
          <div class="duel-pile-head">
            {{ ZONE_LABELS[zone] }}
            <span class="duel-pile-count">{{ countOf(zone) }}</span>
          </div>
          <div class="duel-pile-body">
            <button
              v-for="(card, index) in expanded(zone).slice(0, limit)"
              :key="`${zone}-${card.name}-${index}`"
              class="duel-mini"
              :title="card.name"
              @click="inspect(card)"
            >
              <img v-if="imageOf(card.name)" :src="imageOf(card.name)" :alt="card.name" loading="lazy" />
              <span v-else class="duel-mini-fallback">{{ card.name.slice(0, 3) }}</span>
              <span v-if="badgeOf(zone, card.name)" class="duel-badge mini">
                {{ badgeOf(zone, card.name) }}
              </span>
            </button>
            <span v-if="countOf(zone) > limit" class="duel-pile-more">
              +{{ countOf(zone) - limit }}
            </span>
          </div>
        </div>
      </div>

      <!-- 手牌 -->
      <div class="duel-hand" :class="{ changed: highlight?.includes('hand') }">
        <div class="duel-hand-head">
          手卡
          <span class="duel-pile-count">{{ countOf('hand') }}</span>
        </div>
        <div class="duel-hand-cards">
          <button
            v-for="(card, index) in hand"
            :key="`hand-${card.name}-${index}`"
            class="duel-hand-card"
            :title="card.name"
            @click="inspect(card)"
          >
            <img v-if="imageOf(card.name)" :src="imageOf(card.name)" :alt="card.name" loading="lazy" />
            <span v-else class="duel-hand-fallback">{{ card.name }}</span>
            <span v-if="badgeOf('hand', card.name)" class="duel-badge">
              {{ badgeOf('hand', card.name) }}
            </span>
          </button>
          <div v-if="!hand.length" class="inline-note">手卡为空</div>
        </div>
      </div>
    </div>

    <div v-if="inspecting" class="card-detail-layer" @click.self="inspecting = null">
      <CardDetail
        :card="inspecting.card"
        :fallback-name="inspecting.name"
        @close="inspecting = null"
      />
    </div>
  </div>
</template>
