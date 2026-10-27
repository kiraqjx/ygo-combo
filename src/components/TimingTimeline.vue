<script setup lang="ts">
import { computed, ref } from 'vue'
import type {
  CardMove,
  ChainEntry,
  Timing,
  TimelineAnalysis,
  TimingState,
  ZoneId,
  ZoneSnapshot,
} from '@/types'
import { UNKNOWN_CARD, ZONE_LABELS } from '@/types'
import { useCardStore } from '@/stores/cards'
import { useHandtrapStore } from '@/stores/handtraps'
import DuelField from './DuelField.vue'
import { cardImageUrl } from '@/lib/cardDb'
import {
  chainSummary,
  handtrapName,
  operationLabel,
  operationTone,
  timingTitle,
  zoneSummary,
} from '@/lib/timeline'

const props = defineProps<{
  timings: Timing[]
  analysis: TimelineAnalysis
  selectedId?: string | null
}>()

const emit = defineEmits<{
  select: [id: string]
  add: [afterId: string | null]
  edit: [timing: Timing]
  remove: [id: string]
  move: [id: string, dir: -1 | 1]
  duplicate: [id: string]
  addChain: [timing: Timing]
  editChain: [timing: Timing, chain: ChainEntry]
  removeChain: [timingId: string, chainId: string]
}>()

const stateIndex = ref<number | null>(null)
/** 场面弹窗看的是发动前，还是发动后（cost 已付、效果未处理） */
const stateStage = ref<'before' | 'activated'>('before')

function openState(index: number, stage: 'before' | 'activated') {
  stateStage.value = stage
  stateIndex.value = index
}

const stateOf = (index: number): TimingState | undefined => props.analysis.states[index]

const cardStore = useCardStore()
const ht = useHandtrapStore()

const startState = computed(() => props.analysis.states[0]?.before)

const statusText: Record<string, string> = {
  ok: '正常',
  partial: '部分失效',
  negated: '被无效',
  broken: '断链',
}

/** 状态面板只展示这四个区域的手牌信息，不展示卡组 */
const VIEW_ZONES: ZoneId[] = ['hand', 'field', 'st', 'gy', 'banish']

const thumbOf = (timing: Timing) => {
  const id = timing.cardId || cardStore.getCardByName(timing.cardName)?.id
  return id ? cardImageUrl(id) : ''
}

/** 连锁也要有卡图：优先 cardId，老数据按卡名回查 */
const chainThumb = (chain: ChainEntry) => {
  const id = chain.cardId || cardStore.getCardByName(chain.cardName)?.id
  return id ? cardImageUrl(id) : ''
}
const toneStyle = (id: string) => {
  const tone = ht.map[id]?.tone || '#9ea7b3'
  return { color: tone, borderColor: `${tone}55`, background: `${tone}14` }
}

const moveText = (move: CardMove) => {
  const count = move.count && move.count > 1 ? ` ×${move.count}` : ''
  const name = move.unknown ? `${UNKNOWN_CARD}${count}` : move.cardName || '—'
  return `${name} ${ZONE_LABELS[move.from]} → ${ZONE_LABELS[move.to]}`
}

/** 每一段移动涉及的卡也带上卡图 */
const moveThumb = (move: CardMove) => {
  if (!move.cardName || move.unknown) return ''
  const id = cardStore.getCardByName(move.cardName)?.id
  return id ? cardImageUrl(id) : ''
}

const zoneCards = (snap: ZoneSnapshot | undefined, zone: ZoneId) => snap?.[zone] || []
const zoneCount = (snap: ZoneSnapshot | undefined, zone: ZoneId) =>
  zoneCards(snap, zone).reduce((total, card) => total + card.count, 0)

const inspecting = computed(() => (stateIndex.value === null ? null : props.timings[stateIndex.value]))
const inspectingState = computed(() =>
  stateIndex.value === null ? undefined : props.analysis.states[stateIndex.value],
)
</script>

<template>
  <div class="flow">
    <!-- 起手 -->
    <div v-if="startState" class="flow-start">
      <div class="flow-start-label">起手</div>
      <div class="flow-start-hand">
        <span v-if="!startState.hand.length" class="mute" style="font-size: 10.5px">未录入起手</span>
        <span v-for="card in startState.hand" :key="card.name" class="zone-card">
          {{ card.name }}<template v-if="card.count > 1"> ×{{ card.count }}</template>
        </span>
      </div>
      <div class="inline-note" style="font-size: 10px">{{ zoneSummary(startState) }}</div>
    </div>

    <template v-for="(timing, index) in timings" :key="timing.id">
      <div class="flow-arrow">›</div>

      <div
        class="flow-card timing"
        :class="[
          stateOf(index)?.status || 'ok',
          { selected: selectedId === timing.id },
        ]"
        @click="emit('select', timing.id)"
      >
        <div class="timing-head">
          <span class="timing-idx">{{ index + 1 }}</span>
          <img v-if="thumbOf(timing)" class="timing-thumb" :src="thumbOf(timing)" :alt="timing.cardName" loading="lazy" />
          <span class="op-chip" :class="operationTone(timing)">{{ operationLabel(timing) }}</span>
          <span class="grow" />
          <span v-if="stateOf(index) && stateOf(index)!.status !== 'ok'" class="status-tag" :class="stateOf(index)!.status">
            {{ statusText[stateOf(index)!.status] }}
          </span>
        </div>

        <div class="timing-title">
          <div
            class="timing-name"
            :class="{ muted: !timing.cardName && !timing.label }"
            :title="timingTitle(timing)"
          >
            {{ timing.label?.trim() || timing.cardName || '未指定卡片' }}
          </div>
          <span v-if="timing.from && timing.cardName" class="zone-tag">{{ ZONE_LABELS[timing.from] }}</span>
        </div>

        <div class="timing-body">
          <div
            class="chain-block editable"
            title="点击编辑这条连锁"
            @click.stop="emit('edit', timing)"
          >
            <div class="chain-line has-tools">
              <span class="chain-badge c1">C1</span>
              <span class="chain-text">
                {{ operationLabel(timing) }}<template v-if="timing.cardName">「{{ timing.cardName }}」</template>
              </span>
              <div class="chain-tools" @click.stop>
                <button class="icon-btn" title="编辑主操作" @click="emit('edit', timing)">✎</button>
              </div>
            </div>

            <div v-if="timing.setup?.length" class="seg-block chain-seg">
              <span class="seg-label">规则</span>
              <span v-for="move in timing.setup" :key="move.id" class="move-chip" :title="move.note">
                <img
                  v-if="moveThumb(move)"
                  class="move-thumb"
                  :src="moveThumb(move)"
                  :alt="move.cardName"
                  loading="lazy"
                />
                {{ moveText(move) }}
              </span>
            </div>

            <div v-if="timing.cost.length" class="seg-block chain-seg">
              <span class="seg-label cost">cost</span>
              <span v-for="move in timing.cost" :key="move.id" class="move-chip cost" :title="move.note">
                <img
                  v-if="moveThumb(move)"
                  class="move-thumb"
                  :src="moveThumb(move)"
                  :alt="move.cardName"
                  loading="lazy"
                />
                {{ moveText(move) }}
              </span>
            </div>

            <div v-if="timing.effect.length" class="seg-block chain-seg">
              <span class="seg-label effect">效果</span>
              <span
                v-for="move in timing.effect"
                :key="move.id"
                class="move-chip"
                :class="{ blocked: analysis.canceledMoves[move.id] }"
                :title="move.note"
              >
                <img
                  v-if="moveThumb(move)"
                  class="move-thumb"
                  :src="moveThumb(move)"
                  :alt="move.cardName"
                  loading="lazy"
                />
                {{ moveText(move) }}
                <span v-for="id in move.handtraps || []" :key="id" class="ht-chip" :style="toneStyle(id)">
                  {{ handtrapName(id) }}
                </span>
                <span v-if="analysis.canceledMoves[move.id]" class="flag ash">
                  被{{ handtrapName(analysis.canceledMoves[move.id]) }}拦下
                </span>
              </span>
            </div>

            <div v-if="timing.settle?.length" class="seg-block chain-seg">
              <span class="seg-label">结算</span>
              <span v-for="move in timing.settle" :key="move.id" class="move-chip" :title="move.note">
                <img
                  v-if="moveThumb(move)"
                  class="move-thumb"
                  :src="moveThumb(move)"
                  :alt="move.cardName"
                  loading="lazy"
                />
                {{ moveText(move) }}
              </span>
            </div>

            <div v-if="timing.handtraps?.length" class="seg-block chain-seg">
              <span class="seg-label">响应</span>
              <span v-for="id in timing.handtraps" :key="id" class="ht-chip" :style="toneStyle(id)">
                {{ handtrapName(id) }}
              </span>
            </div>
          </div>

          <div
            v-for="chain in [...timing.chains].sort((a, b) => a.link - b.link)"
            :key="chain.id"
            class="chain-block editable"
            title="点击编辑这条连锁"
            @click.stop="emit('editChain', timing, chain)"
          >
            <div class="chain-line has-tools">
              <span class="chain-badge">C{{ chain.link }}</span>
              <img
                v-if="chainThumb(chain)"
                class="chain-thumb"
                :src="chainThumb(chain)"
                :alt="chain.cardName"
                loading="lazy"
              />
              <span class="chain-text">{{ chainSummary(chain) }}</span>
              <span v-if="chain.from" class="zone-tag">{{ ZONE_LABELS[chain.from] }}</span>
              <span v-if="chain.negates" class="flag ash">无效前段</span>
              <div class="chain-tools" @click.stop>
                <button class="icon-btn" title="编辑连锁" @click="emit('editChain', timing, chain)">✎</button>
                <button class="icon-btn" title="删除连锁" @click="emit('removeChain', timing.id, chain.id)">✕</button>
              </div>
            </div>

            <div v-if="chain.setup?.length" class="seg-block chain-seg">
              <span class="seg-label">规则</span>
              <span v-for="move in chain.setup" :key="move.id" class="move-chip" :title="move.note">
                <img
                  v-if="moveThumb(move)"
                  class="move-thumb"
                  :src="moveThumb(move)"
                  :alt="move.cardName"
                  loading="lazy"
                />
                {{ moveText(move) }}
              </span>
            </div>
            <div v-if="chain.cost.length" class="seg-block chain-seg">
              <span class="seg-label cost">cost</span>
              <span v-for="move in chain.cost" :key="move.id" class="move-chip cost" :title="move.note">
                <img
                  v-if="moveThumb(move)"
                  class="move-thumb"
                  :src="moveThumb(move)"
                  :alt="move.cardName"
                  loading="lazy"
                />
                {{ moveText(move) }}
              </span>
            </div>
            <div v-if="chain.effect.length" class="seg-block chain-seg">
              <span class="seg-label effect">效果</span>
              <span v-for="move in chain.effect" :key="move.id" class="move-chip" :title="move.note">
                <img
                  v-if="moveThumb(move)"
                  class="move-thumb"
                  :src="moveThumb(move)"
                  :alt="move.cardName"
                  loading="lazy"
                />
                {{ moveText(move) }}
                <span v-for="id in move.handtraps || []" :key="id" class="ht-chip" :style="toneStyle(id)">
                  {{ handtrapName(id) }}
                </span>
              </span>
            </div>
            <div v-if="chain.settle?.length" class="seg-block chain-seg">
              <span class="seg-label">结算</span>
              <span v-for="move in chain.settle" :key="move.id" class="move-chip" :title="move.note">
                <img
                  v-if="moveThumb(move)"
                  class="move-thumb"
                  :src="moveThumb(move)"
                  :alt="move.cardName"
                  loading="lazy"
                />
                {{ moveText(move) }}
              </span>
            </div>
          </div>

          <button class="chain-add" @click.stop="emit('addChain', timing)">＋ 追加连锁</button>

          <div v-if="stateOf(index)?.reasons.length" class="reason-list">
            <div v-for="reason in stateOf(index)!.reasons" :key="reason">{{ reason }}</div>
          </div>

          <div v-if="timing.note" class="timing-note">{{ timing.note }}</div>
        </div>

        <div class="timing-foot">
          <div class="state-toggles">
            <button
              class="state-toggle"
              title="查看发动前的完整场面"
              @click.stop="openState(index, 'before')"
            >
              <span class="state-tag">发动前</span>
              <span class="mute">{{ stateOf(index) ? zoneSummary(stateOf(index)!.before) : '' }}</span>
            </button>
            <button
              class="state-toggle"
              title="查看发动后（效果已全部处理、尚未送墓）的完整场面"
              @click.stop="openState(index, 'activated')"
            >
              <span class="state-tag">发动后</span>
              <span class="mute">{{ stateOf(index) ? zoneSummary(stateOf(index)!.activated) : '' }}</span>
            </button>
          </div>
          <div class="timing-tools" @click.stop>
            <button class="icon-btn" title="编辑" @click="emit('edit', timing)">✎</button>
            <button class="icon-btn" title="在后面插入时序" @click="emit('add', timing.id)">＋</button>
            <button class="icon-btn" title="复制" @click="emit('duplicate', timing.id)">⧉</button>
            <button class="icon-btn" title="左移" @click="emit('move', timing.id, -1)">←</button>
            <button class="icon-btn" title="右移" @click="emit('move', timing.id, 1)">→</button>
            <button class="icon-btn" title="删除" @click="emit('remove', timing.id)">✕</button>
          </div>
        </div>
      </div>
    </template>

    <div class="flow-arrow">›</div>
    <button class="flow-add" @click="emit('add', timings.length ? timings[timings.length - 1].id : null)">
      <span style="font-size: 20px; line-height: 1">＋</span>
      <span>添加时序</span>
    </button>
  </div>

  <!-- 场面：可看发动前，也可看发动后（cost 已付、效果未处理） -->
  <DuelField
    v-if="inspecting && inspectingState"
    :snapshot="inspectingState[stateStage]"
    :title="`第 ${(stateIndex ?? 0) + 1} 时序 · ${stateStage === 'before' ? '发动前场面' : '发动后场面'}`"
    :subtitle="
      stateStage === 'before'
        ? `${timingTitle(inspecting)} · 这是效果发动前、cost 结算之前的场面`
        : `${timingTitle(inspecting)} · 这是效果（含连锁）已全部处理完、卡片尚未送墓 / 回额外的场面`
    "
    @close="stateIndex = null"
  />
</template>
