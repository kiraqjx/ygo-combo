<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import type {
  CardMove,
  PlaybackFrame,
  Timing,
  TimingState,
  ZoneCard,
  ZoneId,
  ZoneSnapshot,
} from '@/types'
import { OPERATION_DEFS, ZONE_LABELS } from '@/types'
import type { BoardFramePaint, CardKind } from '@/lib/boardCanvas'
import { downloadBlob, renderBoardGif } from '@/lib/exportGif'
import { cardImageProxyUrl } from '@/lib/cardDb'
import { useCardStore } from '@/stores/cards'
import DuelBoard from './DuelBoard.vue'

const props = defineProps<{
  timings: Timing[]
  states: TimingState[]
  /** 逐动作帧，优先使用；缺省时退化成「发动后 / 结算后」两帧 */
  frames?: PlaybackFrame[]
  name?: string
}>()

const emit = defineEmits<{ close: [] }>()

const STEP_MS = 900
const SPEEDS = [0.5, 1, 2]
const ZONES: ZoneId[] = ['hand', 'field', 'st', 'gy', 'banish', 'extra', 'deck']

/** 游标：0 = 开局，i + 1 = 第 i 帧之后的画面 */
const index = ref(0)
const playing = ref(false)
const speed = ref(1)
let timer: number | null = null

const frames = computed<PlaybackFrame[]>(() => {
  if (props.frames?.length) return props.frames
  return props.states.flatMap((state, i) => [
    {
      id: `${state.timingId}:activated`,
      timingId: state.timingId,
      timingIndex: i,
      phase: 'chainResolve' as const,
      label: '发动后',
      moves: [],
      snapshot: state.activated,
    },
    {
      id: `${state.timingId}:after`,
      timingId: state.timingId,
      timingIndex: i,
      phase: 'settle' as const,
      label: '结算后',
      moves: [],
      snapshot: state.after,
    },
  ])
})

const total = computed(() => frames.value.length + 1)
const frame = computed(() => (index.value <= 0 ? undefined : frames.value[index.value - 1]))
const timingIndex = computed(() => frame.value?.timingIndex ?? 0)
const timing = computed(() => props.timings[timingIndex.value])

/** 每个时序在游标上的三段位置：发动前 / 发动后 / 结算后 */
interface Range {
  start: number
  activated: number
  end: number
}

const ranges = computed<(Range | undefined)[]>(() => {
  const out: (Range | undefined)[] = []
  frames.value.forEach((item, i) => {
    const at = i + 1
    const slot = out[item.timingIndex] || { start: at, activated: at, end: at }
    slot.end = at
    // 发动后 = 效果全部处理完、送墓之前的最后一帧
    if (item.phase !== 'settle') slot.activated = at
    out[item.timingIndex] = slot
  })
  return out
})

const rangeOf = (i: number) => ranges.value[i]
const currentRange = computed(() => ranges.value[timingIndex.value])

const snapshot = computed(() => {
  if (index.value <= 0) return props.states[0]?.before || null
  return frame.value?.snapshot || null
})

/** 上一个画面，用来判断这一帧哪些区域变了 */
const previousSnapshot = computed(() => {
  if (index.value <= 0) return null
  if (index.value === 1) return props.states[0]?.before || null
  return frames.value[index.value - 2]?.snapshot || null
})

function labelOf(item?: Timing) {
  if (!item) return ''
  const def = OPERATION_DEFS.find((entry) => entry.id === item.operation)
  const head = item.label || `${def?.label || ''} ${item.cardName}`.trim()
  return head || '未命名时序'
}

const zoneKey = (cards: ZoneCard[]) =>
  cards
    .map((card) => `${card.name}x${card.count}`)
    .sort()
    .join('|')

function diffZones(prev?: ZoneSnapshot | null, next?: ZoneSnapshot | null): ZoneId[] {
  if (!prev || !next) return []
  return ZONES.filter((zone) => zoneKey(next[zone] || []) !== zoneKey(prev[zone] || []))
}

/** 与上一个画面相比发生变化的区域，用来做高亮 */
const changedZones = computed<ZoneId[]>(() => diffZones(previousSnapshot.value, snapshot.value))

/** 连锁帧：在对应卡片上打 C2 / C3 角标 */
function chainBadgesOf(snap: ZoneSnapshot, chains?: { link: number; name: string }[]) {
  if (!chains?.length) return []
  const order: ZoneId[] = ['st', 'field', 'hand', 'gy', 'banish', 'extra', 'deck']
  const zoneOf = (name: string): ZoneId | null =>
    order.find((zone) => (snap[zone] || []).some((card) => card.name === name)) || null

  return chains.map((chain) => ({
    name: chain.name,
    label: `C${chain.link}`,
    zone: zoneOf(chain.name),
  }))
}

const chainBadges = computed(() =>
  frame.value ? chainBadgesOf(frame.value.snapshot, frame.value.chains) : [],
)

/** 本帧的卡片移动，如「灰流丽 · 手卡 → 墓地」，同帧多段用「＋」并列 */
function movesText(moves?: CardMove[]): string {
  if (!moves?.length) return ''
  return moves
    .map((move) => {
      const count = move.count && move.count > 1 ? ` ×${move.count}` : ''
      return `「${move.cardName}」${count} ${ZONE_LABELS[move.from]} → ${ZONE_LABELS[move.to]}`
    })
    .join(' ＋ ')
}

/* ------------------------------------------------------------------ */
/* 导出 GIF                                                             */
/* ------------------------------------------------------------------ */

const store = useCardStore()
const exportOpen = ref(false)
const exporting = ref(false)
const progress = ref(0)
const exportScope = ref<'all' | 'timing'>('all')
const exportWidth = ref(480)
const exportHold = ref(800)
let canceled = false

/** 卡片配色按卡种来；查不到就用中性色 */
function kindOf(name: string): CardKind {
  const frame = store.getCardByName(name)?.frame
  return frame === 'monster' || frame === 'spell' || frame === 'trap' ? frame : 'other'
}

/** 同源卡图地址（取不到就退回文字卡牌） */
function imageUrlOf(name: string): string | null {
  const card = store.getCardByName(name)
  return card ? cardImageProxyUrl(card.id) : null
}

function buildExportFrames(scope: 'all' | 'timing'): BoardFramePaint[] {
  const out: BoardFramePaint[] = []
  const opener = props.states[0]?.before

  if (scope === 'all' && opener) {
    out.push({
      snapshot: opener,
      title: '开局场面',
      subtitle: `共 ${props.timings.length} 个时序`,
      kindOf,
    })
  }

  frames.value.forEach((item, i) => {
    if (scope === 'timing' && item.timingIndex !== timingIndex.value) return
    const prev = i === 0 ? opener : frames.value[i - 1]?.snapshot
    out.push({
      snapshot: item.snapshot,
      title: `第 ${item.timingIndex + 1} / ${props.timings.length} 时序 · ${item.label}`,
      subtitle: movesText(item.moves),
      highlight: diffZones(prev, item.snapshot),
      kindOf,
      badges: chainBadgesOf(item.snapshot, item.chains),
    })
  })

  return out
}

function toggleExport() {
  stop()
  exportOpen.value = !exportOpen.value
}

async function runExport(scope: 'all' | 'timing') {
  if (exporting.value) return
  exportOpen.value = false
  exporting.value = true
  progress.value = 0
  canceled = false

  try {
    const list = buildExportFrames(scope)
    const blob = await renderBoardGif(list, {
      width: exportWidth.value,
      holdMs: exportHold.value,
      onProgress: (value) => (progress.value = value),
      shouldCancel: () => canceled,
      imageUrlOf,
    })
    if (blob) {
      const safeName = (props.name || 'combo').replace(/[\\/:*?"<>|]/g, '_')
      downloadBlob(blob, `${safeName}.gif`)
    }
  } catch (error) {
    console.error(error)
  } finally {
    exporting.value = false
  }
}

function clearTimer() {
  if (timer !== null) {
    window.clearTimeout(timer)
    timer = null
  }
}

function stop() {
  playing.value = false
  clearTimer()
}

function schedule() {
  clearTimer()
  timer = window.setTimeout(() => {
    timer = null
    if (!playing.value) return
    if (index.value >= total.value - 1) {
      stop()
      return
    }
    index.value += 1
    schedule()
  }, STEP_MS / speed.value)
}

function play() {
  if (playing.value) {
    stop()
    return
  }
  if (index.value >= total.value - 1) index.value = 0
  playing.value = true
  schedule()
}

function cycleSpeed() {
  const at = SPEEDS.indexOf(speed.value)
  speed.value = SPEEDS[(at + 1) % SPEEDS.length]
  if (playing.value) schedule()
}

function jump(target: number) {
  stop()
  index.value = Math.max(0, Math.min(total.value - 1, target))
}

function jumpTiming(i: number) {
  const range = ranges.value[i]
  jump(range ? range.start : 0)
}

function step(delta: number) {
  jump(index.value + delta)
}

function reset() {
  stop()
  index.value = 0
}

onBeforeUnmount(stop)
</script>

<template>
  <div class="overlay center" @click.self="emit('close')">
    <div class="modal duel-playback-modal">
      <div class="modal-head">
        <div>
          <div class="duel-modal-title">动态演示{{ name ? ` · ${name}` : '' }}</div>
          <div class="inline-note">
            <template v-if="index === 0">
              开局场面 · 共 {{ frames.length }} 个动作 / {{ timings.length }} 个时序
            </template>
            <template v-else>
              第 {{ timingIndex + 1 }} / {{ timings.length }} 时序 · {{ frame?.label }}
              <span v-if="frame?.moves.length" class="playback-move">{{ movesText(frame.moves) }}</span>
            </template>
          </div>
        </div>
        <button class="icon-btn" aria-label="关闭" @click="emit('close')">✕</button>
      </div>

      <div class="modal-body">
        <div class="playback-steps">
          <button
            class="playback-step"
            :class="{ on: index === 0, done: index > 0 }"
            title="开局场面"
            @click="jump(0)"
          >
            始
          </button>
          <button
            v-for="(item, i) in timings"
            :key="item.id"
            class="playback-step"
            :class="{
              on: rangeOf(i) && index >= rangeOf(i)!.start && index <= rangeOf(i)!.end,
              done: rangeOf(i) && index > rangeOf(i)!.end,
            }"
            :title="labelOf(item)"
            @click="jumpTiming(i)"
          >
            {{ i + 1 }}
          </button>
        </div>

        <div v-if="index > 0 && currentRange" class="playback-stages">
          <button
            class="playback-stage"
            :class="{ on: index === currentRange.start - 1 }"
            title="本时序开始前的场面"
            @click="jump(currentRange.start - 1)"
          >
            发动前
          </button>
          <button
            class="playback-stage"
            :class="{ on: index === currentRange.activated }"
            title="效果已处理完、尚未送墓"
            @click="jump(currentRange.activated)"
          >
            发动后
          </button>
          <button
            class="playback-stage"
            :class="{ on: index === currentRange.end }"
            title="本时序结算完的场面"
            @click="jump(currentRange.end)"
          >
            结算后
          </button>
        </div>

        <DuelBoard
          v-if="snapshot"
          :snapshot="snapshot"
          :highlight="changedZones"
          :badges="chainBadges"
        />
        <div v-else class="inline-note">还没有时序，先配置一条 combo。</div>

        <div v-if="exportOpen" class="playback-export">
          <div class="playback-export-row">
            <span class="playback-export-label">范围</span>
            <button
              class="playback-stage"
              :class="{ on: exportScope === 'all' }"
              @click="exportScope = 'all'"
            >
              整个 combo
            </button>
            <button
              class="playback-stage"
              :class="{ on: exportScope === 'timing' }"
              :disabled="index <= 0"
              @click="exportScope = 'timing'"
            >
              当前时序
            </button>
          </div>
          <div class="playback-export-row">
            <span class="playback-export-label">宽度</span>
            <button class="playback-stage" :class="{ on: exportWidth === 480 }" @click="exportWidth = 480">
              480
            </button>
            <button class="playback-stage" :class="{ on: exportWidth === 640 }" @click="exportWidth = 640">
              640
            </button>
            <span class="playback-export-label">停留</span>
            <button class="playback-stage" :class="{ on: exportHold === 600 }" @click="exportHold = 600">
              0.6s
            </button>
            <button class="playback-stage" :class="{ on: exportHold === 1000 }" @click="exportHold = 1000">
              1s
            </button>
          </div>
          <div class="playback-export-row">
            <button class="btn primary sm" @click="runExport(exportScope)">开始导出</button>
            <button class="btn ghost sm" @click="exportOpen = false">取消</button>
            <span class="inline-note">卡图取不到时会退回文字卡牌</span>
          </div>
        </div>

        <div v-if="exporting" class="playback-export-row">
          <span class="inline-note">正在生成 GIF… {{ progress }}%</span>
          <span class="grow" />
          <button class="btn ghost sm" @click="canceled = true">取消</button>
        </div>
      </div>

      <div class="modal-foot">
        <button class="btn ghost sm" @click="reset">重置</button>
        <button class="btn ghost sm" :disabled="index <= 0" @click="step(-1)">上一步</button>
        <button class="btn primary sm" :disabled="total <= 1" @click="play">
          {{ playing ? '暂停' : '播放' }}
        </button>
        <button class="btn ghost sm" :disabled="index >= total - 1" @click="step(1)">下一步</button>
        <button class="btn ghost sm" title="播放速度" @click="cycleSpeed">{{ speed }}x</button>
        <span class="grow" />
        <button class="btn ghost sm" :disabled="exporting || total <= 1" @click="toggleExport">
          导出 GIF
        </button>
        <button class="btn ghost" @click="emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>
