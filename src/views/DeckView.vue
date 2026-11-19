<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { CardData, DeckEntry, FrameType } from '@/types'
import { blankCustomDraft, type CustomCardDraft, type CustomExtraKind } from '@/lib/customCards'
import { useCardStore } from '@/stores/cards'
import { DECK_SECTIONS, MAX_STARTER_CARDS, useDeckStore, type DeckSection } from '@/stores/deck'
import { createFilters, searchCards } from '@/lib/search'
import { cardImageUrl } from '@/lib/cardDb'
import { downloadText, toast } from '@/lib/toast'
import { atLeastOneChance, formatChance } from '@/lib/odds'
import { allPresentChance, atLeastOneStarterChance } from '@/lib/starter'
import { groupYdkCards, parseYdk, toYdk } from '@/lib/ydk'
import { renderDeckPoster } from '@/lib/deckPoster'
import { downloadBlob } from '@/lib/download'
import { copyImageToClipboard } from '@/lib/clipboard'
import {
  exactOneMatch,
  formatMatch,
  isSmallWorldMonster,
  type PropertyMatch,
} from '@/lib/smallWorld'
import CardDetail from '@/components/CardDetail.vue'

const cards = useCardStore()
const deck = useDeckStore()

onMounted(() => {
  void cards.init()
})

onUnmounted(() => {
  if (posterUrl.value) URL.revokeObjectURL(posterUrl.value)
})

/* ---------------- 卡组编辑 ---------------- */

const sections = computed(() =>
  DECK_SECTIONS.map((section) => ({
    ...section,
    entries: deck.lists[section.id],
    used: deck.counts[section.id],
  })),
)

const emptyHints: Record<DeckSection, string> = {
  main: '主卡组还是空的，从右侧检索卡片并点击加入。',
  extra: '额外卡组为空：融合 / 同调 / 超量 / 连接怪兽会自动进入这里。',
  side: '副卡组为空，可用来准备替换方案。',
}

/* ---- 上手概率 ---- */

const oddsModal = ref(false)
const drawCount = ref(5)

const oddsRows = computed(() => {
  const size = deck.counts.main
  return deck.lists.main
    .map((entry) => ({
      ...entry,
      chance: atLeastOneChance(size, entry.count, drawCount.value),
    }))
    .sort((a, b) => b.chance - a.chance || a.name.localeCompare(b.name, 'zh-Hans-CN'))
})

/* ---- 导出 ---- */

function exportYdk() {
  const active = deck.current
  if (!active) return
  const filename = `${(active.name || 'deck').replace(/[\\/:*?"<>|]/g, '_')}.ydk`
  downloadText(filename, toYdk(active))
  toast(`已导出 ${filename}`)
}

/* ---- 卡组长图 ---- */

const posterBusy = ref(false)
const posterPercent = ref(0)
const posterCopying = ref(false)
const posterModal = ref(false)
const posterUrl = ref('')
const posterBlob = ref<Blob | null>(null)
const posterName = ref('deck')

const posterMeta = computed(() => {
  const blob = posterBlob.value
  if (!blob) return ''
  return `${Math.round(blob.size / 1024)} KB · ${blob.type.replace('image/', '').toUpperCase()}`
})

function posterFileName(blob: Blob): string {
  const ext = blob.type === 'image/png' ? 'png' : 'webp'
  return `${posterName.value.replace(/[\\/:*?"<>|]/g, '_')}-卡组.${ext}`
}

async function exportPoster() {
  const active = deck.current
  if (!active || posterBusy.value) return
  const total = [...active.main, ...active.extra, ...active.side].reduce(
    (sum, entry) => sum + entry.count,
    0,
  )
  if (!total) {
    toast('卡组还是空的，先加几张卡', true)
    return
  }

  posterBusy.value = true
  posterPercent.value = 0
  try {
    const blob = await renderDeckPoster(
      { name: active.name, main: active.main, extra: active.extra, side: active.side },
      { onProgress: (percent) => (posterPercent.value = percent) },
    )
    if (posterUrl.value) URL.revokeObjectURL(posterUrl.value)
    posterName.value = active.name || 'deck'
    posterBlob.value = blob
    posterUrl.value = URL.createObjectURL(blob)
    posterModal.value = true
  } catch (error) {
    toast(error instanceof Error ? error.message : '导出卡组长图失败', true)
  } finally {
    posterBusy.value = false
    posterPercent.value = 0
  }
}

function closePoster() {
  posterModal.value = false
  if (posterUrl.value) {
    URL.revokeObjectURL(posterUrl.value)
    posterUrl.value = ''
  }
  posterBlob.value = null
}

function downloadPoster() {
  const blob = posterBlob.value
  if (!blob) return
  downloadBlob(blob, posterFileName(blob))
  toast(`已保存卡组长图（${Math.round(blob.size / 1024)} KB）`)
}

async function copyPoster() {
  const blob = posterBlob.value
  if (!blob || posterCopying.value) return
  posterCopying.value = true
  try {
    await copyImageToClipboard(blob)
    toast('已复制到剪贴板，去微信直接粘贴发送')
  } catch (error) {
    toast(error instanceof Error ? error.message : '复制失败，请改用下载', true)
  } finally {
    posterCopying.value = false
  }
}

/* ---- ydk 导入 ---- */

type DeckSections = Record<DeckSection, DeckEntry[]>

const ydkInput = ref<HTMLInputElement | null>(null)
const ydkTextarea = ref<HTMLTextAreaElement | null>(null)
const ydkModal = ref(false)
const ydkText = ref('')

const sectionLabels: Record<DeckSection, string> = { main: '主卡组', extra: '额外卡组', side: '副卡组' }
const sectionLimits: Record<DeckSection, number> = { main: 60, extra: 15, side: 15 }
const sectionOrder: DeckSection[] = ['main', 'extra', 'side']

/** 粘贴 / 选文件得到的文本，实时解析成预览 */
const ydkParsed = computed(() => parseYdk(ydkText.value))

const ydkTotal = computed(() => {
  const parsed = ydkParsed.value
  return parsed.main.length + parsed.extra.length + parsed.side.length
})

/** 解析卡号：异画编号先折回本体密码，再回查卡库（本体和它的异画会合并成一条） */
const resolveYdkCard = (id: number) => cards.getCard(cards.normalizeCardId(id))

const ydkEntries = computed<DeckSections>(() => {
  const parsed = ydkParsed.value
  return {
    main: groupYdkCards(parsed.main, resolveYdkCard),
    extra: groupYdkCards(parsed.extra, resolveYdkCard),
    side: groupYdkCards(parsed.side, resolveYdkCard),
  }
})

/** 被折回本体密码的异画卡张数 */
const ydkAltCount = computed(() => {
  const parsed = ydkParsed.value
  let count = 0
  for (const id of [...parsed.main, ...parsed.extra, ...parsed.side]) {
    if (cards.normalizeCardId(id) !== id) count += 1
  }
  return count
})

/** 卡库未收录的卡片种类数（名称会显示成 #卡号） */
const ydkUnknown = computed(
  () =>
    [...ydkEntries.value.main, ...ydkEntries.value.extra, ...ydkEntries.value.side].filter(
      (entry) => !cards.getCard(entry.id),
    ).length,
)

/** 覆盖前先检查一遍，不通过就不让点「导入并覆盖」 */
const ydkIssues = computed(() => {
  const issues: string[] = []
  if (!ydkTotal.value) return issues

  for (const section of sectionOrder) {
    const used = ydkEntries.value[section].reduce((sum, entry) => sum + entry.count, 0)
    if (used > sectionLimits[section]) {
      issues.push(`${sectionLabels[section]} ${used} 张，超过 ${sectionLimits[section]} 张上限`)
    }
  }

  const copies = new Map<number, { count: number; name: string }>()
  for (const section of sectionOrder) {
    for (const entry of ydkEntries.value[section]) {
      const hit = copies.get(entry.id)
      if (hit) hit.count += entry.count
      else copies.set(entry.id, { count: entry.count, name: entry.name })
    }
  }
  for (const info of copies.values()) {
    if (info.count > 3) issues.push(`「${info.name}」合计 ${info.count} 张，超过同名 3 张`)
  }

  return issues
})

function openYdk() {
  ydkText.value = ''
  ydkModal.value = true
  void nextTick(() => ydkTextarea.value?.focus())
}

function pickYdkFile() {
  ydkInput.value?.click()
}

async function onYdkFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    ydkText.value = await file.text()
  } catch {
    toast('读不到这个文件', true)
  }
}

function confirmYdkImport() {
  if (!ydkTotal.value || ydkIssues.value.length) return
  const outcome = deck.replaceAll(ydkEntries.value)
  toast(outcome.message, !outcome.ok)
  if (!outcome.ok) return
  ydkModal.value = false
  ydkText.value = ''
}

/* ---- 小世界现象 ----
   展示手卡 A → 从卡组选「种族·属性·等级·攻击力·守备力中只有 1 项与 A 相同」的 B 确认，
   把 A 里侧除外 → 再把「只有 1 项与 B 相同」的 C 从卡组加入手卡，把 B 里侧除外。 */

const swModal = ref(false)
const swKeyword = ref('')
const swLimit = ref(150)

/** 主卡组里可作为展示 / 确认 / 加入手卡对象的怪兽 */
const swMonsters = computed(() =>
  deck.lists.main
    .map((entry) => ({ entry, card: cards.getCard(entry.id) }))
    .filter((item): item is { entry: DeckEntry; card: CardData } => isSmallWorldMonster(item.card)),
)

interface SmallWorldLine {
  key: string
  /** A：展示的手卡怪兽，处理后里侧除外 */
  hand: CardData
  /** B：从卡组选出的怪兽，确认后里侧除外 */
  bridge: CardData
  /** C：从卡组加入手卡的怪兽 */
  gained: CardData
  /** A 与 B 唯一相同的那一项 */
  hb: PropertyMatch
  /** B 与 C 唯一相同的那一项 */
  bg: PropertyMatch
}

/** 枚举卡组里所有 A -> B -> C 线路 */
const swLines = computed<SmallWorldLine[]>(() => {
  const pool = swMonsters.value.map((item) => item.card)
  const copies = new Map<number, number>()
  for (const item of swMonsters.value) copies.set(item.card.id, item.entry.count)

  const lines: SmallWorldLine[] = []
  for (const bridge of pool) {
    const linked = pool
      .filter((card) => card.id !== bridge.id)
      .map((card) => ({ card, match: exactOneMatch(bridge, card) }))
      .filter((item): item is { card: CardData; match: PropertyMatch } => item.match !== null)

    for (const hand of linked) {
      for (const gained of linked) {
        // A 与 C 同名（A -> B -> A）：需要卡组里至少 2 张，1 张在手卡、另 1 张仍在卡组
        if (hand.card.id === gained.card.id && (copies.get(hand.card.id) || 0) < 2) continue
        lines.push({
          key: `${hand.card.id}-${bridge.id}-${gained.card.id}`,
          hand: hand.card,
          bridge,
          gained: gained.card,
          hb: hand.match,
          bg: gained.match,
        })
      }
    }
  }
  return lines.sort(
    (a, b) =>
      a.bridge.name.localeCompare(b.bridge.name, 'zh-Hans-CN') ||
      a.hand.name.localeCompare(b.hand.name, 'zh-Hans-CN') ||
      a.gained.name.localeCompare(b.gained.name, 'zh-Hans-CN'),
  )
})

const swFiltered = computed(() => {
  const keyword = swKeyword.value.trim().toLowerCase()
  if (!keyword) return swLines.value
  return swLines.value.filter((line) =>
    `${line.hand.name} ${line.bridge.name} ${line.gained.name}`.toLowerCase().includes(keyword),
  )
})

watch(swKeyword, () => {
  swLimit.value = 150
})

function openSmallWorld() {
  swKeyword.value = ''
  swLimit.value = 150
  swModal.value = true
}

/* ---- 启动率 ---- */

const starterModal = ref(false)
const starterDraws = ref(5)

/** 当前卡组配置的启动组合（组与组之间是或关系） */
const starterGroups = computed(() => deck.current?.starters ?? [])

function starterCopies(id: number): number {
  return deck.lists.main.find((entry) => entry.id === id)?.count ?? 0
}

function starterName(id: number): string {
  return (
    deck.lists.main.find((entry) => entry.id === id)?.name ||
    cards.getCard(id)?.name ||
    `未知卡片 ${id}`
  )
}

/** 任意一组启动卡全部上手即算启动成功 */
const starterRate = computed(() =>
  atLeastOneStarterChance(
    deck.counts.main,
    starterGroups.value.map((group) => group.cards),
    starterCopies,
    starterDraws.value,
  ),
)

function groupChance(cards: number[]): number {
  return allPresentChance(deck.counts.main, cards.map(starterCopies), starterDraws.value)
}

function availableStarterCards(used: number[]): DeckEntry[] {
  return deck.lists.main.filter((entry) => !used.includes(entry.id))
}

function onStarterCardPick(starterId: string, event: Event) {
  const select = event.target as HTMLSelectElement
  const id = Number(select.value)
  if (id > 0) {
    const outcome = deck.addStarterCard(starterId, id)
    if (!outcome.ok) toast(outcome.message, true)
  }
  select.value = ''
}

/* ---- 模拟起手 ---- */

interface DrawnCard {
  key: string
  entry: DeckEntry
}

const handModal = ref(false)
const handCards = ref<DrawnCard[]>([])

/** 从主卡组按张数不放回随机抽取，默认 5 张 */
function rollHand(size = 5) {
  const pool: DeckEntry[] = []
  for (const entry of deck.lists.main) {
    for (let i = 0; i < entry.count; i += 1) pool.push(entry)
  }
  const draw = Math.min(size, pool.length)
  const picked: DeckEntry[] = []
  for (let i = 0; i < draw; i += 1) {
    const j = i + Math.floor(Math.random() * (pool.length - i))
    const swap = pool[j]
    pool[j] = pool[i]
    pool[i] = swap
    picked.push(pool[i])
  }
  handCards.value = picked.map((entry, index) => ({ key: `${entry.id}-${index}`, entry }))
}

function openHand() {
  rollHand()
  handModal.value = true
}

function sectionLabel(section: DeckSection): string {
  return DECK_SECTIONS.find((item) => item.id === section)?.label || ''
}

/** 打开卡片详情；带 section 时表示从卡组里点开，可调整张数 */
function openCard(id: number, section?: DeckSection) {
  const card = cards.getCard(id)
  if (!card) return
  selected.value = card
  selectedSection.value = section ?? null
}

function closeCard() {
  selected.value = null
  selectedSection.value = null
}

const selectedSection = ref<DeckSection | null>(null)

const selectedSectionLabel = computed(() =>
  selectedSection.value ? sectionLabel(selectedSection.value) : '',
)

const selectedCount = computed(() => {
  const card = selected.value
  const section = selectedSection.value
  if (!card || !section) return 0
  return deck.lists[section].find((entry) => entry.id === card.id)?.count ?? 0
})

/** 卡组详情里的 ±1 */
function changeCount(delta: 1 | -1) {
  const card = selected.value
  const section = selectedSection.value
  if (!card || !section) return

  if (delta > 0) {
    const outcome = deck.add(card, section)
    toast(outcome.message, !outcome.ok)
    return
  }

  if (selectedCount.value <= 0) return
  deck.remove(card.id, section)
  toast(`已从${sectionLabel(section)}移除：${card.name}`)
}

function removeOne(id: number, name: string, section: DeckSection) {
  deck.remove(id, section)
  toast(`已从${DECK_SECTIONS.find((item) => item.id === section)?.label}移除：${name}`)
}

function removeAll(id: number, name: string, section: DeckSection) {
  deck.remove(id, section, true)
  toast(`已移除全部：${name}`)
}

/** 右键移除：默认 1 张，Shift + 右键移除该卡全部 */
function onDeckCardMenu(event: MouseEvent, id: number, name: string, section: DeckSection) {
  if (event.shiftKey) removeAll(id, name, section)
  else removeOne(id, name, section)
}

function clearSection(section: DeckSection) {
  deck.clear(section)
  toast(`已清空${DECK_SECTIONS.find((item) => item.id === section)?.label}`)
}

/* ---------------- 卡组管理 ---------------- */

function selectDeck(event: Event) {
  deck.select((event.target as HTMLSelectElement).value)
}

function newDeck() {
  const created = deck.create()
  toast(`已新建卡组：${created.name}`)
}

function duplicateDeck() {
  const copy = deck.duplicate()
  if (copy) toast(`已复制卡组：${copy.name}`)
}

function deleteDeck() {
  const active = deck.current
  if (!active) return
  deck.removeDeck(active.id)
  toast(`已删除卡组：${active.name}`)
}

/* ---------------- 卡片检索 ---------------- */

type FrameFilter = 'all' | 'monster' | 'spell' | 'trap'

const frames: { value: FrameFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'monster', label: '怪兽' },
  { value: 'spell', label: '魔法' },
  { value: 'trap', label: '陷阱' },
]

const targets: { value: 'auto' | DeckSection; label: string; title: string }[] = [
  { value: 'auto', label: '自动', title: '融合 / 同调 / 超量 / 连接进额外卡组，其余进主卡组' },
  { value: 'main', label: '主', title: '加入主卡组' },
  { value: 'extra', label: '额', title: '加入额外卡组' },
  { value: 'side', label: '副', title: '加入副卡组' },
]

const keyword = ref('')
const debounced = ref('')
const frame = ref<FrameFilter>('all')
const target = ref<'auto' | DeckSection>('auto')
const limit = ref(50)
const selected = ref<CardData | null>(null)

let timer: number | undefined
watch(keyword, (value) => {
  window.clearTimeout(timer)
  timer = window.setTimeout(() => {
    debounced.value = value
    limit.value = 50
  }, 200)
})

watch(frame, () => {
  limit.value = 50
})

const result = computed(() => {
  // 卡库还在下载时，至少让手动录入的自定义卡能被搜到
  if (cards.status !== 'ready' && !cards.custom.length) return { items: [] as CardData[], total: 0 }
  const filters = { ...createFilters(), keyword: debounced.value, frame: frame.value }
  return searchCards(cards.cards, filters, limit.value)
})

function addCard(card: CardData) {
  const outcome = deck.add(card, target.value === 'auto' ? undefined : target.value)
  toast(outcome.message, !outcome.ok)
}

/* ---------------- 自定义卡（先行服 / 卡库未收录） ---------------- */

const customModal = ref(false)
const customDraft = ref<CustomCardDraft>(blankCustomDraft())

const customFrames: { value: FrameType; label: string }[] = [
  { value: 'monster', label: '怪兽' },
  { value: 'spell', label: '魔法' },
  { value: 'trap', label: '陷阱' },
]

const customSections: { value: CustomExtraKind; label: string }[] = [
  { value: '', label: '主卡组' },
  { value: '融合', label: '融合' },
  { value: '同调', label: '同调' },
  { value: '超量', label: '超量' },
  { value: '连接', label: '连接' },
]

function openCustomCard(presetName = '') {
  customDraft.value = blankCustomDraft(presetName || debounced.value.trim())
  customModal.value = true
}

function submitCustomCard() {
  const outcome = cards.addCustomCard(customDraft.value)
  if (!outcome.ok || !outcome.card) {
    toast(outcome.message, true)
    return
  }
  toast(outcome.message)
  customModal.value = false

  const card = outcome.card
  const preferred = target.value === 'auto' ? undefined : target.value
  const placed = deck.add(card, preferred)
  if (placed.ok || !preferred) {
    toast(placed.message, !placed.ok)
    return
  }
  // 指定的分区放不下（比如额外怪兽被指定进主卡组）就自动分栏再试一次
  const retry = deck.add(card)
  toast(retry.ok ? retry.message : placed.message, !retry.ok)
}

function deleteCustomCard(card: CardData) {
  cards.removeCustomCard(card.id)
  toast(`已删除自定义卡「${card.name}」，卡组里若还有它会显示为缺卡`)
}

/** 卡库缓存可能落后于新发售的卡，重新拉一次 */
function refreshLibrary() {
  toast('正在重新下载卡库…')
  void cards.refresh()
}
</script>

<template>
  <div class="page">
    <div class="search-bar deck-toolbar">
      <div class="deck-toolbar-row">
        <select class="select deck-picker" :value="deck.currentDeckId" title="切换卡组" @change="selectDeck">
          <option v-for="item in deck.decks" :key="item.id" :value="item.id">
            {{ item.name }}（{{ deck.totalOf(item) }}）
          </option>
        </select>
        <input
          v-model="deck.name"
          class="input deck-name-input"
          placeholder="卡组名称"
          spellcheck="false"
          aria-label="卡组名称"
        />
        <button class="btn sm" @click="newDeck">＋ 新建</button>
        <button class="btn sm ghost" @click="duplicateDeck">复制</button>
        <button class="btn sm ghost danger" @click="deleteDeck">删除</button>
        <span class="grow" />
        <span
          v-for="s in sections"
          :key="s.id"
          class="deck-stat"
          :class="{ full: s.used >= s.limit }"
        >
          {{ s.label }} <b class="mono">{{ s.used }}</b><span class="mute">/{{ s.limit }}</span>
        </span>
      </div>
      <div class="deck-toolbar-row">
        <button class="btn sm ghost" title="粘贴或选择 ydk 导入（会覆盖当前卡组）" @click="openYdk">导入ydk</button>
        <button class="btn sm ghost" @click="exportYdk">导出ydk</button>
        <button
          class="btn sm ghost"
          title="把整套卡组画成一张竖版长图（可直接分享）"
          :disabled="posterBusy"
          @click="exportPoster"
        >
          {{ posterBusy ? `生成中 ${posterPercent}%` : '导出长图' }}
        </button>
        <input
          ref="ydkInput"
          type="file"
          accept=".ydk,.txt,text/plain"
          style="display: none"
          @change="onYdkFile"
        />
        <button class="btn sm ghost" @click="oddsModal = true">上手概率</button>
        <button class="btn sm ghost" :disabled="!deck.counts.main" @click="openSmallWorld">小世界现象</button>
        <button class="btn sm ghost" :disabled="!deck.counts.main" @click="openHand">模拟起手</button>
        <button class="btn sm ghost" :disabled="!deck.counts.main" @click="starterModal = true">启动率</button>
        <span class="grow" />
        <span class="inline-note">左键查看效果 · 右键移除 1 张 · Shift+右键移除全部</span>
      </div>
    </div>

    <div class="deck-layout">
      <div class="deck-main">
        <div v-for="s in sections" :key="s.id" class="panel deck-section">
          <div class="panel-head">
            <span class="panel-title">{{ s.label }} · {{ s.used }} / {{ s.limit }}</span>
            <button class="btn xs ghost" :disabled="!s.entries.length" @click="clearSection(s.id)">清空</button>
          </div>
          <div v-if="s.entries.length" class="deck-grid">
            <button
              v-for="entry in s.entries"
              :key="entry.id"
              class="deck-card"
              :title="`${entry.name} ×${entry.count} · 左键查看效果，右键移除 1 张`"
              @click="openCard(entry.id, s.id)"
              @contextmenu.prevent="onDeckCardMenu($event, entry.id, entry.name, s.id)"
            >
              <img :src="cardImageUrl(entry.id)" :alt="entry.name" loading="lazy" />
              <span v-if="entry.count > 1" class="deck-count">×{{ entry.count }}</span>
            </button>
          </div>
          <div v-else class="deck-empty">{{ emptyHints[s.id] }}</div>
        </div>
      </div>

      <aside class="panel deck-search">
        <div class="panel-head">
          <span class="panel-title">卡片检索</span>
          <div class="row" style="gap: 6px; align-items: center">
            <span class="mono mute" style="font-size: 11px">
              {{ cards.status === 'ready' ? `${result.total.toLocaleString()} 张` : '卡库载入中' }}
            </span>
            <button
              class="btn xs ghost"
              title="手动录入卡库里没有的卡（先行服 / 新卡）"
              @click="openCustomCard()"
            >
              ＋ 自定义卡
            </button>
          </div>
        </div>
        <div class="deck-search-body">
          <input v-model="keyword" class="input" placeholder="搜索卡名 / 效果文本" spellcheck="false" />
          <div class="seg" style="width: 100%">
            <button
              v-for="f in frames"
              :key="f.value"
              style="flex: 1"
              :class="{ on: frame === f.value }"
              @click="frame = f.value"
            >
              {{ f.label }}
            </button>
          </div>
          <div class="seg" style="width: 100%">
            <button
              v-for="t in targets"
              :key="t.value"
              style="flex: 1"
              :class="{ on: target === t.value }"
              :title="t.title"
              @click="target = t.value"
            >
              {{ t.label }}
            </button>
          </div>

          <div class="deck-result-list">
            <div
              v-for="c in result.items"
              :key="c.id"
              class="deck-result"
              :class="{ 'is-custom': c.custom }"
              :title="c.custom ? `${c.name} · 自定义卡 · 点击加入卡组` : `${c.name} · 点击加入卡组`"
              @click="addCard(c)"
            >
              <img :src="cardImageUrl(c.id)" :alt="c.name" loading="lazy" @click.stop="openCard(c.id)" />
              <span class="deck-result-name">{{ c.name }}</span>
              <span v-if="deck.copiesOf(c.id)" class="deck-result-count">{{ deck.copiesOf(c.id) }}</span>
              <span class="deck-result-plus">＋</span>
            </div>
            <div v-if="cards.status === 'loading' && !result.items.length" class="deck-empty">
              {{ cards.progress.message }}
            </div>
            <div v-else-if="cards.status === 'error'" class="deck-empty">
              {{ cards.error }}
              <button class="btn xs primary" style="margin-top: 10px" @click="cards.init(true)">重试</button>
              <button
                v-if="debounced.trim()"
                class="btn xs ghost"
                style="margin-top: 8px"
                @click="openCustomCard(debounced.trim())"
              >
                ＋ 手动添加「{{ debounced.trim() }}」
              </button>
            </div>
            <div v-else-if="!result.items.length" class="deck-empty">
              没有符合条件的卡片
              <button
                v-if="debounced.trim()"
                class="btn xs primary"
                style="margin-top: 10px"
                @click="openCustomCard(debounced.trim())"
              >
                ＋ 手动添加「{{ debounced.trim() }}」
              </button>
              <button
                v-if="debounced.trim()"
                class="btn xs ghost"
                style="margin-top: 8px"
                title="卡库缓存可能没有收录新发售的卡，重新下载一次"
                @click="refreshLibrary"
              >
                刷新卡库
              </button>
            </div>
          </div>

          <button
            v-if="result.items.length < result.total"
            class="btn ghost sm"
            style="width: 100%"
            @click="limit += 60"
          >
            加载更多（{{ result.total - result.items.length }}）
          </button>
          <div class="inline-note">点击卡片加入 · 点卡图查看详情 · 搜不到的卡可手动录入</div>
        </div>
      </aside>
    </div>

    <div v-if="oddsModal" class="overlay center" @click.self="oddsModal = false">
      <div class="modal" style="width: min(620px, 100%)">
        <div class="modal-head">
          <span style="font-size: 14px; font-weight: 600">上手概率</span>
          <button class="icon-btn" @click="oddsModal = false">✕</button>
        </div>
        <div class="modal-body">
          <div class="row wrap" style="gap: 10px; margin-bottom: 12px; align-items: flex-end">
            <div class="field" style="width: 120px">
              <label>抽卡数</label>
              <input
                v-model.number="drawCount"
                type="number"
                min="1"
                :max="deck.counts.main || 1"
                class="input"
                aria-label="抽卡数"
              />
            </div>
            <span class="inline-note">
              主卡组 {{ deck.counts.main }} 张 · 不放回抽 {{ drawCount || 0 }} 张，至少抽到 1 张的概率
            </span>
          </div>

          <div v-if="oddsRows.length" class="draw-odds-list">
            <div v-for="row in oddsRows" :key="row.id" class="draw-odds-row">
              <img :src="cardImageUrl(row.id)" :alt="row.name" loading="lazy" />
              <span class="draw-odds-name" :title="row.name">{{ row.name }}</span>
              <span class="draw-odds-copies">×{{ row.count }}</span>
              <span class="draw-odds-bar"><i :style="{ width: `${row.chance * 100}%` }" /></span>
              <span class="draw-odds-value">{{ formatChance(row.chance) }}</span>
            </div>
          </div>
          <div v-else class="empty">主卡组为空，先加入卡片再计算概率。</div>
        </div>
        <div class="modal-foot">
          <button class="btn ghost" @click="oddsModal = false">关闭</button>
        </div>
      </div>
    </div>

    <div v-if="swModal" class="overlay center" @click.self="swModal = false">
      <div class="modal" style="width: min(840px, 100%)">
        <div class="modal-head">
          <span style="font-size: 14px; font-weight: 600">小世界现象</span>
          <button class="icon-btn" @click="swModal = false">✕</button>
        </div>
        <div class="modal-body">
          <div class="inline-note" style="margin-bottom: 12px">
            展示手卡 A → 从卡组选种族·属性·等级·攻击力·守备力中<b>只有 1 项</b>与 A 相同的 B 确认，把 A 里侧除外
            → 再把只有 1 项与 B 相同的 C 从卡组加入手卡，把 B 里侧除外。下面列出卡组里所有成立的三段线路
            （A 与 C 同名的线路需要该卡在主卡组至少有 2 张）：
          </div>

          <div class="row wrap" style="gap: 10px; margin-bottom: 12px; align-items: center">
            <input
              v-model="swKeyword"
              class="input"
              style="flex: 1; min-width: 160px"
              placeholder="按卡名筛选线路"
              spellcheck="false"
            />
            <span class="chip plain">共 {{ swFiltered.length }} 条</span>
          </div>

          <div v-if="swFiltered.length" class="sw-lines">
            <div
              v-for="line in swFiltered.slice(0, swLimit)"
              :key="line.key"
              class="sw-line"
              :title="
                line.hand.id === line.gained.id
                  ? '同名卡线路：需要卡组里至少 2 张（1 张作为手卡的 A，另 1 张仍在卡组作为 C）'
                  : undefined
              "
            >
              <button class="sw-node" @click="openCard(line.hand.id)">
                <img :src="cardImageUrl(line.hand.id)" :alt="line.hand.name" loading="lazy" />
                <span class="sw-node-body">
                  <span class="sw-role banished">展示 · 除外</span>
                  <span class="sw-node-name" :title="line.hand.name">{{ line.hand.name }}</span>
                </span>
              </button>

              <span
                class="sw-bridge"
                :title="`「${line.hand.name}」与「${line.bridge.name}」唯一相同：${formatMatch(line.hb)}`"
              >
                <span class="sw-tags">
                  <span class="sw-tag">{{ formatMatch(line.hb) }}</span>
                </span>
                <span class="sw-bridge-line" />
              </span>

              <button class="sw-node" @click="openCard(line.bridge.id)">
                <img :src="cardImageUrl(line.bridge.id)" :alt="line.bridge.name" loading="lazy" />
                <span class="sw-node-body">
                  <span class="sw-role banished">确认 · 除外</span>
                  <span class="sw-node-name" :title="line.bridge.name">{{ line.bridge.name }}</span>
                </span>
              </button>

              <span
                class="sw-bridge"
                :title="`「${line.bridge.name}」与「${line.gained.name}」唯一相同：${formatMatch(line.bg)}`"
              >
                <span class="sw-tags">
                  <span class="sw-tag">{{ formatMatch(line.bg) }}</span>
                </span>
                <span class="sw-bridge-line" />
              </span>

              <button class="sw-node target" @click="openCard(line.gained.id)">
                <img :src="cardImageUrl(line.gained.id)" :alt="line.gained.name" loading="lazy" />
                <span class="sw-node-body">
                  <span class="sw-role target">加入手卡</span>
                  <span class="sw-node-name" :title="line.gained.name">{{ line.gained.name }}</span>
                </span>
              </button>
            </div>
          </div>
          <div v-else class="empty">
            {{
              cards.status === 'ready'
                ? swLines.length
                  ? '没有匹配的线路'
                  : '主卡组里没有能构成小世界线路的怪兽。'
                : cards.progress.message
            }}
          </div>

          <button
            v-if="swFiltered.length > swLimit"
            class="btn ghost sm"
            style="width: 100%; margin-top: 10px"
            @click="swLimit += 200"
          >
            显示更多（剩余 {{ swFiltered.length - swLimit }}）
          </button>
        </div>
        <div class="modal-foot">
          <button class="btn ghost" @click="swModal = false">关闭</button>
        </div>
      </div>
    </div>

    <div v-if="posterModal" class="overlay center" @click.self="closePoster">
      <div class="modal poster-modal">
        <div class="modal-head">
          <div>
            <div style="font-size: 14px; font-weight: 600">卡组长图</div>
            <div class="inline-note">{{ posterMeta }} · 复制后可直接粘进微信</div>
          </div>
          <button class="icon-btn" aria-label="关闭" @click="closePoster">✕</button>
        </div>
        <div class="modal-body poster-body">
          <div class="poster-preview">
            <img v-if="posterUrl" :src="posterUrl" alt="卡组长图预览" />
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn ghost" @click="closePoster">关闭</button>
          <button class="btn" @click="downloadPoster">下载图片</button>
          <button class="btn primary" :disabled="posterCopying" @click="copyPoster">
            {{ posterCopying ? '复制中…' : '复制到剪贴板' }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="ydkModal" class="overlay center" @click.self="ydkModal = false">
      <div class="modal" style="width: min(560px, 100%)">
        <div class="modal-head">
          <div>
            <div style="font-size: 14px; font-weight: 600">导入 ydk</div>
            <div class="inline-note">粘贴 ydk 文本，或选择一个 .ydk 文件</div>
          </div>
          <button class="icon-btn" aria-label="关闭" @click="ydkModal = false">✕</button>
        </div>
        <div class="modal-body">
          <textarea
            ref="ydkTextarea"
            v-model="ydkText"
            class="textarea ydk-textarea"
            spellcheck="false"
            placeholder="#created by ...&#10;#main&#10;71599345&#10;89631139&#10;#extra&#10;44508094&#10;!side&#10;97268402"
          />

          <div class="row wrap" style="gap: 8px; margin-top: 10px">
            <button class="btn sm ghost" @click="pickYdkFile">选择 ydk 文件</button>
            <button class="btn sm ghost" :disabled="!ydkText" @click="ydkText = ''">清空</button>
            <span class="inline-note">每行一张卡的卡号；没有段标记时全部按主卡组处理</span>
          </div>

          <template v-if="ydkTotal">
            <div class="ydk-summary" style="margin-top: 14px">
              <div v-for="section in sectionOrder" :key="section" class="ydk-stat">
                <span>{{ sectionLabels[section] }}</span>
                <b :class="{ over: ydkParsed[section].length > sectionLimits[section] }">
                  {{ ydkParsed[section].length }}
                </b>
                <span class="mute">/ {{ sectionLimits[section] }}</span>
              </div>
            </div>

            <div class="ydk-note">
              导入后会<b>覆盖</b>当前卡组「{{ deck.name || '未命名' }}」的主卡组 / 额外卡组 / 副卡组，原有内容不会保留。
            </div>

            <div v-if="ydkAltCount" class="ydk-note">
              {{ ydkAltCount }} 张异画卡会按本体卡导入（卡库只收录本体密码，卡图显示原画）。
            </div>
            <div v-if="ydkUnknown" class="ydk-note warn">
              {{ ydkUnknown }} 种卡片卡库未收录，会以 #卡号 显示；可以先刷新卡库，或在检索面板用「＋ 自定义卡」补录。
            </div>
            <div v-if="ydkParsed.ignored" class="ydk-note warn">
              忽略了 {{ ydkParsed.ignored }} 行无法识别的内容。
            </div>
            <div v-for="(issue, index) in ydkIssues" :key="index" class="ydk-note warn">{{ issue }}</div>
          </template>
          <div v-else class="ydk-note" style="margin-top: 14px">
            还没读到卡号。至少要有 1 张卡，例如 <span class="mono">71599345</span>。
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn ghost" @click="ydkModal = false">取消</button>
          <button class="btn primary" :disabled="!ydkTotal || ydkIssues.length > 0" @click="confirmYdkImport">
            导入并覆盖
          </button>
        </div>
      </div>
    </div>

    <div v-if="customModal" class="overlay center" @click.self="customModal = false">
      <div class="modal" style="width: min(540px, 100%)">
        <div class="modal-head">
          <div>
            <div style="font-size: 14px; font-weight: 600">添加自定义卡</div>
            <div class="inline-note">卡库里没有的卡（先行服 / 新发售）可以手动录入，保存在本机</div>
          </div>
          <button class="icon-btn" aria-label="关闭" @click="customModal = false">✕</button>
        </div>
        <div class="modal-body">
          <div class="field">
            <label>卡名</label>
            <input
              v-model="customDraft.name"
              class="input"
              placeholder="例如：究极青眼白龙"
              spellcheck="false"
              @keyup.enter="submitCustomCard()"
            />
          </div>

          <div class="field" style="margin-top: 10px">
            <label>卡片 ID（可选）</label>
            <input
              v-model="customDraft.id"
              class="input"
              inputmode="numeric"
              spellcheck="false"
              placeholder="知道先行服卡号就填，能对上卡图；留空自动分配本地卡号"
            />
          </div>

          <div class="field" style="margin-top: 10px">
            <label>种类</label>
            <div class="seg" style="width: 100%">
              <button
                v-for="f in customFrames"
                :key="f.value"
                type="button"
                style="flex: 1"
                :class="{ on: customDraft.frame === f.value }"
                @click="customDraft.frame = f.value"
              >
                {{ f.label }}
              </button>
            </div>
          </div>

          <div v-if="customDraft.frame === 'monster'" class="field" style="margin-top: 10px">
            <label>怪兽位置</label>
            <div class="seg" style="width: 100%">
              <button
                v-for="k in customSections"
                :key="k.value"
                type="button"
                style="flex: 1"
                :class="{ on: customDraft.extra === k.value }"
                @click="customDraft.extra = k.value"
              >
                {{ k.label }}
              </button>
            </div>
          </div>

          <div class="field" style="margin-top: 10px">
            <label>效果文本（可选）</label>
            <textarea
              v-model="customDraft.desc"
              class="textarea"
              placeholder="贴上效果文本后，按效果关键词也能搜到，启动率页还能自动识别抽滤算子"
            />
          </div>

          <div v-if="cards.custom.length" style="margin-top: 14px">
            <div class="label" style="margin-bottom: 6px">已录入的自定义卡（{{ cards.custom.length }}）</div>
            <div class="row wrap" style="gap: 6px">
              <span v-for="c in cards.custom" :key="c.id" class="chip" :title="`卡号 ${c.id}`">
                {{ c.name }}
                <button type="button" title="删除这张自定义卡" @click="deleteCustomCard(c)">✕</button>
              </span>
            </div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn ghost" @click="customModal = false">取消</button>
          <button class="btn primary" @click="submitCustomCard()">添加并放入卡组</button>
        </div>
      </div>
    </div>

    <div v-if="starterModal" class="overlay center" @click.self="starterModal = false">
      <div class="modal" style="width: min(700px, 100%)">
        <div class="modal-head">
          <span style="font-size: 14px; font-weight: 600">启动率</span>
          <button class="icon-btn" @click="starterModal = false">✕</button>
        </div>
        <div class="modal-body">
          <div class="starter-summary">
            <span class="starter-rate">{{ formatChance(starterRate) }}</span>
            <span class="starter-meta">
              主卡组 {{ deck.counts.main }} 张 · 抽
              <input
                v-model.number="starterDraws"
                type="number"
                min="1"
                :max="deck.counts.main || 1"
                class="input starter-draws"
                aria-label="抽卡数"
              />
              张起手
            </span>
            <span class="starter-bar"><i :style="{ width: `${starterRate * 100}%` }" /></span>
          </div>

          <div class="inline-note" style="margin-bottom: 10px">
            任意一组启动卡全部上手即算启动成功（组之间是或关系）；每组可选 1-{{ MAX_STARTER_CARDS }} 张主卡组内的卡。
          </div>

          <div v-for="(group, index) in starterGroups" :key="group.id" class="starter-group">
            <div class="starter-head">
              <span class="starter-title">
                启动 {{ index + 1 }} · {{ group.cards.length }} / {{ MAX_STARTER_CARDS }}
              </span>
              <span class="starter-group-chance">{{ formatChance(groupChance(group.cards)) }}</span>
              <button class="icon-btn" style="width: 24px; height: 24px" title="删除这一组" @click="deck.removeStarter(group.id)">
                ✕
              </button>
            </div>
            <div class="starter-chips">
              <span
                v-for="id in group.cards"
                :key="id"
                class="starter-chip"
                :class="{ missing: !starterCopies(id) }"
                :title="starterCopies(id) ? `${starterName(id)} ×${starterCopies(id)}` : '这张卡已不在主卡组'"
              >
                {{ starterName(id) }}
                <button @click="deck.removeStarterCard(group.id, id)">✕</button>
              </span>
              <span v-if="!group.cards.length" class="inline-note">还没选卡</span>
            </div>
            <select
              class="select"
              :disabled="group.cards.length >= MAX_STARTER_CARDS"
              @change="onStarterCardPick(group.id, $event)"
            >
              <option value="">＋ 从主卡组选择一张卡（{{ group.cards.length }} / {{ MAX_STARTER_CARDS }}）</option>
              <option v-for="entry in availableStarterCards(group.cards)" :key="entry.id" :value="entry.id">
                {{ entry.name }} ×{{ entry.count }}
              </option>
            </select>
          </div>

          <div v-if="!starterGroups.length" class="empty">还没有配置启动组合</div>
          <button class="btn ghost sm" style="width: 100%; margin-top: 10px" @click="deck.addStarter()">
            ＋ 新建启动组合
          </button>
        </div>
        <div class="modal-foot">
          <RouterLink to="/rates" class="btn ghost" @click="starterModal = false">
            完整推演（含抽滤效果）→
          </RouterLink>
          <button class="btn ghost" @click="starterModal = false">关闭</button>
        </div>
      </div>
    </div>

    <div v-if="handModal" class="overlay center" @click.self="handModal = false">
      <div class="modal" style="width: min(640px, 100%)">
        <div class="modal-head">
          <span style="font-size: 14px; font-weight: 600">模拟起手</span>
          <button class="icon-btn" @click="handModal = false">✕</button>
        </div>
        <div class="modal-body">
          <div class="inline-note" style="margin-bottom: 12px">
            从主卡组 {{ deck.counts.main }} 张中随机抽 5 张（不放回，按同名卡张数计权重）。
          </div>
          <div v-if="handCards.length" class="hand-grid">
            <button
              v-for="item in handCards"
              :key="item.key"
              class="hand-card"
              :title="`${item.entry.name} · 点击查看详情`"
              @click="openCard(item.entry.id)"
            >
              <img :src="cardImageUrl(item.entry.id)" :alt="item.entry.name" loading="lazy" />
              <span>{{ item.entry.name }}</span>
            </button>
          </div>
          <div v-else class="empty">主卡组为空，无法模拟起手。</div>
        </div>
        <div class="modal-foot">
          <button class="btn ghost" @click="handModal = false">关闭</button>
          <button class="btn primary" :disabled="!deck.counts.main" @click="rollHand()">再抽一次</button>
        </div>
      </div>
    </div>

    <div v-if="selected" class="card-detail-layer" @click.self="closeCard">
      <CardDetail :card="selected" @close="closeCard">
        <template v-if="selectedSection" #actions>
          <span class="inline-note" style="margin-right: auto">
            {{ selectedSectionLabel }} · 当前 {{ selectedCount }} 张
          </span>
          <button class="btn sm ghost" :disabled="selectedCount === 0" @click="changeCount(-1)">−1</button>
          <button class="btn sm primary" @click="changeCount(1)">＋1</button>
        </template>
      </CardDetail>
    </div>
  </div>
</template>
