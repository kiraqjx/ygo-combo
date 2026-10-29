<script setup lang="ts">
import { computed, ref } from 'vue'
import type { CardData, ComboLine } from '@/types'
import { useComboStore } from '@/stores/combos'
import { cardImageUrl } from '@/lib/cardDb'
import CardPicker from './CardPicker.vue'

const props = defineProps<{ line: ComboLine }>()

const store = useComboStore()
const combo = computed(() => props.line)

const picker = ref<'deck' | 'opening' | null>(null)

function pick(card: CardData) {
  if (picker.value === 'opening') store.addOpening({ id: card.id, name: card.name })
  else store.addDeckCard(card.id, card.name)
  picker.value = null
}

const deckCount = computed(() => (combo.value?.deck || []).reduce((n, d) => n + d.count, 0))
</script>

<template>
  <div v-if="combo" class="lab-col">
    <div class="panel">
      <div class="panel-head">
        <span class="panel-title">已知起手</span>
        <button class="btn xs" @click="picker = 'opening'">＋ 加牌</button>
      </div>
      <div class="panel-body" style="padding: 12px">
        <div v-if="!combo.opening.length" class="inline-note">
          录入起手牌后，它就是区域账本的第一份手卡；后续时序的 cost 与效果都会在这里增减。
        </div>
        <div v-else class="row wrap" style="gap: 6px">
          <span v-for="o in combo.opening" :key="o.id" class="chip gold">
            {{ o.name }}
            <button type="button" @click="store.removeOpening(o.id)">✕</button>
          </span>
        </div>
        <div class="inline-note" style="margin-top: 10px">
          {{ combo.opening.length }} / {{ combo.handSize }} 张已知 · 其余按未知手牌处理
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">
        <span class="panel-title">推演卡组</span>
        <span class="mono mute" style="font-size: 11px">{{ deckCount }} 张</span>
      </div>
      <div style="padding: 8px">
        <button v-for="d in combo.deck" :key="d.id" class="deck-row" style="width: 100%; background: transparent; border: 1px solid transparent; text-align: left; cursor: pointer" @click="store.removeDeckCard(d.id)">
          <img :src="cardImageUrl(d.id)" :alt="d.name" style="width: 22px; border-radius: 3px" loading="lazy" />
          <span class="grow" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis">{{ d.name }}</span>
          <span class="count">×{{ d.count }}</span>
        </button>
        <div v-if="!combo.deck.length" class="empty" style="padding: 22px 10px">卡组为空</div>
        <button class="btn ghost sm" style="width: 100%; margin-top: 6px; justify-content: center" @click="picker = 'deck'">
          ＋ 添加卡片
        </button>
        <div class="inline-note" style="margin-top: 8px">
          卡组余量用于校验「检索 / 堆墓 / 卡组特召」是否还有库存；点击卡片可移除。
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><span class="panel-title">推演说明</span></div>
      <div class="panel-body" style="padding: 12px">
        <ul class="note-list" style="margin-top: 0">
          <li>时序按 C1 → Cn 记录，cost 必定成功，只有效果段会被手坑拦下。</li>
          <li>卡片从卡组 / 墓地 / 手卡流到哪个区域都记在「效果段」里，系统据此自动连链。</li>
          <li>手坑标在具体效果段上；无效类整段无效，封锁类只封被标记的段。</li>
          <li>上游链路被切断时，下游使用时序会自动标为「断链」。</li>
        </ul>
      </div>
    </div>

    <CardPicker
      v-if="picker"
      :title="picker === 'opening' ? '加入已知起手' : '加入推演卡组'"
      @close="picker = null"
      @pick="pick"
    />
  </div>
</template>
