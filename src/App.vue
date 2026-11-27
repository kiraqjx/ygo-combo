<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { useCardStore } from '@/stores/cards'
import { useThemeStore } from '@/stores/theme'
import { handleCardImageError } from '@/lib/cardDb'
import { toasts } from '@/lib/toast'

const cardStore = useCardStore()
const theme = useThemeStore()

const dbLabel = computed(() => {
  if (cardStore.status === 'ready') return `${cardStore.cards.length.toLocaleString()} 张卡`
  if (cardStore.status === 'loading') {
    const p = cardStore.progress
    if (p.phase === 'download' && p.total) return `卡库 ${Math.round((p.loaded / p.total) * 100)}%`
    return '卡库载入中'
  }
  if (cardStore.status === 'error') return '卡库离线'
  return '卡库待机'
})

const dbPercent = computed(() => {
  const p = cardStore.progress
  if (p.phase === 'download' && p.total) return Math.min(100, (p.loaded / p.total) * 100)
  if (p.phase === 'extract') return 92
  if (p.phase === 'parse') return 96
  return cardStore.status === 'ready' ? 100 : 0
})

/**
 * 卡图是 <img> 直接指向 CDN 的，自定义卡 / 先行服卡可能没有图。
 * 用捕获阶段的全局监听统一兜底，省得每个 <img> 都写一遍 @error。
 */
function onImageError(event: Event) {
  const img = event.target as HTMLImageElement | null
  if (!img || img.tagName !== 'IMG') return
  const src = img.src || ''
  // 只处理卡图源（momobako / YGOPRODeck 大小图），别去动页面上的其他图片
  if (!src.includes('/pics/') && !src.includes('/images/cards')) return
  handleCardImageError(event)
}

/**
 * 卡牌全息：把指针位置写成 --mx / --my，交给 atmosphere.css 的 radial-gradient 用。
 * 用委托 + rAF 合并，避免每个卡片各挂一个监听。
 */
let holoFrame = 0
let holoPending: { el: HTMLElement; x: number; y: number } | null = null
const finePointer = typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches

function onPointerMove(event: PointerEvent) {
  if (!finePointer) return
  const target = event.target as HTMLElement | null
  const tile = target?.closest?.('.card-tile') as HTMLElement | null
  if (!tile) return
  holoPending = { el: tile, x: event.clientX, y: event.clientY }
  if (holoFrame) return
  holoFrame = requestAnimationFrame(() => {
    holoFrame = 0
    const pending = holoPending
    if (!pending) return
    const box = pending.el.getBoundingClientRect()
    pending.el.style.setProperty('--mx', `${((pending.x - box.left) / box.width) * 100}%`)
    pending.el.style.setProperty('--my', `${((pending.y - box.top) / box.height) * 100}%`)
  })
}

onMounted(() => {
  void cardStore.init()
  document.addEventListener('error', onImageError, true)
  document.addEventListener('pointermove', onPointerMove, { passive: true })
})

onUnmounted(() => {
  document.removeEventListener('error', onImageError, true)
  document.removeEventListener('pointermove', onPointerMove)
  if (holoFrame) cancelAnimationFrame(holoFrame)
})
</script>

<template>
  <div class="app-layout">
  <a class="skip-link" href="#main">跳到主要内容</a>
  <header class="site-header">
    <div class="header-inner">
      <RouterLink to="/" class="brand">
        <span class="brand-mark">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
            <path d="M12 2.6 21.4 12 12 21.4 2.6 12 12 2.6Z" />
            <path d="M12 7.4 16.6 12 12 16.6 7.4 12 12 7.4Z" opacity=".7" />
            <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
          </svg>
        </span>
        <span>
          决斗推演室
          <small>YGO COMBO</small>
        </span>
      </RouterLink>

      <nav class="nav">
        <RouterLink to="/">首页</RouterLink>
        <RouterLink to="/guide">使用说明</RouterLink>
        <RouterLink to="/cards">卡牌检索</RouterLink>
        <RouterLink to="/deck">卡组构建</RouterLink>
        <RouterLink to="/rates">启动率</RouterLink>
        <RouterLink to="/duel">对战区</RouterLink>
        <RouterLink to="/skills">对战分析</RouterLink>
        <RouterLink to="/ai">AI 设置</RouterLink>
      </nav>

      <div class="header-right">
        <RouterLink to="/cards" class="chip" :title="cardStore.progress.message || '本地卡库状态'">
          <span
            class="dot"
            :class="cardStore.status === 'ready' ? 'safe' : cardStore.status === 'error' ? 'danger' : 'warning'"
          />
          {{ dbLabel }}
        </RouterLink>
        <button
          class="btn sm ghost"
          :title="theme.name === 'dark' ? '切换到浅色' : '切换到深色'"
          @click="theme.toggle()"
        >
          {{ theme.name === 'dark' ? '☀ 浅色' : '☾ 深色' }}
        </button>
        <a class="btn sm ghost" href="https://ygocdb.com" target="_blank" rel="noreferrer">卡库来源</a>
      </div>
    </div>
    <div v-if="cardStore.status === 'loading'" class="progress-track" style="border-radius: 0">
      <div class="progress-fill" :style="{ width: `${dbPercent}%` }" />
    </div>
  </header>

  <main id="main" class="app-main">
    <RouterView />
  </main>

  <footer class="site-foot">
    <div class="foot-inner">
      <span>决斗推演室 · 前端推演工具，卡牌数据来自 ygocdb（中文卡库）与 YGOPRODeck。</span>
      <span>推演结果为规则近似判断，实战请以卡片裁定为准。</span>
    </div>
  </footer>

  <div class="toast-wrap" role="status" aria-live="polite">
    <div
      v-for="t in toasts"
      :key="t.id"
      class="toast"
      :class="{ err: t.error }"
      :role="t.error ? 'alert' : 'status'"
    >
      {{ t.message }}
    </div>
  </div>
  </div>
</template>
