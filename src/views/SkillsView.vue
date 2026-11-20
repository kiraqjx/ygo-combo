<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
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
  renameReplayBinding,
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
import {
  loadSkillBundle,
  saveSkillBundle,
  type SkillBundleSource,
} from '@/lib/skillBundleStore'
import { isAiActive, loadAiConfig, type AiConfig } from '@/lib/ai/config'
import { generateSkillBundleWithAi } from '@/lib/ai/skillWriter'
import { copyText, downloadBytes, downloadText, toast } from '@/lib/toast'
import { renderComboChainPoster, chainPosterFileName } from '@/lib/replayPoster'
import { prepareFlowPoster, flowPosterFileName, type FlowPosterScene } from '@/lib/flowPoster'
import {
  buildHandtrapReport,
  handtrapReportMarkdown,
  replayHandtrapReportMarkdown,
} from '@/lib/handtrapReport'
import { handtrapCardImage } from '@/lib/handtrapArt'
import { FLOW_VERSION, type ReplayFlow } from '@/lib/duel/replayFlows'
import { downloadBlob } from '@/lib/download'
import { copyImageToClipboard } from '@/lib/clipboard'
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

/* ---- AI 生成 skill 包 ---- */

/** AI 设置独立成 tab 后，这里只读配置：总开关关着就让按钮置灰 */
const aiConfig = ref<AiConfig>(loadAiConfig())
const aiActive = computed(() => isAiActive(aiConfig.value))
const aiGenerating = ref(false)
/** 模型这回自己写的一句说明 */
const aiNote = ref('')
/** 当前包的来源：本地推导 / AI 生成（界面上标一下，手工改过也还是这个来源） */
const bundleSource = ref<SkillBundleSource>('local')

/* ---- 手工编辑 ---- */

const editing = ref(false)
const editText = ref('')
const addingFile = ref(false)
const newFilePath = ref('')

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

  // 分组规则之外的文件（AI 新增的 10-matchup.md / 手工加的文件）落到「自定义」
  const known = (name: string) =>
    name === 'manifest.json' ||
    name === '00-router.md' ||
    name.startsWith('line-') ||
    name.startsWith('20-') ||
    name.startsWith('90-') ||
    name.startsWith('cards/')

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
    { id: 'other', label: '自定义', files: take((name) => !known(name)) },
  ].filter((group) => group.files.length)
})

const currentText = computed(() => {
  const current = bundle.value
  if (!current || !currentPath.value) return ''
  return current.files[currentPath.value] ?? ''
})

function selectFile(path: string) {
  currentPath.value = path
  // 换文件时丢掉未保存的手改，避免把 A 的修改写进 B
  editing.value = false
  editText.value = ''
}

const dirty = computed(() => editing.value && editText.value !== currentText.value)

function startEdit() {
  if (!bundle.value || !currentPath.value) return
  editText.value = currentText.value
  editing.value = true
}

function cancelEdit() {
  editing.value = false
  editText.value = ''
}

/** 保存手改：写回 `bundle.files` 并落盘，下次进页面还在 */
function saveEdit() {
  const current = bundle.value
  if (!current || !currentPath.value) return
  current.files[currentPath.value] = editText.value
  editing.value = false
  editText.value = ''
  persistBundle()
  toast('已保存修改')
}

function openAddFile() {
  if (!bundle.value) return
  newFilePath.value = `${bundle.value.dir}/`
  addingFile.value = true
}

/** 新增文件：路径允许写相对名（自动补 `<dir>/`），同名则直接打开编辑 */
function confirmAddFile() {
  const current = bundle.value
  if (!current) return
  const raw = newFilePath.value.trim().replace(/\\/g, '/').replace(/^\/+/, '')
  if (!raw) return
  const path = raw.startsWith(`${current.dir}/`) ? raw : `${current.dir}/${raw}`
  if (path.includes('..')) {
    toast('文件名不合法', true)
    return
  }
  if (current.files[path] === undefined) current.files[path] = ''
  currentPath.value = path
  addingFile.value = false
  newFilePath.value = ''
  editText.value = current.files[path]
  editing.value = true
  persistBundle()
  if (!current.files[path]) toast('已新增文件，写点内容再保存')
}

/** 把当前包 + 全量文档存到本地，刷新 / 切 tab 后还能看到（再次生成才会覆盖） */
function persistBundle(source: SkillBundleSource = bundleSource.value) {
  const current = bundle.value
  const deckId = deckStore.currentDeckId
  if (!current || !deckId) return
  bundleSource.value = source
  saveSkillBundle(deckId, current, source, skillText.value)
}

/** 进入页面 / 切卡组时恢复存档：包不会再因为切 tab 而消失 */
function restoreBundle() {
  const deckId = deckStore.currentDeckId
  const saved = deckId ? loadSkillBundle(deckId) : null
  editing.value = false
  editText.value = ''
  aiNote.value = ''
  if (!saved) {
    bundle.value = null
    skillText.value = ''
    currentPath.value = ''
    bundleSource.value = 'local'
    return
  }
  bundle.value = {
    files: { ...saved.files },
    manifest: saved.manifest,
    zipName: saved.zipName,
    dir: saved.dir,
  }
  skillText.value = saved.fullText || ''
  bundleSource.value = saved.source
  const router = `${saved.dir}/00-router.md`
  currentPath.value = saved.files[router] !== undefined ? router : Object.keys(saved.files).sort()[0] ?? ''
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

watch(() => deckStore.currentDeckId, async () => {
  await refresh()
  restoreBundle()
})

onMounted(async () => {
  // 卡名解析依赖卡库；没就绪时先拉一次，日志里的卡名才不会全是 #编号
  if (cardStore.status !== 'ready') void cardStore.init()
  await refresh()
  restoreBundle()
})

/* ---------------- 展开链长图 ---------------- */

const chainBusy = ref('')
const chainModal = ref(false)
const chainUrl = ref('')
const chainBlob = ref<Blob | null>(null)
const chainCopying = ref(false)
const chainBase = ref({ deck: '', replay: '' })

const chainMeta = computed(() => {
  const blob = chainBlob.value
  if (!blob) return ''
  return `${Math.round(blob.size / 1024)} KB · ${blob.type.replace('image/', '').toUpperCase()}`
})

/* ---- 检索网络图（聚合当前卡组的全部录像） ---- */

const flowBusy = ref(false)
const flowModal = ref(false)
const flowCopying = ref(false)
/** 画的是整副卡组（合并全部录像）还是单份录像 */
const flowScope = ref<'deck' | 'replay'>('deck')
const flowBase = ref('deck')
/** 画好的场景（卡图已预加载），聚焦时只在同一张 canvas 上重画 */
const flowScene = shallowRef<FlowPosterScene | null>(null)
/** 当前聚焦的卡名，空串 = 全图 */
const flowFocus = ref('')
const flowHost = ref<HTMLDivElement | null>(null)

onUnmounted(() => {
  if (chainUrl.value) URL.revokeObjectURL(chainUrl.value)
  flowScene.value?.canvas.removeEventListener('click', onFlowClick)
})

/* ---- 手坑报告（单份录像 + 卡组维度） ---- */

const reportModal = ref(false)

/** 手坑规则升过版的录像不进报告：旧规则算出来的命中步数是错的 */
const reportSources = computed(() =>
  bindings.value
    .filter((item) => item.analysis?.ok && !staleHits(item))
    .map((item) => ({ id: item.id, name: item.name, analysis: item.analysis })),
)

const handtrapReport = computed(() => buildHandtrapReport(reportSources.value))

const reportSkipped = computed(
  () => bindings.value.filter((item) => item.analysis?.ok && staleHits(item)).length,
)

/** 报告有两种范围：卡组维度（全部录像）/ 单份录像 */
const reportScope = ref<'deck' | 'replay'>('deck')
const reportReplayId = ref('')

const reportRow = computed(
  () => handtrapReport.value.rows.find((row) => row.id === reportReplayId.value) ?? null,
)

/** 抽卡型手坑（增殖的 G / 欢聚友伴）只在单份录像里有，不进卡组维度 */
const reportDrawTurns = computed(() => {
  if (reportScope.value !== 'replay') return []
  const item = bindings.value.find((binding) => binding.id === reportReplayId.value)
  return item?.analysis?.ok ? (item.analysis.drawHandtraps ?? []) : []
})

function openDeckReport() {
  reportScope.value = 'deck'
  reportReplayId.value = ''
  reportModal.value = true
}

function openReplayReport(item: ReplayBindingMeta) {
  reportScope.value = 'replay'
  reportReplayId.value = item.id
  reportModal.value = true
}

function downloadHandtrapReport() {
  const row = reportRow.value
  if (reportScope.value === 'replay' && row) {
    downloadText(
      `${row.name}-手坑报告.md`,
      replayHandtrapReportMarkdown(deckName.value, row, reportDrawTurns.value),
      'text/markdown;charset=utf-8',
    )
    return
  }
  downloadText(
    `${deckName.value}-手坑报告.md`,
    handtrapReportMarkdown(deckName.value, handtrapReport.value),
    'text/markdown;charset=utf-8',
  )
}

/** 单份报告里「这个手坑占本展开步数」的比例 */
function reportPercent(steps: number): string {
  const total = reportRow.value?.steps ?? 0
  return total ? `${((steps / total) * 100).toFixed(1)}%` : '0.0%'
}

/** 进度条宽度：0 也留一点，免得看起来像没数据 */
function reportShare(steps: number): string {
  const total = reportRow.value?.steps ?? 0
  if (!total) return '3%'
  return `${Math.max(3, Math.min(100, (steps / total) * 100))}%`
}

/* ---- 录像改名 ---- */

const renamingId = ref('')
const renameValue = ref('')

function startRename(item: ReplayBindingMeta) {
  renamingId.value = item.id
  renameValue.value = item.name
}

function cancelRename() {
  renamingId.value = ''
  renameValue.value = ''
}

async function commitRename() {
  const id = renamingId.value
  const name = renameValue.value.trim()
  if (!id || !name) {
    cancelRename()
    return
  }
  await renameReplayBinding(id, name)
  cancelRename()
  await refresh()
}

/**
 * inline 输入框挂上就聚焦并全选，省得再点一次。
 *
 * 函数 ref 每次重渲染都会重跑（`v-model` 每敲一个字就渲染一次），
 * 所以必须记住已经处理过的元素 —— 否则每输入一个字都会被 `select()` 全选。
 */
let renameInputEl: HTMLInputElement | null = null

function focusRenameInput(el: unknown) {
  if (!(el instanceof HTMLInputElement)) {
    if (renameInputEl) renameInputEl = null
    return
  }
  if (renameInputEl === el) return
  renameInputEl = el
  el.focus()
  el.select()
}

/** 卡名 → 卡号：图里的卡图靠它 */
function cardIdByName(name: string): number | undefined {
  const current = deck.value
  if (!current) return undefined
  return [...current.main, ...current.extra, ...current.side].find((entry) => entry.name === name)?.id
}

async function exportChainPoster(item: ReplayBindingMeta) {
  if (chainBusy.value) return
  const analysis = item.analysis
  if (!analysis?.ok) {
    toast('这份录像还没解析成功，先点「重新解析」', true)
    return
  }
  chainBusy.value = item.id
  try {
    if (cardStore.status !== 'ready') await cardStore.init()
    const blob = await renderComboChainPoster({
      deckName: deck.value?.name || item.deckName || '未命名卡组',
      replayName: item.name,
      analysis,
      cardIdOf: cardIdByName,
      nameOf,
    })
    if (chainUrl.value) URL.revokeObjectURL(chainUrl.value)
    chainBase.value = { deck: deck.value?.name || item.deckName || 'deck', replay: item.name }
    chainBlob.value = blob
    chainUrl.value = URL.createObjectURL(blob)
    chainModal.value = true
  } catch (error) {
    toast(error instanceof Error ? error.message : '生成展开链长图失败', true)
  } finally {
    chainBusy.value = ''
  }
}

function closeChain() {
  chainModal.value = false
  if (chainUrl.value) {
    URL.revokeObjectURL(chainUrl.value)
    chainUrl.value = ''
  }
  chainBlob.value = null
}

function downloadChain() {
  const blob = chainBlob.value
  if (!blob) return
  downloadBlob(blob, chainPosterFileName(chainBase.value.deck, chainBase.value.replay, blob))
  toast(`已保存展开链长图（${Math.round(blob.size / 1024)} KB）`)
}

async function copyChain() {
  const blob = chainBlob.value
  if (!blob || chainCopying.value) return
  chainCopying.value = true
  try {
    await copyImageToClipboard(blob)
    toast('已复制到剪贴板，去微信直接粘贴发送')
  } catch (error) {
    toast(error instanceof Error ? error.message : '复制失败，请改用下载', true)
  } finally {
    chainCopying.value = false
  }
}

/**
 * 取一份录像的 `flows`。
 *
 * 旧缓存没有 `flows`（这一项是新加的），或是旧归因规则跑出来的，
 * 这里按需重放一次并写回缓存 —— 点了就有图，不用先去点「重新解析」。
 */
async function loadReplayFlows(meta: ReplayBindingMeta): Promise<ReplayFlow[] | null> {
  const record = await loadReplayBinding(meta.id)
  if (!record) return null
  let analysis = record.analysis ?? null
  if (!analysis?.ok || !analysis.flows || analysis.flowVersion !== FLOW_VERSION) {
    try {
      analysis = await analyzeReplay(record.bytes, nameOf)
    } catch {
      analysis = null
    }
    if (analysis) await saveReplayAnalysis(meta.id, { analysis })
  }
  return analysis?.ok ? (analysis.flows ?? []) : null
}

/** 画图 + 打开弹窗；没抓到连线时提示并返回 false */
async function openFlowPoster(
  cards: { id: number; name: string }[],
  flows: ReplayFlow[],
  replayCount: number,
  baseName: string,
  scope: 'deck' | 'replay',
): Promise<boolean> {
  if (!flows.length) {
    toast('这些录像里没抓到卡与卡之间的区域转移', true)
    return false
  }
  progress.value = '正在绘制检索网络…'
  await nextTick()
  const scene = await prepareFlowPoster({
    deckName: deck.value?.name || '未命名卡组',
    cards,
    flows,
    replayCount,
  })
  flowScope.value = scope
  flowBase.value = baseName || 'deck'
  flowScene.value?.canvas.removeEventListener('click', onFlowClick)
  flowScene.value = scene
  flowFocus.value = ''
  flowModal.value = true
  await nextTick()
  mountFlow()
  return true
}

/** 检索图（卡组维度）：把全部录像的「卡 → 卡 + 区域转移」合并成一张圆图 */
async function exportFlowGraph() {
  if (flowBusy.value || generating.value) return
  const current = deck.value
  if (!current) {
    toast('先选一套卡组', true)
    return
  }
  if (!bindings.value.length) {
    toast('这套卡组还没有录像，先在 combo 推演里打一局或导入 .yrp', true)
    return
  }
  const cards = [...current.main, ...current.extra].map((entry) => ({ id: entry.id, name: entry.name }))
  if (cards.length < 2) {
    toast('卡组是空的，画不出检索图', true)
    return
  }

  flowBusy.value = true
  try {
    if (cardStore.status !== 'ready') {
      progress.value = '正在准备卡库…'
      await cardStore.init()
    }
    const merged = new Map<string, ReplayFlow>()
    let usable = 0

    for (let index = 0; index < bindings.value.length; index += 1) {
      const meta = bindings.value[index]
      progress.value = `正在分析检索关系 ${index + 1}/${bindings.value.length}：${meta.name}`
      const flows = await loadReplayFlows(meta)
      if (!flows) continue
      usable += 1
      for (const flow of flows) {
        const key = `${flow.source}|${flow.target}|${flow.from}|${flow.to}`
        const exist = merged.get(key)
        if (exist) exist.count += flow.count
        else merged.set(key, { ...flow })
      }
    }

    if (!usable) {
      toast('没有可用的录像解析结果，先确认录像能解析成功', true)
      return
    }

    await openFlowPoster(cards, [...merged.values()], usable, current.name || 'deck', 'deck')
  } catch (error) {
    toast(error instanceof Error ? error.message : '生成检索图失败', true)
  } finally {
    flowBusy.value = false
    progress.value = ''
    await refresh()
  }
}

/** 检索图（单份录像）：只看这一条展开里的「卡 → 卡」关系 */
async function exportReplayFlowGraph(item: ReplayBindingMeta) {
  if (flowBusy.value || generating.value) return
  const current = deck.value
  if (!current) {
    toast('先选一套卡组', true)
    return
  }
  const cards = [...current.main, ...current.extra].map((entry) => ({ id: entry.id, name: entry.name }))
  if (cards.length < 2) {
    toast('卡组是空的，画不出检索图', true)
    return
  }

  flowBusy.value = true
  try {
    if (cardStore.status !== 'ready') {
      progress.value = '正在准备卡库…'
      await cardStore.init()
    }
    progress.value = `正在分析检索关系：${item.name}`
    const flows = await loadReplayFlows(item)
    if (!flows) {
      toast('这份录像还没解析成功，先点「重新解析」', true)
      return
    }
    await openFlowPoster(cards, flows, 1, item.name, 'replay')
  } catch (error) {
    toast(error instanceof Error ? error.message : '生成检索图失败', true)
  } finally {
    flowBusy.value = false
    progress.value = ''
    await refresh()
  }
}

/** 把场景的 canvas 挂进弹窗；每次打开都要重绑一次点击 */
function mountFlow() {
  const host = flowHost.value
  const scene = flowScene.value
  if (!host || !scene) return
  scene.render('')
  host.replaceChildren(scene.canvas)
  scene.canvas.addEventListener('click', onFlowClick)
}

/**
 * 点卡片 = 聚焦：只留这张卡和它的直接关联，其余的卡与线压暗。
 * 再点同一张（或点空白）恢复全图。
 */
function onFlowClick(event: MouseEvent) {
  const scene = flowScene.value
  if (!scene) return
  const rect = scene.canvas.getBoundingClientRect()
  if (!rect.width || !rect.height) return
  const hit = scene.cardAt((event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height)
  const next = hit === flowFocus.value ? '' : hit
  if (next === flowFocus.value) return
  flowFocus.value = next
  scene.render(next)
}

function closeFlow() {
  flowScene.value?.canvas.removeEventListener('click', onFlowClick)
  flowHost.value?.replaceChildren()
  flowScene.value = null
  flowFocus.value = ''
  flowModal.value = false
}

async function downloadFlow() {
  const scene = flowScene.value
  if (!scene) return
  const blob = await scene.toBlob()
  downloadBlob(blob, flowPosterFileName(flowBase.value, blob))
  toast(`已保存检索图（${Math.round(blob.size / 1024)} KB）`)
}

async function copyFlow() {
  const scene = flowScene.value
  if (!scene || flowCopying.value) return
  flowCopying.value = true
  try {
    await copyImageToClipboard(await scene.toBlob())
    toast('已复制到剪贴板，去微信直接粘贴发送')
  } catch (error) {
    toast(error instanceof Error ? error.message : '复制失败，请改用下载', true)
  } finally {
    flowCopying.value = false
  }
}

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
  // 已生成的包不跟着录像一起消失：它是独立产物，重新生成才会被覆盖
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
 * 逐份回放录像，拿到 skill 需要的输入。
 * 回放结果缓存在 IndexedDB 里，只有 force 或没缓存时才真的重跑内核。
 */
async function collectInputs(force: boolean): Promise<SkillBindingInput[]> {
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
  return inputs
}

/**
 * 本地推导 skill 包。
 *
 * 生成过程中**不清空旧包**：失败或中途退出时，上一次的结果与手工修改都还在，
 * 只有成功推导出新的包才会覆盖（并落盘）。
 */
async function generate(force: boolean) {
  const current = deck.value
  if (!current || generating.value || aiGenerating.value || flowBusy.value) return
  generating.value = true
  try {
    const inputs = await collectInputs(force)

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
    editing.value = false
    aiNote.value = ''
    persistBundle('local')

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

/**
 * AI 生成 skill 包。
 *
 * 本地包（卡组 / 录像 / 卡效切片）先照常推导一份当底稿，再把「卡组 + 录像分片 +
 * 手坑报告」交给模型；模型只输出要新增或改写的文件，合并进底稿。
 * 模型失败时不动现有包，避免把手工改过的内容冲掉。
 */
async function generateWithAi() {
  const current = deck.value
  if (!current || aiGenerating.value || generating.value || flowBusy.value) return
  if (!aiActive.value) {
    toast('先到「AI 设置」页开启 AI 并填写密钥', true)
    return
  }
  aiGenerating.value = true
  try {
    const inputs = await collectInputs(false)
    const payload = skillInput(inputs)
    if (!payload) return
    progress.value = '正在整理卡组、录像与手坑报告…'
    await nextTick()
    const base = buildSkillBundle(payload)

    progress.value = 'AI 正在编写 skill 包…（可能要一两分钟）'
    await nextTick()
    const result = await generateSkillBundleWithAi(payload, base, aiConfig.value)
    const files = { ...base.files, ...result.files }
    bundle.value = { ...base, files }
    // 全量文档也跟着重建，保证两个页签看到的是同一套内容
    skillText.value = buildSkillMarkdown(payload)
    view.value = 'bundle'
    const router = `${base.dir}/00-router.md`
    currentPath.value = files[router] !== undefined ? router : Object.keys(files).sort()[0] ?? ''
    editing.value = false
    aiNote.value = result.note
    persistBundle('ai')
    toast(`AI 已改写 / 新增 ${Object.keys(result.files).length} 个文件`)
  } catch (error) {
    toast(error instanceof Error ? error.message : 'AI 生成 skill 包失败', true)
  } finally {
    aiGenerating.value = false
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
  // 编辑中的内容按屏幕上看到的导出，避免「看着改了、导出还是旧的」
  downloadText(name, editing.value ? editText.value : currentText.value)
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
        <h1 class="page-title">对战分析</h1>
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
        <button
          class="btn"
          :disabled="flowBusy || generating || !deck || !bindings.length"
          title="把当前卡组全部录像里的「卡 → 卡」区域转移画成一张圆图"
          @click="exportFlowGraph"
        >
          {{ flowBusy ? '分析中…' : '检索图' }}
        </button>
        <button
          class="btn"
          :disabled="!handtrapReport.replays"
          :title="
            reportSkipped
              ? `有 ${reportSkipped} 份录像的手坑分析已过期，先点「重新解析」`
              : '统计每条展开的步数，以及各个手坑能卡住几步'
          "
          @click="openDeckReport"
        >
          手坑报告
        </button>
        <button
          class="btn"
          :disabled="aiGenerating || generating || !deck || !aiActive"
          :title="
            aiActive
              ? '把卡组、录像与手坑报告发给 AI，让它改写 / 补全 skill 包'
              : 'AI 未开启：先到「AI 设置」页打开总开关并填写密钥'
          "
          @click="generateWithAi"
        >
          {{ aiGenerating ? 'AI 生成中…' : 'AI 生成 skill 包' }}
        </button>
        <button
          class="btn primary"
          :disabled="generating || aiGenerating || !deck"
          @click="generate(false)"
        >
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
      <span v-if="bundle" class="chip" :class="{ gold: bundleSource === 'ai' }">
        {{ bundleSource === 'ai' ? 'AI 生成' : '本地生成' }} · {{ Object.keys(bundle.files).length }} 个文件
      </span>
      <span v-if="(flowBusy || generating || aiGenerating) && progress" class="chip amber">
        {{ progress }}
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
              <div v-if="renamingId === item.id" class="replay-rename">
                <input
                  :ref="focusRenameInput"
                  v-model="renameValue"
                  class="input"
                  spellcheck="false"
                  @keydown.enter.prevent="commitRename"
                  @keydown.esc.prevent="cancelRename"
                  @blur="commitRename"
                />
                <button class="btn xs" @click="commitRename">保存</button>
                <!-- mousedown 拦下焦点转移：否则 blur 会先把名字提交掉 -->
                <button class="btn xs ghost" @mousedown.prevent="cancelRename">取消</button>
              </div>
              <div v-else class="replay-name" :title="item.name">{{ item.name }}</div>
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
              <!-- 按钮跟在「手坑点 N 处」这一行右边：名称下方的空白别浪费 -->
              <div class="replay-foot">
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
                <div class="replay-actions">
                  <button
                    class="btn xs ghost"
                    :disabled="!item.analysis?.ok || generating || !!chainBusy"
                    :title="item.analysis?.ok ? '把这条展开画成一张竖版长图' : '解析成功后才能生成展开图'"
                    @click="exportChainPoster(item)"
                  >
                    {{ chainBusy === item.id ? '生成中…' : '展开图' }}
                  </button>
                  <button
                    class="btn xs ghost"
                    :disabled="flowBusy || generating || !!chainBusy"
                    title="只看这份录像里的卡与卡关系"
                    @click="exportReplayFlowGraph(item)"
                  >
                    检索图
                  </button>
                  <button class="btn xs ghost" title="改录像名" @click="startRename(item)">改名</button>
                  <button
                    class="btn xs ghost"
                    :disabled="!item.analysis?.ok || staleHits(item)"
                    title="这条展开一共几步、哪几步会吃手坑"
                    @click="openReplayReport(item)"
                  >
                    手坑报告
                  </button>
                  <button
                    class="btn xs ghost"
                    :title="`导出 ${replayFileName(item.name)}`"
                    @click="exportReplay(item)"
                  >
                    导出
                  </button>
                  <button class="btn xs danger" :disabled="generating" @click="remove(item)">移除</button>
                </div>
              </div>
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
            <template v-if="editing">
              <button class="btn xs primary" :disabled="!dirty" @click="saveEdit">保存修改</button>
              <button class="btn xs ghost" @click="cancelEdit">取消</button>
            </template>
            <template v-else>
              <button class="btn xs" :disabled="!bundle" @click="startEdit">编辑</button>
              <button class="btn xs" :disabled="!currentText" @click="copyCurrent">复制</button>
              <button class="btn xs" :disabled="!currentText" @click="downloadCurrent">
                下载当前文件
              </button>
            </template>
            <button class="btn xs" :disabled="!bundle" @click="openAddFile">新增文件</button>
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
              <br />在「AI 设置」页开启 AI 后，还可以点「AI 生成 skill 包」：把卡组、录像与手坑报告发给模型，
              让它改写或补写文件。
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
              <div class="skill-edit">
                <div class="skill-note">
                  <span class="chip" :class="{ gold: bundleSource === 'ai' }">
                    {{ bundleSource === 'ai' ? 'AI 生成' : '本地生成' }}
                  </span>
                  <span v-if="aiNote" class="skill-note-text">{{ aiNote }}</span>
                  <span class="skill-note-text">
                    已存在本机浏览器，重新点生成才会覆盖；文件可直接编辑或新增。
                  </span>
                </div>
                <div v-if="addingFile" class="skill-add-row">
                  <input
                    v-model="newFilePath"
                    class="input"
                    spellcheck="false"
                    :placeholder="`${bundle.dir}/10-matchup.md`"
                    @keydown.enter.prevent="confirmAddFile"
                  />
                  <button class="btn xs primary" @click="confirmAddFile">新增</button>
                  <button class="btn xs ghost" @click="addingFile = false">取消</button>
                </div>
                <textarea
                  v-if="editing"
                  v-model="editText"
                  class="skill-editor"
                  spellcheck="false"
                  :aria-label="`编辑 ${currentPath}`"
                />
                <pre v-else class="skill-preview">{{ currentText }}</pre>
              </div>
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

    <div v-if="chainModal" class="overlay center" @click.self="closeChain">
      <div class="modal poster-modal">
        <div class="modal-head">
          <div>
            <div style="font-size: 14px; font-weight: 600">展开链长图</div>
            <div class="inline-note">{{ chainMeta }} · 复制后可直接粘进微信</div>
          </div>
          <button class="icon-btn" aria-label="关闭" @click="closeChain">✕</button>
        </div>
        <div class="modal-body poster-body">
          <div class="poster-preview">
            <img v-if="chainUrl" :src="chainUrl" alt="展开链长图预览" />
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn ghost" @click="closeChain">关闭</button>
          <button class="btn" @click="downloadChain">下载图片</button>
          <button class="btn primary" :disabled="chainCopying" @click="copyChain">
            {{ chainCopying ? '复制中…' : '复制到剪贴板' }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="flowModal" class="overlay center" @click.self="closeFlow">
      <div class="modal poster-modal">
        <div class="modal-head">
          <div>
            <div style="font-size: 14px; font-weight: 600">
              {{ flowScope === 'deck' ? '检索网络图 · 卡组维度' : '检索网络图 · 单份录像' }}
            </div>
            <div class="inline-note">
              {{ flowBase }} · 线的颜色 = 区域转移类型，连线方向 = 从来源卡到被移动的卡 ·
              {{ flowFocus ? `正在看「${flowFocus}」，再点一次取消` : '点一张卡只看它的关联' }}
            </div>
          </div>
          <button class="icon-btn" aria-label="关闭" @click="closeFlow">✕</button>
        </div>
        <div class="modal-body poster-body">
          <div ref="flowHost" class="poster-preview flow-preview"></div>
        </div>
        <div class="modal-foot">
          <button class="btn ghost" @click="closeFlow">关闭</button>
          <button class="btn" @click="downloadFlow">下载图片</button>
          <button class="btn primary" :disabled="flowCopying" @click="copyFlow">
            {{ flowCopying ? '复制中…' : '复制到剪贴板' }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="reportModal" class="overlay center" @click.self="reportModal = false">
      <div class="modal report-modal">
        <div class="modal-head">
          <div>
            <div style="font-size: 14px; font-weight: 600">
              {{ reportScope === 'deck' ? '手坑报告 · 卡组维度' : '手坑报告 · 单份录像' }}
            </div>
            <div v-if="reportScope === 'deck'" class="inline-note">
              {{ handtrapReport.replays }} 份录像 · 共 {{ handtrapReport.steps }} 步 · 平均
              {{ handtrapReport.averageSteps }} 步/份
              <template v-if="reportSkipped"> · 另有 {{ reportSkipped }} 份手坑分析已过期，未计入</template>
            </div>
            <div v-else class="inline-note">
              {{ reportRow?.name }} · 展开 {{ reportRow?.steps ?? 0 }} 步 · 其中
              {{ reportRow?.hitSteps ?? 0 }} 步会被手坑打断
            </div>
          </div>
          <button class="icon-btn" aria-label="关闭" @click="reportModal = false">✕</button>
        </div>
        <div class="modal-body report-body">
          <template v-if="reportScope === 'deck'">
            <div v-if="!handtrapReport.handtraps.length" class="empty-block">
              这些录像里还没抓到可判定的手坑点。
            </div>
            <div v-else class="report-list">
              <div v-for="item in handtrapReport.handtraps" :key="item.id" class="report-row">
                <img class="report-thumb" :src="handtrapCardImage(item.id)" alt="" loading="lazy" />
                <div class="report-name">{{ item.name }}</div>
                <div class="report-bar">
                  <i :style="{ width: `${Math.max(3, item.rate * 100)}%` }"></i>
                </div>
                <div class="report-value">{{ item.steps }} 步 · {{ (item.rate * 100).toFixed(1) }}%</div>
                <div class="report-note">
                  最早第 {{ item.firstStep }} 步 · {{ item.replays }} 份录像<template v-if="item.dodged">
                    · {{ item.dodged }} 次被自排连锁规避</template
                  >
                </div>
              </div>
            </div>
          </template>
          <template v-else>
            <div v-if="!reportRow" class="empty-block">这份录像没有可用的手坑分析，先点「重新解析」。</div>
            <template v-else>
              <div v-if="!reportRow.byHandtrap.length" class="empty-block">
                这条展开里没有可统计的打断型手坑点（尼比鲁 / 锁鸟 不计入报告）。
              </div>
              <div v-else class="report-list">
                <div v-for="hit in reportRow.byHandtrap" :key="hit.id" class="report-row">
                  <img class="report-thumb" :src="handtrapCardImage(hit.id)" alt="" loading="lazy" />
                  <div class="report-name">{{ hit.name }}</div>
                  <div class="report-bar">
                    <i :style="{ width: reportShare(hit.steps) }"></i>
                  </div>
                  <div class="report-value">{{ hit.steps }} 步 · {{ reportPercent(hit.steps) }}</div>
                  <div class="report-note">
                    最早第 {{ hit.firstStep }} 步<template v-if="hit.dodged">
                      · {{ hit.dodged }} 次被自排连锁规避</template
                    >
                  </div>
                </div>
              </div>

              <div v-if="reportDrawTurns.length" class="report-section">
                <div class="report-section-title">抽卡型手坑（假设对手持有）</div>
                <div class="inline-note">
                  它们不打断展开，只统计「对手在这一刻发动，这回合还会喂给他几张卡」。
                </div>
                <div v-for="turn in reportDrawTurns" :key="turn.turn" class="report-draw-turn">
                  <div class="report-draw-head">第 {{ turn.turn }} 回合 · 我方登场 {{ turn.spawns }} 次</div>
                  <div v-for="stat in turn.stats" :key="stat.id" class="report-draw-row">
                    <img class="report-thumb report-thumb-sm" :src="handtrapCardImage(stat.id)" alt="" loading="lazy" />
                    <span class="report-draw-name">{{ stat.name }}</span>
                    <span class="report-draw-value">对手抽 {{ stat.draws }} 张</span>
                  </div>
                </div>
              </div>
            </template>
          </template>
        </div>
        <div class="modal-foot">
          <button class="btn ghost" @click="reportModal = false">关闭</button>
          <button class="btn primary" @click="downloadHandtrapReport">导出 Markdown</button>
        </div>
      </div>
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

/* 「手坑点 N 处」与操作按钮同一行：按钮贴着名称下方的右侧空白 */
.replay-foot {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  margin-top: 6px;
}

.replay-foot .replay-hits {
  min-width: 0;
  margin-top: 0;
}

.replay-actions {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
  margin-left: auto;
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

.skill-edit {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.skill-note {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--text-mute);
}

.skill-note-text {
  line-height: 1.6;
}

.skill-add-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.skill-add-row .input {
  flex: 1;
  min-width: 0;
  font-family: var(--mono);
  font-size: 12px;
}

.skill-editor {
  width: 100%;
  min-height: 64vh;
  max-height: 64vh;
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

/* ---- 手坑报告 ---- */
.report-modal {
  width: min(760px, 100%);
}

.report-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.report-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.report-row {
  display: grid;
  grid-template-columns: 26px minmax(84px, 0.9fr) minmax(60px, 1.6fr) minmax(90px, 0.8fr);
  grid-template-areas:
    'thumb name bar value'
    'thumb note note note';
  align-items: center;
  gap: 4px 10px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-2);
}

.report-thumb {
  grid-area: thumb;
  align-self: center;
  width: 26px;
  height: 38px;
  border-radius: 3px;
  object-fit: cover;
  background: rgba(255, 255, 255, 0.04);
}

.report-thumb-sm {
  width: 22px;
  height: 32px;
}

.report-name {
  grid-area: name;
  font-size: 12px;
  font-weight: 600;
}

.report-bar {
  grid-area: bar;
  height: 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.07);
  overflow: hidden;
}

.report-bar i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--gold), #ff8f5e);
}

.report-value {
  grid-area: value;
  text-align: right;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-dim);
}

.report-note {
  grid-area: note;
  font-size: 11px;
  color: var(--text-mute);
}

/* ---- 抽卡型手坑（单份报告的第二块） ---- */
.report-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px dashed var(--line);
}

.report-section-title {
  font-size: 12px;
  font-weight: 600;
}

.report-draw-turn {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-2);
}

.report-draw-head {
  font-size: 11px;
  color: var(--text-mute);
}

.report-draw-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
}

.report-draw-name {
  min-width: 132px;
  font-weight: 600;
}

.report-draw-value {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--gold);
}

.replay-rename {
  display: flex;
  align-items: center;
  gap: 6px;
}

.replay-rename .input {
  flex: 1;
  min-width: 0;
  padding: 4px 8px;
  font-size: 12px;
}
</style>
