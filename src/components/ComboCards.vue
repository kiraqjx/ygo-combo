<script setup lang="ts">
import { computed, ref } from 'vue'
import type { CardData, ComboLine } from '@/types'
import { useCardStore } from '@/stores/cards'
import { isExtraDeckCard } from '@/lib/infer'
import CardThumb from './CardThumb.vue'
import CardDetail from './CardDetail.vue'

const props = defineProps<{ lines: ComboLine[] }>()
const emit = defineEmits<{ close: [] }>()

const store = useCardStore()
const selected = ref<CardData | null>(null)

/** 整个展开（所有展开链）用到的卡片：时序主卡 + 连锁卡 + 各段移动涉及的卡，按首次出现排序 */
const used = computed(() => {
  const main: CardData[] = []
  const extra: CardData[] = []
  const seen = new Set<number>()

  const push = (name?: string | null, cardId?: number | null) => {
    const card = store.getCard(cardId) || store.getCardByName(name)
    if (!card || seen.has(card.id)) return
    seen.add(card.id)
    if (isExtraDeckCard(card)) extra.push(card)
    else main.push(card)
  }

  for (const timing of props.lines.flatMap((line) => line.timings)) {
    push(timing.cardName, timing.cardId)
    for (const move of [...timing.setup, ...timing.cost, ...timing.effect, ...timing.settle]) {
      if (move.unknown) continue
      push(move.cardName)
    }
    for (const chain of timing.chains) {
      push(chain.cardName, chain.cardId)
      for (const move of [...(chain.setup || []), ...chain.cost, ...chain.effect, ...(chain.settle || [])]) {
        if (move.unknown) continue
        push(move.cardName)
      }
    }
  }

  return { main, extra }
})
</script>

<template>
  <div class="overlay center" @click.self="emit('close')">
    <div class="modal" style="width: min(920px, 100%)">
      <div class="modal-head">
        <div>
          <div style="font-size: 14px; font-weight: 600">本展开用到的卡片</div>
          <div class="inline-note">
            主卡组 {{ used.main.length }} 种 · 额外卡组 {{ used.extra.length }} 种 · 点卡图看效果
          </div>
        </div>
        <button class="icon-btn" aria-label="关闭" @click="emit('close')">✕</button>
      </div>

      <div class="modal-body">
        <div v-if="!used.main.length && !used.extra.length" class="inline-note">
          还没有用到卡库里的卡片：添加时序并在主卡 / 效果段里选卡后，这里会自动汇总。
        </div>

        <template v-else>
          <div class="row" style="justify-content: space-between; align-items: baseline">
            <span class="label">主卡组</span>
            <span class="mute" style="font-size: 10.5px">{{ used.main.length }} 种</span>
          </div>
          <div v-if="used.main.length" class="card-grid dense" style="margin-top: 8px">
            <CardThumb v-for="card in used.main" :key="card.id" :card="card" @click="selected = card" />
          </div>
          <div v-else class="inline-note" style="margin-top: 6px">没有用到主卡组的卡。</div>

          <div class="divider" />

          <div class="row" style="justify-content: space-between; align-items: baseline">
            <span class="label">额外卡组</span>
            <span class="mute" style="font-size: 10.5px">{{ used.extra.length }} 种</span>
          </div>
          <div v-if="used.extra.length" class="card-grid dense" style="margin-top: 8px">
            <CardThumb v-for="card in used.extra" :key="card.id" :card="card" @click="selected = card" />
          </div>
          <div v-else class="inline-note" style="margin-top: 6px">没有用到额外卡组的卡。</div>
        </template>
      </div>

      <div class="modal-foot">
        <span class="inline-note">融合 / 同调 / 超量 / 连接怪兽归入额外卡组，其余算主卡组</span>
        <span class="grow" />
        <button class="btn ghost" @click="emit('close')">关闭</button>
      </div>
    </div>

    <div v-if="selected" class="card-detail-layer" @click.self="selected = null">
      <CardDetail :card="selected" @close="selected = null" />
    </div>
  </div>
</template>
