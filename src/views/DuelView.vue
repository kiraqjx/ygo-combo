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
  loadCheckpoints,
  removeCheckpoint,
  saveCheckpoint,
  seedToStrings,
  stringsToSeed,
  type DuelCheckpoint,
} from '@/lib/duel/checkpoint'
import type { DuelCardView, DuelDeck, DuelEvent, DuelPlayerId, DuelQuestion } from '@/lib/duel/types'
import DuelQuestionPanel from '@/components/duel/DuelQuestionPanel.vue'

const deckStore = useDeckStore()
const cardStore = useCardStore()

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
const checkpoints = ref<DuelCheckpoint[]>(loadCheckpoints())
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
    },
  )
  session.value = next
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
    seed,
    playerDeck: activeDeck.value,
    handSize: handSize.value,
    openingHand: openingPicks.value.slice(),
    steps,
    turn: view.turn,
    phase: view.phase,
    createdAt: Date.now(),
  }
  checkpoints.value = saveCheckpoint(checkpoint)
  showToast(`已暂存，共 ${steps.length} 步操作`)
}

function deleteCheckpoint(id: string) {
  checkpoints.value = removeCheckpoint(id)
}

function requestEndDuel() {
  if (!session.value) {
    immersive.value = false
    return
  }
  endConfirm.value = true
}

function finishDuel(mode: 'none' | 'export' | 'bind') {
  if (mode === 'export') exportReplay()
  // 绑定要在 stop 之前调用：它同步取出响应字节，await 之后才写 IndexedDB
  if (mode === 'bind') void bindReplayToDeck()
  endConfirm.value = false
  void exitWebFullscreen()
  session.value?.stop()
  session.value = null
  immersive.value = false
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

function exportReplay() {
  const bytes = replayBytes()
  if (!bytes) return
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  downloadReplay(bytes, `combo-${stamp}.yrp`)
}

/** 绑定到当前卡组：AI Skill 页会把这些录像重放成展开说明 */
async function bindReplayToDeck() {
  const bytes = replayBytes()
  const deckId = deckStore.currentDeckId
  if (!bytes || !deckId) return
  const deckName = deckStore.current?.name || '未命名卡组'
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
  try {
    await bindReplay({
      deckId,
      deckName,
      name: `${deckName} · 第 ${state.value?.turn ?? 1} 回合 · ${stamp}`,
      bytes,
    })
    showToast('已绑定到当前卡组，去「AI Skill」页生成展开说明')
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
        <h1 class="page-title">combo 推演</h1>
        <p class="inline-note">
          用「卡组构建」里的卡组推演一局，对手是只会结束回合的沙包。点场上的卡就能操作；结束时可以把过程导出成 .yrp，或绑定到卡组后在「AI Skill」页转成展开说明。
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
          绑定到卡组则会在「AI Skill」页被重放成这套卡组的展开说明。
        </p>
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
          然后交还给你继续打。卡组内容改变过的话，回放可能对不上。
        </p>
        <div v-if="!checkpoints.length" class="inline-note" style="margin-top: 12px">
          还没有暂存。对局中点上方的「暂存」就会存到当前局面。
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
