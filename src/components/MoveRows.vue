<script setup lang="ts">
import { ref } from 'vue'
import type { BattlePosition, CardData, CardMove, Timing, ZoneId } from '@/types'
import { POSITION_LABELS, SLOT_COUNT, UNKNOWN_CARD, ZONE_LABELS, ZONE_ORDER } from '@/types'
import { suggestHandtraps, uid } from '@/lib/infer'
import { useCardStore } from '@/stores/cards'
import { useHandtrapStore } from '@/stores/handtraps'
import { cardImageUrl } from '@/lib/cardDb'
import CardPicker from './CardPicker.vue'

const moves = defineModel<CardMove[]>({ required: true })
const props = defineProps<{
  phase: CardMove['phase']
  operation: Timing['operation']
  from?: ZoneId
}>()

const store = useCardStore()
const ht = useHandtrapStore()
const picking = ref<string | null>(null)
const manual = ref<string | null>(null)

/** 手输卡名也能出图：按名字回查卡库 */
const moveThumb = (move: CardMove) => {
  if (!move.cardName || move.unknown) return ''
  const id = store.getCardByName(move.cardName)?.id
  return id ? cardImageUrl(id) : ''
}

function add() {
  // 这一段已经在处理超量素材时，新行接着按素材的语义填默认值
  const usesMaterial = moves.value.some((item) => item.from === 'material' || item.to === 'material')
  const attach = props.phase === 'auto' && usesMaterial
  const detach = props.phase === 'cost' && usesMaterial
  moves.value = [
    ...moves.value,
    {
      id: uid(),
      cardName: '',
      from: attach ? 'field' : detach ? 'material' : props.phase === 'cost' ? 'hand' : 'deck',
      to: attach ? 'material' : props.phase === 'cost' ? 'gy' : 'hand',
      phase: props.phase,
      handtraps: [],
      note: '',
    },
  ]
}

function remove(id: string) {
  moves.value = moves.value.filter((move) => move.id !== id)
}

function pick(card: CardData) {
  const move = moves.value.find((item) => item.id === picking.value)
  if (move) {
    move.cardName = card.name
    move.unknown = false
  }
  picking.value = null
}

function toggleUnknown(move: CardMove) {
  move.unknown = !move.unknown
  if (move.unknown) {
    move.cardName = UNKNOWN_CARD
    manual.value = null
  } else {
    move.cardName = ''
  }
}

function toggle(move: CardMove, id: string) {
  const set = new Set(move.handtraps || [])
  if (set.has(id)) set.delete(id)
  else set.add(id)
  move.handtraps = [...set]
}

function suggest(move: CardMove) {
  move.handtraps = suggestHandtraps(move, { operation: props.operation, from: props.from })
}

/** 0 = 不指定，自动顺排到第一个空位 */
function setSlot(move: CardMove, raw: string) {
  const slot = Number(raw)
  if (slot > 0) move.slot = slot
  else delete move.slot
}

/** 选中 / 取消「叠放到该格位已有的怪兽上」 */
function toggleOverlay(move: CardMove) {
  if (move.overlay) delete move.overlay
  else move.overlay = true
}

/** 超量素材相关：格位表示素材挂在几号位的怪兽下面 */
const isMaterialMove = (move: CardMove) => move.to === 'material' || move.from === 'material'

const POSITIONS: BattlePosition[] = ['attack', 'defense', 'set']

/** 表示形式：攻击 / 守备 / 里侧守备（盖放） */
function setPosition(move: CardMove, raw: string) {
  if (raw === 'attack') delete move.position
  else move.position = raw as BattlePosition
}

const toneStyle = (id: string) => {
  const tone = ht.map[id]?.tone || '#9ea7b3'
  return { color: tone, borderColor: `${tone}55`, background: `${tone}14` }
}
</script>

<template>
  <div class="move-editor">
    <div v-for="(move, index) in moves" :key="move.id" class="move-editor-row">
      <div class="row wrap" style="gap: 6px; align-items: center">
        <span class="eff-idx">{{ index + 1 }}</span>
        <span
          v-if="move.auto"
          class="flag opt"
          title="由规则自动生成，切换操作 / 区域 / 卡片时会重新计算"
        >规则</span>

        <button
          v-if="!move.unknown"
          class="card-pick"
          :class="{ empty: !move.cardName }"
          @click="picking = move.id"
        >
          <img
            v-if="moveThumb(move)"
            class="move-thumb"
            :src="moveThumb(move)"
            :alt="move.cardName"
            loading="lazy"
          />
          {{ move.cardName || '选择卡片' }}
        </button>
        <span v-else class="card-pick unknown">未知卡片</span>
        <button
          v-if="!move.unknown"
          class="icon-btn"
          :title="manual === move.id ? '收起手动输入' : '手动输入卡名'"
          @click="manual = manual === move.id ? null : move.id"
        >
          ✎
        </button>
        <label class="unknown-toggle" title="抽到 / 丢弃的卡不知道具体是哪张时勾选">
          <input type="checkbox" :checked="move.unknown" @change="toggleUnknown(move)" />
          未知
        </label>
        <label
          v-if="move.to === 'field'"
          class="unknown-toggle"
          title="超量叠放：被叠的旧怪兽送墓、素材由新怪兽继承；叠谁看素材行（旧怪兽 → 超量素材）或该格位上的怪兽，格位是新怪兽的位置"
        >
          <input type="checkbox" :checked="Boolean(move.overlay)" @change="toggleOverlay(move)" />
          叠放
        </label>

        <select v-model="move.from" class="select" style="width: 88px">
          <option v-for="zone in ZONE_ORDER" :key="zone" :value="zone">{{ ZONE_LABELS[zone] }}</option>
        </select>
        <span class="mute">→</span>
        <select v-model="move.to" class="select" style="width: 88px">
          <option v-for="zone in ZONE_ORDER" :key="zone" :value="zone">{{ ZONE_LABELS[zone] }}</option>
        </select>
        <select
          v-if="move.to === 'field' || move.to === 'st' || isMaterialMove(move)"
          class="select"
          style="width: 88px"
          :title="
            isMaterialMove(move)
              ? '素材挂在几号位的怪兽下面（留空 = 本时序主卡所在格位）'
              : move.to === 'field'
                ? '放到怪兽区几号位'
                : '放到魔陷区几号位'
          "
          :value="move.slot || 0"
          @change="setSlot(move, ($event.target as HTMLSelectElement).value)"
        >
          <option :value="0">格位自动</option>
          <option v-for="n in SLOT_COUNT" :key="n" :value="n">{{ n }} 号位</option>
        </select>
        <select
          v-if="move.to === 'field'"
          class="select"
          style="width: 92px"
          title="放到场上时的表示形式"
          :value="move.position || 'attack'"
          @change="setPosition(move, ($event.target as HTMLSelectElement).value)"
        >
          <option v-for="position in POSITIONS" :key="position" :value="position">
            {{ POSITION_LABELS[position] }}
          </option>
        </select>
        <button class="icon-btn" title="删除这一段" @click="remove(move.id)">✕</button>
      </div>

      <input
        v-if="manual === move.id && !move.unknown"
        v-model="move.cardName"
        class="input"
        style="margin-top: 5px"
        placeholder="手动输入卡名 / 占位名"
      />

      <div class="row wrap" style="gap: 6px; align-items: center; margin-top: 5px">
        <input v-model="move.note" class="input" style="flex: 1; min-width: 130px" placeholder="说明（cost / 那之后 / 处理时机）" />
        <template v-if="phase === 'effect'">
          <button class="btn xs ghost" @click="suggest(move)">按规则推荐手坑</button>
          <details class="ht-picker">
            <summary>
              <span v-if="!move.handtraps?.length" class="mute">手坑</span>
              <span v-for="id in move.handtraps" :key="id" class="ht-chip" :style="toneStyle(id)">
                {{ ht.map[id]?.name || id }}
              </span>
            </summary>
            <div class="row wrap" style="gap: 5px; margin-top: 6px">
              <button
                v-for="def in ht.defs"
                :key="def.id"
                class="chip clickable"
                :class="{ on: move.handtraps?.includes(def.id) }"
                :style="move.handtraps?.includes(def.id) ? toneStyle(def.id) : undefined"
                @click="toggle(move, def.id)"
              >
                {{ def.name }}
              </button>
            </div>
          </details>
        </template>
        <span v-else class="inline-note">
          {{ phase === 'cost' ? 'cost 必定成功，不吃手坑' : '规则处理：必定发生，不吃手坑' }}
        </span>
      </div>
    </div>

    <div v-if="!moves.length" class="inline-note">
      {{
        phase === 'cost'
          ? '没有 cost。需要丢弃 / 解放 / 送墓作为 cost 时在这里记录。'
          : phase === 'auto'
            ? '没有规则处理段。'
            : '没有效果段。效果产生的取牌、堆墓、特召都记在这里。'
      }}
    </div>
    <button class="btn xs ghost" style="margin-top: 6px" @click="add">
      ＋ {{ phase === 'cost' ? 'cost 段' : phase === 'auto' ? '处理段' : '效果段' }}
    </button>

    <CardPicker v-if="picking" title="选择这一段涉及的卡片" @close="picking = null" @pick="pick" />
  </div>
</template>
