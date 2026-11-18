<script setup lang="ts">
import { computed } from 'vue'
import { createSampleCombo } from '@/data/sampleCombo'
import { analyzeCombo } from '@/lib/timeline'
import { useCardStore } from '@/stores/cards'
import { useHandtrapStore } from '@/stores/handtraps'

const cards = useCardStore()
const ht = useHandtrapStore()

/** 首页只留一条「示例战报」的数字，不放长段说明 */
const demoLine = createSampleCombo().lines[0]
const demo = analyzeCombo(demoLine)
const ashSites = computed(() => demo.reports.find((report) => report.id === 'ash')?.sites.length ?? 0)

const ticker = computed(
  () =>
    `示例展开 · ${demoLine.timings.length} 个时序 · ${demo.links.length} 条链 · 灰流丽 ${ashSites.value} 个命中点`,
)

const stats = computed(() => [
  { value: cards.status === 'ready' ? cards.cards.length.toLocaleString() : '14,000+', label: '卡池' },
  { value: String(ht.defs.length), label: '手坑模型' },
  { value: 'C1→Cn', label: '连锁记录' },
])
</script>

<template>
  <div class="home">
    <div class="home-bg" aria-hidden="true" />
    <div class="home-veil" aria-hidden="true" />
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
          <RouterLink to="/duel" class="btn primary">开始推演</RouterLink>
          <RouterLink to="/deck" class="btn">构筑卡组</RouterLink>
          <RouterLink to="/rates" class="btn ghost">先攻启动率</RouterLink>
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
        <span class="home-entry-note">检索 · ydk · 一图流</span>
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
        <span class="home-entry-note">废件 · 抽滤 · 先攻</span>
      </RouterLink>

      <RouterLink to="/duel" class="home-entry">
        <span class="home-entry-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
            <path d="M9.5 8.5a3 3 0 1 1 0 6H7a3 3 0 0 1 0-6h2.5Z" />
            <path d="M14.5 9.5H17a3 3 0 0 1 0 6h-2.5a3 3 0 0 1 0-6Z" />
            <path d="M8.5 12h7" opacity=".6" />
          </svg>
        </span>
        <span class="home-entry-title">combo 推演</span>
        <span class="home-entry-note">内核 · 演练 · yrp 录像</span>
      </RouterLink>

      <RouterLink to="/skills" class="home-entry">
        <span class="home-entry-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
            <path d="M12 3.5 14.2 9l5.8.5-4.4 3.8 1.4 5.7L12 16l-5 3 1.4-5.7L4 9.5 9.8 9 12 3.5Z" />
          </svg>
        </span>
        <span class="home-entry-title">AI Skill</span>
        <span class="home-entry-note">录像 · 展开逻辑 · 喂给 AI</span>
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
    </section>

    <section class="home-stats">
      <div v-for="item in stats" :key="item.label" class="home-stat">
        <b>{{ item.value }}</b>
        <span>{{ item.label }}</span>
      </div>
    </section>
  </div>
</template>
