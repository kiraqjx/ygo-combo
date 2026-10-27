<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useCardStore } from '@/stores/cards'
import { useThemeStore } from '@/stores/theme'
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

onMounted(() => {
  void cardStore.init()
})
</script>

<template>
  <div class="app-layout">
  <header class="site-header">
    <div class="header-inner">
      <RouterLink to="/" class="brand">
        <span class="brand-mark">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
            <path d="M12 3 21 20H3L12 3Z" />
            <circle cx="12" cy="14.6" r="2.4" />
          </svg>
        </span>
        <span>
          决斗推演室
          <small>YGO COMBO</small>
        </span>
      </RouterLink>

      <nav class="nav">
        <RouterLink to="/">总览</RouterLink>
        <RouterLink to="/cards">卡牌检索</RouterLink>
        <RouterLink to="/lab">展开工坊</RouterLink>
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

  <main class="app-main">
    <RouterView />
  </main>

  <footer class="site-foot">
    <div class="foot-inner">
      <span>决斗推演室 · 前端推演工具，卡牌数据来自 ygocdb（中文卡库）与 YGOPRODeck。</span>
      <span>推演结果为规则近似判断，实战请以卡片裁定为准。</span>
    </div>
  </footer>

  <div class="toast-wrap">
    <div v-for="t in toasts" :key="t.id" class="toast" :class="{ err: t.error }">{{ t.message }}</div>
  </div>
  </div>
</template>
