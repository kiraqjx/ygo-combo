<script setup lang="ts">
import { ref } from 'vue'
import type { HandtrapDef, TrapCategory } from '@/lib/handtraps'
import { CATEGORY_LABEL } from '@/lib/handtraps'
import { useHandtrapStore } from '@/stores/handtraps'

const emit = defineEmits<{ close: [] }>()

const store = useHandtrapStore()
const editing = ref<HandtrapDef | null>(null)

const CATEGORIES = Object.keys(CATEGORY_LABEL) as TrapCategory[]
/** 深底上高对比的亮色 */
const TONES = [
  '#ff6a69',
  '#ff8f6b',
  '#ff9b57',
  '#f0b72f',
  '#56d364',
  '#26cd4d',
  '#39c5cf',
  '#71b7ff',
  '#7ea8ff',
  '#a371f7',
  '#ff7bd5',
  '#9ea7b3',
]

function startAdd() {
  editing.value = store.blank()
}

function startEdit(def: HandtrapDef) {
  editing.value = { ...def }
}

function cancel() {
  editing.value = null
}

function save() {
  if (!editing.value?.name.trim()) return
  store.save({ ...editing.value, name: editing.value.name.trim() })
  editing.value = null
}

function reset() {
  store.reset()
  editing.value = null
}
</script>

<template>
  <div class="overlay center" @click.self="emit('close')">
    <div class="modal handtrap-modal">
      <div class="modal-head">
        <div>
          <div style="font-size: 14px; font-weight: 600">手坑配置</div>
          <div class="inline-note">
            这里维护的手坑会出现在所有选手坑的地方，并参与抗性推演；改动自动保存在本地
          </div>
        </div>
        <button class="icon-btn" aria-label="关闭" @click="emit('close')">✕</button>
      </div>

      <div class="modal-body">
        <template v-if="!editing">
          <div class="ht-table">
            <button
              v-for="def in store.defs"
              :key="def.id"
              class="ht-table-row"
              @click="startEdit(def)"
            >
              <span class="ht-dot" :style="{ background: def.tone }" />
              <span class="ht-name">{{ def.name }}</span>
              <span class="ht-cat">{{ CATEGORY_LABEL[def.category] }}</span>
              <span class="grow" />
              <span class="ht-alias">{{ def.alias }}</span>
              <span class="icon-btn" title="删除" @click.stop="store.remove(def.id)">✕</span>
            </button>
          </div>

          <button class="btn sm" style="margin-top: 10px" @click="startAdd">＋ 新增手坑</button>
        </template>

        <template v-else>
          <div class="timing-form-grid">
            <div class="field">
              <label>名称</label>
              <input v-model="editing.name" class="input" placeholder="例如：D.D.乌鸦" />
            </div>
            <div class="field">
              <label>别名（可选）</label>
              <input v-model="editing.alias" class="input" placeholder="简称 / 俗称" />
            </div>
            <div class="field">
              <label>类型</label>
              <select v-model="editing.category" class="select">
                <option v-for="key in CATEGORIES" :key="key" :value="key">
                  {{ CATEGORY_LABEL[key] }}
                </option>
              </select>
            </div>
            <div class="field">
              <label>颜色</label>
              <div class="row wrap" style="gap: 6px; margin-top: 3px">
                <button
                  v-for="tone in TONES"
                  :key="tone"
                  class="ht-tone"
                  :class="{ on: editing.tone === tone }"
                  :style="{ background: tone }"
                  :aria-label="tone"
                  @click="editing.tone = tone"
                />
              </div>
            </div>
          </div>

          <div class="row" style="gap: 8px; margin-top: 12px">
            <button class="btn ghost sm" @click="cancel">返回列表</button>
            <span class="grow" />
            <button class="btn primary sm" :disabled="!editing.name.trim()" @click="save">
              保存
            </button>
          </div>
        </template>
      </div>

      <div class="modal-foot">
        <button class="btn danger" @click="reset">恢复内置手坑</button>
        <span class="grow" />
        <button class="btn ghost" @click="emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>
