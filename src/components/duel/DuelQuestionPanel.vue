<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  OcgMessageType,
  OcgResponseType,
  SelectBattleCMDAction,
  SelectIdleCMDAction,
  ocgPositionParse,
  type OcgPosition,
  type OcgResponse,
} from 'ocgcore-wasm'
import type { DuelQuestion } from '@/lib/duel/types'
import {
  battleCommands,
  idleCommands,
  isExtraSummon,
  placeOptions,
  selectCandidates,
  selectRange,
  type DuelCommand,
} from '@/lib/duel/interaction'
import { positionLabel, zoneLabel } from '@/lib/duel/labels'
import { cardImageUrl } from '@/lib/cardDb'
import { useCardStore } from '@/stores/cards'

const props = defineProps<{
  question: DuelQuestion
  nameOf: (code: number) => string
  /** 选项问题的文字版（由父组件用 strings / 卡效果文本翻译） */
  optionLabels?: string[]
  /** 已选中的候选下标（卡片选择类） */
  selected: number[]
  /** 已选中的格位下标（放置类） */
  placePicks: number[]
  /** 嵌在棋盘里时横排显示 */
  dock?: boolean
}>()

const emit = defineEmits<{
  (event: 'answer', response: OcgResponse): void
  (event: 'command', command: DuelCommand): void
  (event: 'toggle', index: number): void
  (event: 'pick', pick: number): void
  (event: 'confirm'): void
  (event: 'cancel'): void
  (event: 'togglePlace', index: number): void
  (event: 'confirmPlace'): void
  (event: 'skip'): void
}>()

function name(code: number) {
  return props.nameOf(code) || `#${code}`
}

const cardStore = useCardStore()

/** 盖放排序要区分陷阱 / 速攻魔法，得先查到卡种 */
function lookupCard(code: number) {
  return cardStore.getCard(code)
}

const commands = computed<DuelCommand[]>(() => {
  const question = props.question
  // 额外卡组的特殊召唤不进列表：几十条会把操作条撑高、棋盘被压小，
  // 这些操作改成点额外卡堆里的卡触发（格子提示不受影响）
  if (question.kind === 'idle') return idleCommands(question.message, lookupCard).filter((item) => !isExtraSummon(item))
  if (question.kind === 'battle') return battleCommands(question.message)
  return []
})

/** 被折叠掉的额外卡组特召数量（只用来判断还要不要显示"没有可选操作"） */
const hiddenExtraSummons = computed(() => {
  const question = props.question
  if (question.kind !== 'idle') return 0
  return idleCommands(question.message, lookupCard).filter(isExtraSummon).length
})

/**
 * 「当前操作」最多占两排（一项 46px + 6px 间距），再多就用弹窗看。
 * 全屏下这块高度固定，操作数量变化不会再牵动棋盘大小。
 */
const listRef = ref<HTMLElement | null>(null)
const listOverflow = ref(false)
const moreOpen = ref(false)

function measureList() {
  const element = listRef.value
  listOverflow.value = Boolean(element && element.scrollHeight > element.clientHeight + 1)
}

function pickCommand(command: DuelCommand) {
  moreOpen.value = false
  emit('command', command)
}

watch(
  () => [props.question, commands.value.length] as const,
  async () => {
    moreOpen.value = false
    await nextTick()
    measureList()
  },
  { immediate: true },
)

onMounted(() => window.addEventListener('resize', measureList))
onBeforeUnmount(() => window.removeEventListener('resize', measureList))

const idleFlags = computed(() => {
  const question = props.question
  if (question.kind === 'idle') return { to_bp: question.message.to_bp, to_ep: question.message.to_ep }
  if (question.kind === 'battle') return { to_bp: question.message.to_m2, to_ep: question.message.to_ep }
  return { to_bp: false, to_ep: false }
})

function toNextPhase() {
  const question = props.question
  if (question.kind === 'idle') {
    emit('answer', { type: OcgResponseType.SELECT_IDLECMD, action: SelectIdleCMDAction.TO_BP, index: null })
  } else if (question.kind === 'battle') {
    emit('answer', { type: OcgResponseType.SELECT_BATTLECMD, action: SelectBattleCMDAction.TO_M2, index: null })
  }
}

function endTurn() {
  const question = props.question
  if (question.kind === 'idle') {
    emit('answer', { type: OcgResponseType.SELECT_IDLECMD, action: SelectIdleCMDAction.TO_EP, index: null })
  } else if (question.kind === 'battle') {
    emit('answer', { type: OcgResponseType.SELECT_BATTLECMD, action: SelectBattleCMDAction.TO_EP, index: null })
  }
}

const candidates = computed(() => selectCandidates(props.question))
const range = computed(() => selectRange(props.question))
const places = computed(() => placeOptions(props.question))
const placeCount = computed(() => (props.question.kind === 'place' ? props.question.message.count : 1))

const chainOptions = computed(() => {
  const question = props.question
  if (question.kind !== 'chain') return []
  return question.message.selects.map((card, index) => ({
    index,
    code: card.code,
    label: name(card.code),
    zone: zoneLabel(card.location, card.sequence),
  }))
})

const yesnoCard = computed(() => {
  const question = props.question
  if (question.kind !== 'yesno') return ''
  return question.message.type === OcgMessageType.SELECT_EFFECTYN ? name(question.message.code) : ''
})

function answerYes(yes: boolean) {
  const question = props.question
  if (question.kind !== 'yesno') return
  emit(
    'answer',
    question.message.type === OcgMessageType.SELECT_EFFECTYN
      ? { type: OcgResponseType.SELECT_EFFECTYN, yes }
      : { type: OcgResponseType.SELECT_YESNO, yes },
  )
}

const chainForced = computed(() => (props.question.kind === 'chain' ? props.question.message.forced : false))
const optionCount = computed(() => (props.question.kind === 'option' ? props.question.message.options.length : 0))
const sortCount = computed(() => (props.question.kind === 'sort' ? props.question.message.cards.length : 0))
const unselectCanCancel = computed(() =>
  props.question.kind === 'unselect' ? props.question.message.can_cancel || props.question.message.can_finish : false,
)

const sortCards = computed(() => (props.question.kind === 'sort' ? props.question.message.cards : []))

/**
 * 选 / 取消 型提问：`select_cards` 是还没选的，`unselect_cards` 是已经选上的。
 * 两组分开渲染，否则用户分不清点哪张是"再选一张"、点哪张是"取消"。
 */
const unselectOpen = computed(() => {
  const question = props.question
  if (question.kind !== 'unselect') return []
  return question.message.select_cards.map((card, index) => ({ pick: index, card }))
})

const unselectChosen = computed(() => {
  const question = props.question
  if (question.kind !== 'unselect') return []
  const base = question.message.select_cards.length
  return question.message.unselect_cards.map((card, offset) => ({ pick: base + offset, card, rank: offset + 1 }))
})

/** 已选张数：内核把选中的卡挪到 unselect_cards，别拿 selected 数 */
const unselectCount = computed(() => {
  const question = props.question
  return question.kind === 'unselect' ? question.message.unselect_cards.length : 0
})

/** 排序类的点击顺序：先点的是第 1 张，依次往后 */
const sortPicks = ref<number[]>([])

watch(
  () => props.question,
  () => {
    sortPicks.value = []
  },
)

function sortRank(index: number): number {
  return sortPicks.value.indexOf(index) + 1
}

function submitSort(order: number[]) {
  emit('answer', { type: OcgResponseType.SORT_CARD, order })
}

/** 点卡片依次决定顺序，排满就自动提交 */
function toggleSort(index: number) {
  const list = sortPicks.value
  if (list.includes(index)) {
    sortPicks.value = list.filter((item) => item !== index)
    return
  }
  const next = [...list, index]
  sortPicks.value = next
  if (sortCount.value > 0 && next.length === sortCount.value) submitSort(next)
}

/** 完全不调整，保持内核给的顺序（也就是点「保持原顺序」） */
function confirmSort() {
  submitSort(sortCards.value.map((_, index) => index))
}

const positionOptions = computed<OcgPosition[]>(() => {
  if (props.question.kind !== 'position') return []
  return ocgPositionParse(props.question.message.positions)
})

/** 动作类型对应的配色，扫一眼就知道是召唤还是发动 */
const ACTION_TONE: Record<string, string> = {
  召唤: 'summon',
  特殊召唤: 'special',
  盖放: 'set',
  发动: 'activate',
  变更表示: 'pose',
}

function toneOf(label: string): string {
  return ACTION_TONE[label] ?? 'plain'
}

/** 卡片选择 / 放置类的进度，固定在标题右侧，不用去数已选了几张 */
const counterText = computed(() => {
  const question = props.question
  if (question.kind === 'place') return `已选 ${props.placePicks.length}/${placeCount.value}`
  if (question.kind === 'sort') return `已排 ${sortPicks.value.length}/${sortCount.value}`
  if (question.kind === 'unselect') {
    const max = range.value.max > 0 ? range.value.max : range.value.min
    return `已选 ${unselectCount.value}/${max}`
  }
  if (question.kind === 'card' || question.kind === 'tribute' || question.kind === 'sum') {
    const max = range.value.max > 0 ? range.value.max : range.value.min
    return `已选 ${props.selected.length}/${max}`
  }
  return ''
})

const canConfirm = computed(() => {
  const question = props.question
  if (question.kind === 'place') return props.placePicks.length === placeCount.value
  // 仪式 / 融合这类素材选择要凑够总和，选不够时别让玩家提交（否则内核只会 RETRY）
  if (question.kind === 'sum') {
    if (!props.selected.length) return false
    const total = candidates.value.reduce(
      (sum, item) => (props.selected.includes(item.index) ? sum + (item.amount ?? 0) : sum),
      0,
    )
    return total >= question.message.amount
  }
  if (question.kind === 'card' || question.kind === 'tribute') {
    return props.selected.length >= range.value.min
  }
  return false
})

/** 固定操作区该出现哪一组按钮；null 表示这一步不需要额外按钮 */
type ActionKind = 'phase' | 'chain' | 'yesno' | 'select' | 'unselect' | 'place' | 'sort' | 'skip'

const actionKind = computed<ActionKind | null>(() => {
  const question = props.question
  switch (question.kind) {
    case 'idle':
    case 'battle':
      return idleFlags.value.to_bp || idleFlags.value.to_ep ? 'phase' : null
    case 'chain':
      return 'chain'
    case 'yesno':
      return 'yesno'
    case 'card':
    case 'tribute':
    case 'sum':
      return 'select'
    case 'unselect':
      return unselectCanCancel.value ? 'unselect' : null
    case 'place':
      return 'place'
    case 'sort':
      return 'sort'
    case 'option':
    case 'position':
      return null
    default:
      return 'skip'
  }
})

const headerText = computed(() => {
  const question = props.question
  switch (question.kind) {
    case 'idle':
      return '主要阶段：点场上的卡或下面的按钮'
    case 'battle':
      return '战斗阶段：点怪兽攻击，或点后场发动'
    case 'chain':
      return '是否连锁发动？'
    case 'yesno':
      return '是否发动 / 确认效果？'
    case 'option':
      return '请选择一项'
    case 'card':
      return `请选择卡片（${range.value.min}-${range.value.max} 张）`
    case 'tribute':
      return `请选择祭品（${range.value.min}-${range.value.max} 张）`
    case 'sum':
      return `请选择卡片（合计 ${question.message.amount}）`
    case 'unselect':
      return '点卡片选中 / 再点取消'
    case 'place':
      return `请选择位置（${placeCount.value} 处）`
    case 'position':
      return '请选择表示形式'
    case 'sort':
      return '点卡片依次安排顺序（先点的是第 1 张）'
    default:
      return '请做出选择'
  }
})

/* ---------------------------------------------------------------- */
/* 键盘：数字键选第 n 项，Enter 确定，Esc 取消，E 结束回合，B 下一阶段 */
/* ---------------------------------------------------------------- */

/** 与模板渲染顺序严格一致，键盘序号才对得上 */
const keyActions = computed<(() => void)[]>(() => {
  const question = props.question
  switch (question.kind) {
    case 'idle':
    case 'battle':
      return commands.value.map((item) => () => emit('command', item))
    case 'chain':
      return chainOptions.value.map((item) => () => emit('answer', { type: OcgResponseType.SELECT_CHAIN, index: item.index }))
    case 'option':
      return Array.from({ length: optionCount.value }, (_, index) => () => emit('answer', { type: OcgResponseType.SELECT_OPTION, index }))
    case 'card':
    case 'tribute':
    case 'sum':
      return candidates.value.map((item) => () => emit('toggle', item.index))
    case 'unselect':
      return candidates.value.map((item) => () => emit('pick', item.pick))
    case 'place':
      return places.value.map((_, index) => () => emit('togglePlace', index))
    case 'position':
      return positionOptions.value.map((position) => () => emit('answer', { type: OcgResponseType.SELECT_POSITION, position }))
    case 'yesno':
      return [() => answerYes(true), () => answerYes(false)]
    case 'sort':
      return sortCards.value.map((_, index) => () => toggleSort(index))
    default:
      return [() => emit('skip')]
  }
})

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element) return false
  return (
    element.tagName === 'INPUT' ||
    element.tagName === 'TEXTAREA' ||
    element.tagName === 'SELECT' ||
    element.isContentEditable
  )
}

/** 返回 true 表示这次按键已被面板消费 */
function handleKey(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false
  if (isTypingTarget(event.target)) return false
  // 弹窗打开时只响应 Esc，别让数字键/回车操作到弹窗背面的列表
  if (moreOpen.value) {
    if (event.key === 'Escape') moreOpen.value = false
    return true
  }
  const question = props.question

  if (/^[1-9]$/.test(event.key)) {
    const action = keyActions.value[Number(event.key) - 1]
    if (!action) return false
    action()
    return true
  }

  if (event.key === 'Enter') {
    if (question.kind === 'yesno') {
      answerYes(true)
      return true
    }
    if (question.kind === 'sort') {
      if (sortCount.value > 0 && sortPicks.value.length === sortCount.value) submitSort(sortPicks.value)
      else confirmSort()
      return true
    }
    if (question.kind === 'place' && canConfirm.value) {
      emit('confirmPlace')
      return true
    }
    // 卡片 / 祭品 / 仪式素材（SELECT_SUM）都走同一条确认路径
    if ((question.kind === 'card' || question.kind === 'tribute' || question.kind === 'sum') && canConfirm.value) {
      emit('confirm')
      return true
    }
    return false
  }

  if (event.key === 'Escape') {
    if (question.kind === 'unselect' && unselectCanCancel.value) {
      emit('cancel')
      return true
    }
    if ((question.kind === 'card' || question.kind === 'tribute') && range.value.cancel) {
      emit('cancel')
      return true
    }
    return false
  }

  const key = event.key.toLowerCase()
  if (key === 'e' && (question.kind === 'idle' || question.kind === 'battle') && idleFlags.value.to_ep) {
    endTurn()
    return true
  }
  if (key === 'b' && (question.kind === 'idle' || question.kind === 'battle') && idleFlags.value.to_bp) {
    toNextPhase()
    return true
  }
  if (key === 'a' && question.kind === 'chain' && !question.message.forced) {
    emit('answer', { type: OcgResponseType.SELECT_CHAIN, index: null })
    return true
  }
  return false
}

defineExpose({ handleKey })
</script>

<template>
  <div class="dq" :class="{ dock }">
    <div class="dq-head">
      <span>{{ headerText }}</span>
      <span v-if="counterText" class="dq-counter">{{ counterText }}</span>
      <span class="dq-keys">
        <kbd>Enter</kbd><kbd>Esc</kbd><kbd>1-9</kbd>
      </span>
    </div>

    <div class="dq-body" :class="{ 'dq-body-list': question.kind === 'idle' || question.kind === 'battle' }">
      <!-- 主要阶段 / 战斗阶段：点卡片就能做，这里的按钮是补充入口 -->
      <template v-if="question.kind === 'idle' || question.kind === 'battle'">
        <div v-if="!commands.length && !hiddenExtraSummons" class="inline-note">场上没有可选操作。</div>
        <!-- 最多两排，多出来的用「查看更多」弹窗看 -->
        <div v-if="commands.length" ref="listRef" class="dq-list">
          <button
            v-for="(item, index) in commands"
            :key="`${item.family}-${item.action}-${item.index}`"
            class="dq-item"
            @click="pickCommand(item)"
          >
            <img class="dq-thumb" :src="cardImageUrl(item.code)" :alt="name(item.code)" />
            <span class="dq-name" :title="name(item.code)">{{ name(item.code) }}</span>
            <span class="dq-tag" :class="toneOf(item.label)">{{ item.label }}</span>
            <span class="dq-zone">{{ zoneLabel(item.location, item.sequence) }}</span>
            <kbd v-if="index < 9" class="dq-key">{{ index + 1 }}</kbd>
          </button>
        </div>
      </template>

      <!-- 连锁 -->
      <template v-else-if="question.kind === 'chain'">
        <div v-if="!chainOptions.length" class="inline-note">
          这一环没有能发动的卡（内核仍然会问一次，可以直接跳过）。
        </div>
        <button
          v-for="item in chainOptions"
          :key="item.index"
          class="dq-item"
          @click="emit('answer', { type: OcgResponseType.SELECT_CHAIN, index: item.index })"
        >
          <img class="dq-thumb" :src="cardImageUrl(item.code)" :alt="item.label" />
          <span class="dq-name">发动｜{{ item.label }}</span>
          <span class="dq-zone">{{ item.zone }}</span>
          <kbd v-if="item.index < 9" class="dq-key">{{ item.index + 1 }}</kbd>
        </button>
      </template>

      <!-- 是 / 否 -->
      <template v-else-if="question.kind === 'yesno'">
        <div v-if="yesnoCard" class="inline-note">{{ yesnoCard }}</div>
      </template>

      <!-- 选项：显示内核给的操作名（strings.conf / 卡效果文本） -->
      <template v-else-if="question.kind === 'option'">
        <button
          v-for="index in optionCount"
          :key="index"
          class="dq-item"
          :title="optionLabels?.[index - 1] || `选项 ${index}`"
          @click="emit('answer', { type: OcgResponseType.SELECT_OPTION, index: index - 1 })"
        >
          <span class="dq-rank">{{ index }}</span>
          <span class="dq-name">{{ optionLabels?.[index - 1] || `选项 ${index}` }}</span>
          <kbd v-if="index <= 9" class="dq-key">{{ index }}</kbd>
        </button>
      </template>

      <!-- 选卡类：优先点场上/手卡的卡，这里列的是兜底（含卡组、除外等点不到的） -->
      <template v-else-if="question.kind === 'card' || question.kind === 'tribute' || question.kind === 'sum'">
        <button
          v-for="item in candidates"
          :key="item.index"
          class="dq-item"
          :class="{ on: selected.includes(item.index) }"
          @click="emit('toggle', item.index)"
        >
          <span class="dq-rank" :class="{ on: selected.includes(item.index) }">
            {{ selected.indexOf(item.index) + 1 || '·' }}
          </span>
          <img class="dq-thumb" :src="cardImageUrl(item.code)" :alt="name(item.code)" />
          <span class="dq-name">{{ name(item.code) }}</span>
          <span class="dq-zone">{{ zoneLabel(item.location, item.sequence) }}<template v-if="item.amount"> · {{ item.amount }}</template></span>
          <kbd v-if="item.index < 9" class="dq-key">{{ item.index + 1 }}</kbd>
        </button>
      </template>

      <!-- 选 / 取消：未选的在上，已选的在下并标出来，避免点回已选卡又变成取消 -->
      <template v-else-if="question.kind === 'unselect'">
        <button
          v-for="(item, index) in unselectOpen"
          :key="`open-${item.pick}`"
          class="dq-item"
          @click="emit('pick', item.pick)"
        >
          <span class="dq-rank">{{ index + 1 }}</span>
          <img class="dq-thumb" :src="cardImageUrl(item.card.code)" :alt="name(item.card.code)" />
          <span class="dq-name">{{ name(item.card.code) }}</span>
          <span class="dq-zone">{{ zoneLabel(item.card.location, item.card.sequence) }}</span>
          <kbd v-if="index < 9" class="dq-key">{{ index + 1 }}</kbd>
        </button>
        <button
          v-for="item in unselectChosen"
          :key="`chosen-${item.pick}`"
          class="dq-item on"
          title="再点一次取消选择"
          @click="emit('pick', item.pick)"
        >
          <span class="dq-rank on">{{ item.rank }}</span>
          <img class="dq-thumb" :src="cardImageUrl(item.card.code)" :alt="name(item.card.code)" />
          <span class="dq-name">{{ name(item.card.code) }}</span>
          <span class="dq-tag pose">已选 · 点击取消</span>
          <span class="dq-zone">{{ zoneLabel(item.card.location, item.card.sequence) }}</span>
          <kbd v-if="unselectOpen.length + item.rank <= 9" class="dq-key">{{ unselectOpen.length + item.rank }}</kbd>
        </button>
        <div v-if="!unselectOpen.length && !unselectChosen.length" class="inline-note">没有可选的卡。</div>
      </template>

      <!-- 位置 -->
      <template v-else-if="question.kind === 'place'">
        <button
          v-for="(place, index) in places"
          :key="index"
          class="dq-item"
          :class="{ on: placePicks.includes(index) }"
          @click="emit('togglePlace', index)"
        >
          <span class="dq-name">{{ place.player === 0 ? '我方' : '对手' }}{{ zoneLabel(place.location, place.sequence) }}</span>
          <kbd v-if="index < 9" class="dq-key">{{ index + 1 }}</kbd>
        </button>
      </template>

      <!-- 表示形式 -->
      <template v-else-if="question.kind === 'position'">
        <button
          v-for="(position, index) in positionOptions"
          :key="position"
          class="btn sm"
          @click="emit('answer', { type: OcgResponseType.SELECT_POSITION, position })"
        >
          {{ positionLabel(position) }}
          <kbd v-if="index < 9" class="dq-key">{{ index + 1 }}</kbd>
        </button>
      </template>

      <!-- 排序：点卡片依次决定顺序，排满自动提交 -->
      <template v-else-if="question.kind === 'sort'">
        <div v-if="!sortCards.length" class="inline-note">没有需要排序的卡，直接确认即可。</div>
        <!-- 只列出内核要求排序的卡：效果可能把部分卡送进了另一方卡组或额外卡组，那部分不在其中 -->
        <div v-else class="inline-note">本次只需排序 {{ sortCount }} 张，其余卡不参与排序。</div>
        <button
          v-for="(card, index) in sortCards"
          :key="`sort-${index}`"
          class="dq-item"
          :class="{ on: sortRank(index) }"
          @click="toggleSort(index)"
        >
          <span class="dq-rank" :class="{ on: sortRank(index) }">{{ sortRank(index) || '·' }}</span>
          <img class="dq-thumb" :src="cardImageUrl(card.code)" :alt="name(card.code)" />
          <span class="dq-name">{{ name(card.code) }}</span>
          <span class="dq-zone">{{ card.controller === 0 ? '我方' : '对手' }}{{ zoneLabel(card.location, card.sequence) }}</span>
        </button>
      </template>

      <!-- 其它（宣言类） -->
      <template v-else>
        <div class="inline-note">这类宣言暂时只能自动作答（取第一个可选项）。</div>
      </template>
    </div>

    <!-- 固定操作区：选项再多也不会被挤到滚动区里 -->
    <div v-if="actionKind || listOverflow" class="dq-actions">
      <button v-if="listOverflow" class="btn sm" @click="moreOpen = true">
        查看更多（{{ commands.length }}）
      </button>
      <template v-if="actionKind === 'phase'">
        <button v-if="idleFlags.to_bp" class="btn sm" @click="toNextPhase">
          {{ question.kind === 'idle' ? '进入战斗阶段' : '进入主要阶段 2' }}
          <kbd class="dq-key">B</kbd>
        </button>
        <button v-if="idleFlags.to_ep" class="btn sm primary" @click="endTurn">
          结束回合
          <kbd class="dq-key">E</kbd>
        </button>
      </template>

      <template v-else-if="actionKind === 'chain'">
        <button
          v-if="!chainForced"
          class="btn sm"
          @click="emit('answer', { type: OcgResponseType.SELECT_CHAIN, index: null })"
        >
          不发动
          <kbd class="dq-key">A</kbd>
        </button>
        <span v-else class="inline-note">必须连锁：从上面选一张发动。</span>
      </template>

      <template v-else-if="actionKind === 'yesno'">
        <button class="btn sm primary" @click="answerYes(true)">是<kbd class="dq-key">Enter</kbd></button>
        <button class="btn sm" @click="answerYes(false)">否<kbd class="dq-key">2</kbd></button>
      </template>

      <template v-else-if="actionKind === 'select'">
        <button class="btn sm primary" :disabled="!canConfirm" @click="emit('confirm')">
          确定<kbd class="dq-key">Enter</kbd>
        </button>
        <button v-if="range.cancel" class="btn sm" @click="emit('cancel')">取消<kbd class="dq-key">Esc</kbd></button>
      </template>

      <template v-else-if="actionKind === 'unselect'">
        <button class="btn sm" @click="emit('cancel')">取消<kbd class="dq-key">Esc</kbd></button>
      </template>

      <template v-else-if="actionKind === 'place'">
        <button class="btn sm primary" :disabled="!canConfirm" @click="emit('confirmPlace')">
          确定<kbd class="dq-key">Enter</kbd>
        </button>
      </template>

      <template v-else-if="actionKind === 'sort'">
        <button class="btn sm" @click="confirmSort()">保持原顺序<kbd class="dq-key">Enter</kbd></button>
      </template>

      <template v-else>
        <button class="btn sm" @click="emit('skip')">自动选择</button>
      </template>
    </div>

    <!-- 操作超过两排：弹窗里看全部，不占场地空间 -->
    <Teleport to="body">
      <div v-if="moreOpen" class="dq-more-overlay" @click.self="moreOpen = false">
        <div class="dq-more">
          <div class="dq-more-head">
            <span class="dq-more-title">全部操作（{{ commands.length }}）</span>
            <button class="btn sm" @click="moreOpen = false">关闭</button>
          </div>
          <div class="dq-more-list">
            <button
              v-for="(item, index) in commands"
              :key="`more-${item.family}-${item.action}-${item.index}`"
              class="dq-item"
              @click="pickCommand(item)"
            >
              <img class="dq-thumb" :src="cardImageUrl(item.code)" :alt="name(item.code)" />
              <span class="dq-name">{{ name(item.code) }}</span>
              <span class="dq-tag" :class="toneOf(item.label)">{{ item.label }}</span>
              <span class="dq-zone">{{ zoneLabel(item.location, item.sequence) }}</span>
              <kbd v-if="index < 9" class="dq-key">{{ index + 1 }}</kbd>
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.dq {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.dq-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--display);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.1em;
  color: var(--gold);
}

.dq-counter {
  padding: 0 7px;
  border-radius: 2px;
  border: 1px solid rgba(217, 185, 106, 0.45);
  background: rgba(217, 185, 106, 0.12);
  color: var(--gold-hi);
  font-size: 11px;
  white-space: nowrap;
}

.dq-keys {
  display: inline-flex;
  gap: 3px;
  margin-left: auto;
  opacity: 0.55;
}

.dq-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  max-height: 40vh;
  overflow: auto;
}

/* 一项 46px（32 卡图 + 12 内边距 + 2 边框），两排 + 一个间距 */
.dq-list {
  display: grid;
  /* 每行固定 4 个方块，列宽均分：方块大小不随卡名长短变化 */
  grid-template-columns: repeat(4, minmax(0, 1fr));
  grid-auto-rows: 46px;
  gap: 6px;
  width: 100%;
  max-height: 98px;
  overflow: hidden;
}

/* grid 里的方块统一撑满列宽，内容超宽自己裁掉，不影响相邻项 */
.dq-list > .dq-item {
  width: 100%;
  min-width: 0;
  overflow: hidden;
  gap: 6px;
  /* 四列并排后每格变窄，右侧只留键盘角标的位置 */
  padding-right: 20px;
}

/* 全屏：始终按两排占位，操作数量变化不再牵动棋盘大小 */
.dq.dock .dq-list {
  min-height: 98px;
}

/* 这块高度自己管，别让父级的滚动条把「查看更多」挤出可视区 */
.dq.dock .dq-body.dq-body-list {
  max-height: none;
  overflow: visible;
}

.dq-more-overlay {
  position: fixed;
  inset: 0;
  z-index: 150;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(6, 4, 2, 0.74);
  backdrop-filter: blur(3px);
}

.dq-more {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(880px, 92vw);
  max-height: 80vh;
  padding: 14px;
  border: 1px solid rgba(217, 185, 106, 0.32);
  border-radius: 3px;
  background: linear-gradient(180deg, rgba(34, 27, 19, 0.98), rgba(15, 12, 8, 0.99));
  box-shadow:
    inset 0 0 0 1px rgba(0, 0, 0, 0.5),
    0 24px 60px -30px #000;
}

.dq-more-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.dq-more-title {
  color: var(--gold);
  font-size: 12px;
  font-weight: 600;
}

.dq-more-list {
  display: flex;
  flex-wrap: wrap;
  align-content: flex-start;
  gap: 6px;
  overflow-y: auto;
}

.dq-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

/* 嵌在棋盘底部：标题 / 选项 / 操作区三列，操作区永远在右端 */
.dq.dock {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
}

.dq.dock .dq-head {
  flex-wrap: wrap;
  max-width: 30vw;
  padding: 2px 10px;
  border-radius: 10px;
  border: 1px solid rgba(255, 196, 87, 0.4);
  background: rgba(255, 196, 87, 0.12);
}

.dq.dock .dq-keys {
  opacity: 0.45;
}

.dq.dock .dq-body {
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  /* 全屏时整块场地要一屏放下，选项区不能无限长高，超出就在条内滚动 */
  max-height: 15vh;
  overflow-y: auto;
}

.dq.dock .dq-item {
  flex: 0 1 auto;
}

.dq.dock .dq-actions {
  flex-wrap: nowrap;
  justify-content: flex-end;
}

@media (max-width: 900px) {
  .dq.dock {
    grid-template-columns: 1fr;
  }

  .dq.dock .dq-head {
    max-width: none;
  }

  .dq.dock .dq-actions {
    justify-content: flex-start;
  }

  .dq.dock .dq-keys {
    display: inline-flex;
  }
}

.dq-item {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  /* 右侧给键盘角标留位，角标不参与布局 */
  padding: 6px 24px 6px 10px;
  border-radius: 9px;
  border: 1px solid var(--line);
  background: rgba(232, 224, 208, 0.04);
  color: var(--text);
  font-size: 12px;
  cursor: pointer;
  text-align: left;
}

.dq-thumb {
  width: 22px;
  height: 32px;
  object-fit: cover;
  border-radius: 2px;
  flex: none;
}

/* 排序模式下的序号徽标：点一下变成 1、2、3… */
.dq-rank {
  flex: none;
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  border-radius: 5px;
  border: 1px solid var(--line);
  background: rgba(1, 4, 9, 0.6);
  color: var(--text-mute);
  font-family: var(--mono);
  font-size: 10px;
}

.dq-rank.on {
  border-color: var(--gold-deep);
  background: rgba(217, 185, 106, 0.3);
  color: var(--gold);
  font-weight: 600;
}

.dq-item:hover {
  border-color: rgba(217, 185, 106, 0.45);
  background: rgba(217, 185, 106, 0.1);
}

.dq-item.on {
  border-color: var(--gold);
  background: rgba(217, 185, 106, 0.26);
  box-shadow: 0 0 0 1px rgba(255, 196, 87, 0.5), inset 3px 0 0 var(--gold);
}

.dq-name {
  font-weight: 550;
  /* 选项名可能是一整句效果分条，别把操作条撑爆（完整文本在 title 里） */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: min(46vw, 420px);
}

/* 「当前操作」方块里的卡名：只留 4 个汉字（英文 8 个字符），超出省略 */
.dq-list > .dq-item .dq-name {
  flex: 1 1 auto;
  min-width: 0;
  max-width: 8ch;
}

/* 标签与区域不参与压缩，卡名先用剩余空间 */
.dq-list > .dq-item .dq-tag,
.dq-list > .dq-item .dq-zone {
  flex: none;
}

.dq-tag {
  padding: 0 6px;
  border-radius: 5px;
  font-size: 10px;
  font-weight: 600;
  white-space: nowrap;
}

.dq-tag.summon {
  color: #8dffb0;
  background: rgba(113, 255, 176, 0.16);
}

.dq-tag.special {
  color: #f4e6c3;
  background: rgba(217, 185, 106, 0.2);
}

.dq-tag.set {
  color: #f4e6c3;
  background: rgba(217, 185, 106, 0.18);
}

.dq-tag.activate {
  color: var(--gold);
  background: rgba(255, 196, 87, 0.18);
}

.dq-tag.pose {
  color: var(--text-mute);
  background: rgba(122, 130, 142, 0.18);
}

.dq-tag.plain {
  color: var(--text-dim);
  background: rgba(122, 130, 142, 0.14);
}

.dq-zone {
  margin-left: auto;
  color: var(--text-mute);
  font-size: 11px;
  white-space: nowrap;
}

.dq-key {
  padding: 0 4px;
  border-radius: 3px;
  border: 1px solid var(--line);
  background: rgba(1, 4, 9, 0.6);
  color: var(--text-mute);
  font-family: var(--mono);
  font-size: 10px;
  line-height: 1.5;
}

/* 操作项上的键盘序号：钉在右端的小角标，卡名再长也不会把它挤出去 */
.dq-item > .dq-key {
  position: absolute;
  top: 50%;
  right: 5px;
  transform: translateY(-50%);
  min-width: 15px;
  padding: 0 3px;
  border-radius: 8px;
  border-color: rgba(255, 196, 87, 0.45);
  background: rgba(1, 4, 9, 0.92);
  color: var(--gold);
  font-size: 10px;
  font-weight: 600;
  line-height: 15px;
  text-align: center;
}
</style>
