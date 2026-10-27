<script setup lang="ts">
import { computed } from 'vue'
import type { Interrupt, Timing } from '@/types'
import type { ComboAnalysis } from '@/lib/timeline'
import type { HandtrapDef } from '@/lib/handtraps'
import { CATEGORY_LABEL } from '@/lib/handtraps'
import { useHandtrapStore } from '@/stores/handtraps'
import { useCardStore } from '@/stores/cards'

const props = defineProps<{
  analysis: ComboAnalysis
  activeId: string
  timings: Timing[]
  applied: Interrupt | null
}>()

const emit = defineEmits<{
  select: [id: string]
  apply: [interrupt: Interrupt | null]
}>()

const ht = useHandtrapStore()
const cardStore = useCardStore()

const FALLBACK_DEF: HandtrapDef = {
  id: '',
  name: '未配置手坑',
  category: 'negate',
  tone: '#9ea7b3',
}

const defOf = (id: string): HandtrapDef => ht.map[id] || FALLBACK_DEF

/** 只列出真正吃到的手坑：没命中的不显示 */
const reports = computed(() => props.analysis.reports.filter((report) => report.sites.length > 0))
const active = computed(
  () => reports.value.find((report) => report.id === props.activeId) || reports.value[0],
)
const activeDef = computed(() => defOf(active.value?.id || ''))
/** 效果文本直接取卡库原文 */
const effectText = computed(() => cardStore.getCard(activeDef.value.cardId)?.desc?.trim() || '')

function applyAt(index: number) {
  const timing = props.timings[index]
  const report = active.value
  if (!timing || !report) return
  emit('apply', { timingId: timing.id, handtrapId: report.id })
}

const appliedIndex = computed(() => {
  if (!props.applied) return -1
  return props.timings.findIndex((timing) => timing.id === props.applied?.timingId)
})
</script>

<template>
  <div class="panel side-sticky">
    <div class="panel-head">
      <span class="panel-title">手坑报告</span>
      <span class="chip plain">{{ reports.length }} 种</span>
    </div>

    <div style="padding: 12px">
      <div v-if="!reports.length" class="inline-note">
        本线没有吃到手坑：效果段上还没有标记会响应的手坑。
      </div>

      <div v-else class="threat-list">
        <button
          v-for="report in reports"
          :key="report.id"
          class="threat"
          :class="{ active: report.id === active?.id }"
          @click="emit('select', report.id)"
        >
          <span class="dot" :style="{ background: defOf(report.id).tone }" />
          <span class="name">{{ defOf(report.id).name }}</span>
          <span class="mono mute" style="margin-left: auto; font-size: 10px; flex: none">
            {{ CATEGORY_LABEL[defOf(report.id).category] }}
          </span>
        </button>
      </div>
    </div>

    <div v-if="active" class="report-detail">
      <div style="font-size: 13.5px; font-weight: 600">
        {{ activeDef.name }}
        <span class="chip plain" style="margin-left: 4px">{{ CATEGORY_LABEL[activeDef.category] }}</span>
      </div>

      <div class="label" style="margin-top: 10px">卡片效果</div>
      <div
        v-if="effectText"
        style="font-size: 12px; line-height: 1.8; color: var(--text-dim); white-space: pre-line"
      >
        {{ effectText }}
      </div>
      <div v-else class="inline-note">卡库未加载或这张手坑没有绑定卡片，暂时读不到效果文本。</div>

      <div v-if="active.negates && active.sites.length" style="margin-top: 12px">
        <div class="label" style="margin-bottom: 6px">点选时序应用这张手坑</div>
        <div class="row wrap" style="gap: 5px">
          <button
            v-for="index in active.sites"
            :key="index"
            class="chip clickable"
            :class="{ on: applied && applied.timingId === timings[index]?.id }"
            @click="applyAt(index)"
          >
            {{ index + 1 }}. {{ timings[index]?.cardName }}
          </button>
        </div>
      </div>

      <div v-if="applied && appliedIndex >= 0" class="applied-box">
        <div class="row" style="justify-content: space-between; gap: 6px">
          <span>已应用在第 {{ appliedIndex + 1 }} 时序</span>
          <button class="btn xs ghost" @click="emit('apply', null)">取消应用</button>
        </div>
      </div>
    </div>
  </div>
</template>
