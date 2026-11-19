<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useDeckStore } from '@/stores/deck'
import { useCardStore } from '@/stores/cards'
import { useHandtrapStore } from '@/stores/handtraps'
import { analyzeReplay } from '@/lib/duel/replay'
import { HANDTRAP_ANALYSIS_VERSION, hitNameText } from '@/lib/duel/replayHandtraps'
import {
  bindReplay,
  listReplayBindings,
  loadReplayBinding,
  removeOrphanReplays,
  removeReplayBinding,
  saveReplayAnalysis,
  type ReplayBindingMeta,
} from '@/lib/replayStore'
import {
  buildSkillJson,
  buildSkillMarkdown,
  skillFileName,
  type SkillBindingInput,
  type SkillInput,
} from '@/lib/skill'
import { buildSkillBundle, type SkillBundle } from '@/lib/skillBundle'
import { copyText, downloadBytes, downloadText, toast } from '@/lib/toast'
import { strToU8, zipSync } from 'fflate'

const deckStore = useDeckStore()
const cardStore = useCardStore()

const bindings = ref<ReplayBindingMeta[]>([])
const orphanCount = ref(0)
const loading = ref(false)
const generating = ref(false)
const progress = ref('')
const skillText = ref('')
const bundle = ref<SkillBundle | null>(null)
const view = ref<'bundle' | 'full'>('bundle')
const currentPath = ref('')
const fileInput = ref<HTMLInputElement | null>(null)

const nameOf = (code: number) => cardStore.getCard(code)?.name || `#${code}`
const deck = computed(() => deckStore.current)
const deckName = computed(() => deck.value?.name || '未命名卡组')

const handtrapStore = useHandtrapStore()

const totalSize = computed(() => bindings.value.reduce((sum, item) => sum + item.size, 0))

/** 可解析的录像：每份都是一条可用路线，会挂到起手命中的启动点上 */
const usableReplays = computed(() => bindings.value.filter((item) => item.analysis?.ok).length)

interface SkillFileEntry {
  path: string
  name: string
  size: number
}

interface SkillFileGroup {
  id: string
  label: string
  files: SkillFileEntry[]
}

/** 分片包的文件树：概览 / 展开 / 兜底 / 卡效 */
const fileGroups = computed<SkillFileGroup[]>(() => {
  const current = bundle.value
  if (!current) return []
  const prefix = `${current.dir}/`
  const all = Object.keys(current.files).sort()
  const take = (test: (name: string) => boolean) =>
    all
      .filter((path) => path.startsWith(prefix) && test(path.slice(prefix.length)))
      .map((path) => ({
        path,
        name: path.slice(prefix.length),
        size: new TextEncoder().encode(current.files[path]).length,
      }))

  return [
    {
      id: 'core',
      label: '概览',
      files: take((name) => name === 'manifest.json' || name === '00-router.md'),
    },
    { id: 'lines', label: '展开', files: take((name) => name.startsWith('line-')) },
    { id: 'replays', label: '对局样本', files: take((name) => name.startsWith('20-')) },
    { id: 'fallback', label: '兜底', files: take((name) => name.startsWith('90-')) },
    { id: 'cards', label: '卡效', files: take((name) => name.startsWith('cards/')) },
  ].filter((group) => group.files.length)
})

const currentText = computed(() => {
  const current = bundle.value
  if (!current || !currentPath.value) return ''
  return current.files[currentPath.value] ?? ''
})

function selectFile(path: string) {
  currentPath.value = path
}

function statusText(item: ReplayBindingMeta): string {
  if (!item.analysis) return item.error ? '解析失败' : '待解析'
  return item.analysis.ok ? `${item.analysis.turns} 回合 · 已解析` : '解析失败'
}

/** 缓存里的手坑分析是不是用旧规则跑出来的 */
function staleHits(item: ReplayBindingMeta): boolean {
  return !!item.analysis?.ok && item.analysis.analysisVersion !== HANDTRAP_ANALYSIS_VERSION
}

function statusTone(item: ReplayBindingMeta): string {
  if (!item.analysis) return item.error ? 'bad' : 'idle'
  return item.analysis.ok ? 'ok' : 'bad'
}

function sizeText(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function dateText(time: number): string {
  const date = new Date(time)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

async function refresh() {
  loading.value = true
  try {
    const deckId = deckStore.currentDeckId
    bindings.value = deckId ? await listReplayBindings(deckId) : []
    const all = await listReplayBindings()
    const known = new Set(deckStore.decks.map((item) => item.id))
    orphanCount.value = all.filter((item) => !known.has(item.deckId)).length
  } finally {
    loading.value = false
  }
}

watch(() => deckStore.currentDeckId, refresh)

onMounted(async () => {
  // 卡名解析依赖卡库；没就绪时先拉一次，日志里的卡名才不会全是 #编号
  if (cardStore.status !== 'ready') void cardStore.init()
  await refresh()
})

function pickFiles() {
  fileInput.value?.click()
}

async function onFiles(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files || [])
  input.value = ''
  if (!files.length) return
  if (!deckStore.currentDeckId) {
    toast('先建一套卡组再绑定录像', true)
    return
  }
  let added = 0
  for (const file of files) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      await bindReplay({
        deckId: deckStore.currentDeckId,
        deckName: deckName.value,
        name: file.name.replace(/\.yrp$/i, ''),
        bytes,
      })
      added += 1
    } catch (error) {
      toast(`${file.name} 绑定失败：${error instanceof Error ? error.message : String(error)}`, true)
    }
  }
  if (added) toast(`已绑定 ${added} 份录像到「${deckName.value}」`)
  await refresh()
}

async function remove(item: ReplayBindingMeta) {
  await removeReplayBinding(item.id)
  await refresh()
  if (!bindings.value.length) skillText.value = ''
}

/** 文件名里的非法字符换成下划线，顺便保证 .yrp 后缀 */
function replayFileName(name: string): string {
  const clean = name
    .replace(/\.yrp$/i, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
  return `${clean || 'replay'}.yrp`
}

/**
 * 导出单份录像的 .yrp 原始字节。
 *
 * 绑定时存的就是文件原样（`bindReplay` 只做一次 `slice()`），所以导出的文件
 * 和当初导入的完全一致，可以直接丢回 ygopro / 别的工具里复盘。
 */
async function exportReplay(item: ReplayBindingMeta) {
  const record = await loadReplayBinding(item.id)
  if (!record) {
    toast('录像数据已丢失，无法导出', true)
    return
  }
  downloadBytes(replayFileName(item.name), record.bytes, 'application/octet-stream')
  toast(`已导出 ${replayFileName(item.name)}（${sizeText(record.size)}）`)
}

async function cleanOrphans() {
  const removed = await removeOrphanReplays(deckStore.decks.map((item) => item.id))
  await refresh()
  toast(removed ? `已清理 ${removed} 份无效录像` : '没有需要清理的录像')
}

/**
 * 逐份回放录像并拼成 skill。
 * 回放结果缓存在 IndexedDB 里，只有 force 或没缓存时才真的重跑内核。
 */
async function generate(force: boolean) {
  const current = deck.value
  if (!current || generating.value) return
  generating.value = true
  skillText.value = ''
  bundle.value = null
  currentPath.value = ''
  try {
    // 回放时内核消息里的卡名走 resolveName，卡库没就绪的话整份文档都是 #编号
    if (cardStore.status !== 'ready') {
      progress.value = '正在准备卡库…'
      await cardStore.init()
    }
    const inputs: SkillBindingInput[] = []
    for (let index = 0; index < bindings.value.length; index += 1) {
      const meta = bindings.value[index]
      progress.value = `正在回放 ${index + 1}/${bindings.value.length}：${meta.name}`
      const record = await loadReplayBinding(meta.id)
      if (!record) continue
      let analysis = force ? null : record.analysis ?? null
      // 旧缓存没有手坑分析 / 判定规则升过版：同一份录像重放一次就能补上，不需要重新录制
      if (analysis?.ok && analysis.analysisVersion !== HANDTRAP_ANALYSIS_VERSION) analysis = null
      if (!analysis) {
        try {
          analysis = await analyzeReplay(record.bytes, nameOf)
        } catch (error) {
          analysis = null
          await saveReplayAnalysis(meta.id, {
            error: error instanceof Error ? error.message : String(error),
          })
        }
        if (analysis) await saveReplayAnalysis(meta.id, { analysis })
      }
      inputs.push({
        id: meta.id,
        name: meta.name,
        createdAt: meta.createdAt,
        error: analysis ? undefined : '回放失败',
        analysis,
      })
    }

    progress.value = '正在推导路线、终场与阻抗…'
    // 推导是同步的，先让进度文案渲染出来再算
    await nextTick()
    const payload = skillInput(inputs)
    if (!payload) return
    const built = buildSkillBundle(payload)
    bundle.value = built
    skillText.value = buildSkillMarkdown(payload)
    view.value = 'bundle'
    currentPath.value = `${built.dir}/00-router.md`

    const usable = inputs.filter((item) => item.analysis?.ok).length
    if (usable) toast(`已生成 skill 包（${usable} 份录像）`)
    else if (inputs.length) toast('录像都没能解析，skill 包只保留推演出来的部分', true)
    else toast(`已生成 skill 包：${built.manifest.starters.filter((item) => item.file).length} 条启动点路线`)
  } finally {
    generating.value = false
    progress.value = ''
    await refresh()
  }
}

async function copySkill() {
  if (!skillText.value) return
  await copyText(skillText.value, 'skill 文档已复制')
}

async function copyCurrent() {
  if (!currentText.value) return
  await copyText(currentText.value, '当前文件已复制')
}

function downloadCurrent() {
  const current = bundle.value
  if (!current || !currentPath.value) return
  const name = currentPath.value.slice(current.dir.length + 1).replace(/[\\/]/g, '_')
  downloadText(name, currentText.value)
}

function downloadMd() {
  if (!skillText.value) return
  downloadText(skillFileName(deckName.value, 'md'), skillText.value)
}

/** 组装 skill 输入：卡组 + 卡库 + 启动率配置 + 关联展开 + 手坑 + 录像 */
function skillInput(inputs: SkillBindingInput[]): SkillInput | null {
  const current = deck.value
  if (!current) return null
  return {
    deckName: current.name || '未命名卡组',
    main: current.main,
    extra: current.extra,
    side: current.side,
    nameOf,
    cardOf: (code) => cardStore.getCard(code),
    plan: current.plan,
    starterGroups: current.starters,
    handtraps: handtrapStore.defs,
    bindings: inputs,
  }
}

function bindingInputs(): SkillBindingInput[] {
  return bindings.value.map((item) => ({
    id: item.id,
    name: item.name,
    createdAt: item.createdAt,
    error: item.error,
    analysis: item.analysis ?? null,
  }))
}

function downloadJson() {
  const payload = skillInput(bindingInputs())
  if (!payload) return
  downloadText(skillFileName(deckName.value, 'json'), buildSkillJson(payload), 'application/json;charset=utf-8')
}

/**
 * 分片包：路由层 + 每个启动点对应的录像路线 + 卡效切片。
 * AI 先读 00-router.md 判断手牌，再只加载需要的那条 20-replay-*.md。
 */
function downloadBundle() {
  const current = bundle.value
  if (!current) {
    toast('先点「生成 skill 包」', true)
    return
  }
  const entries: Record<string, Uint8Array> = {}
  for (const [path, text] of Object.entries(current.files)) entries[path] = strToU8(text)
  downloadBytes(current.zipName, zipSync(entries, { level: 6 }), 'application/zip')
  const lines = current.manifest.starters.filter((item) => item.file).length
  toast(`已导出 skill 包：${lines} 条启动点路线，共 ${Object.keys(current.files).length} 个文件`)
}
</script>

<template>
  <div class="page skills">
    <header class="skills-head">
      <div>
        <h1 class="page-title">AI Skill</h1>
        <p class="inline-note">
          把卡组、启动率配置与绑定的 .yrp 录像整理成一份 AI 能读懂的 skill：
          录像就是展开路线，按起手自动挂到对应启动点；完整卡效、起手概率、终场与阻抗时机都会自动推导。
        </p>
      </div>
      <div class="skills-actions">
        <select
          class="select"
          :value="deckStore.currentDeckId"
          @change="deckStore.select(($event.target as HTMLSelectElement).value)"
        >
          <option v-for="item in deckStore.decks" :key="item.id" :value="item.id">{{ item.name }}</option>
        </select>
        <button class="btn" :disabled="loading" @click="pickFiles">导入 .yrp</button>
        <button class="btn primary" :disabled="generating || !deck" @click="generate(false)">
          {{ generating ? '生成中…' : '生成 skill 包' }}
        </button>
        <input ref="fileInput" class="hidden-file" type="file" accept=".yrp" multiple @change="onFiles" />
      </div>
    </header>

    <div class="skills-meta">
      <span class="chip">卡组：{{ deckName }}</span>
      <span class="chip-dim">录像 {{ bindings.length }} 份 · {{ sizeText(totalSize) }}</span>
      <span
        class="chip-dim"
        :title="usableReplays ? '录像按起手自动关联到启动点，就是各启动点的路线' : '没有可解析的录像：启动点会显示「未录入」'"
      >
        录像路线 {{ usableReplays }} 份
      </span>
      <span v-if="cardStore.status !== 'ready'" class="chip amber">卡库未就绪，卡名可能显示为 #编号</span>
      <span v-if="orphanCount" class="chip-dim">
        另有 {{ orphanCount }} 份录像所属卡组已删除
        <button class="link-btn" @click="cleanOrphans">清理</button>
      </span>
    </div>

    <div class="skills-grid">
      <aside class="panel">
        <div class="panel-head">
          <span class="panel-title">绑定的录像</span>
          <button class="btn xs ghost" :disabled="generating || !bindings.length" @click="generate(true)">
            重新解析
          </button>
        </div>
        <div class="panel-body">
          <div v-if="!bindings.length" class="empty-block">
            还没有绑定录像。两条路都可以：
            <br />1. 在 <RouterLink to="/duel">combo 推演</RouterLink> 里打完一局，点「绑定到卡组」；
            <br />2. 点右上角「导入 .yrp」把已经导出的录像挂到当前卡组。
          </div>
          <div v-for="item in bindings" :key="item.id" class="replay-row">
            <div class="replay-main">
              <div class="replay-name" :title="item.name">{{ item.name }}</div>
              <div class="replay-meta">
                <span>{{ sizeText(item.size) }}</span>
                <span>{{ dateText(item.createdAt) }}</span>
                <span class="replay-state" :class="statusTone(item)">{{ statusText(item) }}</span>
                <span
                  v-if="item.analysis?.ok && (staleHits(item) || !item.analysis.handtrapHits)"
                  class="replay-state"
                  :title="staleHits(item) ? '手坑判定规则升过版，点「重新解析」按新规则重跑' : '旧缓存里没有手坑分析，点「重新解析」补上'"
                >
                  {{ staleHits(item) ? '手坑分析已过期' : '手坑点待解析' }}
                </span>
              </div>
              <div v-if="item.analysis && !item.analysis.ok" class="replay-error">
                {{ item.analysis.error }}
              </div>
              <div v-else-if="!item.analysis && item.error" class="replay-error">{{ item.error }}</div>
              <details v-if="item.analysis?.handtrapHits?.length && !staleHits(item)" class="replay-hits">
                <summary>手坑点 {{ item.analysis.handtrapHits.length }} 处</summary>
                <ul>
                  <li
                    v-for="hit in item.analysis.handtrapHits ?? []"
                    :key="`${hit.id}-${hit.step}`"
                    :class="{ 'hit-dodged': hit.dodged }"
                  >
                    <span class="hit-step">第 {{ hit.step }} 步</span>
                    <strong>{{ hitNameText(hit) }}</strong>
                    {{ hit.dodged ? hit.dodgeNote : hit.effect }}
                  </li>
                </ul>
              </details>
            </div>
            <div class="replay-actions">
              <button class="btn xs ghost" :title="`导出 ${replayFileName(item.name)}`" @click="exportReplay(item)">
                导出
              </button>
              <button class="btn xs danger" :disabled="generating" @click="remove(item)">移除</button>
            </div>
          </div>
        </div>
      </aside>

      <section class="panel">
        <div class="panel-head">
          <span class="panel-title">Skill 包</span>
          <span class="skill-tabs">
            <button class="skill-tab" :class="{ active: view === 'bundle' }" @click="view = 'bundle'">
              分片包
            </button>
            <button class="skill-tab" :class="{ active: view === 'full' }" @click="view = 'full'">
              全量文档
            </button>
          </span>
          <span class="skills-spacer" />
          <template v-if="view === 'bundle'">
            <button class="btn xs" :disabled="!currentText" @click="copyCurrent">复制</button>
            <button class="btn xs" :disabled="!currentText" @click="downloadCurrent">下载当前文件</button>
            <button class="btn xs" :disabled="!bundle" @click="downloadBundle">下载 zip</button>
          </template>
          <template v-else>
            <button class="btn xs" :disabled="!skillText" @click="copySkill">复制</button>
            <button class="btn xs" :disabled="!skillText" @click="downloadMd">下载 .md</button>
            <button class="btn xs" :disabled="!skillText" @click="downloadJson">下载 .json</button>
          </template>
        </div>
        <div class="panel-body">
          <div v-if="progress" class="progress-note">{{ progress }}</div>

          <template v-if="view === 'bundle'">
            <div v-if="!bundle" class="empty-block">
              点「生成 skill 包」后，这里会按「概览 / 每条启动点一份展开 / 对局样本 / 兜底 / 卡效切片」拆成多个文件。
              <br />录像的展开流程与手坑命中点在「对局样本」里；AI 先读 00-router.md 判断 5 张起手，再按需加载。
            </div>
            <div v-else class="skill-bundle">
              <aside class="skill-files">
                <div v-for="group in fileGroups" :key="group.id" class="skill-file-group">
                  <div class="skill-file-label">{{ group.label }}</div>
                  <button
                    v-for="file in group.files"
                    :key="file.path"
                    class="skill-file"
                    :class="{ active: file.path === currentPath }"
                    :title="file.path"
                    @click="selectFile(file.path)"
                  >
                    <span class="skill-file-name">{{ file.name }}</span>
                    <span class="skill-file-size">{{ sizeText(file.size) }}</span>
                  </button>
                </div>
              </aside>
              <pre class="skill-preview">{{ currentText }}</pre>
            </div>
          </template>

          <template v-else>
            <textarea
              v-if="skillText"
              v-model="skillText"
              class="skill-output"
              spellcheck="false"
              aria-label="生成的 skill 文档"
            />
            <div v-else class="empty-block">
              点「生成 skill 包」后，这里会输出一份全量 Markdown：卡组构筑、完整卡效、起手样本、展开路线、终场与阻抗，以及可程序读取的 JSON。
            </div>
          </template>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.skills {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page-title {
  margin: 0 0 4px;
  font-size: 22px;
  font-weight: 650;
}

.skills-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
}

.skills-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.skills-actions .select {
  min-width: 180px;
}

.hidden-file {
  display: none;
}

.skills-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.chip-dim {
  color: var(--text-mute);
  font-size: 11px;
}

.link-btn {
  margin-left: 6px;
  padding: 0;
  border: none;
  background: none;
  color: var(--gold);
  font-size: 11px;
  cursor: pointer;
  text-decoration: underline;
}

.skills-grid {
  display: grid;
  grid-template-columns: minmax(280px, 0.8fr) minmax(0, 1.4fr);
  gap: 14px;
  align-items: start;
}

.skills-spacer {
  flex: 1;
}

.panel-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.empty-block {
  padding: 14px;
  border: 1px dashed var(--line);
  border-radius: var(--radius-sm);
  color: var(--text-mute);
  font-size: 12px;
  line-height: 1.8;
}

.replay-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px solid var(--line);
}

.replay-row:last-child {
  border-bottom: none;
}

.replay-main {
  min-width: 0;
  flex: 1;
}

.replay-actions {
  display: flex;
  flex: none;
  gap: 6px;
}

.replay-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
}

.replay-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 3px;
  color: var(--text-mute);
  font-size: 11px;
}

.replay-state {
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid var(--line);
}

.replay-state.ok {
  color: var(--green);
  border-color: rgba(38, 205, 77, 0.4);
}

.replay-state.bad {
  color: var(--red);
  border-color: rgba(255, 106, 105, 0.4);
}

.replay-error {
  margin-top: 4px;
  color: var(--red);
  font-size: 11px;
  line-height: 1.6;
}

.replay-hits {
  margin-top: 6px;
  color: var(--text-mute);
  font-size: 11px;
}

.replay-hits summary {
  color: var(--gold);
  cursor: pointer;
}

.replay-hits ul {
  margin: 4px 0 0;
  padding-left: 16px;
  line-height: 1.75;
}

.replay-hits strong {
  margin-right: 4px;
  color: var(--text-dim);
}

.hit-step {
  margin-right: 6px;
  color: var(--text-mute);
}

/* 自排连锁规避的点：留在列表里说明「为什么这一步安全」，但弱化显示 */
.replay-hits li.hit-dodged {
  color: var(--text-mute);
  opacity: 0.75;
}

.progress-note {
  margin-bottom: 8px;
  color: var(--gold);
  font-size: 12px;
}

.skill-tabs {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--bg-2);
}

.skill-tab {
  padding: 3px 10px;
  border: 0;
  border-radius: 999px;
  background: none;
  color: var(--text-mute);
  font-size: 11px;
  cursor: pointer;
}

.skill-tab.active {
  background: var(--line);
  color: var(--text);
}

.skill-bundle {
  display: grid;
  grid-template-columns: minmax(140px, 190px) minmax(0, 1fr);
  gap: 10px;
  align-items: stretch;
}

.skill-files {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 64vh;
  overflow: auto;
  padding-right: 8px;
  border-right: 1px solid var(--line);
}

.skill-file-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.skill-file-label {
  padding: 0 6px;
  color: var(--text-mute);
  font-size: 11px;
}

.skill-file {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  width: 100%;
  padding: 4px 6px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: var(--text-dim);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.skill-file:hover {
  background: var(--bg-2);
  color: var(--text);
}

.skill-file.active {
  background: var(--bg-2);
  color: var(--text);
  box-shadow: inset 2px 0 0 var(--gold);
}

.skill-file-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-file-size {
  flex: none;
  color: var(--text-mute);
  font-size: 10px;
}

.skill-preview {
  margin: 0;
  max-height: 64vh;
  overflow: auto;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-2);
  color: var(--text-dim);
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}

.skill-output {
  width: 100%;
  min-height: 62vh;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-2);
  color: var(--text-dim);
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.7;
  resize: vertical;
}

@media (max-width: 980px) {
  .skills-grid {
    grid-template-columns: 1fr;
  }

  .skill-bundle {
    grid-template-columns: 1fr;
  }

  .skill-files {
    max-height: 190px;
    padding: 0 0 8px;
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }
}
</style>
