<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { OcgDuelMode, OcgLocation, OcgMessageType, OcgResponseType, type OcgResponse } from 'ocgcore-wasm'
import { useDeckStore } from '@/stores/deck'
import { useCardStore } from '@/stores/cards'
import { cardImageUrl } from '@/lib/cardDb'
import { DuelSession } from '@/lib/duel/session'
import { buildReplay, downloadReplay } from '@/lib/duel/yrp'
import { bindReplay } from '@/lib/replayStore'
import { isAttackPosition, isFaceDown, positionLabel, zoneLabel } from '@/lib/duel/labels'
import { autoRespond } from '@/lib/duel/auto'
import { buildSlotHints, placeOptions, selectRange, slotKey, type DuelCommand, type SlotHint } from '@/lib/duel/interaction'
import {
  deckFingerprint,
  loadCheckpoints,
  removeCheckpoint,
  saveCheckpoint,
  seedToStrings,
  stringsToSeed,
  type DuelCheckpoint,
} from '@/lib/duel/checkpoint'
import type { DuelCardView, DuelDeck, DuelEvent, DuelPlayerId, DuelQuestion } from '@/lib/duel/types'
import { useHandtrapStore } from '@/stores/handtraps'
import { AgentRunner, type AgentStats, type AgentStatus, type AgentTrace } from '@/lib/ai/agent'
import type { Plan } from '@/lib/ai/prompt'
import { isAiActive, loadAiConfig, type AiConfig } from '@/lib/ai/config'
import { buildSkillSource, type SkillSource } from '@/lib/ai/skillContext'
import { renderBoard } from '@/lib/ai/board'
import { buildSkillBundle } from '@/lib/skillBundle'
import { listReplayBindings } from '@/lib/replayStore'
import { downloadText } from '@/lib/toast'
import type { SkillBindingInput, SkillInput } from '@/lib/skill'
import DuelQuestionPanel from '@/components/duel/DuelQuestionPanel.vue'

const deckStore = useDeckStore()
const cardStore = useCardStore()
const handtrapStore = useHandtrapStore()

const session = shallowRef<DuelSession | null>(null)
const version = ref(0)
const starting = ref(false)
const errorText = ref('')
const handSize = ref(5)
const showLog = ref(true)
/** 自选起手：按点击顺序进手牌，最多 handSize 张 */
const openingPicks = ref<number[]>([])
const pickerOpen = ref(false)

/** 导出录像需要和开局一模一样的种子 */
const currentSeed = ref<[bigint, bigint, bigint, bigint]>(randomSeed())
/** 开局时用的未洗卡组：暂存要靠它 + 种子复现洗牌结果 */
const activeDeck = ref<DuelDeck>({ main: [], extra: [] })

/** 全屏沉浸模式：开打之后场地铺满视口，HUD 提供重开 / 暂存 / 结束 */
const immersive = ref(false)
/** 当前卡组自己的暂存，卡组 / 卡表变化时由 refreshCheckpoints() 重算 */
const checkpoints = ref<DuelCheckpoint[]>([])
const checkpointOpen = ref(false)
/** 结束对局的确认（顺便问要不要导出 .yrp） */
const endConfirm = ref(false)
const toast = ref('')
let toastTimer: ReturnType<typeof setTimeout> | null = null

function showToast(text: string) {
  toast.value = text
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.value = ''
  }, 2200)
}

const snapshot = computed(() => {
  version.value
  return session.value?.snapshot() ?? null
})

const state = computed(() => snapshot.value?.state ?? null)
const question = computed<DuelQuestion | null>(() => snapshot.value?.question ?? null)
const hintText = computed(() => snapshot.value?.hint ?? '')
const logs = computed(() => [...(snapshot.value?.logs ?? [])].reverse())

const canExport = computed(() => {
  version.value
  return Boolean(session.value && session.value.responses.length)
})

const sessionError = computed(() => snapshot.value?.error ?? '')
/** 正在回放暂存：界面只显示"自动操作到存档点" */
const replaying = computed(() => snapshot.value?.replaying ?? false)

/** 内核亮牌（确认卡组顶 / 确认卡片）时提示一下，免得「堆墓」看起来像凭空发生 */
watch(
  () => snapshot.value?.reveal?.id,
  () => {
    const reveal = snapshot.value?.reveal
    if (reveal?.names.length) showToast(`确认：${reveal.names.join('、')}`)
  },
)

const nameMap = computed(() => new Map(cardStore.cards.map((card) => [card.id, card.name])))
const nameOf = (code: number) => nameMap.value.get(code) || `#${code}`

/**
 * 选项 / 提示的描述 id：
 *   < 10000  strings.conf 的 !system 文本（如 1100「魔陷破坏」）
 *   否则     aux.Stringid(code, n) = code << 20 | n，取该卡效果文本的第 n 条
 */
function describeOption(raw: bigint | number): string {
  const id = Number(raw)
  if (!Number.isFinite(id) || id <= 0) return ''
  const system = session.value?.systemText(id)
  if (system) return system
  const code = Math.floor(id / 0x100000)
  const index = id % 0x100000
  const fromKernel = session.value?.cardDescriptionText(code, index)
  if (fromKernel) return fromKernel
  // 分条表缺失时退回卡库的整段效果文本（按行近似）
  const card = cardStore.getCard(code)
  if (!card) return ''
  const lines = (card.desc || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  return lines[index] ?? card.name
}

/* ---------------------------------------------------------------- */
/* AI 代打：起手规划路线 → 沿路线执行 → 被手坑打断才重规划             */
/* ---------------------------------------------------------------- */

const aiConfig = ref<AiConfig>(loadAiConfig())
/** runner 持有这个对象的引用，设置改动即时生效，不用重开对局 */
const liveAiConfig: AiConfig = { ...aiConfig.value }
const aiEnabled = ref(false)
const aiStatus = ref<AgentStatus>('idle')
const aiReason = ref('')
const aiError = ref('')
const aiStats = ref<AgentStats | null>(null)
const agent = shallowRef<AgentRunner | null>(null)

/** 决策日志：规划、每一步选择、打断与降级都会追加到这里 */
const aiLog = ref<AgentTrace[]>([])
const aiLogOpen = ref(false)
/** 是否连「唯一候选 / 沿路线执行」这类没有模型参与的步骤也显示 */
const aiLogAll = ref(false)
const aiPlan = ref<Plan | null>(null)

/** 「AI 设置」页开启总开关且填好密钥，才允许开代打 */
const aiActive = computed(() => isAiActive(aiConfig.value))
const aiBusy = computed(() => aiStatus.value === 'planning' || aiStatus.value === 'thinking')

const AI_LOG_KINDS: Record<AgentTrace['kind'], string> = {
  plan: '规划',
  replan: '重规划',
  decide: '决策',
  auto: '自动',
  fallback: '降级',
  interrupt: '打断',
  switch: '接管',
}

/** 日志保留条数：一条完整展开能有上百步，留太少会把开局的规划挤掉 */
const AI_LOG_MAX = 300

/**
 * 追加一条日志。
 *
 * 裁剪时**优先保住规划 / 重规划 / 打断**：排查「为什么没照录像打」看的就是这几条，
 * 让后面几百条「唯一候选」把它们挤出去，导出的日志就只剩流水账了。
 */
function appendAiLog(entry: AgentTrace): AgentTrace[] {
  const next = [...aiLog.value, entry]
  if (next.length <= AI_LOG_MAX) return next
  const keep = next.filter(
    (item) => item.kind === 'plan' || item.kind === 'replan' || item.kind === 'interrupt',
  )
  const rest = next.filter((item) => !keep.includes(item))
  const budget = Math.max(AI_LOG_MAX - keep.length, 50)
  return [...keep, ...rest.slice(-budget)]
}

/** 接管 / 暂停也写进日志：判断问题时能看出时间线在哪断过 */
function pushAiLog(title: string, detail: string) {
  aiLog.value = appendAiLog({
    at: Date.now(),
    kind: 'switch',
    title,
    detail,
    latencyMs: 0,
    retries: 0,
  })
}

/** 最新一条在最上面：对局里更关心「刚才为什么这么走」 */
const aiLogVisible = computed(() => {
  const list = aiLogAll.value
    ? aiLog.value
    : aiLog.value.filter((item) => item.kind !== 'auto')
  return [...list].reverse()
})

function aiLogTime(at: number) {
  const date = new Date(at)
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => String(value).padStart(2, '0'))
    .join(':')
}

function aiTokenText(entry: AgentTrace) {
  if (!entry.tokens) return ''
  const total = entry.tokens.prompt + entry.tokens.completion
  if (!total) return ''
  return entry.tokens.cacheHit ? `${total} tok（缓存 ${entry.tokens.cacheHit}）` : `${total} tok`
}

/* ---------------------------------------------------------------- */
/* 决策日志导出                                                        */
/* ---------------------------------------------------------------- */

function pad2(value: number) {
  return String(value).padStart(2, '0')
}

function clockText(at: number) {
  const date = new Date(at)
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

function stampText(at: number) {
  const date = new Date(at)
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}`
}

/** 一条 trace 的 Markdown：元信息 + 结果 + 理由 + 完整请求 / 返回 */
function renderTraceEntry(entry: AgentTrace, index: number): string {
  const lines = [`### ${index + 1}. ${clockText(entry.at)} · ${AI_LOG_KINDS[entry.kind]}｜${entry.title}`]
  const meta: string[] = []
  if (entry.candidateCount) meta.push(`${entry.candidateCount} 个候选`)
  if (entry.latencyMs) meta.push(`${entry.latencyMs}ms`)
  if (entry.retries) meta.push(`重试 ${entry.retries}`)
  if (entry.tokens) {
    const total = entry.tokens.prompt + entry.tokens.completion
    if (entry.tokens.calls || total) {
      meta.push(
        `${entry.tokens.calls} 次调用｜${total} tok（prompt ${entry.tokens.prompt}、completion ${entry.tokens.completion}、缓存命中 ${entry.tokens.cacheHit}）`,
      )
    }
  }
  if (meta.length) lines.push(`- ${meta.join('｜')}`)
  if (entry.detail) lines.push('', '**结果**', '```text', entry.detail, '```')
  if (entry.reason) lines.push('', `**模型理由**：${entry.reason}`)
  if (entry.request) {
    lines.push('', '<details><summary>发给模型的完整内容</summary>', '', '````text', entry.request, '````', '', '</details>')
  }
  if (entry.raw) {
    lines.push('', '<details><summary>模型原始返回</summary>', '', '````text', entry.raw, '````', '', '</details>')
  }
  return lines.join('\n')
}

/**
 * 导出决策日志。
 *
 * 只导出日志本身不够排查「为什么没照录像打」：模型看到了什么取决于 skill 是否加载、
 * 录像有没有解析、规划有没有触发，这些都不在单条 trace 里。所以把配置、skill 状态、
 * 绑定的录像、当前盘面和累计用量一起打包，拿到文件就能复盘整条链路。
 * 密钥不进文件。
 */
function buildAiLogReport(): string {
  const deck = deckStore.current
  const view = snapshot.value
  const config = aiConfig.value
  const skill = skillCache?.source ?? null
  const stats = aiStats.value ?? agent.value?.getStats() ?? null
  const plans = aiLog.value.filter((item) => item.kind === 'plan' || item.kind === 'replan').length
  const count = (list: { count: number }[]) => list.reduce((sum, entry) => sum + (Number(entry.count) || 0), 0)

  const lines: string[] = []
  lines.push(`# AI 决策日志 · ${deck?.name || '未命名卡组'}`, '')
  lines.push(`- 导出时间：${new Date().toLocaleString('zh-CN')}`)
  lines.push(`- 卡组：${deck?.name || '未命名卡组'}（主 ${deck ? count(deck.main) : 0} / 额外 ${deck ? count(deck.extra) : 0} / 副 ${deck ? count(deck.side) : 0}）`)
  lines.push(`- 日志条数：${aiLog.value.length}（其中规划 ${plans} 次）`)

  lines.push('', '## 模型配置', '')
  lines.push(`- 协议：${config.protocol}｜端点：${config.baseUrl}｜模型：${config.model}`)
  lines.push(
    `- 温度：${config.temperature}｜maxTokens：${config.maxTokens}｜超时：${config.timeoutMs}ms｜工具轮数：${config.toolRounds}`,
  )
  lines.push(
    `- json 模式：${config.jsonMode ? '开' : '关'}｜开局规划：${config.planOnStart ? '开' : '关'}｜思考模式：${config.thinking ? '开' : '关'}（${config.reasoningEffort}）｜skill 预算：${config.skillBudget}`,
  )
  lines.push('- 密钥：已省略')
  lines.push(`- 当前状态：${aiStatus.value}${aiError.value ? `｜错误：${aiError.value}` : ''}`)

  lines.push('', '## skill 状态', '')
  if (skill) {
    lines.push(`- 已加载：分片 ${skill.sections.length} 份｜router ${skill.router.length} 字｜录像路线 ${skill.replays.length} 份`)
    lines.push('', '**卡组角色摘要（会被塞进每次决策的 system）**', '', '```text', skill.brief, '```')
  } else {
    lines.push('- **没有读到 skill**：模型只能凭常识打，录像路线完全不会生效。检查卡组是否绑定了录像、skill 是否生成。')
  }
  lines.push('', `**绑定的录像**（${skillBindings.value.length} 份）`, '')
  if (!skillBindings.value.length) {
    lines.push('- 没有绑定录像：skill 里不会有任何路线。')
  } else {
    for (const binding of skillBindings.value) {
      const analysis = binding.analysis
      const status = analysis
        ? analysis.ok
          ? `已解析（${analysis.turns} 回合${analysis.incomplete ? '，未终局' : ''}，步骤 ${analysis.steps.length}、决策 ${analysis.decisions.length}）`
          : `解析失败：${analysis.error}`
        : binding.error
          ? `解析失败：${binding.error}`
          : '未解析'
      lines.push(`- ${binding.name}：${status}`)
    }
  }

  if (view) {
    lines.push('', '## 当前盘面', '', '```text', renderBoard(view.state), '```')
    if (view.hint) lines.push('', `- 内核提示：${view.hint}`)
    if (view.missingScripts.length) lines.push(`- 缺脚本的卡：${view.missingScripts.join('、')}`)
  }

  if (stats) {
    lines.push('', '## 累计用量', '')
    lines.push(
      `- 调用 ${stats.calls} 次｜重试 ${stats.retries}｜降级 ${stats.fallbacks}｜失败 ${stats.failures}`,
    )
    lines.push(
      `- prompt ${stats.promptTokens} tok｜completion ${stats.completionTokens} tok｜缓存命中 ${stats.cacheHitTokens}｜未命中 ${stats.cacheMissTokens}`,
    )
  }

  const plan = aiPlan.value
  if (plan) {
    lines.push('', '## 当前路线', '')
    lines.push(`- 路线：${plan.route}`)
    if (plan.goal) lines.push(`- 目标：${plan.goal}`)
    if (plan.steps.length) lines.push('', '**执行顺序**', '', ...plan.steps.map((step, index) => `${index + 1}. ${step}`))
    if (plan.avoid.length) lines.push('', `- 避免：${plan.avoid.join('；')}`)
  }

  lines.push('', '## 日志（按时间正序）', '')
  aiLog.value.forEach((entry, index) => lines.push(renderTraceEntry(entry, index)))
  return lines.join('\n')
}

function exportAiLog() {
  if (!aiLog.value.length) return
  const name = (deckStore.current?.name || 'deck').replace(/[\\/:*?"<>|]/g, '_')
  downloadText(`ai-log-${name}-${stampText(Date.now())}.md`, buildAiLogReport())
  showToast(`已导出 AI 决策日志（${aiLog.value.length} 条）`)
}

/** skill 包按卡表缓存：生成一次要跑手坑模拟，不能每次提问重算 */
let skillCache: { key: string; source: SkillSource | null } | null = null

/**
 * 当前卡组绑定的录像。
 *
 * 工作坊废弃后 combo 就靠录像录入，所以 AI 代打必须带上这些 bindings——
 * 否则 skill 里只有启动点表和 router，一条路线都没有，模型只能凭常识打。
 */
const skillBindings = ref<SkillBindingInput[]>([])

async function loadSkillBindings() {
  const deck = deckStore.current
  if (!deck) {
    skillBindings.value = []
    return
  }
  const metas = await listReplayBindings(deck.id)
  skillBindings.value = metas.map((meta) => ({
    id: meta.id,
    name: meta.name,
    createdAt: meta.createdAt,
    error: meta.error,
    analysis: meta.analysis ?? null,
  }))
  // 录像变了，之前生成的 skill 包不再可信
  skillCache = null
}

function skillInput(): SkillInput | null {
  const deck = deckStore.current
  if (!deck) return null
  return {
    deckName: deck.name || '未命名卡组',
    main: deck.main,
    extra: deck.extra,
    side: deck.side,
    nameOf,
    cardOf: (code) => cardStore.getCard(code),
    plan: deck.plan,
    starterGroups: deck.starters,
    handtraps: handtrapStore.defs,
    bindings: skillBindings.value,
  }
}

/**
 * 取 skill 包。失败与「加载成功但内容为空」都写进日志——
 * 之前这里是 console.warn，AI 打错时完全看不出是因为根本没读到路线。
 */
function getSkillSource(): SkillSource | null {
  const deck = deckStore.current
  if (!deck) {
    pushAiLog('skill 不可用', '当前没有选中卡组')
    return null
  }
  const key = [
    deck.name,
    deck.main.map((entry) => `${entry.id}x${entry.count}`).join(','),
    deck.extra.map((entry) => `${entry.id}x${entry.count}`).join(','),
    // 录像就是路线来源，换了一批录像必须重新生成
    skillBindings.value.map((item) => item.id).join(','),
  ].join('|')
  if (skillCache?.key === key) return skillCache.source

  let source: SkillSource | null = null
  try {
    const payload = skillInput()
    if (payload) source = buildSkillSource(buildSkillBundle(payload))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    pushAiLog('skill 生成失败', `${message}（本次只能凭模型常识规划）`)
    skillCache = { key, source: null }
    return null
  }

  const replayFiles = source ? source.sections.filter((item) => item.id.startsWith('20-replay')).length : 0
  const usable = skillBindings.value.filter((item) => item.analysis?.ok).length
  pushAiLog(
    'skill 已加载',
    source
      ? `录像 ${usable}/${skillBindings.value.length} 份可解析；分片 ${source.sections.length} 个（录像路线 ${replayFiles}、router ${source.router.length} 字）`
      : `没有可用的 skill（录像 ${skillBindings.value.length} 份可解析 ${usable} 份）`,
  )
  skillCache = { key, source }
  return source
}

function createAgent(current: DuelSession): AgentRunner {
  return new AgentRunner({
    config: liveAiConfig,
    nameOf,
    describe: describeOption,
    summary: (code) => cardStore.getCard(code)?.desc ?? '',
    getSkill: getSkillSource,
    getSignals: () => current.signals,
    deck: () => {
      const deck = deckStore.current
      return {
        name: deck?.name || '未命名卡组',
        mainNames: deck ? deck.main.map((entry) => entry.name).slice(0, 80) : [],
        extraNames: deck ? deck.extra.map((entry) => entry.name).slice(0, 20) : [],
      }
    },
    onStatus: (status, note) => {
      aiStatus.value = status
      if (note) aiError.value = note
    },
    onReason: (text) => {
      aiReason.value = text
    },
    onTrace: (entry) => {
      aiStats.value = agent.value?.getStats() ?? null
      aiPlan.value = agent.value?.getPlan() ?? null
      aiLog.value = appendAiLog(entry)
      if (aiError.value && aiStatus.value !== 'error') aiError.value = ''
    },
  })
}

/** 把当前待答问题交给 AI；开启开关时如果正停在某一步，立刻接管 */
function driveAgent() {
  const runner = agent.value
  const current = session.value
  const pending = question.value
  if (!runner || !current || !pending || pending.player !== 0) return
  void runner.handle(pending, current.snapshot().state, (response) => current.answer(response))
}

/** 「重新开始」会主动关掉 AI：这次关闭不该写成「已暂停接管」，新局日志要是干净的 */
let aiOffByRestart = false

/** 开新局前停掉代打：必须等玩家重新点「AI 代打」才开始推理 */
function stopAiSilently() {
  if (!aiEnabled.value) return
  aiOffByRestart = true
  aiEnabled.value = false
}

watch(aiEnabled, async (on) => {
  aiReason.value = ''
  aiError.value = ''
  const runner = agent.value
  // 总开关关着 / 没填密钥时不允许接管：按钮本身是置灰的，这里只是兜底
  if (on && !aiActive.value) {
    aiOffByRestart = true
    aiEnabled.value = false
    showToast('先到「AI 设置」页开启 AI 并填写密钥')
    return
  }
  if (!on) {
    const silent = aiOffByRestart
    aiOffByRestart = false
    aiStatus.value = 'idle'
    // 重新开始主动关闭：旧 runner 已由 startDuel 停掉，别再误停刚建好的新 runner
    if (silent) return
    runner?.stop()
    // 日志刻意不清空：手动接管后往往正是要回溯刚才的决策
    if (session.value) pushAiLog('已暂停接管', '接下来的提问需要手动操作；重新开启会接着用同一份日志')
    return
  }
  if (!runner || !session.value) {
    showToast('先开始一局，再开启 AI 代打')
    return
  }
  runner.reset()
  aiStatus.value = 'thinking'
  // 录像就是路线来源：先读出来，第一次规划才能看到录过的打法
  await loadSkillBindings()
  if (!aiEnabled.value) return
  pushAiLog(
    '重新接管',
    runner.hasPlan()
      ? '沿用原路线继续；只有检测到偏离（对手打断 / 路线资源耗尽 / 跨回合）才重新规划'
      : '没有可沿用的路线，下一次操作会重新规划',
  )
  driveAgent()
})

/** 选项的文字版：面板按这个渲染，不再是「选项 1 / 选项 2」 */
const optionLabels = computed(() =>
  question.value?.kind === 'option' ? question.value.message.options.map((id) => describeOption(id)) : [],
)

const missingScriptNames = computed(() => {
  version.value
  return (session.value?.snapshot().missingScripts ?? []).map((code) => nameOf(code))
})

/* ---------------------------------------------------------------- */
/* 交互：所有选择都在页面这一层，棋盘和操作条共用                      */
/* ---------------------------------------------------------------- */

const selected = ref<number[]>([])
const placePicks = ref<number[]>([])
const menu = ref<{ x: number; y: number; items: DuelCommand[] } | null>(null)
const preview = ref<DuelCardView | null>(null)
const pileView = ref<{ player: DuelPlayerId; kind: 'gy' | 'banished' | 'extra' } | null>(null)
/** 超量素材查看器：点带素材的怪兽 / 素材角标时打开 */
const materialView = ref<{ name: string; codes: number[] } | null>(null)

watch(question, () => {
  selected.value = []
  placePicks.value = []
  menu.value = null
})

const hints = computed(() => buildSlotHints(question.value))
const range = computed(() => (question.value ? selectRange(question.value) : { min: 1, max: 1, cancel: false }))
const placeCount = computed(() => (question.value?.kind === 'place' ? question.value.message.count : 1))

function hintAt(player: number, location: number, sequence: number): SlotHint | undefined {
  return hints.value.get(slotKey(player, location, sequence))
}

function isSlotSelected(player: number, location: number, sequence: number): boolean {
  const hint = hintAt(player, location, sequence)
  if (!hint) return false
  if (hint.place !== undefined) return placePicks.value.includes(hint.place)
  return hint.candidates.some((item) => item.mode === 'toggle' && selected.value.includes(item.index))
}

/** 已选顺序（1 起），0 表示没选：多选类操作靠它一眼看出选了哪几张 */
function slotOrder(player: number, location: number, sequence: number): number {
  const hint = hintAt(player, location, sequence)
  if (!hint) return 0
  if (hint.place !== undefined) return placePicks.value.indexOf(hint.place) + 1
  const candidate = hint.candidates.find((item) => item.mode === 'toggle' && selected.value.includes(item.index))
  return candidate ? selected.value.indexOf(candidate.index) + 1 : 0
}

function isSlotClickable(player: number, location: number, sequence: number): boolean {
  const hint = hintAt(player, location, sequence)
  if (!hint) return false
  return Boolean(hint.place !== undefined || hint.chain !== undefined || hint.candidates.length || hint.commands.length)
}

function answer(response: OcgResponse) {
  menu.value = null
  const current = session.value
  if (!current) return
  // AI 正在算这一步：手动作答会和它抢同一个 answerResolve，直接忽略
  if (aiEnabled.value && aiBusy.value) return
  // 面板是上一帧的残留时内核并没有在等回答：丢掉这次点击，并强制刷一次快照，
  // 免得界面停在一个点不动的旧面板上
  if (!current.answer(response)) version.value += 1
}

function runCommand(command: DuelCommand) {
  answer({
    type: command.family === 'idle' ? OcgResponseType.SELECT_IDLECMD : OcgResponseType.SELECT_BATTLECMD,
    action: command.action,
    index: command.index,
  } as OcgResponse)
}

function submitSelection(indices: number[]) {
  const current = question.value
  if (!current) return
  if (current.kind === 'card') answer({ type: OcgResponseType.SELECT_CARD, indicies: indices })
  else if (current.kind === 'tribute') answer({ type: OcgResponseType.SELECT_TRIBUTE, indicies: indices })
  else if (current.kind === 'sum') answer({ type: OcgResponseType.SELECT_SUM, indicies: indices })
}

function toggleIndex(index: number) {
  const list = selected.value
  if (list.includes(index)) {
    selected.value = list.filter((item) => item !== index)
    return
  }
  const next = range.value.max > 0 && list.length >= range.value.max ? [...list.slice(1), index] : [...list, index]
  selected.value = next
  // 只能选一张时点一下就直接提交，少一次"确定"
  if (range.value.max === 1 && next.length >= Math.max(1, range.value.min)) submitSelection(next)
}

function pickCard(pick: number) {
  answer({ type: OcgResponseType.SELECT_UNSELECT_CARD, index: pick })
}

function confirmSelection() {
  submitSelection(selected.value)
}

function cancelSelection() {
  const current = question.value
  if (!current) return
  if (current.kind === 'unselect') answer({ type: OcgResponseType.SELECT_UNSELECT_CARD, index: null })
  else if (current.kind === 'tribute') answer({ type: OcgResponseType.SELECT_TRIBUTE, indicies: null })
  else answer({ type: OcgResponseType.SELECT_CARD, indicies: null })
}

function togglePlace(index: number) {
  const list = placePicks.value
  if (list.includes(index)) {
    placePicks.value = list.filter((item) => item !== index)
    return
  }
  const next = list.length >= placeCount.value ? [...list.slice(1), index] : [...list, index]
  placePicks.value = next
  if (next.length === placeCount.value) confirmPlaces()
}

function confirmPlaces() {
  const current = question.value
  if (!current || current.kind !== 'place') return
  const places = placePicks.value.map((index) => placeOptions(current)[index]).filter(Boolean)
  if (!places.length) return
  // 两种提问要用各自的响应类型，答错内核会一直 RETRY
  const isDisfield = current.message.type === OcgMessageType.SELECT_DISFIELD
  answer({ type: isDisfield ? OcgResponseType.SELECT_DISFIELD : OcgResponseType.SELECT_PLACE, places })
}

/** 界面上不好表达的宣言类（种族/属性/卡名/数字）交给内核的兜底策略 */
function autoSkip(current: DuelQuestion) {
  return autoRespond(current)
}

function onSlotClick(player: number, location: number, sequence: number, event: MouseEvent) {
  pileView.value = null
  const hint = hintAt(player, location, sequence)
  if (!hint) return
  if (hint.place !== undefined) {
    togglePlace(hint.place)
    return
  }
  if (hint.chain !== undefined) {
    answer({ type: OcgResponseType.SELECT_CHAIN, index: hint.chain })
    return
  }
  if (hint.candidates.length) {
    const candidate = hint.candidates[0]
    if (candidate.mode === 'pick') pickCard(candidate.pick)
    else toggleIndex(candidate.index)
    return
  }
  if (hint.commands.length === 1) {
    runCommand(hint.commands[0])
    return
  }
  if (hint.commands.length > 1) {
    // 贴着点的地方弹出，但别超出视口，免得菜单跑到屏幕外面
    const width = 190
    const height = 36 * hint.commands.length + 12
    menu.value = {
      x: Math.max(8, Math.min(event.clientX - 12, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(event.clientY - 12, window.innerHeight - height - 8)),
      items: hint.commands,
    }
  }
}

/* ---------------------------------------------------------------- */
/* 动画：攻击 / LP 变化                                               */
/* ---------------------------------------------------------------- */

const attackFx = ref<{ id: number; key: string } | null>(null)
const lpFx = ref<{ id: number; player: number; delta: number } | null>(null)
let attackTimer: ReturnType<typeof setTimeout> | null = null
let lpTimer: ReturnType<typeof setTimeout> | null = null

watch(
  () => snapshot.value?.attack as DuelEvent | null,
  (event) => {
    if (!event || event.location === undefined || event.sequence === undefined) return
    attackFx.value = { id: event.id, key: slotKey(event.player, event.location, event.sequence) }
    if (attackTimer) clearTimeout(attackTimer)
    attackTimer = setTimeout(() => {
      attackFx.value = null
    }, 900)
  },
)

let lastLp: [number, number] | null = null
watch(
  () => state.value?.players.map((player) => player.lp).join(','),
  (joined) => {
    if (!joined) return
    const now = joined.split(',').map(Number) as [number, number]
    if (lastLp) {
      for (const player of [0, 1] as const) {
        const delta = now[player] - lastLp[player]
        if (!delta) continue
        lpFx.value = { id: Date.now(), player, delta }
        if (lpTimer) clearTimeout(lpTimer)
        lpTimer = setTimeout(() => {
          lpFx.value = null
        }, 1400)
      }
    }
    lastLp = now
  },
)

/** 连锁中的卡：在场上显示 C1/C2 角标 */
const chainLinks = computed(() => {
  const map = new Map<string, number>()
  for (const link of state.value?.chain ?? []) {
    map.set(`${link.code}`, link.link)
  }
  return map
})

function chainLinkOf(card: DuelCardView | null): number {
  if (!card) return 0
  return chainLinks.value.get(`${card.code}`) ?? 0
}

/* ---------------------------------------------------------------- */
/* 卡组 / 开局                                                       */
/* ---------------------------------------------------------------- */

function expand(list: { id: number; count: number }[]): number[] {
  const out: number[] = []
  for (const entry of list) {
    for (let index = 0; index < entry.count; index += 1) out.push(entry.id)
  }
  return out
}

const currentDeck = computed<DuelDeck>(() => ({
  main: expand(deckStore.current?.main ?? []),
  extra: expand(deckStore.current?.extra ?? []),
}))

const deckReady = computed(() => currentDeck.value.main.length >= 20)
const deckSummary = computed(() => `主 ${currentDeck.value.main.length} · 额外 ${currentDeck.value.extra.length}`)

/** 卡组里的每种卡（自选起手时用） */
const deckEntries = computed(() =>
  (deckStore.current?.main ?? []).map((entry) => ({ id: entry.id, name: nameOf(entry.id), count: entry.count })),
)

function pickCount(code: number): number {
  return openingPicks.value.filter((item) => item === code).length
}

function addPick(entry: { id: number; count: number }) {
  if (openingPicks.value.length >= handSize.value) return
  if (pickCount(entry.id) >= entry.count) return
  openingPicks.value = [...openingPicks.value, entry.id]
}

function removePick(code: number) {
  const index = openingPicks.value.lastIndexOf(code)
  if (index < 0) return
  openingPicks.value = openingPicks.value.filter((_, item) => item !== index)
}

watch(handSize, (size) => {
  if (openingPicks.value.length > size) openingPicks.value = openingPicks.value.slice(0, Math.max(0, size))
})

// 换卡组后自选手牌就没意义了
watch(
  () => deckStore.currentDeckId,
  () => {
    openingPicks.value = []
  },
)

function randomSeed(): [bigint, bigint, bigint, bigint] {
  const buffer = new Uint32Array(8)
  crypto.getRandomValues(buffer)
  const pick = (index: number) => (BigInt(buffer[index]) << 32n) | BigInt(buffer[index + 1])
  return [pick(0), pick(2), pick(4), pick(6)]
}

function formatSeed(seed: [bigint, bigint, bigint, bigint]) {
  return seed.map((value) => value.toString(16).padStart(16, '0')).join('-')
}

const seedText = computed(() => (session.value ? formatSeed(currentSeed.value) : ''))

/** 开一局；传了暂存就用暂存的卡组 / 种子，并自动回放到存档点 */
async function startDuel(restore?: DuelCheckpoint) {
  const deck = restore?.playerDeck ?? currentDeck.value
  if (!restore && !deckReady.value) {
    errorText.value = '请先在「卡组构建」里准备一套至少 20 张主卡组的卡组'
    return
  }
  starting.value = true
  errorText.value = ''
  endConfirm.value = false
  // 重新开始一律回到手动操作：否则 aiEnabled 还是 true，新局第一帧 AI 就自己推理了
  stopAiSilently()
  agent.value?.stop()
  session.value?.stop()
  session.value = null
  lastLp = null

  const seed = restore ? stringsToSeed(restore.seed) : randomSeed()
  const hand = restore ? restore.handSize : handSize.value
  const opening = restore ? restore.openingHand.slice() : openingPicks.value.slice()
  if (restore) {
    handSize.value = restore.handSize
    openingPicks.value = restore.openingHand.slice()
  }
  currentSeed.value = seed
  activeDeck.value = deck

  const next = new DuelSession(
    {
      playerDeck: deck,
      // 沙包用同一套卡组：保证卡都在卡库里，且第一版沙包不动作
      opponentDeck: deck,
      seed,
      startingLP: 8000,
      startingHand: hand,
      drawCount: 1,
      names: ['我', '沙包'],
      openingHand: opening,
      replay: restore?.steps,
    },
    nameOf,
    {
      onChange: () => {
        version.value += 1
      },
      onLog: (text) => console.info('[duel]', text),
      onQuestion: (pending) => {
        // 只代打我方；对手固定走沙包策略
        if (!aiEnabled.value || pending.player !== 0) return
        const runner = agent.value
        if (!runner) return
        void runner.handle(pending, next.snapshot().state, (response) => next.answer(response))
      },
    },
  )
  session.value = next
  agent.value = createAgent(next)
  // 预读录像：开启 AI 时就能拿到路线（不阻塞开局）
  void loadSkillBindings()
  aiStats.value = null
  aiReason.value = ''
  aiError.value = ''
  aiLog.value = []
  aiPlan.value = null
  // 默认进网站全屏（场地铺满视口，HUD 提供暂存 / 屏幕全屏 / 结束）
  immersive.value = true
  try {
    await next.start()
    if (restore) showToast(`已回到暂存点（回放 ${restore.steps.length} 步）`)
  } catch (error) {
    immersive.value = false
    const message = error instanceof Error ? error.message : String(error)
    const customIds = new Set(cardStore.custom.map((card) => card.id))
    const hasCustom = deck.main.some((code) => customIds.has(code))
    errorText.value =
      hasCustom && message.includes('内核卡库里没有')
        ? `${message}（自定义卡没有内核数据，无法参与对局）`
        : message
  } finally {
    starting.value = false
    version.value += 1
  }
}

/* ---------------------------------------------------------------- */
/* 暂存：记住开局参数 + 我方每一步决定，恢复时重开并自动走到存档点      */
/* ---------------------------------------------------------------- */

/** 当前卡组的卡表指纹：卡号 + 张数变了，旧暂存就对不上了 */
const currentDeckFingerprint = computed(() => deckFingerprint(currentDeck.value))

/**
 * 暂存按卡组隔离：只列当前卡组的档，且卡表变过（指纹对不上）的会被清掉，
 * 因为回放是拿卡组重开一局，卡组换了必然走到别的局面。
 */
function refreshCheckpoints() {
  checkpoints.value = loadCheckpoints({
    deckId: deckStore.currentDeckId ?? '',
    fingerprint: currentDeckFingerprint.value,
  })
}

refreshCheckpoints()
watch([() => deckStore.currentDeckId, currentDeckFingerprint], refreshCheckpoints)

function saveCurrentCheckpoint() {
  const current = session.value
  const view = state.value
  if (!current || !view) return
  // 刚答完、内核还在结算时，这一步的响应还没记进队列，存下来会少一步，
  // 恢复后就停在「之前的步骤」
  if (snapshot.value?.busy) {
    showToast('内核还在结算这一步，等当前操作面板出现后再暂存')
    return
  }
  const steps = current.playerResponses.slice()
  if (!steps.length) {
    showToast('还没有可复现的操作，先做一步再暂存')
    return
  }
  const deckName = deckStore.current?.name || '未命名卡组'
  const seed = seedToStrings(currentSeed.value)
  const checkpoint: DuelCheckpoint = {
    // 同一局（同卡组 + 同种子）只保留一个存档点：重存就覆盖，
    // 否则列表里堆满越来越旧的同名存档，很容易点到旧档、看起来像"回到之前的步骤"
    id: `${deckStore.currentDeckId ?? 'deck'}-${seed.join('-')}`,
    label: `${deckName} · 第 ${view.turn} 回合`,
    deckId: deckStore.currentDeckId ?? '',
    deckName,
    deckFingerprint: deckFingerprint(activeDeck.value),
    seed,
    playerDeck: activeDeck.value,
    handSize: handSize.value,
    openingHand: openingPicks.value.slice(),
    steps,
    turn: view.turn,
    phase: view.phase,
    createdAt: Date.now(),
  }
  saveCheckpoint(checkpoint)
  refreshCheckpoints()
  showToast(`已暂存，共 ${steps.length} 步操作`)
}

function deleteCheckpoint(id: string) {
  removeCheckpoint(id)
  refreshCheckpoints()
}

/** 结束前给这局起个名字：绑定到卡组后就是录像列表里的展示名 */
const replayNameInput = ref('')

function defaultReplayName(): string {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
  return `${deckStore.current?.name || '未命名卡组'} · 第 ${state.value?.turn ?? 1} 回合 · ${stamp}`
}

function requestEndDuel() {
  if (!session.value) {
    immersive.value = false
    return
  }
  replayNameInput.value = defaultReplayName()
  endConfirm.value = true
}

function finishDuel(mode: 'none' | 'export' | 'bind') {
  if (mode === 'export') exportReplay(replayNameInput.value)
  // 绑定要在 stop 之前调用：它同步取出响应字节，await 之后才写 IndexedDB
  if (mode === 'bind') void bindReplayToDeck(replayNameInput.value)
  endConfirm.value = false
  void exitWebFullscreen()
  agent.value?.stop()
  session.value?.stop()
  session.value = null
  immersive.value = false
  aiStatus.value = 'idle'
  version.value += 1
}

/** 当前这局的 .yrp 字节；导出和绑定卡组共用 */
function replayBytes(): Uint8Array | null {
  const current = session.value
  if (!current) return null
  // 必须写洗好的那份顺序，否则回放出来的起手和这局不一样
  const built = current.builtDecks
  return buildReplay({
    seed: currentSeed.value,
    playerDeck: built?.player ?? activeDeck.value,
    opponentDeck: built?.opponent ?? activeDeck.value,
    names: ['我', '沙包'],
    responses: current.responses,
    startingLP: 8000,
    startingHand: handSize.value,
    drawCount: 1,
    duelFlags: Number(OcgDuelMode.MODE_MR5),
  })
}

function exportReplay(name = '') {
  const bytes = replayBytes()
  if (!bytes) return
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const clean = name.trim().replace(/[\\/:*?"<>|]/g, '_')
  downloadReplay(bytes, `${clean || `combo-${stamp}`}.yrp`)
}

/** 绑定到当前卡组：对战分析页会把这些录像重放成展开说明 */
async function bindReplayToDeck(name = '') {
  const bytes = replayBytes()
  const deckId = deckStore.currentDeckId
  if (!bytes || !deckId) return
  const deckName = deckStore.current?.name || '未命名卡组'
  try {
    await bindReplay({
      deckId,
      deckName,
      name: name.trim() || defaultReplayName(),
      bytes,
    })
    showToast('已绑定到当前卡组，去「对战分析」页生成展开说明')
  } catch (error) {
    showToast(`绑定失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

const cardBack = computed(() => cardImageUrl(0))
function imageOf(card: DuelCardView | null) {
  if (!card) return ''
  return card.hidden ? cardBack.value : cardImageUrl(card.code)
}

/**
 * 场上卡面：里侧盖放一律显示卡背（内核的 isHidden 只标"对当前玩家隐藏"，
 * 自己盖下去的卡并不隐藏，直接用 imageOf 会把卡图亮出来）。
 * 悬停预览仍用 imageOf，所以移上去还能看正面。
 */
function faceOf(card: DuelCardView | null) {
  if (!card) return ''
  return isFaceDown(card.position) ? cardBack.value : imageOf(card)
}

/** 鼠标移开后保留上一张卡，左栏不会闪回占位文案 */
const lastPreview = ref<DuelCardView | null>(null)
watch(preview, (card) => {
  if (card) lastPreview.value = card
})

const inspectCard = computed(() => preview.value ?? lastPreview.value)

/** 左栏的效果描述：用本地卡库的完整效果文本 */
const inspectDesc = computed(() => {
  const card = inspectCard.value
  if (!card) return ''
  if (card.hidden) return '盖放卡片，看不到卡面信息。'
  return cardStore.getCard(card.code)?.desc || '本地卡库没有这张卡的效果描述。'
})

/* ---------------------------------------------------------------- */
/* 场地布局：按实卡决斗盘摆放                                         */
/*                                                                   */
/*   对手： 魔陷区 / 怪兽区                                            */
/*   中间： 额外怪兽区（双方共用 2 格）+ 中线（回合与阶段）              */
/*   我方： 怪兽区 / 魔陷区                                            */
/*                                                                   */
/* 场地区在左侧；墓地和除外在右侧；灵摆区叠在魔陷区最左/最右格上；      */
/* 卡组和额外卡组贴在魔陷区两端                                        */
/* ---------------------------------------------------------------- */

const PHASE_STEPS = [
  { value: 1, label: '抽卡' },
  { value: 2, label: '准备' },
  { value: 4, label: '主要1' },
  { value: 8, label: '战斗' },
  { value: 16, label: '主要2' },
  { value: 32, label: '结束' },
] as const

type ZoneKind = 'monster' | 'emz' | 'spell' | 'pendulum' | 'field'

interface ZoneCell {
  card: DuelCardView | null
  location: number
  sequence: number
  kind: ZoneKind
  /** 空格里的提示文字 */
  hint: string
  /** 叠在这一格上的灵摆区（魔陷区最左/最右格才有） */
  pendulum?: { card: DuelCardView | null; sequence: number } | null
}

interface ZoneRow {
  key: string
  kind: 'monsters' | 'emz' | 'spells'
  /** 用 flex order 控制行序，对手的魔陷区在上、额外怪兽区贴着中线 */
  order: number
  cells: (ZoneCell | null)[]
}

function cell(
  card: DuelCardView | null,
  location: number,
  sequence: number,
  kind: ZoneKind,
  hint: string,
): ZoneCell {
  return { card, location, sequence, kind, hint }
}

/** 一方的两行格子：怪兽区 / 魔陷区（灵摆叠在魔陷区两端）；额外怪兽区是双方共享的，单独渲染 */
function rowsFor(player: DuelPlayerId): ZoneRow[] {
  const view = state.value?.players[player]
  if (!view) return []

  const monsters: ZoneCell[] = Array.from({ length: 5 }, (_, index) =>
    cell(view.monsters[index] ?? null, OcgLocation.MZONE, index, 'monster', '怪兽'),
  )
  // 魔陷区固定 5 格；灵摆区（PZONE）叠在最左/最右格上，不额外占列
  const spells: ZoneCell[] = Array.from({ length: 5 }, (_, index) => {
    const slot = cell(view.spells[index] ?? null, OcgLocation.SZONE, index, 'spell', '魔陷')
    if (index === 0) slot.pendulum = { card: view.spells[5] ?? null, sequence: 0 }
    if (index === 4) slot.pendulum = { card: view.spells[6] ?? null, sequence: 1 }
    return slot
  })

  return [
    { key: `p${player}-m`, kind: 'monsters', order: 2, cells: monsters },
    { key: `p${player}-s`, kind: 'spells', order: player === 0 ? 3 : 1, cells: spells },
  ]
}

/* ---------------------------------------------------------------- */
/* 额外怪兽区：全场只有 2 格，双方共用                                 */
/*                                                                   */
/* 一格在 ocgcore 里对应两个位置（因为双方视角相反）：                  */
/*   屏幕左格 = 我方 MZONE 5 / 对手 MZONE 6                            */
/*   屏幕右格 = 我方 MZONE 6 / 对手 MZONE 5                            */
/* 同一时刻只会有一方占着其中一格，所以显示和点击都取"有卡 / 能操作"那个。 */
/* ---------------------------------------------------------------- */

type EmzSide = 'left' | 'right'

interface EmzEntry {
  player: DuelPlayerId
  sequence: number
  card: DuelCardView | null
}

function emzEntries(side: EmzSide): EmzEntry[] {
  const view = state.value
  if (!view) return []
  const pairs: [DuelPlayerId, number][] =
    side === 'left'
      ? [
          [0, 5],
          [1, 6],
        ]
      : [
          [0, 6],
          [1, 5],
        ]
  return pairs.map(([player, sequence]) => ({
    player,
    sequence,
    card: view.players[player].monsters[sequence] ?? null,
  }))
}

/** 这一格该用谁的 (player, sequence)：有卡的优先，其次轮到本方能操作的那一个 */
function emzOwner(side: EmzSide): EmzEntry {
  const list = emzEntries(side)
  return (
    list.find((entry) => entry.card && hintAt(entry.player, OcgLocation.MZONE, entry.sequence)) ??
    list.find((entry) => hintAt(entry.player, OcgLocation.MZONE, entry.sequence)) ??
    list.find((entry) => entry.card) ??
    list[0]
  )
}

function emzClickable(side: EmzSide): boolean {
  return emzEntries(side).some((entry) => isSlotClickable(entry.player, OcgLocation.MZONE, entry.sequence))
}

function emzSelected(side: EmzSide): boolean {
  return emzEntries(side).some((entry) => isSlotSelected(entry.player, OcgLocation.MZONE, entry.sequence))
}

function onEmzClick(side: EmzSide, event: MouseEvent) {
  const owner = emzOwner(side)
  if (!owner) return
  onSlotClick(owner.player, OcgLocation.MZONE, owner.sequence, event)
}

/** 模板里要用到的两格状态（避免同一格反复算 owner） */
const emzCells = computed(() =>
  (['left', 'right'] as const).map((side) => {
    const owner = emzOwner(side)
    return {
      side,
      card: owner.card,
      clickable: emzClickable(side),
      selected: emzSelected(side),
    }
  }),
)

function fieldSlot(player: DuelPlayerId): ZoneCell {
  return cell(state.value?.players[player].fieldZone ?? null, OcgLocation.FZONE, 0, 'field', '场地')
}

function handOf(player: DuelPlayerId): DuelCardView[] {
  return state.value?.players[player].hand ?? []
}

type PileKind = 'gy' | 'banished' | 'extra'

function pileCards(player: DuelPlayerId, kind: PileKind): DuelCardView[] {
  const view = state.value?.players[player]
  if (!view) return []
  if (kind === 'extra') return view.extra.filter((card): card is DuelCardView => Boolean(card))
  return kind === 'banished' ? view.banished : view.gy
}

function pileTop(player: DuelPlayerId, kind: PileKind): DuelCardView | null {
  const list = pileCards(player, kind)
  return list.length ? list[list.length - 1] : null
}

/** 列表项要带原始下标：内核的 sequence 就是额外卡组里的位置 */
function pileEntries(player: DuelPlayerId, kind: PileKind): { card: DuelCardView; index: number }[] {
  const view = state.value?.players[player]
  if (!view) return []
  const list = kind === 'extra' ? view.extra : kind === 'banished' ? view.banished : view.gy
  return list.flatMap((card, index) => (card ? [{ card, index }] : []))
}

function pileLocation(kind: PileKind): number {
  if (kind === 'extra') return OcgLocation.EXTRA
  return kind === 'gy' ? OcgLocation.GRAVE : OcgLocation.REMOVED
}

function pileTitle(player: DuelPlayerId, kind: PileKind): string {
  const who = player === 0 ? '我方' : '对手'
  return `${who}${kind === 'extra' ? '额外卡组' : kind === 'banished' ? '除外' : '墓地'}`
}

function openPile(player: DuelPlayerId, kind: PileKind) {
  pileView.value = { player, kind }
}

/** 打开超量素材列表（素材卡号来自内核查询的 overlayCards） */
function openMaterials(card: DuelCardView | null | undefined) {
  if (!card?.materials) return
  materialView.value = { name: card.name, codes: card.overlayCodes ?? [] }
}

/** 墓地永远在外侧、除外靠中线，所以对手那边上下要颠倒过来（镜像） */
function pileOrder(player: DuelPlayerId): PileKind[] {
  return player === 0 ? ['banished', 'gy'] : ['gy', 'banished']
}

/** 额外卡组里有没有能操作（特殊召唤 / 选择）的卡 */
function extraActionable(player: DuelPlayerId): boolean {
  const prefix = `${player}:${OcgLocation.EXTRA}:`
  for (const [key, hint] of hints.value) {
    if (!key.startsWith(prefix)) continue
    if (hint.commands.length || hint.candidates.length || hint.chain !== undefined) return true
  }
  return false
}

/* ---------------------------------------------------------------- */
/* 键盘：统一入口，先关浮层，再交给操作面板消费                        */
/* ---------------------------------------------------------------- */

const panelRef = ref<{ handleKey: (event: KeyboardEvent) => boolean } | null>(null)
const boardRef = ref<HTMLElement | null>(null)
const promptRef = ref<HTMLElement | null>(null)
/** 全屏下由实测高度反算出的卡高（0 = 不干预，用 CSS 默认值） */
const zoneHeight = ref(0)

/**
 * 全屏时卡尺寸不能再靠固定的 vh 公式估：操作条的选项一多，
 * 估算值就会把场地撑出屏幕、把操作条挤掉。这里直接量棋盘和操作条的真实高度，
 * 剩下的空间按 7 行卡均分（双方各 2 行场地 + 共享的额外怪兽区 1 行 + 双方手卡各 1 行）。
 */
function measureZoneHeight() {
  const board = boardRef.value
  const prompt = promptRef.value
  if (!immersive.value || !board || !prompt) {
    zoneHeight.value = 0
    return
  }
  // 中线 + 双方头部 / 手卡行内边距 + 棋盘内边距 + 与操作条的间距，不随卡大小变化
  const chrome = 146
  const available = board.clientHeight - prompt.offsetHeight - chrome
  const byHeight = Math.floor(available / 7)
  // 怪兽 / 魔陷区是正方形：整行连同左右侧栏约 6.5 个卡高，宽度也得放得下。
  // 左栏 240 + 间距，窄屏会隐藏左栏，那时不用让
  const inspectGutter = board.clientWidth > 900 ? 252 : 0
  const byWidth = Math.floor((board.clientWidth - 32 - inspectGutter) / 6.5)
  zoneHeight.value = Math.max(40, Math.min(140, Math.min(byHeight, byWidth)))
}

let zoneObserver: ResizeObserver | null = null

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

function onKeydown(event: KeyboardEvent) {
  if (event.metaKey || event.ctrlKey || event.altKey) return
  if (isTypingTarget(event.target)) return

  if (event.key === 'Escape') {
    if (endConfirm.value) {
      endConfirm.value = false
      event.preventDefault()
      return
    }
    if (checkpointOpen.value) {
      checkpointOpen.value = false
      event.preventDefault()
      return
    }
    if (menu.value) {
      menu.value = null
      event.preventDefault()
      return
    }
    if (pileView.value) {
      pileView.value = null
      event.preventDefault()
      return
    }
    if (pickerOpen.value) {
      pickerOpen.value = false
      event.preventDefault()
      return
    }
  }

  // 弹层开着的时候不让快捷键穿透到棋盘
  if (endConfirm.value || checkpointOpen.value) return

  // 卡片操作菜单是模态的：菜单开着时只认菜单里的序号，别误触底下的面板
  if (menu.value) {
    if (/^[1-9]$/.test(event.key)) {
      const item = menu.value.items[Number(event.key) - 1]
      if (item) {
        runCommand(item)
        event.preventDefault()
      }
    }
    return
  }

  // 面板认得 Enter / 数字 / Esc / E / B / A，认不出就放行给浏览器
  if (panelRef.value?.handleKey(event)) event.preventDefault()
}

/* ---------------------------------------------------------------- */
/* 屏幕全屏：用浏览器 Fullscreen API 把整页铺满，Esc 可随时退出          */
/* ---------------------------------------------------------------- */

const webFullscreen = ref(false)
/** 浏览器不支持全屏（例如 iOS Safari）时就不显示那个按钮，免得点了没反应 */
const fullscreenSupported = Boolean(
  document.fullscreenEnabled ||
    (document as Document & { webkitFullscreenEnabled?: boolean }).webkitFullscreenEnabled,
)

type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void
}

type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null
  webkitExitFullscreen?: () => Promise<void> | void
}

function syncFullscreen() {
  const doc = document as FullscreenDocument
  webFullscreen.value = Boolean(doc.fullscreenElement || doc.webkitFullscreenElement)
}

/**
 * 申请全屏必须发生在点击的同步阶段：一旦 await 过，浏览器就不再认为
 * 这是"用户手势"，会直接拒绝。所以这里先同步调用再 await 结果。
 */
async function enterWebFullscreen() {
  if (webFullscreen.value) return
  const element = document.documentElement as FullscreenElement
  try {
    if (element.requestFullscreen) await element.requestFullscreen({ navigationUI: 'hide' })
    else await element.webkitRequestFullscreen?.()
  } catch {
    /* 浏览器不允许（iOS Safari、iframe 权限策略等），退回普通的沉浸布局 */
  }
  syncFullscreen()
}

async function exitWebFullscreen() {
  const doc = document as FullscreenDocument
  if (!doc.fullscreenElement && !doc.webkitFullscreenElement) return
  try {
    if (doc.exitFullscreen) await doc.exitFullscreen()
    else await doc.webkitExitFullscreen?.()
  } catch {
    /* 已经退出（比如用户按了 Esc）就忽略 */
  }
  syncFullscreen()
}

function toggleWebFullscreen() {
  void (webFullscreen.value ? exitWebFullscreen() : enterWebFullscreen())
}

/** 开局：默认会展开网站全屏，这里不再额外申请浏览器全屏 */
function launchDuel() {
  if (starting.value) return
  void startDuel()
}

function launchRestore(checkpoint: DuelCheckpoint) {
  checkpointOpen.value = false
  void startDuel(checkpoint)
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  document.addEventListener('fullscreenchange', syncFullscreen)
  document.addEventListener('webkitfullscreenchange', syncFullscreen)
  syncFullscreen()

  zoneObserver = new ResizeObserver(() => measureZoneHeight())
  if (boardRef.value) zoneObserver.observe(boardRef.value)
  if (promptRef.value) zoneObserver.observe(promptRef.value)
  measureZoneHeight()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  document.removeEventListener('fullscreenchange', syncFullscreen)
  document.removeEventListener('webkitfullscreenchange', syncFullscreen)
  zoneObserver?.disconnect()
  zoneObserver = null
  void exitWebFullscreen()
  agent.value?.stop()
  session.value?.stop()
  if (attackTimer) clearTimeout(attackTimer)
  if (lpTimer) clearTimeout(lpTimer)
  if (toastTimer) clearTimeout(toastTimer)
})
</script>

<template>
  <section class="duel" :class="{ immersive }">
    <!-- 全屏 HUD：对局中的重开 / 暂存 / 结束都收在这里 -->
    <div v-if="immersive" class="duel-hud">
      <span class="hud-name">{{ deckStore.current?.name || '未命名卡组' }}</span>
      <span v-if="state" class="chip-dim">
        第 {{ state.turn }} 回合 · {{ state.turnPlayer === 0 ? '我方回合' : '对手回合' }}
      </span>
      <span v-if="state?.chain.length" class="hud-chain">
        <span v-for="link in state.chain" :key="`${link.link}-${link.code}`" class="chip-chain">
          C{{ link.link }} {{ link.name }}
        </span>
      </span>
      <span v-if="replaying" class="hud-replay">正在自动操作到暂存点…</span>
      <span class="hud-spacer" />
      <button
        v-if="session"
        class="btn sm"
        :class="{ primary: aiEnabled }"
        :disabled="starting || replaying || !aiActive"
        :title="
          !aiActive
            ? 'AI 未开启：先到「AI 设置」页打开总开关并填写密钥'
            : aiEnabled
              ? 'AI 正在替你操作，随时可以关掉'
              : '让 AI 从起手规划路线并接管我方操作'
        "
        @click="aiEnabled = !aiEnabled"
      >
        {{ aiEnabled ? 'AI 代打中' : 'AI 代打' }}
      </button>
      <button v-if="aiLog.length" class="btn sm ghost" @click="aiLogOpen = true">
        日志 ({{ aiLog.length }})
      </button>
      <RouterLink class="btn sm ghost" to="/ai" title="会离开当前对局，可先用「暂存」保存进度">
        AI 设置
      </RouterLink>
      <button class="btn sm" :disabled="starting" @click="launchDuel">重新开始</button>
      <button class="btn sm" :disabled="!session || starting || replaying" @click="saveCurrentCheckpoint">暂存</button>
      <button v-if="fullscreenSupported" class="btn sm" @click="toggleWebFullscreen">
        {{ webFullscreen ? '退出屏幕全屏' : '屏幕全屏' }}
      </button>
      <button class="btn sm" @click="requestEndDuel">结束对局</button>
      <button class="btn sm ghost" @click="immersive = false">收起布局</button>
    </div>

    <div class="duel-head">
      <div>
        <h1 class="page-title">对战区</h1>
        <p class="inline-note">
          用「卡组构建」里的卡组推演一局，对手是只会结束回合的沙包。点场上的卡就能操作；结束时可以把过程导出成 .yrp，或绑定到卡组后在「对战分析」页转成展开说明。
        </p>
      </div>
      <div class="duel-head-actions">
        <div class="head-group core">
          <select
            class="select deck-picker"
            :value="deckStore.currentDeckId"
            @change="deckStore.select(($event.target as HTMLSelectElement).value)"
          >
            <option v-for="item in deckStore.decks" :key="item.id" :value="item.id">{{ item.name }}</option>
          </select>
          <label class="inline-note">
            起手
            <input v-model.number="handSize" class="input hand-input" type="number" min="1" max="10" />
          </label>
          <button class="btn" :class="{ primary: openingPicks.length }" @click="pickerOpen = true">
            自选手牌 {{ openingPicks.length ? `${openingPicks.length}/${handSize}` : '' }}
          </button>
          <button class="btn" :disabled="starting" @click="checkpointOpen = true">
            历史暂存 {{ checkpoints.length ? `(${checkpoints.length})` : '' }}
          </button>
          <button
            v-if="session"
            class="btn"
            :class="{ primary: aiEnabled }"
            :disabled="starting || replaying || !aiActive"
            :title="
              !aiActive ? 'AI 未开启：先到「AI 设置」页打开总开关并填写密钥' : undefined
            "
            @click="aiEnabled = !aiEnabled"
          >
            {{ aiEnabled ? 'AI 代打中' : 'AI 代打' }}
          </button>
          <RouterLink class="btn" to="/ai" title="会离开当前对局，可先用「暂存」保存进度">
            AI 设置
          </RouterLink>
          <button class="btn primary" :disabled="starting" @click="launchDuel">
            {{ session ? '重新开始' : '开始对局' }}
          </button>
        </div>
        <div class="head-group view">
          <button v-if="fullscreenSupported" class="btn" @click="toggleWebFullscreen">
            {{ webFullscreen ? '退出屏幕全屏' : '屏幕全屏' }}
          </button>
          <button class="btn" :disabled="starting" title="场地铺满视口，隐藏列表信息" @click="immersive = true">
            网站全屏
          </button>
        </div>
      </div>
    </div>

    <div
      v-if="aiEnabled || aiLog.length"
      class="duel-ai"
      :class="{ paused: !aiEnabled }"
    >
      <span class="ai-tag">AI</span>
      <span class="ai-state">
        {{
          !aiEnabled
            ? '已暂停，手动操作中'
            : aiStatus === 'planning'
              ? '正在规划路线…'
              : aiStatus === 'thinking'
                ? '正在决策…'
                : '待命'
        }}
      </span>
      <span v-if="aiReason" class="ai-reason">{{ aiReason }}</span>
      <span v-if="aiError" class="ai-err">{{ aiError }}</span>
      <span class="ai-spacer" />
      <button class="btn sm ghost" @click="aiLogOpen = true">
        日志{{ aiLog.length ? ` (${aiLog.length})` : '' }}
      </button>
      <RouterLink class="btn sm ghost" to="/ai" title="会离开当前对局，可先用「暂存」保存进度">
        设置
      </RouterLink>
      <button
        class="btn sm"
        :class="{ primary: !aiEnabled }"
        :disabled="!aiActive"
        :title="!aiActive ? 'AI 未开启：先到「AI 设置」页打开总开关并填写密钥' : undefined"
        @click="aiEnabled = !aiEnabled"
      >
        {{ aiEnabled ? '接管回来' : '继续接管' }}
      </button>
    </div>

    <div v-if="errorText" class="duel-error">{{ errorText }}</div>
    <div v-else-if="sessionError" class="duel-error">{{ sessionError }}</div>
    <div v-if="missingScriptNames.length" class="duel-warn">
      这些卡没有内核脚本，效果不会生效：{{ missingScriptNames.join('、') }}
    </div>

    <div class="duel-meta">
      <span class="chip">卡组：{{ deckSummary }}</span>
      <span class="chip-dim">{{ deckStore.current?.name || '未命名卡组' }}</span>
      <span v-if="openingPicks.length" class="chip-dim">自选起手 {{ openingPicks.length }} 张</span>
      <span v-if="seedText" class="chip-dim mono">{{ seedText }}</span>
      <span v-if="state?.finished" class="chip-win">{{ state.winner === 0 ? '我方胜利' : '对手胜利' }}</span>
    </div>

    <div ref="boardRef" class="duel-board">
      <!-- 左栏：悬停卡片的卡图 + 效果描述（用棋盘左侧留白，不挡场地） -->
      <aside v-if="state" class="duel-inspect">
        <div class="inspect-card">
          <img v-if="inspectCard" :src="imageOf(inspectCard)" :alt="inspectCard.name" />
          <span v-else class="inspect-empty">移到卡片上查看</span>
        </div>
        <div v-if="inspectCard" class="inspect-title">{{ inspectCard.name }}</div>
        <div v-if="inspectCard" class="inspect-meta">
          {{ inspectCard.hidden ? '盖放卡片' : positionLabel(inspectCard.position) }}
          <template v-if="inspectCard.materials"> · 素材 {{ inspectCard.materials }}</template>
        </div>
        <div v-if="inspectCard?.materials" class="inspect-materials">
          <div class="inspect-material-list">
            <img
              v-for="(code, index) in inspectCard.overlayCodes || []"
              :key="`im-${index}`"
              :src="cardImageUrl(code)"
              :alt="nameOf(code)"
              :title="nameOf(code)"
            />
          </div>
          <span class="inspect-material-note">右下角数字可放大查看</span>
        </div>
        <div class="inspect-desc">
          {{ inspectCard ? inspectDesc : '把鼠标移到任意卡片上，这里会显示卡图与效果描述。' }}
        </div>
      </aside>
      <!-- 右栏：场地 + 操作条，整体在自己的区域内居中，不会因为左栏而错位 -->
      <div class="duel-arena">
      <div
        v-if="state"
        class="field"
        :style="zoneHeight ? ({ '--zone-h': `${zoneHeight}px` } as Record<string, string>) : undefined"
      >
        <!-- 回合 / 阶段：挪到场地最上面，中间整行只留给额外怪兽区 -->
        <div class="center-band">
          <span class="turn-chip" :class="state.turnPlayer === 0 ? 'mine' : 'foe'">
            第 {{ state.turn }} 回合 · {{ state.turnPlayer === 0 ? '我方回合' : '对手回合' }}
          </span>
          <div class="phase-steps">
            <span
              v-for="step in PHASE_STEPS"
              :key="step.value"
              class="phase"
              :class="{ on: state.phase === step.value }"
            >
              {{ step.label }}
            </span>
          </div>
        </div>

        <template v-for="player in ([1, 0] as const)" :key="player">
          <section class="half" :class="player === 0 ? 'mine' : 'foe'">
            <header class="half-head">
              <span class="who">{{ player === 0 ? '我' : '沙包' }}</span>
              <span class="lp" :class="{ flash: lpFx && lpFx.player === player }">
                LP {{ state.players[player].lp }}
                <span v-if="lpFx && lpFx.player === player" class="lp-delta" :class="lpFx.delta > 0 ? 'up' : 'down'">
                  {{ lpFx.delta > 0 ? '+' : '' }}{{ lpFx.delta }}
                </span>
              </span>
              <span class="half-tags">
                <span>手卡 {{ player === 0 ? state.players[0].hand.length : state.players[player].handCount }}</span>
                <span>卡组 {{ state.players[player].deckCount }}</span>
              </span>
            </header>

            <div class="half-body">
              <!-- 左：场地区 -->
              <div class="rail rail-field">
                <div
                  class="zone field"
                  :class="{
                    filled: fieldSlot(player).card,
                    clickable: isSlotClickable(player, OcgLocation.FZONE, 0),
                    on: isSlotSelected(player, OcgLocation.FZONE, 0),
                  }"
                  @click="onSlotClick(player, OcgLocation.FZONE, 0, $event)"
                  @mouseenter="preview = fieldSlot(player).card"
                  @mouseleave="preview = null"
                >
                  <img v-if="fieldSlot(player).card" :src="faceOf(fieldSlot(player).card)" alt="场地魔法" />
                  <span v-else class="zone-hint">场地</span>
                </div>
              </div>

              <!-- 中：怪兽区（含额外怪兽区）与魔陷区（含两端灵摆区） -->
              <div class="mat">
                <div
                  v-for="row in rowsFor(player)"
                  :key="row.key"
                  class="row"
                  :class="row.kind"
                  :style="{ order: row.order }"
                >
                  <!-- 额外卡组贴着左灵摆区，随时能点开看 -->
                  <button
                    v-if="row.kind === 'spells'"
                    class="pile card-pile beside left"
                    :class="{ actionable: extraActionable(player) }"
                    @click="openPile(player, 'extra')"
                  >
                    <span class="pile-label">额外</span>
                    <span class="pile-count">{{ state.players[player].extraCount }}</span>
                  </button>

                  <template v-for="(zone, index) in row.cells" :key="zone ? `${zone.location}-${zone.sequence}` : `gap-${index}`">
                    <div v-if="!zone" class="zone gap" />
                    <div
                      v-else
                      class="zone"
                      :class="[
                        zone.kind,
                        {
                          filled: zone.card,
                          clickable: isSlotClickable(player, zone.location, zone.sequence),
                          on: isSlotSelected(player, zone.location, zone.sequence),
                          attacking: attackFx && attackFx.key === slotKey(player, zone.location, zone.sequence),
                        },
                      ]"
                      @click="onSlotClick(player, zone.location, zone.sequence, $event)"
                      @mouseenter="preview = zone.card"
                      @mouseleave="preview = null"
                    >
                      <img
                        v-if="zone.card"
                        :src="faceOf(zone.card)"
                        :alt="zone.card.name"
                        :class="{ rotated: !isAttackPosition(zone.card.position) }"
                      />
                      <span v-else class="zone-hint">{{ zone.hint }}</span>
                      <button
                        v-if="zone.card?.materials"
                        class="zone-badge"
                        type="button"
                        title="查看超量素材"
                        @click.stop="openMaterials(zone.card)"
                      >
                        {{ zone.card.materials }}
                      </button>
                      <span v-if="chainLinkOf(zone.card)" class="chain-badge">C{{ chainLinkOf(zone.card) }}</span>
                      <span v-if="slotOrder(player, zone.location, zone.sequence)" class="pick-badge">
                        {{ slotOrder(player, zone.location, zone.sequence) }}
                      </span>

                      <!-- 灵摆区叠在魔陷区最左/最右格上 -->
                      <div
                        v-if="zone.pendulum"
                        class="pendulum"
                        :class="{
                          filled: zone.pendulum.card,
                          clickable: isSlotClickable(player, OcgLocation.PZONE, zone.pendulum.sequence),
                          on: isSlotSelected(player, OcgLocation.PZONE, zone.pendulum.sequence),
                        }"
                        @click.stop="onSlotClick(player, OcgLocation.PZONE, zone.pendulum.sequence, $event)"
                        @mouseenter.stop="preview = zone.pendulum.card"
                        @mouseleave.stop="preview = null"
                      >
                        <img v-if="zone.pendulum.card" :src="faceOf(zone.pendulum.card)" alt="灵摆卡" />
                        <span v-else class="pendulum-hint">灵摆</span>
                      </div>
                    </div>
                  </template>

                  <!-- 主卡组贴着右灵摆区 -->
                  <div v-if="row.kind === 'spells'" class="pile card-pile plain beside right">
                    <span class="pile-label">卡组</span>
                    <span class="pile-count">{{ state.players[player].deckCount }}</span>
                  </div>
                </div>
              </div>

              <!-- 右：除外 / 墓地，格子跟卡一样大，随时能看到里面是什么 -->
              <div class="rail piles">
                <button
                  v-for="kind in pileOrder(player)"
                  :key="kind"
                  class="pile card-pile"
                  @click="openPile(player, kind)"
                >
                  <img v-if="pileTop(player, kind)" :src="imageOf(pileTop(player, kind))" :alt="kind === 'gy' ? '墓地' : '除外'" />
                  <span class="pile-label">{{ kind === 'gy' ? '墓地' : '除外' }}</span>
                  <span class="pile-count">{{ pileCards(player, kind).length }}</span>
                </button>
              </div>
            </div>

            <!-- 手卡行只放手卡，卡组 / 额外已经贴到魔陷区两侧 -->
            <div class="hand-row">
              <template v-if="player === 0">
                <div
                  v-for="(card, index) in handOf(0)"
                  :key="`h-${index}`"
                  class="hand-card"
                  :class="{ clickable: isSlotClickable(0, OcgLocation.HAND, index), on: isSlotSelected(0, OcgLocation.HAND, index) }"
                  @click="onSlotClick(0, OcgLocation.HAND, index, $event)"
                  @mouseenter="preview = card"
                  @mouseleave="preview = null"
                >
                  <img :src="imageOf(card)" :alt="card.name" />
                  <span v-if="slotOrder(0, OcgLocation.HAND, index)" class="pick-badge">
                    {{ slotOrder(0, OcgLocation.HAND, index) }}
                  </span>
                </div>
                <span v-if="!handOf(0).length" class="inline-note">手卡为空</span>
              </template>
              <!-- 对手手卡：只给数量，铺卡背，不泄露具体卡片 -->
              <template v-else>
                <div v-for="index in state.players[player].handCount" :key="`foe-h-${index}`" class="hand-card back">
                  <img :src="cardBack" alt="对手手卡" />
                </div>
                <span v-if="!state.players[player].handCount" class="inline-note hand-count">手卡为空</span>
              </template>
            </div>
          </section>

          <!-- 额外怪兽区：全场只有 2 格，双方共用，夹在两个半场中间 -->
          <div v-if="player === 1" class="emz-row">
            <div
              v-for="cell in emzCells"
              :key="cell.side"
              class="zone emz"
              :class="{ filled: cell.card, clickable: cell.clickable, on: cell.selected }"
              :style="{ gridColumn: cell.side === 'left' ? 2 : 4 }"
              @click="onEmzClick(cell.side, $event)"
              @mouseenter="preview = cell.card"
              @mouseleave="preview = null"
            >
              <img
                v-if="cell.card"
                :src="faceOf(cell.card)"
                :alt="cell.card.name"
                :class="{ rotated: !isAttackPosition(cell.card.position) }"
              />
              <span v-else class="zone-hint">额外</span>
              <button
                v-if="cell.card?.materials"
                class="zone-badge"
                type="button"
                title="查看超量素材"
                @click.stop="openMaterials(cell.card)"
              >
                {{ cell.card.materials }}
              </button>
              <span v-if="chainLinkOf(cell.card)" class="chain-badge">C{{ chainLinkOf(cell.card) }}</span>
            </div>
          </div>
        </template>
      </div>

      <div v-else class="duel-placeholder">
        <p class="inline-note">
          对局还没有开始。选好卡组后点「开始对局」。<br />
          首次对局会加载 ocgcore（WebAssembly）与卡片脚本，需要一点时间。
        </p>
      </div>

      <!-- 当前操作：棋盘内部的浮条，贴着视口底部，永远看得到 -->
      <section ref="promptRef" class="prompt" :class="{ active: Boolean(question) }">
        <div class="prompt-title">
          当前操作
          <span v-if="question" class="prompt-hint">{{ hintText }}</span>
          <span v-if="question" class="prompt-keys">
            <kbd>1-9</kbd> 选择 · <kbd>Enter</kbd> 确定 · <kbd>E</kbd> 结束回合 · <kbd>B</kbd> 下一阶段 · <kbd>A</kbd> 不发动
          </span>
        </div>
        <div v-if="starting" class="inline-note">正在加载内核与卡片脚本…</div>
        <div v-else-if="state?.finished" class="inline-note">对局已结束。</div>
        <DuelQuestionPanel
          v-else-if="question"
          ref="panelRef"
          dock
          :question="question"
          :name-of="nameOf"
          :option-labels="optionLabels"
          :selected="selected"
          :place-picks="placePicks"
          :hint="hintText"
          @answer="answer"
          @command="runCommand"
          @toggle="toggleIndex"
          @pick="pickCard"
          @confirm="confirmSelection"
          @cancel="cancelSelection"
          @toggle-place="togglePlace"
          @confirm-place="confirmPlaces"
          @skip="question && answer(autoSkip(question))"
        />
        <div v-else-if="replaying" class="inline-note">正在自动操作到暂存点…</div>
        <div v-else class="inline-note">{{ state ? '等待沙包行动…' : '先开始一局。' }}</div>
      </section>
      </div>
    </div>

    <div class="duel-extra">
      <section v-if="state?.chain.length" class="panel">
        <div class="panel-title">连锁</div>
        <div v-for="(link, index) in state.chain" :key="`${link.code}-${index}`" class="chain-row">
          <span class="chain-dot">C{{ link.link }}</span>
          <span>{{ link.name }}</span>
        </div>
      </section>

      <section class="panel log-panel">
        <div class="panel-title log-title" @click="showLog = !showLog">
          对局记录
          <span class="inline-note">{{ showLog ? '收起' : '展开' }}</span>
        </div>
        <div v-if="showLog" class="log-list">
          <div v-for="entry in logs" :key="entry.id" class="log-line" :class="`log-${entry.player}`">
            {{ entry.text }}
          </div>
        </div>
      </section>
    </div>

    <!-- 墓地 / 除外 全屏查看 -->
    <div v-if="pileView" class="pile-overlay" @click.self="pileView = null">
      <div class="pile-modal">
        <div class="pile-head">
          <span class="panel-title">
            {{ pileView.player === 0 ? '我方' : '对手' }}{{ pileView.kind === 'gy' ? '墓地' : '除外' }}
            （{{ pileCards(pileView.player, pileView.kind).length }} 张）
          </span>
          <button class="btn sm" @click="pileView = null">关闭</button>
        </div>
        <div class="pile-grid">
          <div
            v-for="entry in pileEntries(pileView.player, pileView.kind)"
            :key="`pv-${entry.index}`"
            class="pile-item"
            :class="{
              clickable: isSlotClickable(pileView.player, pileLocation(pileView.kind), entry.index),
              on: isSlotSelected(pileView.player, pileLocation(pileView.kind), entry.index),
            }"
            @click="onSlotClick(pileView.player, pileLocation(pileView.kind), entry.index, $event)"
            @mouseenter="preview = entry.card"
            @mouseleave="preview = null"
          >
            <img :src="imageOf(entry.card)" :alt="entry.card.name" />
            <span class="pile-name">{{ entry.card.name }}</span>
            <span
              v-if="slotOrder(pileView.player, pileLocation(pileView.kind), entry.index)"
              class="pick-badge"
            >
              {{ slotOrder(pileView.player, pileLocation(pileView.kind), entry.index) }}
            </span>
          </div>
          <span v-if="!pileEntries(pileView.player, pileView.kind).length" class="inline-note">空</span>
        </div>
      </div>
    </div>

    <!-- 超量素材：点带素材的怪兽或角标打开 -->
    <div v-if="materialView" class="pile-overlay" @click.self="materialView = null">
      <div class="pile-modal">
        <div class="pile-head">
          <span class="panel-title">
            「{{ materialView.name }}」的超量素材（{{ materialView.codes.length }}）
          </span>
          <button class="btn sm" @click="materialView = null">关闭</button>
        </div>
        <div class="pile-grid">
          <div v-for="(code, index) in materialView.codes" :key="`mat-${index}`" class="pile-item">
            <img :src="cardImageUrl(code)" :alt="nameOf(code)" />
            <span class="pile-name">{{ nameOf(code) }}</span>
          </div>
          <span v-if="!materialView.codes.length" class="inline-note">没有查到素材信息。</span>
        </div>
      </div>
    </div>

    <!-- 自选起手 -->
    <div v-if="pickerOpen" class="pile-overlay" @click.self="pickerOpen = false">
      <div class="pile-modal">
        <div class="pile-head">
          <span class="panel-title">
            自选起手（{{ openingPicks.length }}/{{ handSize }}）· 按点击顺序进手牌
          </span>
          <div class="pick-actions">
            <button class="btn sm" @click="openingPicks = []">清空</button>
            <button class="btn sm primary" @click="pickerOpen = false">完成</button>
          </div>
        </div>
        <div v-if="!deckEntries.length" class="inline-note">当前卡组没有卡，先去「卡组构建」选卡。</div>
        <div class="pick-grid">
          <div v-for="entry in deckEntries" :key="entry.id" class="pick-item" :class="{ on: pickCount(entry.id) }">
            <img :src="cardImageUrl(entry.id)" :alt="entry.name" @click="addPick(entry)" />
            <span class="pick-name">{{ entry.name }}</span>
            <span class="pick-deck">卡组 {{ entry.count }}</span>
            <span v-if="pickCount(entry.id)" class="pick-badge">×{{ pickCount(entry.id) }}</span>
            <button v-if="pickCount(entry.id)" class="pick-minus" @click.stop="removePick(entry.id)">−</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 结束对局：先问要不要存一份录像 -->
    <div v-if="endConfirm" class="pile-overlay" @click.self="endConfirm = false">
      <div class="pile-modal end-dialog">
        <div class="pile-head">
          <span class="panel-title">结束对局</span>
          <button class="btn sm" @click="endConfirm = false">取消</button>
        </div>
        <p class="end-text">
          这一局打了 {{ state?.turn ?? 0 }} 个回合。要不要把过程导出成 .yrp 录像？<br />
          导出后可以用任何支持回放的 YGO 客户端按你的操作重现这一局；<br />
          绑定到卡组则会在「对战分析」页被重放成这套卡组的展开说明。
        </p>
        <label class="end-name">
          <span>录像名</span>
          <input v-model="replayNameInput" class="input" spellcheck="false" placeholder="给这局起个名字" />
        </label>
        <div class="end-actions">
          <button class="btn sm" @click="finishDuel('none')">直接结束</button>
          <button class="btn sm" :disabled="!canExport" @click="finishDuel('bind')">绑定到卡组并结束</button>
          <button class="btn sm primary" :disabled="!canExport" @click="finishDuel('export')">
            导出 .yrp 并结束
          </button>
        </div>
      </div>
    </div>

    <!-- 历史暂存：选一条从那个局面接着打 -->
    <div v-if="checkpointOpen" class="pile-overlay" @click.self="checkpointOpen = false">
      <div class="pile-modal">
        <div class="pile-head">
          <span class="panel-title">历史暂存（{{ checkpoints.length }}）</span>
          <button class="btn sm" @click="checkpointOpen = false">关闭</button>
        </div>
        <p class="end-text">
          暂存记录的是开局参数和我方做过的每一步决定。载入后会重开一局并自动操作到存档点，
          然后交还给你继续打。暂存按卡组独立保存，卡表（卡号 / 张数）改动后旧暂存会自动作废。
        </p>
        <div v-if="!checkpoints.length" class="inline-note" style="margin-top: 12px">
          当前卡组还没有暂存。对局中点上方的「暂存」就会存到当前局面。
        </div>
        <div v-else class="cp-list">
          <div v-for="item in checkpoints" :key="item.id" class="cp-item">
            <div class="cp-main">
              <span class="cp-title">{{ item.label }}</span>
              <span class="chip-dim">
                第 {{ item.turn }} 回合 · {{ item.steps.length }} 步操作 · {{ item.deckName }}
              </span>
              <span class="chip-dim">{{ new Date(item.createdAt).toLocaleString() }}</span>
            </div>
            <div class="cp-actions">
              <button class="btn sm" @click="deleteCheckpoint(item.id)">删除</button>
              <button class="btn sm primary" :disabled="starting" @click="launchRestore(item)">载入</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-if="toast" class="duel-toast">{{ toast }}</div>

    <!-- 一张卡有多个操作时的浮层 -->
    <div v-if="menu" class="menu-backdrop" @click="menu = null" />
    <div v-if="menu" class="duel-menu" :style="{ left: `${menu.x}px`, top: `${menu.y}px` }">
      <button v-for="(item, index) in menu.items" :key="`${item.action}-${item.index}`" class="menu-item" @click.stop="runCommand(item)">
        <span class="menu-label">
          <kbd v-if="index < 9">{{ index + 1 }}</kbd>
          {{ item.label }}
        </span>
        <span class="menu-zone">{{ zoneLabel(item.location, item.sequence) }}</span>
      </button>
    </div>

    <!-- AI 决策日志：规划 / 每步选择 / 打断 / 降级 -->
    <div v-if="aiLogOpen" class="ai-log-mask" @click.self="aiLogOpen = false">
      <section class="ai-log-panel">
        <header class="ai-log-head">
          <span class="panel-title">AI 决策日志</span>
          <span class="ai-log-count">{{ aiLog.length }} 条</span>
          <span class="ai-spacer" />
          <label class="ai-log-filter">
            <input v-model="aiLogAll" type="checkbox" />
            显示自动步骤
          </label>
          <button
            class="btn sm"
            :disabled="!aiLog.length"
            title="导出完整日志：模型配置、skill 状态、录像解析情况、盘面、每条请求与返回"
            @click="exportAiLog"
          >
            导出日志
          </button>
          <button class="btn sm ghost" @click="aiLogOpen = false">关闭</button>
        </header>

        <!-- 路线与日志共用一个滚动区：plan 长了也不会把日志压没 -->
        <div class="ai-log-body">
          <div v-if="aiPlan" class="ai-log-plan">
            <div class="plan-route">{{ aiPlan.route }}</div>
            <div v-if="aiPlan.goal" class="plan-line">目标：{{ aiPlan.goal }}</div>
            <ol v-if="aiPlan.steps.length" class="plan-steps">
              <li v-for="(step, index) in aiPlan.steps" :key="index">{{ step }}</li>
            </ol>
            <div v-if="aiPlan.avoid.length" class="plan-line">避免：{{ aiPlan.avoid.join('；') }}</div>
            <div v-if="aiPlan.handtraps.length" class="plan-line">
              手坑应对：{{ aiPlan.handtraps.join('；') }}
            </div>
          </div>

          <ol v-if="aiLogVisible.length" class="ai-log-list">
            <li
              v-for="(item, index) in aiLogVisible"
              :key="`${item.at}-${index}`"
              :class="`k-${item.kind}`"
            >
              <div class="log-head">
                <span class="log-time">{{ aiLogTime(item.at) }}</span>
                <span class="log-kind">{{ AI_LOG_KINDS[item.kind] }}</span>
                <span class="log-title">{{ item.title }}</span>
                <span v-if="item.candidateCount" class="log-cands">{{ item.candidateCount }} 选</span>
                <span class="log-meta">
                  <template v-if="item.latencyMs">{{ item.latencyMs }}ms</template>
                  <template v-if="aiTokenText(item)"> · {{ aiTokenText(item) }}</template>
                  <template v-if="item.retries"> · 重试 {{ item.retries }}</template>
                </span>
              </div>
              <div class="log-detail">{{ item.detail }}</div>
              <div v-if="item.reason" class="log-reason">理由：{{ item.reason }}</div>
              <details v-if="item.request || item.raw" class="log-io">
                <summary>查看发给模型的内容与原始返回</summary>
                <div v-if="item.request" class="log-io-block">
                  <div class="log-io-label">发给模型</div>
                  <pre class="log-io-pre">{{ item.request }}</pre>
                </div>
                <div v-if="item.raw" class="log-io-block">
                  <div class="log-io-label">原始返回</div>
                  <pre class="log-io-pre">{{ item.raw }}</pre>
                </div>
              </details>
            </li>
          </ol>

          <div v-else class="ai-log-empty">
            还没有决策记录。开启 AI 代打后，路线规划、每一步选择、被打断与降级都会记在这里。
          </div>
        </div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.duel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 22px 24px 40px;
}

/* 网站全屏布局：整块对战区一屏放下，不出现滚动条。
   垂直方向一共 8 行卡高（双方各 3 行场地 + 各 1 行手卡），
   其余固定开销（HUD / 中线 / 操作条 / 内边距）按 340px 预留，
   所以卡高由视口高度反算，视口越高卡越大，最矮的屏幕也保证不滚。 */
.duel.immersive {
  position: fixed;
  inset: 0;
  z-index: 60;
  height: 100vh;
  max-height: 100vh;
  height: 100dvh;
  max-height: 100dvh;
  gap: 6px;
  padding: 6px 14px 8px;
  overflow: hidden;
  background: radial-gradient(circle at 50% 38%, rgba(47, 129, 247, 0.1), transparent 62%), var(--bg);
}

.duel.immersive .duel-head,
.duel.immersive .duel-meta,
.duel.immersive .duel-extra {
  display: none;
}

.duel.immersive .duel-board {
  flex: 1;
  min-height: 0;
  gap: 10px;
  padding: 8px 12px 10px;
  overflow: hidden;
}

/* 精确的卡高由 measureZoneHeight() 内联写进 --zone-h（跟着操作条实时变），
   这里的公式只是首帧兜底 */
.duel.immersive .field {
  --zone-h: clamp(46px, calc((100vh - 400px) / 7), 140px);
  --zone-w: calc(var(--zone-h) * 0.7);
  /* 上下 margin auto 把场地在剩余高度里居中，操作条永远贴在最下方 */
  margin-block: auto;
}

/* 全屏下操作条跟着场地走，不再吸底。
   高度固定：操作项变多 / 变少都不再改变 measureZoneHeight 的结果，
   卡高只在视口尺寸变化时重算；内容放不下就在条内滚动。 */
.duel.immersive .prompt {
  position: static;
  margin-top: 0;
  flex: none;
  height: clamp(142px, 18vh, 168px);
  overflow: auto;
}

/* 全屏空间宝贵：选项排紧一点，别让一堆效果把操作条撑爆 */
.duel.immersive :deep(.dq.dock) {
  gap: 8px;
}

.duel.immersive :deep(.dq.dock .dq-head) {
  max-width: 18vw;
  overflow: hidden;
  font-size: 11px;
}

.duel.immersive :deep(.dq.dock .dq-keys) {
  display: none;
}

.duel.immersive :deep(.dq.dock .dq-item) {
  gap: 6px;
  /* 右侧留给键盘角标 */
  padding: 4px 20px 4px 8px;
  font-size: 11px;
}

.duel.immersive :deep(.dq.dock .dq-thumb) {
  width: 16px;
  height: 24px;
}

/* 全屏下也保留 1-9 角标：它不占布局宽度，是唯一能直接看出按哪个键的提示 */
.duel.immersive :deep(.dq.dock .dq-key) {
  min-width: 13px;
  padding: 0 2px;
  line-height: 13px;
  font-size: 9px;
}

/* 选项区不再自己滚，改成整条操作条滚，避免出现两层滚动条 */
.duel.immersive :deep(.dq.dock .dq-body) {
  max-height: none;
  overflow: visible;
}

.duel.immersive .center-band {
  padding: 2px 0;
  margin: 0;
}

.duel.immersive .half-head {
  font-size: 11px;
}

/* 全屏时 HUD 常驻：重开 / 暂存 / 结束对局 */
.duel-hud {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 6px 10px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: rgba(9, 13, 20, 0.9);
  font-size: 12px;
}

.hud-name {
  font-weight: 650;
}

.hud-replay {
  color: var(--gold);
}

/* 全屏时日志区被收起来，连锁进度挪到 HUD 里 */
.hud-chain {
  display: inline-flex;
  gap: 4px;
  flex-wrap: wrap;
  min-width: 0;
}

.chip-chain {
  padding: 1px 7px;
  border-radius: 999px;
  background: rgba(139, 108, 255, 0.22);
  color: #c7b4ff;
  font-size: 11px;
  white-space: nowrap;
}

.hud-spacer {
  margin-left: auto;
}

.duel-toast {
  position: fixed;
  left: 50%;
  bottom: 120px;
  z-index: 70;
  transform: translateX(-50%);
  padding: 8px 18px;
  border-radius: 999px;
  border: 1px solid rgba(113, 255, 176, 0.45);
  background: rgba(9, 13, 20, 0.94);
  color: var(--green);
  font-size: 12px;
  pointer-events: none;
}

/* 结束对局确认 */
.end-dialog {
  max-width: 420px;
}

.end-text {
  margin: 12px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-dim);
}

.end-name {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
  font-size: 12px;
  color: var(--text-dim);
}

.end-name .input {
  flex: 1;
  min-width: 0;
  padding: 6px 10px;
  font-size: 12px;
}

.end-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
  flex-wrap: wrap;
}

/* 暂存列表 */
.cp-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 58vh;
  overflow: auto;
  margin-top: 12px;
}

.cp-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: rgba(240, 243, 246, 0.03);
}

.cp-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.cp-title {
  font-size: 13px;
  font-weight: 600;
}

.cp-actions {
  display: flex;
  gap: 6px;
  flex: none;
}

.duel-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 18px;
  flex-wrap: wrap;
}

.page-title {
  margin: 0 0 4px;
  font-size: 22px;
  font-weight: 650;
}

.duel-head-actions {
  display: flex;
  align-items: center;
  gap: 10px 28px;
  flex-wrap: wrap;
  /* 占满标题右侧的剩余空间：核心操作贴左，视图操作贴右 */
  flex: 1 1 auto;
  min-width: 0;
  justify-content: space-between;
}

.head-group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.head-group.view {
  margin-left: auto;
}

.deck-picker {
  min-width: 160px;
}

.hand-input {
  width: 64px;
  margin-left: 6px;
}

.duel-error {
  padding: 9px 12px;
  border-radius: 10px;
  border: 1px solid rgba(255, 106, 105, 0.45);
  background: rgba(255, 106, 105, 0.1);
  color: var(--red);
  font-size: 12px;
}

/* AI 代打状态条：只在开启时出现，保持和错误条同一行的视觉层级 */
.duel-ai {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 7px 12px;
  border: 1px solid rgba(113, 183, 255, 0.4);
  border-radius: 10px;
  background: rgba(113, 183, 255, 0.08);
  font-size: 12px;
  color: var(--text-dim);
}

.ai-tag {
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--gold-deep);
  color: #fff;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.08em;
}

.ai-state {
  color: var(--gold);
}

/* 暂停状态：条形还在（日志入口不能丢），但视觉上退到背景 */
.duel-ai.paused {
  border-color: var(--line);
  background: transparent;
}

.duel-ai.paused .ai-tag {
  background: var(--line);
  color: var(--text-mute);
}

.duel-ai.paused .ai-state {
  color: var(--text-mute);
}

.ai-reason {
  max-width: 52ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-mute);
}

.ai-err {
  color: var(--amber);
}

.ai-spacer {
  flex: 1;
}

/* AI 决策日志：右侧抽屉，只读 */
.ai-log-mask {
  position: fixed;
  inset: 0;
  z-index: 58;
  display: flex;
  justify-content: flex-end;
  background: rgba(0, 0, 0, 0.45);
}

.ai-log-panel {
  display: flex;
  flex-direction: column;
  width: min(480px, 100vw);
  height: 100%;
  min-height: 0;
  overflow: hidden;
  border-left: 1px solid var(--line);
  background: var(--panel);
}

.ai-log-head {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--line);
}

/*
 * 滚动容器：路线 + 日志都放在这里。
 * 之前是 list 自己 flex:1 + overflow，而 flex 子项的 min-height 默认取内容高度，
 * 路线一长就把 list 压到几乎 0 高——内容看不到也滚不动。
 */
.ai-log-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: thin;
  scrollbar-color: rgba(240, 243, 246, 0.18) transparent;
}

.ai-log-count {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-mute);
}

.ai-log-filter {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--text-mute);
  cursor: pointer;
}

.ai-log-plan {
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
  background: var(--panel-2);
  font-size: 12px;
  line-height: 1.65;
}

.plan-route {
  color: var(--gold);
  font-weight: 600;
}

.plan-line {
  margin-top: 2px;
  color: var(--text-mute);
}

.plan-steps {
  margin: 6px 0 0;
  padding-left: 18px;
  color: var(--text-dim);
}

.ai-log-list {
  padding: 10px 14px 20px;
  margin: 0;
  list-style: none;
}

.ai-log-list li {
  padding: 8px 10px;
  margin-bottom: 6px;
  border-left: 2px solid var(--line);
  border-radius: 0 4px 4px 0;
  background: var(--panel-2);
  font-size: 12px;
}

.ai-log-list li.k-plan,
.ai-log-list li.k-replan {
  border-left-color: var(--gold);
}

.ai-log-list li.k-decide {
  border-left-color: var(--green);
}

.ai-log-list li.k-fallback {
  border-left-color: var(--amber);
}

.ai-log-list li.k-interrupt {
  border-left-color: var(--violet);
}

.ai-log-list li.k-switch {
  border-left-color: var(--cyan);
  background: rgba(57, 197, 207, 0.07);
}

.ai-log-list li.k-auto {
  border-left-color: var(--line);
  opacity: 0.75;
}

.log-head {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: baseline;
}

.log-time {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--text-mute);
}

.log-kind {
  padding: 0 5px;
  border-radius: 3px;
  background: rgba(113, 183, 255, 0.14);
  color: var(--gold);
  font-size: 10px;
}

.log-title {
  color: var(--text-dim);
}

.log-cands {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--text-mute);
}

.log-meta {
  margin-left: auto;
  font-family: var(--mono);
  font-size: 10px;
  color: var(--text-mute);
}

.log-detail {
  margin-top: 4px;
  color: var(--text);
  word-break: break-word;
}

.log-reason {
  margin-top: 3px;
  font-size: 11px;
  color: var(--text-mute);
}

.log-io {
  margin-top: 6px;
}

.log-io summary {
  cursor: pointer;
  font-size: 11px;
  color: var(--cyan);
}

.log-io-block {
  margin-top: 6px;
}

.log-io-label {
  margin-bottom: 3px;
  font-size: 10px;
  color: var(--text-mute);
}

.log-io-pre {
  max-height: 280px;
  padding: 8px 10px;
  margin: 0;
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--bg-2);
  color: var(--text-dim);
  font-family: var(--mono);
  font-size: 10px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}

.ai-log-empty {
  padding: 24px 16px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-mute);
}

.duel-warn {
  padding: 9px 12px;
  border-radius: 10px;
  border: 1px solid rgba(255, 176, 32, 0.4);
  background: rgba(255, 176, 32, 0.09);
  color: var(--amber);
  font-size: 12px;
}

.duel-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
}

.chip-dim {
  color: var(--text-mute);
  font-size: 11px;
}

.chip-win {
  color: var(--green);
  font-weight: 600;
}

.mono {
  font-family: var(--mono);
}

.duel-board {
  display: flex;
  flex-direction: row;
  align-items: stretch;
  gap: 12px;
  padding: 14px 16px 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: radial-gradient(circle at 50% 50%, rgba(47, 129, 247, 0.07), transparent 62%), var(--panel);
  min-height: 460px;
}

/* 右栏：场地与操作条各自成列，场地在本栏内居中，不会因为左栏整体偏移 */
.duel-arena {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* 左栏：卡图在上、效果描述在下 */
.duel-inspect {
  flex: none;
  width: 240px;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: rgba(9, 13, 20, 0.82);
  overflow: hidden;
}

/* 卡图不贴左右边，固定宽度居中 */
.inspect-card {
  flex: none;
  width: 172px;
  margin: 0 auto;
  aspect-ratio: 421 / 614;
  display: grid;
  place-items: center;
  border-radius: 6px;
  border: 1px solid var(--line);
  background: rgba(240, 243, 246, 0.04);
  overflow: hidden;
}

.inspect-card img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.inspect-empty {
  padding: 0 8px;
  color: var(--text-mute);
  font-size: 11px;
  text-align: center;
}

.inspect-title {
  font-size: 12px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.inspect-meta {
  font-size: 10px;
  color: var(--text-mute);
}

/* 超量素材：横排缩略图，悬停怪兽时直接能看到叠在下面的卡 */
.inspect-materials {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.inspect-material-list {
  display: flex;
  gap: 3px;
  overflow-x: auto;
  padding-bottom: 2px;
}

.inspect-material-list img {
  flex: none;
  width: 34px;
  aspect-ratio: 421 / 614;
  object-fit: cover;
  border-radius: 3px;
  border: 1px solid var(--line);
}

.inspect-material-note {
  color: var(--text-mute);
  font-size: 10px;
}

.inspect-desc {
  flex: 1;
  min-height: 0;
  overflow: auto;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-dim);
  white-space: pre-wrap;
}

@media (max-width: 900px) {
  .duel-inspect {
    display: none;
  }
}

/* ---------------------------------------------------------------- */
/* 决斗盘                                                            */
/* ---------------------------------------------------------------- */

.field {
  /* 卡片尺寸只有一个来源：改这两个变量，整块场地等比缩放 */
  --zone-h: 92px;
  --zone-w: 64px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.half {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* 场地永远贴着中间的额外怪兽区：手卡和头部信息都往外推。
   我方从内到外是 场地 → 手卡 → 头部，对手镜像成 头部 → 手卡 → 场地，
   这样额外怪兽区到两边怪兽区的距离完全一致。 */
.half.mine .half-body {
  order: 0;
}

.half.mine .hand-row {
  order: 1;
}

.half.mine .half-head {
  order: 2;
}

.half.foe .half-head {
  order: 0;
}

.half.foe .hand-row {
  order: 1;
}

.half.foe .half-body {
  order: 2;
}

.half-head {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: var(--text-dim);
}

.half.foe .half-head {
  flex-direction: row-reverse;
}

.who {
  font-weight: 650;
}

.lp {
  position: relative;
  color: var(--gold);
  font-family: var(--mono);
  font-size: 13px;
  transition: color 0.2s ease;
}

.lp.flash {
  color: var(--red);
  animation: lp-pulse 0.6s ease;
}

.lp-delta {
  margin-left: 4px;
  font-size: 11px;
}

.lp-delta.down {
  color: var(--red);
}

.lp-delta.up {
  color: var(--green);
}

.half-tags {
  display: inline-flex;
  gap: 8px;
  color: var(--text-mute);
  font-size: 11px;
}

.half-body {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

/* 中间三行：额外怪兽区 / 怪兽区 / 魔陷区（行序由 order 控制，双方镜像）
   场地 / 墓地直接贴着怪兽区，卡组与额外卡组挂在魔陷区两侧，
   与场地 / 墓地在同一列、不同行（灵摆区那一行），所以互不遮挡。 */
.mat {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: center;
}

/* 卡组 / 额外卡组贴在魔陷区（灵摆区）两端，落在 .mat 的留白里 */
.row.spells {
  position: relative;
}

.row.spells > .beside {
  position: absolute;
  top: 0;
}

/* 左右正好落在场地 / 墓地那一列上（半个 half-body 的 gap 是 8px） */
.row.spells > .beside.left {
  right: calc(100% + 8px);
}

.row.spells > .beside.right {
  left: calc(100% + 8px);
}

.row {
  display: grid;
  gap: 4px;
}

.row.monsters,
.row.emz,
.row.spells {
  grid-template-columns: repeat(5, var(--zone-h));
}

/* 额外怪兽区：同行 2 格、跨在两名玩家之间，占第 2 / 4 列以对齐怪兽区 */
.emz-row {
  display: grid;
  grid-template-columns: repeat(5, var(--zone-h));
  gap: 4px;
  align-self: center;
  justify-content: center;
}

/* 怪兽区 / 魔陷区 / 额外怪兽区都是正方形格：卡图居中，守备表示旋转 90°
   也有足够横向空间，不会被压小。手卡 / 墓地 / 场地仍用窄长卡形。 */
.row.monsters > .zone,
.row.spells > .zone,
.emz-row > .zone {
  width: var(--zone-h);
  /* 高度交给 aspect-ratio，保证一定是正方形，哪怕别处又给 .zone 设了高度 */
  height: auto;
  aspect-ratio: 1 / 1;
}

/* 卡图：绝对定位 + margin auto，按原始比例缩到格内并严格居中。
   width/height 不能写 100%：竖版卡图会被拉成正方形、撑出格子。 */
.row.monsters > .zone img,
.row.spells > .zone img,
.emz-row > .zone img {
  position: absolute;
  inset: 0;
  width: auto;
  height: auto;
  max-width: 100%;
  max-height: 100%;
  margin: auto;
  object-fit: contain;
}

/* 守备表示逆时针转（卡顶朝左），正方形格里刚好放得下，不必缩到 0.72 */
.row.monsters > .zone img.rotated,
.emz-row > .zone img.rotated {
  --rot: -90deg;
  --zoom: 0.9;
}

.zone {
  position: relative;
  height: var(--zone-h);
  border: 1px dashed rgba(122, 130, 142, 0.32);
  border-radius: 4px;
  display: grid;
  place-items: center;
  background: rgba(240, 243, 246, 0.02);
  transition: border-color 0.12s ease, box-shadow 0.12s ease, background 0.12s ease;
  overflow: hidden;
}

.zone.gap {
  border-color: transparent;
  background: none;
}

.zone.emz {
  border-color: rgba(139, 108, 255, 0.4);
}

/* 魔陷区两端同时是灵摆区，给个淡一点的边提示 */
.row.spells > .zone:first-child,
.row.spells > .zone:last-child {
  border-color: rgba(113, 255, 176, 0.28);
}

.zone.filled {
  border-style: solid;
  border-color: rgba(122, 130, 142, 0.6);
}

.zone.clickable {
  cursor: pointer;
  border-color: rgba(113, 255, 176, 0.62);
  box-shadow: inset 0 0 0 1px rgba(113, 255, 176, 0.22), 0 0 10px rgba(113, 255, 176, 0.16);
}

.zone.clickable:hover {
  background: rgba(113, 255, 176, 0.1);
}

.zone.on {
  border-color: var(--gold);
  box-shadow: 0 0 0 2px rgba(255, 196, 87, 0.75), inset 0 0 14px rgba(255, 196, 87, 0.28);
}

.zone.attacking {
  animation: attack-lunge 0.5s ease;
  box-shadow: 0 0 0 2px rgba(255, 106, 105, 0.6), 0 0 18px rgba(255, 106, 105, 0.35);
}

/* 卡图必须严格待在格子里：格子宽高就是卡图比例，fill 不会有黑边也不会溢出 */
.zone img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: fill;
  border-radius: 3px;
  /*
   * 旋转和缩放都走自定义属性：pop-in 动画的 transform 会和守备表示的旋转
   * 抢同一个属性，直接写 rotate 的话动画期间旋转被盖掉，卡会先竖着出现，
   * 动画结束再突然横过来（看起来像先攻击表示再变守备）。
   */
  --rot: 0deg;
  --zoom: 1;
  transform: rotate(var(--rot)) scale(var(--zoom));
  animation: pop-in 0.3s cubic-bezier(0.2, 0.8, 0.3, 1.1);
  transition: transform 0.15s ease;
}

.zone img.rotated {
  --rot: -90deg;
  --zoom: 0.72;
}

/* 灵摆区：和魔陷区一样大，整格叠在最左/最右格上（有卡时整张卡盖在上面） */
.pendulum {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: grid;
  place-items: center;
  border: 1px dashed rgba(113, 255, 176, 0.28);
  border-radius: 4px;
  background: rgba(113, 255, 176, 0.03);
  overflow: hidden;
  cursor: default;
  /* 空格子不挡下面魔陷区的点击，只有能点/有卡时才接管 */
  pointer-events: none;
}

.pendulum.filled,
.pendulum.clickable,
.pendulum.on {
  pointer-events: auto;
}

.pendulum.filled {
  border-style: solid;
  border-color: rgba(113, 255, 176, 0.75);
  background: rgba(1, 4, 9, 0.9);
}

.pendulum.clickable {
  cursor: pointer;
  border-color: rgba(255, 196, 87, 0.85);
  box-shadow: 0 0 8px rgba(255, 196, 87, 0.45);
}

.pendulum.on {
  border-color: var(--gold);
  box-shadow: 0 0 0 2px rgba(255, 196, 87, 0.55);
}

.pendulum img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 2px;
}

.pendulum-hint {
  position: absolute;
  right: 3px;
  bottom: 2px;
  color: rgba(113, 255, 176, 0.5);
  font-size: 9px;
  letter-spacing: 1px;
}

.zone-hint {
  color: rgba(122, 130, 142, 0.55);
  font-size: 10px;
  letter-spacing: 1px;
}

.zone-badge {
  position: absolute;
  right: 2px;
  bottom: 2px;
  padding: 0 4px;
  border: none;
  border-radius: 3px;
  background: rgba(1, 4, 9, 0.85);
  color: var(--cyan);
  font: inherit;
  font-size: 10px;
  line-height: 1.5;
  cursor: pointer;
}

.zone-badge:hover {
  background: var(--gold);
  color: #0a0f16;
}

.chain-badge {
  position: absolute;
  left: 2px;
  top: 2px;
  padding: 0 5px;
  border-radius: 4px;
  background: rgba(139, 108, 255, 0.92);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  animation: pop-in 0.2s ease;
}

/* 多选时在卡上标出「这是第几张」，选了哪些一眼可见 */
.pick-badge {
  position: absolute;
  right: 2px;
  top: 2px;
  z-index: 4;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  background: var(--gold);
  color: #06101c;
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 700;
  box-shadow: 0 0 0 1px rgba(1, 4, 9, 0.65);
  animation: pop-in 0.15s ease;
}

/* 左右两条侧栏：左=场地区，右=墓地/除外（和卡一样大，能看清顶牌） */
.rail {
  display: flex;
  align-items: center;
  justify-content: center;
}

.rail-field .zone {
  width: var(--zone-w);
}

.piles {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* 墓地 / 除外向上贴齐额外怪兽区（那一行总是最靠近中线的），双方镜像 */
.half.mine .rail.piles {
  align-self: flex-start;
}

.half.foe .rail.piles {
  align-self: flex-end;
}

/* 场地贴着怪兽区那一行，别掉到魔陷区去跟卡组 / 额外卡组抢位置 */
.half.mine .rail-field {
  align-self: flex-start;
}

.half.foe .rail-field {
  align-self: flex-end;
}

.pile {
  position: relative;
  display: grid;
  place-items: center;
  gap: 2px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: rgba(240, 243, 246, 0.03);
  color: var(--text-mute);
  font-size: 10px;
  cursor: pointer;
  overflow: hidden;
}

.pile.card-pile {
  width: var(--zone-w);
  height: var(--zone-h);
}

.pile:hover {
  border-color: rgba(113, 183, 255, 0.55);
  color: var(--text);
}

/* 额外卡组里有能特召 / 能选的卡时，卡堆自己亮起来提醒去点 */
.pile.actionable {
  border-color: rgba(255, 196, 87, 0.7);
  box-shadow: 0 0 0 1px rgba(255, 196, 87, 0.28), 0 0 12px rgba(255, 196, 87, 0.25);
  animation: pile-pulse 1.6s ease-in-out infinite;
}

.pile.plain {
  cursor: default;
  line-height: 1.15;
  text-align: center;
}

.pile strong {
  display: block;
  color: var(--text-dim);
  font-family: var(--mono);
  font-size: 12px;
}

.pile img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: fill;
  opacity: 0.9;
}

.pile-label,
.pile-count {
  position: relative;
  z-index: 1;
}

.pile-label {
  padding: 0 4px;
  border-radius: 4px;
  background: rgba(1, 4, 9, 0.66);
  color: var(--text-dim);
}

.pile-count {
  padding: 0 4px;
  border-radius: 6px;
  background: rgba(1, 4, 9, 0.78);
  color: var(--text);
  font-family: var(--mono);
  font-size: 10px;
}

.hand-row {
  display: flex;
  align-items: flex-end;
  justify-content: center;
  gap: 5px;
  flex-wrap: wrap;
  min-height: calc(var(--zone-h) + 8px);
  padding-top: 2px;
}

.hand-card {
  position: relative;
  width: var(--zone-w);
  height: var(--zone-h);
  border-radius: 4px;
  overflow: hidden;
  border: 1px solid var(--line);
  transition: transform 0.12s ease, border-color 0.12s ease, box-shadow 0.12s ease;
}

.hand-card.clickable {
  cursor: pointer;
  border-color: rgba(113, 255, 176, 0.65);
  box-shadow: 0 0 8px rgba(113, 255, 176, 0.2);
}

.hand-card.clickable:hover,
.hand-card.on {
  transform: translateY(-6px);
}

.hand-card.on {
  border-color: var(--gold);
  box-shadow: 0 0 0 2px rgba(255, 196, 87, 0.55);
}

.hand-card img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: fill;
}

/* 对手手卡：只铺卡背，不做任何点击 / 悬浮反馈 */
.hand-card.back {
  cursor: default;
  border-color: rgba(122, 130, 142, 0.3);
  opacity: 0.92;
}

/* 中线：回合与阶段 */
.center-band {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 4px 0;
  border-top: 1px solid rgba(122, 130, 142, 0.18);
  border-bottom: 1px solid rgba(122, 130, 142, 0.18);
  margin: 2px 0;
}

.turn-chip {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-dim);
}

.turn-chip.mine {
  color: var(--green);
}

.turn-chip.foe {
  color: var(--amber);
}

.phase-steps {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.phase {
  padding: 1px 9px;
  border-radius: 999px;
  border: 1px solid var(--line);
  color: var(--text-mute);
  font-size: 11px;
  transition: all 0.15s ease;
}

.phase.on {
  border-color: var(--gold);
  background: rgba(255, 196, 87, 0.14);
  color: var(--gold);
  font-weight: 600;
}

.duel-placeholder {
  flex: 1;
  display: grid;
  place-items: center;
  text-align: center;
}

/* 当前操作条：贴在视口底部，场地再高也不会漏掉提问。
   z-index 高于卡片预览（30），hover 卡片时不会盖住「确定 / 结束回合」 */
.prompt {
  position: sticky;
  bottom: 6px;
  z-index: 35;
  margin-top: 4px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: rgba(9, 13, 20, 0.94);
  backdrop-filter: blur(6px);
  box-shadow: 0 -6px 24px rgba(0, 0, 0, 0.35);
}

.prompt.active {
  border-color: rgba(255, 196, 87, 0.55);
  box-shadow: 0 -6px 24px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(255, 196, 87, 0.25);
}

.prompt-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-dim);
}

.prompt-hint {
  font-weight: 400;
  color: var(--text-mute);
}

.prompt-keys {
  margin-left: auto;
  font-size: 11px;
  font-weight: 400;
  color: var(--text-mute);
  white-space: nowrap;
}

.prompt-keys kbd {
  padding: 0 4px;
  border-radius: 3px;
  border: 1px solid var(--line);
  background: rgba(1, 4, 9, 0.6);
  color: var(--text-dim);
  font-family: var(--mono);
  font-size: 10px;
}

.hand-count {
  align-self: center;
  color: var(--text-mute);
  font-size: 11px;
}

.duel-extra {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 12px;
}

.panel {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--panel);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.panel-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-dim);
}

.log-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
}

.log-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 200px;
  overflow: auto;
  font-size: 11px;
  color: var(--text-mute);
}

.log-0 {
  color: var(--text-dim);
}

.log-1 {
  color: var(--amber);
}

.chain-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.chain-dot {
  color: var(--violet);
  font-family: var(--mono);
  font-size: 11px;
}

/* 自选起手 */
.pick-actions {
  display: flex;
  gap: 6px;
}

.pick-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(84px, 1fr));
  gap: 8px;
  overflow: auto;
}

.pick-item {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px;
  border-radius: 8px;
  border: 1px solid transparent;
}

.pick-item img {
  width: 100%;
  border-radius: 5px;
  cursor: pointer;
  transition: transform 0.12s ease;
}

.pick-item img:hover {
  transform: translateY(-2px);
}

.pick-item.on {
  border-color: var(--gold);
  background: rgba(255, 196, 87, 0.08);
}

.pick-name {
  font-size: 10px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pick-deck {
  font-size: 10px;
  color: var(--text-mute);
}

.pick-badge {
  position: absolute;
  top: 7px;
  left: 7px;
  padding: 0 4px;
  border-radius: 5px;
  background: var(--gold);
  color: #1a1206;
  font-size: 10px;
  font-weight: 700;
}

.pick-minus {
  position: absolute;
  top: 7px;
  right: 7px;
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 50%;
  background: rgba(1, 4, 9, 0.85);
  color: var(--text);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}

.pick-minus:hover {
  background: var(--red);
  color: #fff;
}

.pile-overlay {
  position: fixed;
  inset: 0;
  z-index: 45;
  display: grid;
  place-items: center;
  background: rgba(1, 4, 9, 0.72);
  padding: 24px;
}

.pile-modal {
  width: min(920px, 92vw);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border-radius: 14px;
  border: 1px solid var(--line);
  background: var(--panel);
}

.pile-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.pile-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(88px, 1fr));
  gap: 8px;
  overflow: auto;
}

.pile-item {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px;
  border-radius: 8px;
  border: 1px solid transparent;
}

.pile-item img {
  width: 100%;
  border-radius: 5px;
}

.pile-item.clickable {
  cursor: pointer;
  border-color: rgba(113, 255, 176, 0.6);
  background: rgba(113, 255, 176, 0.07);
}

.pile-item.on {
  border-color: var(--gold);
  box-shadow: 0 0 0 2px rgba(255, 196, 87, 0.5);
}

.pile-name {
  font-size: 10px;
  color: var(--text-mute);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.menu-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
}

.duel-menu {
  position: fixed;
  z-index: 41;
  display: flex;
  flex-direction: column;
  min-width: 140px;
  padding: 6px;
  border-radius: 10px;
  border: 1px solid var(--line);
  background: var(--panel);
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.45);
}

.menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 8px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text);
  font-size: 12px;
  cursor: pointer;
  text-align: left;
}

.menu-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.menu-item kbd {
  padding: 0 4px;
  border-radius: 3px;
  border: 1px solid var(--line);
  background: rgba(1, 4, 9, 0.6);
  color: var(--text-mute);
  font-family: var(--mono);
  font-size: 10px;
}

.menu-item:hover {
  background: rgba(113, 183, 255, 0.14);
}

.menu-zone {
  color: var(--text-mute);
  font-size: 11px;
}

@keyframes pile-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 1px rgba(255, 196, 87, 0.24), 0 0 8px rgba(255, 196, 87, 0.18);
  }
  50% {
    box-shadow: 0 0 0 1px rgba(255, 196, 87, 0.5), 0 0 16px rgba(255, 196, 87, 0.38);
  }
}

@keyframes pop-in {
  from {
    opacity: 0;
    transform: rotate(var(--rot)) scale(calc(var(--zoom) * 0.86));
  }
  to {
    opacity: 1;
    transform: rotate(var(--rot)) scale(var(--zoom));
  }
}

@keyframes attack-lunge {
  0% {
    transform: translateY(0);
  }
  45% {
    transform: translateY(-8px);
  }
  100% {
    transform: translateY(0);
  }
}

@keyframes lp-pulse {
  0% {
    transform: scale(1);
  }
  40% {
    transform: scale(1.12);
  }
  100% {
    transform: scale(1);
  }
}

/* 怪兽 / 魔陷区是正方形：5 格 + 两条侧栏（各 0.72 个卡宽）+ 间距，
   整体约 6.4 个卡高，窄屏按视口宽度反算，别撑出屏幕 */
@media (max-width: 720px) {
  .field {
    --zone-h: clamp(40px, calc((100vw - 56px) / 6.8), 64px);
    --zone-w: calc(var(--zone-h) * 0.72);
  }
}

@media (max-width: 400px) {
  .field {
    --zone-h: clamp(34px, calc((100vw - 56px) / 6.8), 56px);
    --zone-w: calc(var(--zone-h) * 0.72);
  }
}
</style>
