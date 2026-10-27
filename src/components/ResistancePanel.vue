<script setup lang="ts">
import { computed } from 'vue'
import type { Interrupt, Timing } from '@/types'
import type { ComboAnalysis } from '@/lib/timeline'
import type { HandtrapDef } from '@/lib/handtraps'
import { CATEGORY_LABEL } from '@/lib/handtraps'
import { useHandtrapStore } from '@/stores/handtraps'

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

const FALLBACK_DEF: HandtrapDef = {
  id: '',
  name: '未配置手坑',
  category: 'negate',
  tone: '#9ea7b3',
  summary: '',
  rule: '',
}

/** 只列出真正吃到的手坑：没命中的不显示 */
const reports = computed(() => props.analysis.reports.filter((report) => report.sites.length > 0))
const active = computed(
  () => reports.value.find((report) => report.id === props.activeId) || reports.value[0],
)
const activeDef = computed(() => ht.map[active.value?.id] || ht.defs[0] || FALLBACK_DEF)

const verdictText: Record<string, string> = {
  safe: '安全',
  warning: '可控',
  danger: '危险',
  lethal: '致命',
  inactive: '不适用',
}

const chipClass = (verdict: string) =>
  verdict === 'safe' ? 'green' : verdict === 'inactive' ? 'plain' : verdict === 'warning' ? 'amber' : 'red'

const canApply = computed(() => Boolean(active.value?.negates && active.value?.sites.length))

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
      <span class="chip plain">链上记录 · 逐段判定</span>
    </div>

    <div style="padding: 12px 12px 10px">
      <div class="row" style="justify-content: space-between; align-items: baseline">
        <span class="label">本线吃到的手坑</span>
        <span class="mute" style="font-size: 10px">{{ reports.length }} 种</span>
      </div>

      <div v-if="!reports.length" class="inline-note" style="margin-top: 6px">
        没有吃到手坑：效果段上还没有标记会响应的手坑。
      </div>

      <div v-else class="threat-list" style="margin-top: 6px">
        <button
          v-for="report in reports"
          :key="report.id"
          class="threat"
          :class="{ active: report.id === active?.id }"
          @click="emit('select', report.id)"
        >
          <span class="dot" :class="report.verdict" />
          <span class="name">{{ ht.map[report.id]?.name }}</span>
          <span class="res" :class="`tone-${report.verdict}`">{{ report.headline }}</span>
          <span v-if="report.draws > 0" class="mono mute" style="font-size: 10px">+{{ report.draws }}</span>
        </button>
      </div>

      <div class="row wrap" style="gap: 6px; margin-top: 9px; font-size: 10.5px; color: var(--text-mute)">
        <span>累计召唤 {{ analysis.totalSummons }}</span>
        <span>·</span>
        <span>陨石 {{ analysis.totalSummons >= 5 ? '可触发' : '不可触发' }}</span>
      </div>
    </div>

    <div v-if="active" class="report-detail">
      <div class="row" style="justify-content: space-between; gap: 8px">
        <div>
          <div style="font-size: 13.5px; font-weight: 600">
            {{ activeDef.name }}
            <span class="chip plain" style="margin-left: 4px">{{ CATEGORY_LABEL[activeDef.category] }}</span>
          </div>
          <div class="inline-note" style="margin-top: 3px">{{ activeDef.summary }}</div>
        </div>
        <span class="chip" :class="chipClass(active.verdict)">{{ verdictText[active.verdict] }}</span>
      </div>

      <div class="row wrap" style="gap: 6px; margin-top: 10px">
        <span class="chip plain">命中 <b class="mono gold">{{ active.sites.length }}</b> 处</span>
        <span class="chip plain">断点 <b class="mono">{{ active.deadAt === null ? '无' : `第 ${active.deadAt + 1} 时序` }}</b></span>
        <span class="chip plain">波及 <b class="mono">{{ active.broken.length }}</b></span>
      </div>

      <div style="margin-top: 12px">
        <div class="label" style="margin-bottom: 6px">
          {{ active.negates ? '可插入的时序（点选应用）' : '抽牌 / 触发时序' }}
        </div>
        <div class="row wrap" style="gap: 5px">
          <button
            v-for="index in active.sites"
            :key="index"
            class="chip clickable"
            :class="{ on: applied && applied.timingId === timings[index]?.id }"
            @click="canApply ? applyAt(index) : undefined"
          >
            {{ index + 1 }}. {{ timings[index]?.cardName }}
          </button>
          <span v-if="!active.sites.length" class="inline-note">本线还没有把这张手坑挂到任何时序上。</span>
        </div>
      </div>

      <div v-if="applied && appliedIndex >= 0" class="applied-box">
        <div class="row" style="justify-content: space-between; gap: 6px">
          <span>已应用在第 {{ appliedIndex + 1 }} 时序</span>
          <button class="btn xs ghost" @click="emit('apply', null)">取消应用</button>
        </div>
        <div class="inline-note" style="margin-top: 4px">
          链路会把这次无效传播到使用该卡后续时序；cost 段不受影响。
        </div>
      </div>

      <div v-if="active.broken.length" style="margin-top: 12px">
        <div class="label" style="margin-bottom: 6px">被切断的时序</div>
        <div style="display: flex; flex-direction: column; gap: 5px">
          <div v-for="index in active.broken" :key="index" class="row" style="gap: 7px; align-items: flex-start">
            <span class="chip red" style="flex: none">第 {{ index + 1 }} 时序</span>
            <span style="font-size: 11.5px; color: var(--text-dim); line-height: 1.6">{{ timings[index]?.cardName }}</span>
          </div>
        </div>
      </div>

      <div class="divider" />
      <div class="inline-note">{{ activeDef.rule }}</div>
      <div class="inline-note" style="margin-top: 6px">
        命中位置来自你在每个效果段上记录的手坑，不再由事件类型推断。
      </div>
    </div>
  </div>
</template>
