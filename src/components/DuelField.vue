<script setup lang="ts">
import type { ZoneId, ZoneSnapshot } from '@/types'
import DuelBoard from './DuelBoard.vue'

defineProps<{
  snapshot: ZoneSnapshot
  title?: string
  subtitle?: string
  highlight?: ZoneId[]
}>()

const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <div class="overlay center" @click.self="emit('close')">
    <div class="modal duel-modal">
      <div class="modal-head">
        <div>
          <div class="duel-modal-title">{{ title || '决斗区域' }}</div>
          <div v-if="subtitle" class="inline-note">{{ subtitle }}</div>
        </div>
        <button class="icon-btn" aria-label="关闭" @click="emit('close')">✕</button>
      </div>

      <div class="modal-body">
        <DuelBoard :snapshot="snapshot" :highlight="highlight" />
      </div>

      <div class="modal-foot">
        <span class="inline-note">点击任意卡片查看详情</span>
        <span class="grow" />
        <button class="btn ghost" @click="emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>
