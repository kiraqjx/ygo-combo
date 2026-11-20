<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import {
  AI_PROTOCOL_PRESETS,
  AI_QUICK_TARGETS,
  RECOMMENDED_TUNING,
  isAiReady,
  loadAiConfig,
  maskedKey,
  saveAiConfig,
  type AiConfig,
  type AiProtocol,
  type AiQuickTarget,
} from '@/lib/ai/config'
import { toast } from '@/lib/toast'

/**
 * AI 设置页。
 *
 * 以前这份配置是「对战区」里的一个弹窗，代打和生成 skill 包都要进去改；
 * 现在独立成 tab：开关、协议、密钥都集中在这里，别的页面只读 localStorage。
 * 改动即时保存（防抖 250ms），不需要点「保存」。
 *
 * 采样参数仍然可调（网关怪癖需要逃生口），但默认值就是 `RECOMMENDED_TUNING`，
 * 一般人不用动；「恢复推荐参数」把这一组写回去。
 */

const config = reactive<AiConfig>(loadAiConfig())
const showKey = ref(false)
const savedTip = ref(false)

const preset = computed(() => AI_PROTOCOL_PRESETS[config.protocol])
const ready = computed(() => isAiReady(config))
const active = computed(() => config.enabled && ready.value)

let saveTimer: ReturnType<typeof setTimeout> | undefined
let tipTimer: ReturnType<typeof setTimeout> | undefined

function flush() {
  saveAiConfig({ ...config })
  savedTip.value = true
  if (tipTimer) clearTimeout(tipTimer)
  tipTimer = setTimeout(() => (savedTip.value = false), 1600)
}

watch(
  config,
  () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(flush, 250)
  },
  { deep: true },
)

onBeforeUnmount(() => {
  if (saveTimer) clearTimeout(saveTimer)
  if (tipTimer) clearTimeout(tipTimer)
  // 关页面前的最后一次改动也要落盘（防抖窗口内切走不能丢）
  saveAiConfig({ ...config })
})

/** 切协议时，只覆盖「还是上一个协议默认值」的端点 / 模型，用户自己填过的保留 */
function switchProtocol(next: AiProtocol) {
  const previous = AI_PROTOCOL_PRESETS[config.protocol]
  const target = AI_PROTOCOL_PRESETS[next]
  config.protocol = next
  if (!config.baseUrl.trim() || config.baseUrl.trim() === previous.baseUrl) {
    config.baseUrl = target.baseUrl
  }
  if (!config.model.trim() || config.model.trim() === previous.model) {
    config.model = target.model
  }
}

/** 快捷填入只是示例：地址 / 模型都是普通输入框，任何兼容服务都能填 */
const quickTargets = computed(() => AI_QUICK_TARGETS[config.protocol])

function applyTarget(target: AiQuickTarget) {
  config.baseUrl = target.baseUrl
  config.model = target.model
  flush()
}

function clamp(value: number, min: number, max: number): number {
  const number = Number.isFinite(value) ? value : min
  return Math.min(max, Math.max(min, number))
}

/** 数字框失焦时收敛到合法区间，避免把 0 token / 0 秒超时存进去 */
function normalize() {
  config.maxTokens = Math.round(clamp(config.maxTokens, 64, 32768))
  config.temperature = clamp(config.temperature, 0, 2)
  config.timeoutMs = Math.round(clamp(config.timeoutMs, 5000, 300000))
  config.toolRounds = Math.round(clamp(config.toolRounds, 0, 8))
  config.skillBudget = Math.round(clamp(config.skillBudget, 2000, 200000))
  flush()
}

/** 只把参数组写回推荐值，连接信息（地址 / 密钥 / 模型）不动 */
function resetTuning() {
  Object.assign(config, RECOMMENDED_TUNING)
  flush()
  toast('已恢复推荐参数')
}
</script>

<template>
  <div class="page ai-settings">
    <header class="head">
      <div>
        <h1 class="page-title">AI 设置</h1>
        <p class="inline-note">
          这里的配置同时作用于「对战区」的 AI 代打与「对战分析」的 AI 生成 skill 包。
          密钥只存在本机 localStorage，不写进对局记录，也不会打包进 skill 包。
        </p>
      </div>
      <div class="head-actions">
        <span class="chip" :class="active ? 'chip-ok' : 'chip-off'">
          {{ active ? 'AI 已启用' : config.enabled ? '缺少密钥' : 'AI 已关闭' }}
        </span>
      </div>
    </header>

    <div class="grid">
      <section class="panel">
        <div class="panel-head">
          <span class="panel-title">开关与接入</span>
          <span class="saved" :class="{ on: savedTip }">{{ savedTip ? '已保存' : '自动保存' }}</span>
        </div>
        <div class="panel-body">
          <label class="toggle" :class="{ on: config.enabled }">
            <input v-model="config.enabled" type="checkbox" />
            <span class="toggle-track"><span class="toggle-dot" /></span>
            <span class="toggle-text">
              <b>{{ config.enabled ? '开启 AI 功能' : '关闭 AI 功能' }}</b>
              <small>
                关闭后，「对战区」的 AI 代打与「对战分析」的 AI 生成 skill 包都会置灰，
                本地生成 skill 包不受影响。
              </small>
            </span>
          </label>

          <div class="divider" />

          <div class="field">
            <label>接口协议</label>
            <select
              class="select"
              :value="config.protocol"
              @change="switchProtocol(($event.target as HTMLSelectElement).value as AiProtocol)"
            >
              <option v-for="(item, key) in AI_PROTOCOL_PRESETS" :key="key" :value="key">
                {{ item.label }}
              </option>
            </select>
            <!-- 说明放外面：塞进 option 会把下拉撑得又长又截断，两列宽度下很难看 -->
            <small class="hint">{{ preset.hint }}</small>
          </div>

          <div class="field">
            <label>接口地址（可自由填写）</label>
            <input
              v-model="config.baseUrl"
              class="input mono"
              spellcheck="false"
              :placeholder="config.protocol === 'openai' ? 'https://api.openai.com/v1 或 /api/llm' : 'https://api.anthropic.com 或 /api/anthropic'"
            />
            <div class="quick">
              <span class="quick-label">快捷填入</span>
              <button
                v-for="target in quickTargets"
                :key="target.label"
                type="button"
                class="quick-chip"
                :class="{ active: config.baseUrl.trim() === target.baseUrl }"
                :title="`${target.baseUrl} · ${target.model}`"
                @click="applyTarget(target)"
              >
                {{ target.label }}
              </button>
              <span class="quick-note">只是示例，任何兼容服务都能填</span>
            </div>
          </div>

          <div class="field">
            <label>API Key</label>
            <div class="key-row">
              <input
                v-model="config.apiKey"
                class="input mono"
                :type="showKey ? 'text' : 'password'"
                placeholder="sk-..."
                autocomplete="off"
                spellcheck="false"
              />
              <button class="btn sm ghost" type="button" @click="showKey = !showKey">
                {{ showKey ? '隐藏' : '显示' }}
              </button>
            </div>
            <small v-if="config.apiKey && !showKey" class="hint">
              当前：{{ maskedKey(config.apiKey) }}
            </small>
          </div>

          <div class="field">
            <label>模型</label>
            <input
              v-model="config.model"
              class="input mono"
              spellcheck="false"
              :placeholder="preset.model"
            />
          </div>

          <p class="hint">
            <template v-if="config.protocol === 'openai'">
              任何实现了 <code>/chat/completions</code> 的服务都能用，不限 DeepSeek：OpenAI、OpenRouter、
              vLLM、自建网关都可以。填根地址会自动补路径，也可以直接填完整接口地址（带 query 也支持）；
              只有直连被 CORS 挡掉时才需要换成本站反代 <code>/api/llm</code>。
            </template>
            <template v-else>
              Anthropic 的 <code>/v1/messages</code> 协议，密钥走 <code>x-api-key</code>。地址同样可以随便填
              （官方、第三方兼容网关、自建反代都行）；直连 <code>api.anthropic.com</code> 会带上允许浏览器访问的请求头，但仍受 CORS 限制。
            </template>
          </p>

          <p v-if="config.enabled && !ready" class="warn">
            已开启 AI，但还没有填写 API Key / 模型名，代打与 AI 生成 skill 包仍然不可用。
          </p>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <span class="panel-title">参数</span>
          <button class="btn xs ghost" @click="resetTuning">恢复推荐参数</button>
        </div>
        <div class="panel-body">
          <p class="hint">
            下面这组默认值是按「决策稳定、规划写得完、skill 生成够长」调好的，一般不用动。
            遇到网关返回空白正文、输出被截断之类的问题再改；改坏了点「恢复推荐参数」。
          </p>

          <div class="row">
            <div class="field grow">
              <label>温度</label>
              <input
                v-model.number="config.temperature"
                class="input"
                type="number"
                step="0.1"
                min="0"
                max="2"
                @change="normalize"
              />
            </div>
            <div class="field grow">
              <label>max_tokens</label>
              <input
                v-model.number="config.maxTokens"
                class="input"
                type="number"
                min="64"
                max="32768"
                step="64"
                @change="normalize"
              />
            </div>
          </div>

          <div class="row">
            <div class="field grow">
              <label>超时（毫秒）</label>
              <input
                v-model.number="config.timeoutMs"
                class="input"
                type="number"
                min="5000"
                max="300000"
                step="1000"
                @change="normalize"
              />
            </div>
            <div class="field grow">
              <label>工具轮数</label>
              <input
                v-model.number="config.toolRounds"
                class="input"
                type="number"
                min="0"
                max="8"
                step="1"
                @change="normalize"
              />
            </div>
          </div>

          <div class="field">
            <label>skill 注入上限（字符）</label>
            <input
              v-model.number="config.skillBudget"
              class="input"
              type="number"
              min="2000"
              max="200000"
              step="1000"
              @change="normalize"
            />
          </div>

          <div class="checks">
            <label class="check">
              <input v-model="config.thinking" type="checkbox" />
              <span>思考模式<small>默认关：思考 token 会把决策的正文额度吃光</small></span>
            </label>
            <label class="check">
              <input v-model="config.planOnStart" type="checkbox" />
              <span>起手先规划路线<small>关掉后每步单独问模型，展开容易散</small></span>
            </label>
            <label class="check" :class="{ muted: config.protocol === 'anthropic' }">
              <input
                v-model="config.jsonMode"
                type="checkbox"
                :disabled="config.protocol === 'anthropic'"
              />
              <span>
                JSON 模式
                <small>
                  {{
                    config.protocol === 'anthropic'
                      ? 'Anthropic 协议不支持 response_format，改为在 system 里要求输出 JSON'
                      : '少数网关在 json_object 下会返回空白正文，遇到就关掉'
                  }}
                </small>
              </span>
            </label>
          </div>

          <div v-if="config.thinking && config.protocol === 'openai'" class="field">
            <label>思考强度（开了思考模式才生效）</label>
            <select v-model="config.reasoningEffort" class="select">
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          </div>

          <p class="hint">
            参数改动即时保存。「对战区」正在进行的对局会直接使用新配置，不需要重开。生成 skill 包时
            max_tokens / 超时会自动抬到推荐下限（8192 token / 180 秒），不必单独设。
          </p>
        </div>
      </section>
    </div>

    <section class="panel privacy">
      <div class="panel-head">
        <span class="panel-title">密钥与隐私</span>
        <span class="chip-dim">我们不保存你的 API Key</span>
      </div>
      <div class="panel-body">
        <p>
          本站是<b>纯前端页面，没有后端，也没有任何服务端存储</b>。你填的 API Key
          不会被上传到我们的服务器，不会被收集或写入任何数据库，也不存在于对局记录、
          导出的 AI 决策日志（那一项固定写「密钥：已省略」）和 skill 包文件里。
        </p>
        <p>
          为了不用每次打开都重填，密钥只写在你<b>本机浏览器</b>的 localStorage
          （键名 <code>ygo-ai-config</code>）里，只由这个页面读取。模型请求由浏览器
          直接发往你填写的接口地址；选择本站反代时，反代只做转发，不会解析或保存请求内容。
        </p>
        <p class="hint">
          换设备 / 换浏览器 / 清理浏览器数据后需要重新填写。想立刻让某个 Key 失效：
          清掉本站的浏览器数据，或直接去服务商后台吊销这把 Key。
        </p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.ai-settings {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.page-title {
  margin: 0 0 4px;
  font-size: 22px;
  font-weight: 650;
}

.head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

/* 状态徽章跟标题头对齐，而不是压在说明文字底部 */
.head-actions {
  margin-top: 2px;
}

.head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.chip-ok {
  color: var(--green);
  border-color: rgba(38, 205, 77, 0.4);
}

.chip-off {
  color: var(--text-mute);
}

/* 两列等宽 + 等高：左右面板的上下边缘、控件宽度才对得齐 */
.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  align-items: stretch;
}

.grid > .panel {
  display: flex;
  flex-direction: column;
}

.grid > .panel > .panel-body {
  flex: 1;
}

/* 右侧是按钮、左侧是文字时，标题栏高度会差 2~3px，这里统一到一个行高 */
.panel-head {
  min-height: 50px;
}

.saved {
  display: inline-flex;
  align-items: center;
  height: 24px;
  font-size: 11px;
  color: var(--text-mute);
  transition: color 0.2s ease;
}

.saved.on {
  color: var(--green);
}

.panel-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 参数里的两列字段用和面板一致的间距，别比上下间距更紧 */
.row {
  gap: 12px;
  align-items: flex-start;
}

.mono {
  font-family: var(--mono);
  font-size: 12px;
}

.key-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.key-row .input {
  flex: 1;
  min-width: 0;
}

.quick {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.quick-label,
.quick-note {
  color: var(--text-mute);
  font-size: 11px;
}

.quick-chip {
  padding: 2px 8px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: transparent;
  color: var(--text-dim);
  font-size: 11px;
  cursor: pointer;
  transition: 0.16s ease;
}

.quick-chip:hover {
  border-color: rgba(113, 183, 255, 0.42);
  color: var(--text);
}

.quick-chip.active {
  border-color: rgba(113, 183, 255, 0.55);
  background: rgba(113, 183, 255, 0.12);
  color: var(--gold);
}

.toggle {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: rgba(240, 243, 246, 0.02);
  cursor: pointer;
  transition: 0.18s ease;
}

.toggle.on {
  border-color: rgba(113, 183, 255, 0.42);
  background: rgba(113, 183, 255, 0.08);
}

.toggle input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.toggle-track {
  position: relative;
  flex: none;
  width: 40px;
  height: 22px;
  margin-top: 2px;
  border-radius: 999px;
  border: 1px solid var(--line-strong);
  background: var(--bg-2);
  transition: 0.18s ease;
}

.toggle-dot {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--text-mute);
  transition: 0.18s ease;
}

.toggle.on .toggle-track {
  background: rgba(113, 183, 255, 0.3);
  border-color: rgba(113, 183, 255, 0.6);
}

.toggle.on .toggle-dot {
  left: 20px;
  background: var(--gold);
}

.toggle-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 13px;
  color: var(--text);
}

.toggle-text small,
.check small {
  display: block;
  margin-top: 2px;
  color: var(--text-mute);
  font-size: 11px;
  line-height: 1.6;
  font-weight: 400;
}

/* 开关组单独框起来：和上面的输入框保持同一左边界，视觉上是一组设置 */
.checks {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: rgba(240, 243, 246, 0.015);
}

.check {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 5px 0;
  font-size: 13px;
  color: var(--text-dim);
  cursor: pointer;
}

.check input {
  margin-top: 3px;
}

.check.muted {
  opacity: 0.55;
}

.hint {
  margin: 0;
  color: var(--text-mute);
  font-size: 11px;
  line-height: 1.7;
}

.warn {
  margin: 0;
  padding: 8px 10px;
  border: 1px dashed rgba(245, 184, 61, 0.5);
  border-radius: var(--radius-sm);
  color: var(--amber);
  font-size: 11px;
  line-height: 1.7;
}

code {
  font-family: var(--mono);
  color: var(--cyan);
}

/* 密钥与隐私：整块放在两个设置面板下方，避免被折叠或忽略 */
.privacy .panel-body p {
  margin: 0 0 8px;
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1.85;
}

.privacy .panel-body p:last-child {
  margin-bottom: 0;
}

.privacy b {
  color: var(--text);
}

/* 全局 .divider 自带 12px 上下 margin，会和 .panel-body 的 gap 叠加成双倍空档 */
.divider {
  height: 1px;
  margin: 0;
  background: var(--line);
}

@media (max-width: 980px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
</style>
