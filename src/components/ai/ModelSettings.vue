<script setup lang="ts">
import { ref, watch } from 'vue'
import { DEFAULT_AI_CONFIG, type AiConfig } from '@/lib/ai/config'
import type { AgentStats } from '@/lib/ai/agent'

const props = defineProps<{
  open: boolean
  config: AiConfig
  stats?: AgentStats | null
}>()

const emit = defineEmits<{
  (event: 'close'): void
  (event: 'save', config: AiConfig): void
}>()

const draft = ref<AiConfig>({ ...props.config })

watch(
  () => props.open,
  (open) => {
    if (open) draft.value = { ...props.config }
  },
)

function save() {
  emit('save', {
    ...draft.value,
    baseUrl: draft.value.baseUrl.trim() || DEFAULT_AI_CONFIG.baseUrl,
    model: draft.value.model.trim() || DEFAULT_AI_CONFIG.model,
    maxTokens: clamp(draft.value.maxTokens, 64, 8192),
    temperature: clamp(draft.value.temperature, 0, 2),
    timeoutMs: clamp(draft.value.timeoutMs, 5000, 180000),
    toolRounds: clamp(draft.value.toolRounds, 0, 5),
    skillBudget: clamp(draft.value.skillBudget, 2000, 120000),
  })
}

function clamp(value: number, min: number, max: number) {
  const number = Number.isFinite(value) ? value : min
  return Math.min(max, Math.max(min, number))
}

function cacheRate(stats: AgentStats | null | undefined) {
  if (!stats) return '—'
  const total = stats.cacheHitTokens + stats.cacheMissTokens
  if (!total) return '—'
  return `${Math.round((stats.cacheHitTokens / total) * 100)}%`
}
</script>

<template>
  <div v-if="open" class="mask" @click.self="emit('close')">
    <section class="panel">
      <header>
        <h3>AI 代打设置</h3>
        <button class="x" @click="emit('close')">✕</button>
      </header>

      <p class="hint">
        密钥只存在本机 localStorage，不写进对局记录。默认走本站 <code>/api/llm</code> 反代，
        也可以填自建网关地址（需兼容 <code>/chat/completions</code>）。
        若对局提示「输出是空的」，先关掉 <b>JSON 模式</b>：少数网关在
        <code>json_object</code> 下会返回空白正文，关掉后改用纯文本输出再自行解析。
      </p>

      <label class="field">
        <span>接口地址</span>
        <input v-model="draft.baseUrl" placeholder="/api/llm" />
      </label>

      <label class="field">
        <span>API Key</span>
        <input v-model="draft.apiKey" type="password" placeholder="sk-..." autocomplete="off" />
      </label>

      <div class="row">
        <label class="field">
          <span>模型</span>
          <input v-model="draft.model" placeholder="deepseek-flash" />
        </label>
        <label class="field narrow">
          <span>温度</span>
          <input v-model.number="draft.temperature" type="number" step="0.1" min="0" max="2" />
        </label>
        <label class="field narrow">
          <span>max_tokens</span>
          <input v-model.number="draft.maxTokens" type="number" min="64" max="8192" step="64" />
        </label>
      </div>

      <div class="row">
        <label class="check">
          <input v-model="draft.thinking" type="checkbox" />
          <span>思考模式</span>
        </label>
        <label class="check">
          <input v-model="draft.planOnStart" type="checkbox" />
          <span>起手先规划路线</span>
        </label>
        <label class="check">
          <input v-model="draft.jsonMode" type="checkbox" />
          <span>JSON 模式</span>
        </label>
        <label class="field narrow">
          <span>工具轮数</span>
          <input v-model.number="draft.toolRounds" type="number" min="0" max="5" step="1" />
        </label>
      </div>

      <div v-if="stats" class="stats">
        <span>调用 {{ stats.calls }}</span>
        <span>重试 {{ stats.retries }}</span>
        <span>降级 {{ stats.fallbacks }}</span>
        <span>token {{ stats.promptTokens + stats.completionTokens }}</span>
        <span>缓存命中 {{ cacheRate(stats) }}</span>
      </div>

      <footer>
        <button class="ghost" @click="emit('close')">取消</button>
        <button class="primary" @click="save">保存</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(2px);
}

.panel {
  width: min(560px, calc(100vw - 32px));
  max-height: calc(100vh - 64px);
  overflow: auto;
  padding: 18px 20px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--panel);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

h3 {
  margin: 0;
  font-size: 15px;
  color: var(--text);
}

.x {
  padding: 2px 6px;
  border: none;
  background: transparent;
  color: var(--text-mute);
  cursor: pointer;
  font-size: 14px;
}

.hint {
  margin: 0 0 14px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-mute);
}

code {
  font-family: var(--mono);
  color: var(--cyan);
}

.field {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 10px;
  font-size: 12px;
  color: var(--text-mute);
}

.field.narrow {
  flex: 0 0 110px;
}

.field input {
  padding: 7px 9px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-2);
  color: var(--text);
  font-family: var(--mono);
  font-size: 12px;
}

.field input:focus {
  border-color: var(--gold);
  outline: none;
}

.row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: flex-end;
}

.check {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 12px;
  font-size: 12px;
  color: var(--text-dim);
  cursor: pointer;
}

.stats {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  padding: 8px 10px;
  margin-bottom: 12px;
  border: 1px dashed var(--line);
  border-radius: var(--radius-sm);
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-mute);
}

footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

button.primary,
button.ghost {
  padding: 7px 16px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  cursor: pointer;
}

button.primary {
  border: 1px solid var(--gold-deep);
  background: var(--gold-deep);
  color: #fff;
}

button.ghost {
  border: 1px solid var(--line);
  background: transparent;
  color: var(--text-dim);
}
</style>
