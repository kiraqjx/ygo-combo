<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useCardStore } from '@/stores/cards'
import { useHandtrapStore } from '@/stores/handtraps'
import { listReplayBindings } from '@/lib/replayStore'

const cards = useCardStore()
const ht = useHandtrapStore()

/**
 * 首页的数字只放真实存在的量：卡池张数、手坑定义数、录像份数。
 * 拿不到录像数时显示「—」，别编一个数糊在上面。
 */
const replayCount = ref<number | null>(null)

onMounted(async () => {
  try {
    replayCount.value = (await listReplayBindings()).length
  } catch {
    replayCount.value = 0
  }
})

const cardPhrase = computed(() => {
  if (cards.status === 'ready') return `${cards.cards.length.toLocaleString()} 张`
  return cards.status === 'error' ? '离线' : '载入中'
})

const ticker = computed(
  () =>
    `卡池 ${cardPhrase.value} · 手坑定义 ${ht.defs.length} 种 · 录像 ${
      replayCount.value === null ? '—' : replayCount.value
    } 份（展开路线由录像推导）`,
)

/* ---------- 数字滚动 ---------- */

const reducedMotion =
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

const displayed = reactive<Record<string, number>>({ cards: 0, handtraps: 0, replays: 0 })
const frames = new Map<string, number>()

function tween(key: string, to: number) {
  const cancel = frames.get(key)
  if (cancel) cancelAnimationFrame(cancel)
  const from = displayed[key] ?? 0
  if (reducedMotion || from === to) {
    displayed[key] = to
    return
  }
  const start = performance.now()
  const duration = 720
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / duration)
    const eased = 1 - Math.pow(1 - t, 3)
    displayed[key] = Math.round(from + (to - from) * eased)
    if (t < 1) frames.set(key, requestAnimationFrame(step))
    else frames.delete(key)
  }
  frames.set(key, requestAnimationFrame(step))
}

watch(
  [() => (cards.status === 'ready' ? cards.cards.length : 0), () => ht.defs.length, replayCount],
  ([cardTotal, handtrapTotal, replayTotal]) => {
    tween('cards', cardTotal)
    tween('handtraps', handtrapTotal)
    tween('replays', replayTotal ?? 0)
  },
  { immediate: true },
)

const stats = computed(() => [
  {
    key: 'cards',
    value: cards.status === 'ready' ? displayed.cards.toLocaleString() : '—',
    label: '卡池',
  },
  {
    key: 'handtraps',
    value: String(displayed.handtraps),
    label: '手坑定义',
  },
  {
    key: 'replays',
    value: replayCount.value === null ? '—' : String(displayed.replays),
    label: '录像',
  },
])

/* ---------- 主视觉视差 ---------- */

const bgEl = ref<HTMLElement | null>(null)
const veilEl = ref<HTMLElement | null>(null)
let scrollFrame = 0

function onScroll() {
  if (reducedMotion || scrollFrame) return
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0
    const y = Math.min(window.scrollY, 640)
    if (bgEl.value) bgEl.value.style.transform = `translate3d(0, ${y * 0.1}px, 0)`
    if (veilEl.value) veilEl.value.style.transform = `translate3d(0, ${y * 0.04}px, 0)`
  })
}

onMounted(() => window.addEventListener('scroll', onScroll, { passive: true }))
onUnmounted(() => {
  window.removeEventListener('scroll', onScroll)
  if (scrollFrame) cancelAnimationFrame(scrollFrame)
  for (const id of frames.values()) cancelAnimationFrame(id)
})
</script>

<template>
  <div class="home">
    <div ref="bgEl" class="home-bg" aria-hidden="true" />
    <div ref="veilEl" class="home-veil" aria-hidden="true" />
    <div class="home-aurora" aria-hidden="true" />
    <div class="home-stars" aria-hidden="true" />

    <section class="home-hero">
      <div class="home-copy">
        <p class="home-eyebrow">遊☆戯☆王 · COMBO LAB</p>

        <h1 class="home-title">
          <span class="home-title-main">DUEL</span>
          <span class="home-title-sub">把每一次展开推演到底</span>
        </h1>

        <div class="home-actions">
          <RouterLink to="/duel" class="btn primary">打开对战区</RouterLink>
          <RouterLink to="/deck" class="btn">构筑卡组</RouterLink>
          <RouterLink to="/rates" class="btn ghost">启动率</RouterLink>
          <RouterLink to="/guide" class="btn ghost">使用说明</RouterLink>
        </div>

        <p class="home-ticker">
          <span class="home-pulse" />
          {{ ticker }}
        </p>
      </div>
    </section>

    <section class="home-entries">
      <RouterLink to="/deck" class="home-entry">
        <span class="home-entry-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
            <rect x="7" y="3" width="11" height="15" rx="1.6" />
            <path d="M10.5 6h4M10.5 9h4" />
            <path d="M5.5 6.5 4 7.4v13.2l9.5 1.9" opacity=".55" />
          </svg>
        </span>
        <span class="home-entry-title">卡组构建</span>
        <span class="home-entry-note">检索 · ydk · 卡组长图</span>
      </RouterLink>

      <RouterLink to="/rates" class="home-entry">
        <span class="home-entry-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
            <circle cx="12" cy="12" r="8.5" />
            <path d="M12 3.5v8.5l6 6" />
            <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
          </svg>
        </span>
        <span class="home-entry-title">启动率</span>
        <span class="home-entry-note">动点 · 废件 · 抽滤</span>
      </RouterLink>

      <RouterLink to="/duel" class="home-entry">
        <span class="home-entry-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
            <path d="M9.5 8.5a3 3 0 1 1 0 6H7a3 3 0 0 1 0-6h2.5Z" />
            <path d="M14.5 9.5H17a3 3 0 0 1 0 6h-2.5a3 3 0 0 1 0-6Z" />
            <path d="M8.5 12h7" opacity=".6" />
          </svg>
        </span>
        <span class="home-entry-title">对战区</span>
        <span class="home-entry-note">真实规则 · 录像 · AI 代打</span>
      </RouterLink>

      <RouterLink to="/skills" class="home-entry">
        <span class="home-entry-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
            <path d="M12 3.5 14.2 9l5.8.5-4.4 3.8 1.4 5.7L12 16l-5 3 1.4-5.7L4 9.5 9.8 9 12 3.5Z" />
          </svg>
        </span>
        <span class="home-entry-title">对战分析</span>
        <span class="home-entry-note">展开 · 手坑 · skill 包</span>
      </RouterLink>

      <RouterLink to="/cards" class="home-entry">
        <span class="home-entry-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
            <circle cx="10.8" cy="10.8" r="6.4" />
            <path d="M15.6 15.6 20 20" />
          </svg>
        </span>
        <span class="home-entry-title">卡牌检索</span>
        <span class="home-entry-note">效果 · 分类 · 卡图</span>
      </RouterLink>

      <RouterLink to="/ai" class="home-entry">
        <span class="home-entry-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
            <circle cx="12" cy="12" r="3.1" />
            <path
              d="M12 3.2v2.1M12 18.7v2.1M4.8 12H2.7M21.3 12h-2.1M6.9 6.9 5.4 5.4M18.6 18.6l-1.5-1.5M17.1 6.9l1.5-1.5M5.4 18.6l1.5-1.5"
              opacity=".85"
            />
          </svg>
        </span>
        <span class="home-entry-title">AI 设置</span>
        <span class="home-entry-note">开关 · 接口 · 密钥</span>
      </RouterLink>
    </section>

    <section class="home-stats">
      <div v-for="item in stats" :key="item.label" class="home-stat">
        <b>{{ item.value }}</b>
        <span>{{ item.label }}</span>
      </div>
    </section>
  </div>
</template>
