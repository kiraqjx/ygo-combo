<script setup lang="ts">
/**
 * 卡组内选卡器：点开是搜索框 + 卡图列表，替代原生 <select>。
 * 支持卡名 / 卡号 / 效果文本检索（走卡库里归一化过的 blob），
 * 列表可以按 optgroup 分组，键盘 ↑↓ + Enter 可选。
 *
 * `multiple` 打开多选：点击是在「勾选 / 取消」之间切换，弹层底部给出「确定添加」，
 * 一次交回一组卡号（`pickMany`）。判定语义交给调用方决定（启动率这边是「或」）。
 *
 * 弹层用 Teleport 挂到 body 上：面板 / 弹窗都有 overflow 与 backdrop-filter，
 * 留在原地会被裁掉（backdrop-filter 还会把 fixed 变成相对容器的定位）。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { cardImageUrl } from '@/lib/cardDb'
import { useCardStore } from '@/stores/cards'

interface PickerCard {
  id: number
  name: string
  /** 主卡组里的张数，仅用于展示 */
  count?: number
  /** 额外的说明文字（例如「能抽牌 / 翻牌」） */
  hint?: string
}

interface PickerGroup {
  label: string
  items: PickerCard[]
}

const props = withDefaults(
  defineProps<{
    /** 扁平列表；给了 groups 时可以省略 */
    options?: PickerCard[]
    /** 分组列表（组内顺序即展示顺序） */
    groups?: PickerGroup[]
    placeholder?: string
    disabled?: boolean
    /** 选完不关闭，方便连续加卡 */
    stayOpen?: boolean
    emptyText?: string
    /** 允许「不指定」：列表顶部出现一条清除项 */
    allowClear?: boolean
    clearLabel?: string
    /** 多选模式：勾选若干张后一次性交回（emit pickMany） */
    multiple?: boolean
    /** 多选模式底部的确认按钮文案 */
    confirmLabel?: string
  }>(),
  {
    options: () => [],
    groups: () => [],
    placeholder: '选择一张卡',
    disabled: false,
    stayOpen: false,
    emptyText: '没有匹配的卡',
    allowClear: false,
    clearLabel: '不指定',
    multiple: false,
    confirmLabel: '确定添加',
  },
)

const emit = defineEmits<{ pick: [id: number]; pickMany: [ids: number[]]; clear: [] }>()

const cards = useCardStore()

const open = ref(false)
const query = ref('')
const active = ref(0)
const root = ref<HTMLElement | null>(null)
const popRef = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLInputElement | null>(null)
const popStyle = ref<Record<string, string>>({})
/** 多选模式下已勾选的卡号，按勾选顺序保存 */
const picked = ref<number[]>([])

function lane(item: PickerCard): string {
  const card = cards.getCard(item.id)
  return `${item.name} ${item.id} ${card?.enName ?? ''} ${card?.jpName ?? ''} ${card?.blob ?? ''}`.toLowerCase()
}

const sections = computed<PickerGroup[]>(() => {
  const source = props.groups.length ? props.groups : [{ label: '', items: props.options }]
  const tokens = query.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const out: PickerGroup[] = []
  for (const section of source) {
    const items = tokens.length
      ? section.items.filter((item) => tokens.every((token) => lane(item).includes(token)))
      : section.items
    if (items.length) out.push({ label: section.label, items })
  }
  return out
})

const flat = computed(() => sections.value.flatMap((section) => section.items))

/** 按触发按钮的位置摆放弹层，空间不够时向上翻 */
function positionPop() {
  const el = root.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const margin = 8
  const width = Math.min(
    360,
    Math.max(rect.width, 240),
    Math.max(200, window.innerWidth - margin * 2),
  )
  const left = Math.min(Math.max(margin, rect.left), Math.max(margin, window.innerWidth - width - margin))
  const below = window.innerHeight - rect.bottom
  const above = rect.top
  const style: Record<string, string> = {
    position: 'fixed',
    left: `${left}px`,
    width: `${width}px`,
  }
  if (below < 300 && above > below) style.bottom = `${window.innerHeight - rect.top + 4}px`
  else style.top = `${rect.bottom + 4}px`
  popStyle.value = style
}

function toggle() {
  if (props.disabled) return
  open.value = !open.value
}

function close() {
  open.value = false
  query.value = ''
}

function togglePick(item: PickerCard) {
  picked.value = picked.value.includes(item.id)
    ? picked.value.filter((id) => id !== item.id)
    : [...picked.value, item.id]
}

/** 多选确认：一次交回全部勾选的卡号 */
function confirmMany() {
  if (!picked.value.length) {
    close()
    return
  }
  emit('pickMany', [...picked.value])
  close()
}

function pick(item: PickerCard) {
  if (props.multiple) {
    togglePick(item)
    void nextTick(positionPop)
    return
  }
  emit('pick', item.id)
  if (props.stayOpen) {
    query.value = ''
    active.value = 0
    void nextTick(() => {
      inputEl.value?.focus()
      // 连续加卡时父级会多一个 chip，触发按钮可能被挤动
      positionPop()
    })
    return
  }
  close()
}

function clearSelection() {
  emit('clear')
  close()
}

function move(step: number) {
  if (!flat.value.length) return
  const next = (active.value + step + flat.value.length) % flat.value.length
  active.value = next
  void nextTick(() => {
    popRef.value?.querySelector('.card-picker-item.active')?.scrollIntoView({ block: 'nearest' })
  })
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    move(1)
    return
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    move(-1)
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    const item = flat.value[active.value]
    if (item) pick(item)
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
  }
}

function onOutside(event: PointerEvent) {
  const target = event.target as Node
  if (root.value?.contains(target)) return
  if (popRef.value?.contains(target)) return
  close()
}

function onViewportChange() {
  if (open.value) positionPop()
}

watch(open, (value) => {
  if (value) {
    // 每次打开都从「一张没选」开始，免得把上次没确认的勾选带进来
    picked.value = []
    document.addEventListener('pointerdown', onOutside)
    window.addEventListener('resize', onViewportChange)
    window.addEventListener('scroll', onViewportChange, true)
    void nextTick(() => {
      positionPop()
      inputEl.value?.focus()
    })
  } else {
    document.removeEventListener('pointerdown', onOutside)
    window.removeEventListener('resize', onViewportChange)
    window.removeEventListener('scroll', onViewportChange, true)
  }
})

watch(query, () => {
  active.value = 0
  void nextTick(positionPop)
})

// 选项变化（例如主卡组里移掉了一张）时，活动项可能越界
watch(flat, (items) => {
  if (active.value >= items.length) active.value = 0
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onOutside)
  window.removeEventListener('resize', onViewportChange)
  window.removeEventListener('scroll', onViewportChange, true)
})

function onImgError(event: Event) {
  const img = event.target as HTMLImageElement | null
  if (img) img.style.visibility = 'hidden'
}

function globalIndex(item: PickerCard): number {
  return flat.value.indexOf(item)
}
</script>

<template>
  <div ref="root" class="card-picker" :class="{ open }">
    <button
      type="button"
      class="card-picker-trigger"
      :disabled="disabled"
      :aria-expanded="open"
      aria-haspopup="listbox"
      @click="toggle"
    >
      <span class="card-picker-label">{{ placeholder }}</span>
      <span class="card-picker-caret" aria-hidden="true">▾</span>
    </button>

    <Teleport to="body">
      <div v-if="open" ref="popRef" class="card-picker-pop" :style="popStyle">
        <input
          ref="inputEl"
          v-model="query"
          class="input card-picker-search"
          type="search"
          placeholder="搜索卡名 / 卡号 / 效果文本"
          aria-label="搜索卡片"
          @keydown="onKeydown"
        />
        <div class="card-picker-list" role="listbox">
          <button
            v-if="allowClear"
            type="button"
            class="card-picker-item card-picker-clear"
            @click="clearSelection"
          >
            {{ clearLabel }}
          </button>
          <template v-for="section in sections" :key="section.label">
            <div v-if="section.label" class="card-picker-group">{{ section.label }}</div>
            <button
              v-for="item in section.items"
              :key="`${section.label}-${item.id}`"
              type="button"
              class="card-picker-item"
              :class="{
                active: globalIndex(item) === active,
                picked: multiple && picked.includes(item.id),
              }"
              role="option"
              :aria-selected="multiple ? picked.includes(item.id) : globalIndex(item) === active"
              @click="pick(item)"
              @mouseenter="active = globalIndex(item)"
            >
              <img
                class="card-picker-thumb"
                :src="cardImageUrl(item.id)"
                :alt="item.name"
                loading="lazy"
                @error="onImgError"
              />
              <span class="card-picker-name">{{ item.name }}</span>
              <span v-if="item.hint" class="card-picker-hint">{{ item.hint }}</span>
              <span v-if="item.count" class="card-picker-count">×{{ item.count }}</span>
              <span v-if="multiple" class="card-picker-tick" aria-hidden="true">
                {{ picked.includes(item.id) ? '✓' : '' }}
              </span>
            </button>
          </template>
          <div v-if="!flat.length" class="card-picker-empty">{{ emptyText }}</div>
        </div>
        <div v-if="multiple" class="card-picker-foot">
          <span class="card-picker-foot-note">
            已选 {{ picked.length }} 张
          </span>
          <button type="button" class="btn xs ghost" :disabled="!picked.length" @click="confirmMany">
            {{ confirmLabel }}
          </button>
        </div>
      </div>
    </Teleport>
  </div>
</template>
