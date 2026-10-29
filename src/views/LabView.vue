<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { ChainEntry, Interrupt, Timing } from '@/types'
import { useComboStore } from '@/stores/combos'
import { useHandtrapStore } from '@/stores/handtraps'
import { analyzeCombo } from '@/lib/timeline'
import { downloadJson, toast } from '@/lib/toast'
import DuelPlayback from '@/components/DuelPlayback.vue'
import HandtrapEditor from '@/components/HandtrapEditor.vue'
import ComboCards from '@/components/ComboCards.vue'
import TimingTimeline from '@/components/TimingTimeline.vue'
import ResistancePanel from '@/components/ResistancePanel.vue'
import DeckSidebar from '@/components/DeckSidebar.vue'
import TimingEditor from '@/components/TimingEditor.vue'
import ChainEditor from '@/components/ChainEditor.vue'

const store = useComboStore()
const htStore = useHandtrapStore()
store.load()

const combo = computed(() => store.current)
const line = computed(() => store.line)
const activeTrapId = ref('maxx')
const selectedTimingId = ref<string | null>(null)
const interrupts = ref<Interrupt[]>([])

const editor = ref<{ timing: Timing | null; afterId: string | null } | null>(null)
const chainEditor = ref<{ timingId: string; chain: ChainEntry | null; link: number; hostName: string } | null>(null)
const deckDrawer = ref(false)
const importModal = ref(false)
const handtrapModal = ref(false)
const cardsModal = ref(false)
const playback = ref(false)
const importText = ref('')

const analysis = computed(() => {
  // 手坑配置变了也要重算：读取 version 建立依赖
  htStore.version
  const target = store.line
  if (!target) return null
  return analyzeCombo(target, interrupts.value)
})

const applied = computed(
  () => interrupts.value.find((item) => item.handtrapId === activeTrapId.value) || null,
)

// 切换展开 / 展开链时，注入的手坑与选中态都归零
watch(
  () => `${store.currentId}:${store.line?.id || ''}`,
  () => {
    interrupts.value = []
    selectedTimingId.value = null
  },
)

function openAdd(afterId: string | null) {
  editor.value = { timing: null, afterId }
}

function openEdit(timing: Timing) {
  editor.value = { timing, afterId: null }
}

function saveTiming(timing: Timing) {
  if (!editor.value) return
  if (editor.value.timing) store.updateTiming(timing)
  else store.addTiming(timing, editor.value.afterId ?? undefined)
  toast('时序已保存')
}

function removeTiming(id: string) {
  store.removeTiming(id)
  interrupts.value = interrupts.value.filter((item) => item.timingId !== id)
  if (selectedTimingId.value === id) selectedTimingId.value = null
}

function hostNameOf(timing: Timing) {
  return timing.label?.trim() || timing.cardName || '本时序'
}

function openAddChain(timing: Timing) {
  const max = timing.chains.reduce((n, chain) => Math.max(n, chain.link), 1)
  chainEditor.value = { timingId: timing.id, chain: null, link: max + 1, hostName: hostNameOf(timing) }
}

function openEditChain(timing: Timing, chain: ChainEntry) {
  chainEditor.value = { timingId: timing.id, chain, link: chain.link, hostName: hostNameOf(timing) }
}

function saveChain(chain: ChainEntry) {
  if (!chainEditor.value) return
  store.saveChain(chainEditor.value.timingId, chain)
  toast('连锁已保存')
}

function removeChainFromEditor(chainId: string) {
  if (!chainEditor.value) return
  store.removeChain(chainEditor.value.timingId, chainId)
}

function removeChain(timingId: string, chainId: string) {
  store.removeChain(timingId, chainId)
}

function applyInterrupt(interrupt: Interrupt | null) {
  if (!interrupt) {
    interrupts.value = interrupts.value.filter((item) => item.handtrapId !== activeTrapId.value)
    return
  }
  interrupts.value = [
    ...interrupts.value.filter((item) => item.handtrapId !== interrupt.handtrapId),
    interrupt,
  ]
  toast('已按该手坑重算链路')
}

function exportCombo() {
  if (!combo.value) return
  downloadJson(`${combo.value.name || 'combo'}.json`, combo.value)
  toast('已导出当前展开')
}

function doImport() {
  try {
    store.importCombo(importText.value)
    importModal.value = false
    importText.value = ''
    toast('导入成功')
  } catch (error) {
    toast(error instanceof Error ? error.message : '导入失败', true)
  }
}

async function onFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  importText.value = await file.text()
}

function newCombo() {
  store.create('光与暗之仪式')
  toast('已创建空白展开')
}

function deleteCombo() {
  if (!combo.value) return
  store.remove(combo.value.id)
  toast('已删除')
}

function newLine() {
  store.addLine()
  toast('已新建展开链')
}

function duplicateLine() {
  if (!line.value) return
  store.duplicateLine(line.value.id)
  toast('已复制展开链')
}

function deleteLine() {
  if (!combo.value || !line.value) return
  if (combo.value.lines.length <= 1) {
    toast('至少要保留一条展开链', true)
    return
  }
  store.removeLine(line.value.id)
  toast('已删除展开链')
}
</script>

<template>
  <div class="lab-screen">
    <div class="lab-toolbar">
      <input v-if="combo" v-model="combo.name" class="combo-title-input" placeholder="展开名称" aria-label="展开名称" />
      <span v-if="line" class="chip plain">{{ line.timings.length }} 时序</span>
      <span v-if="analysis" class="chip plain">{{ analysis.links.length }} 链路</span>

      <span class="grow" />

      <select class="select" style="width: 180px" :value="store.currentId"
        @change="store.select(($event.target as HTMLSelectElement).value)">
        <option v-for="item in store.combos" :key="item.id" :value="item.id">{{ item.name }}</option>
      </select>
      <button class="btn sm" @click="newCombo">新建</button>
      <button class="btn sm ghost" :disabled="!combo" @click="store.duplicate(store.currentId)">复制</button>
      <button class="btn sm ghost danger" :disabled="!combo" @click="deleteCombo">删除</button>
      <button class="btn sm ghost" :disabled="!combo" @click="exportCombo">导出</button>
      <button class="btn sm ghost" @click="importModal = true">导入</button>
      <button class="btn sm ghost" @click="handtrapModal = true">手坑配置</button>
      <button class="btn sm" :disabled="!combo?.lines.length" @click="cardsModal = true">卡表</button>
    </div>

    <div v-if="combo && line" class="line-bar">
      <span class="label" style="margin: 0">展开链</span>
      <div class="row wrap" style="gap: 6px">
        <button v-for="item in combo.lines" :key="item.id" class="btn sm"
          :class="{ primary: item.id === combo.activeLineId }" @click="store.selectLine(item.id)">
          {{ item.name }}
        </button>
        <button class="btn sm ghost" title="新建展开链" @click="newLine">＋</button>
      </div>

      <span class="grow" />

      <input v-model="line.name" class="input" style="width: 140px" placeholder="展开链名称" aria-label="展开链名称" />
      <button class="btn sm" @click="deckDrawer = true">卡组 · 起手</button>
      <button class="btn sm" :disabled="!analysis || !line.timings.length" @click="playback = true">
        ▶ 动态演示
      </button>
      <button class="btn sm ghost" @click="duplicateLine">复制链</button>
      <button class="btn sm ghost danger" :disabled="combo.lines.length <= 1" @click="deleteLine">
        删除链
      </button>
    </div>

    <div v-if="!combo" class="panel">
      <div class="empty">
        还没有展开流程。
        <button class="btn primary sm" style="margin-left: 10px" @click="newCombo">新建展开</button>
      </div>
    </div>

    <div v-else-if="line && analysis" class="lab-stage">
      <div class="flow-panel">
        <div class="panel-head">
          <span class="panel-title">展开链 · {{ line.name }}</span>
          <div class="row" style="gap: 6px">
            <span class="chip plain">← 从左到右 →</span>
            <span class="chip plain" title="每个时序按 C1 → Cn 记录连锁">C1 → Cn</span>
            <span class="chip plain" title="cost 必定成功，效果段才吃手坑">cost / 效果</span>
          </div>
        </div>
        <div class="flow-panel-body">
          <TimingTimeline :timings="line.timings" :analysis="analysis" :selected-id="selectedTimingId"
            @select="(id) => (selectedTimingId = id)" @add="openAdd" @edit="openEdit" @remove="removeTiming"
            @move="(id, dir) => store.moveTiming(id, dir)" @duplicate="(id) => store.duplicateTiming(id)"
            @add-chain="openAddChain" @edit-chain="openEditChain" @remove-chain="removeChain" />
        </div>
      </div>

      <ResistancePanel class="report-col" :analysis="analysis" :active-id="activeTrapId" :timings="line.timings"
        :applied="applied" @select="(id) => (activeTrapId = id)" @apply="applyInterrupt" />
    </div>

    <!-- 卡组 / 起手 / 目标 -->
    <div v-if="deckDrawer && line" class="overlay center" @click.self="deckDrawer = false">
      <div class="modal deck-modal">
        <div class="modal-head">
          <span style="font-size: 14px; font-weight: 600">卡组 · 起手 · 目标</span>
          <button class="icon-btn" @click="deckDrawer = false">✕</button>
        </div>
        <div class="modal-body">
          <div class="inline-note" style="margin-bottom: 10px">
            这些是「{{ line.name }}」的卡组与起手，每条展开链各自独立。
          </div>
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px">
            <div class="field">
              <label>卡组 / 系统</label>
              <input v-model="line.deckName" class="input" placeholder="例如 HERO" />
            </div>
            <div class="field">
              <label>起手张数</label>
              <input v-model.number="line.handSize" type="number" min="1" max="10" class="input" />
            </div>
            <div class="field" style="grid-column: span 2">
              <label>目标终场</label>
              <input v-model="line.goal" class="input" placeholder="例如：暗爪 + 天空侠 + 手卡资源" />
            </div>
          </div>
          <div class="divider" />
          <DeckSidebar :line="line" />
        </div>
      </div>
    </div>

    <TimingEditor v-if="editor" :timing="editor.timing" @close="editor = null" @save="saveTiming"
      @remove="removeTiming" />

    <ChainEditor v-if="chainEditor" :chain="chainEditor.chain" :link="chainEditor.link"
      :host-name="chainEditor.hostName" @close="chainEditor = null" @save="saveChain" @remove="removeChainFromEditor" />

    <HandtrapEditor v-if="handtrapModal" @close="handtrapModal = false" />

    <ComboCards v-if="cardsModal && combo" :lines="combo.lines" @close="cardsModal = false" />

    <DuelPlayback v-if="playback && line && analysis" :timings="line.timings" :states="analysis.states"
      :frames="analysis.frames" :name="`${combo?.name || ''} · ${line.name}`" @close="playback = false" />

    <!-- 导入 -->
    <div v-if="importModal" class="overlay center" @click.self="importModal = false">
      <div class="modal" style="width: min(560px, 100%)">
        <div class="modal-head">
          <span style="font-size: 14px; font-weight: 600">导入展开流程</span>
          <button class="icon-btn" @click="importModal = false">✕</button>
        </div>
        <div class="modal-body">
          <input type="file" accept=".json,application/json" class="input" @change="onFile" />
          <textarea v-model="importText" class="textarea"
            style="margin-top: 10px; min-height: 160px; font-family: var(--mono); font-size: 11px"
            placeholder="粘贴导出的 JSON（新版 lines / timings，或旧版 steps 会自动转换）" />
        </div>
        <div class="modal-foot">
          <button class="btn ghost" @click="importModal = false">取消</button>
          <button class="btn primary" :disabled="!importText.trim()" @click="doImport">导入</button>
        </div>
      </div>
    </div>
  </div>
</template>
