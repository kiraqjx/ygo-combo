<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { CardData, CardMove, ChainEntry, OperationKind, ZoneId } from '@/types'
import { ZONE_LABELS, ZONE_ORDER } from '@/types'
import { autoRuleMoves, reuseAutoIds, uid } from '@/lib/infer'
import { useCardStore } from '@/stores/cards'
import CardPicker from './CardPicker.vue'
import MoveRows from './MoveRows.vue'

const props = defineProps<{
  chain: ChainEntry | null
  link: number
  hostName: string
}>()

const emit = defineEmits<{
  close: []
  save: [chain: ChainEntry]
  remove: [id: string]
}>()

const store = useCardStore()
const showPicker = ref(false)
const zones: ZoneId[] = ZONE_ORDER
const hints = ref<string[]>([])

/** 兼容旧数据：补齐 setup / settle */
function normalizeChain(raw: ChainEntry): ChainEntry {
  return {
    ...raw,
    setup: [...(raw.setup || [])],
    cost: [...(raw.cost || [])],
    effect: [...(raw.effect || [])],
    settle: [...(raw.settle || [])],
  }
}

const draft = ref<ChainEntry>(
  props.chain
    ? normalizeChain(JSON.parse(JSON.stringify(props.chain)))
    : {
        id: uid(),
        link: props.link,
        cardName: '',
        from: 'hand',
        negates: false,
        setup: [],
        cost: [],
        effect: [],
        settle: [],
        note: '',
      },
)

const card = computed(
  () => store.getCard(draft.value.cardId) || store.getCardByName(draft.value.cardName),
)
const isAutoMove = (move: CardMove) => move.auto === true || move.phase === 'auto'
const isAutoOnly = (moves: CardMove[]) => moves.every(isAutoMove)
const keepManual = (moves: CardMove[]) => moves.filter((move) => !isAutoMove(move))

/**
 * 连锁里的卡片按发动区域区分：
 * - 手卡 / 卡组发动（速攻魔法、手卡陷阱）：等同「发动卡片」，会先进入魔陷区
 * - 魔陷区 / 墓地 / 场上发动：等同「发动卡片效果」，只有结算后去向
 */
const ruleOperation = computed<OperationKind>(() =>
  draft.value.from === 'hand' || draft.value.from === 'deck' ? 'activate' : 'activateEffect',
)

/** 选好卡片后才显示规则处理段（怪兽效果不会生成任何内容） */
const showAuto = computed(
  () =>
    Boolean(draft.value.cardName.trim()) || draft.value.setup.length > 0 || draft.value.settle.length > 0,
)

function regenerateAuto(showHints = true) {
  if (!draft.value.cardName.trim()) return
  const rules = autoRuleMoves({
    operation: ruleOperation.value,
    card: card.value,
    cardName: draft.value.cardName.trim(),
    from: draft.value.from,
  })
  draft.value.setup = reuseAutoIds([...rules.setup, ...keepManual(draft.value.setup)], draft.value.setup)
  draft.value.settle = reuseAutoIds(
    [...rules.settle, ...keepManual(draft.value.settle)],
    draft.value.settle,
  )
  if (!showHints) return

  const messages: string[] = []
  if (rules.setup.length) messages.push('发动时置入魔陷区')
  if (rules.settle.length) {
    messages.push(rules.settle[0].to === 'extra' ? '结算后加入额外卡组' : '结算后送去墓地')
  }
  if (!messages.length) {
    messages.push(
      card.value?.frame === 'monster'
        ? '怪兽效果发动不产生规则移动'
        : '结算后留场，或本卡不涉及魔陷区规则处理',
    )
  }
  hints.value = messages
}

function pick(target: CardData) {
  draft.value.cardName = target.name
  draft.value.cardId = target.id
  showPicker.value = false
  regenerateAuto()
}

watch(
  () => draft.value.from,
  () => {
    if (isAutoOnly(draft.value.setup) && isAutoOnly(draft.value.settle)) regenerateAuto()
  },
)

function save() {
  if (!draft.value.cardName.trim()) return
  emit('save', JSON.parse(JSON.stringify(draft.value)))
  emit('close')
}
</script>

<template>
  <div class="overlay center" @click.self="emit('close')">
    <div class="modal chain-modal">
      <div class="modal-head">
        <div>
          <div class="row" style="gap: 7px; font-size: 14px; font-weight: 600">
            <span>{{ chain ? '编辑连锁' : '追加连锁' }}</span>
            <span class="chain-badge">C{{ draft.link }}</span>
          </div>
          <div class="inline-note">
            接在「{{ hostName || '本时序' }}」的 C1 之后；连锁只能是卡片效果
          </div>
        </div>
        <button class="icon-btn" aria-label="关闭" @click="emit('close')">✕</button>
      </div>

      <div class="modal-body">
        <div class="row wrap" style="gap: 10px; align-items: center">
          <button class="card-pick" :class="{ empty: !draft.cardName }" @click="showPicker = true">
            {{ draft.cardName || '选择连锁卡片' }}
          </button>
          <select v-model="draft.from" class="select" style="width: 104px" title="发动区域">
            <option v-for="zone in zones" :key="zone" :value="zone">{{ ZONE_LABELS[zone] }}</option>
          </select>
          <span class="op-chip effect">卡片效果</span>
          <label class="row" style="gap: 5px; font-size: 12px">
            <input v-model="draft.negates" type="checkbox" style="accent-color: #e7c17a" />
            无效前段
          </label>
        </div>

        <div v-if="hints.length" class="row wrap" style="gap: 5px; margin-top: 8px">
          <span v-for="hint in hints" :key="hint" class="chip violet">{{ hint }}</span>
        </div>

        <div class="divider" />

        <template v-if="showAuto">
          <div class="row" style="align-items: center; gap: 8px; margin-bottom: 6px">
            <div class="label" style="margin: 0">规则处理 · 发动置入（必定发生）</div>
            <span class="grow" />
            <button class="btn xs ghost" @click="regenerateAuto()">重新生成</button>
          </div>
          <MoveRows v-model="draft.setup" phase="auto" operation="activateEffect" :from="draft.from" />

          <div class="divider" />
        </template>

        <div class="label" style="margin-bottom: 6px">cost（必定成功，不吃手坑）</div>
        <MoveRows v-model="draft.cost" phase="cost" operation="activateEffect" :from="draft.from" />

        <div class="divider" />

        <div class="label" style="margin-bottom: 6px">效果段（按结算顺序）</div>
        <MoveRows v-model="draft.effect" phase="effect" operation="activateEffect" :from="draft.from" />

        <template v-if="showAuto">
          <div class="divider" />

          <div class="label" style="margin-bottom: 6px">规则处理 · 结算后去向（去墓地 / 额外，或留场）</div>
          <MoveRows v-model="draft.settle" phase="auto" operation="activateEffect" :from="draft.from" />
        </template>

        <div class="divider" />

        <div class="field">
          <label>连锁说明</label>
          <input v-model="draft.note" class="input" placeholder="例如：把对方的灰流丽除外" />
        </div>
      </div>

      <div class="modal-foot">
        <button v-if="chain" class="btn danger" @click="emit('remove', draft.id); emit('close')">删除连锁</button>
        <span class="grow" />
        <button class="btn ghost" @click="emit('close')">取消</button>
        <button class="btn primary" :disabled="!draft.cardName.trim()" @click="save">保存连锁</button>
      </div>
    </div>

    <CardPicker v-if="showPicker" title="选择连锁卡片" @close="showPicker = false" @pick="pick" />
  </div>
</template>
