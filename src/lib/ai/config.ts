/**
 * AI 配置（代打 + 生成 skill 包共用）。
 *
 * 只存 localStorage，不进 skill 包、不写进对局记录。
 * 默认走本站的 `/api/llm` 反代（OpenAI 兼容协议）：浏览器直连 api.deepseek.com
 * 会因为缺少 CORS 头被拦，而且密钥走同源请求更容易在部署侧统一加来源限制。
 * 也可以切成 Anthropic 的 `/v1/messages` 协议，默认走 `/api/anthropic` 反代。
 *
 * **参数是可编辑的**，但 `DEFAULT_AI_CONFIG` 里那组是给这套系统调过的推荐值：
 * 绝大多数人直接用默认就行，遇到网关怪癖（返回空白正文、输出被截断）再自己动。
 */

/** 接口协议：OpenAI 兼容（DeepSeek / 自建网关）/ Anthropic Messages */
export type AiProtocol = 'openai' | 'anthropic'

export interface AiConfig {
  /** 总开关：关掉后对战区 AI 代打与「AI 生成 skill 包」都置灰 */
  enabled: boolean
  protocol: AiProtocol
  /** 接口根地址，例如 `/api/llm`、`https://api.deepseek.com`、`/api/anthropic` */
  baseUrl: string
  apiKey: string
  /** 具体模型名，取决于接入的服务商 */
  model: string
  /**
   * 是否开启思考模式。
   * 默认关：决策只要一个 JSON，思考 token 会把 max_tokens 吃光、正文变空白。
   */
  thinking: boolean
  /** 思考强度（仅 thinking 打开且 DeepSeek 协议时生效） */
  reasoningEffort: 'low' | 'medium' | 'high'
  /** 决策要可复现，推荐接近 0 */
  temperature: number
  /** 单次决策的输出上限；规划（≥4000）与生成 skill（≥8192）会在调用处抬高 */
  maxTokens: number
  /** 单次请求超时 */
  timeoutMs: number
  /**
   * 用 `response_format: json_object`（仅 OpenAI 兼容协议）。
   * 少数模型/网关在该模式下会返回空白正文，关掉后改用纯文本输出 +
   * 自己解析（prompt 里仍然要求 json），是出问题时的逃生口。
   */
  jsonMode: boolean
  /** 起手时先做一次路线规划 */
  planOnStart: boolean
  /** 允许的最大工具调用轮数（read_skill） */
  toolRounds: number
  /** 单次规划注入的 skill 字符上限，防止把上下文塞爆 */
  skillBudget: number
}

/**
 * 推荐参数。界面上一键「恢复推荐参数」就是把这些值写回去。
 *
 * 这组值是按「决策稳定、规划写得完、skill 生成够长」调出来的：
 * 温度压到 0.2 让同样的盘面得到同样的选择；512 token 够一个决策 JSON；
 * 60s 超时是给慢网关留的余量（45s 时规划偶尔会在写步骤时被截断）。
 */
export const RECOMMENDED_TUNING = {
  thinking: false,
  reasoningEffort: 'medium' as const,
  temperature: 0.2,
  maxTokens: 512,
  timeoutMs: 60000,
  jsonMode: true,
  planOnStart: true,
  toolRounds: 2,
  skillBudget: 24000,
} satisfies Omit<AiConfig, 'enabled' | 'protocol' | 'baseUrl' | 'apiKey' | 'model'>

/**
 * 生成 skill 包时的下限：要写几千字，输出上限与超时都比决策宽松得多。
 * 用户没提供这两个选项，取「推荐值」与这里的较大者即可。
 */
export const SKILL_GENERATION_LIMITS = {
  maxTokens: 8192,
  timeoutMs: 180000,
} as const

/** 每种协议的默认端点 / 模型：切换协议时用它覆盖「还是上一个协议默认值」的字段 */
export const AI_PROTOCOL_PRESETS: Record<
  AiProtocol,
  { label: string; baseUrl: string; model: string; hint: string }
> = {
  openai: {
    label: 'OpenAI 兼容',
    baseUrl: '/api/llm',
    model: 'deepseek-flash',
    hint: '任何 /chat/completions 兼容服务（DeepSeek / OpenAI / OpenRouter / vLLM / 自建网关…）',
  },
  anthropic: {
    label: 'Anthropic',
    baseUrl: '/api/anthropic',
    model: 'claude-sonnet-4-5',
    hint: 'Claude 的 /v1/messages 协议（x-api-key）',
  },
}

/**
 * 设置页「快捷填入」的示例。
 *
 * 只是省得手敲：`baseUrl` / `model` 都是普通输入框，任何兼容服务都能填，
 * 不属于这里的服务商也照样能用。反代地址（`/api/llm`、`/api/anthropic`）
 * 只是给浏览器直连会被 CORS 挡掉的人准备的默认值。
 */
export interface AiQuickTarget {
  label: string
  baseUrl: string
  model: string
}

export const AI_QUICK_TARGETS: Record<AiProtocol, AiQuickTarget[]> = {
  openai: [
    { label: '本站反代', baseUrl: '/api/llm', model: 'deepseek-flash' },
    { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
    { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
  ],
  anthropic: [
    { label: '本站反代', baseUrl: '/api/anthropic', model: 'claude-sonnet-4-5' },
    { label: 'Anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5' },
  ],
}

const STORAGE_KEY = 'ygo-ai-config'

/**
 * 推荐参数的版本号。
 *
 * 参数以前没有界面（写死在代码里），所以老配置里存的那几个值都是当时的旧默认。
 * 这里带个版本号：对不上就整组落回新的推荐值，用户之后自己改过的则会保留。
 * 以后调推荐值就 +1。
 */
const TUNING_VERSION = 1

/** 参数组（与连接信息无关的那部分） */
type TuningFields = Pick<
  AiConfig,
  | 'thinking'
  | 'reasoningEffort'
  | 'temperature'
  | 'maxTokens'
  | 'timeoutMs'
  | 'jsonMode'
  | 'planOnStart'
  | 'toolRounds'
  | 'skillBudget'
>

export const DEFAULT_AI_CONFIG: AiConfig = {
  enabled: false,
  protocol: 'openai',
  baseUrl: AI_PROTOCOL_PRESETS.openai.baseUrl,
  apiKey: '',
  model: AI_PROTOCOL_PRESETS.openai.model,
  ...RECOMMENDED_TUNING,
}

function pickNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function pickText(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

/** 读取配置；localStorage 里的残缺字段用默认值补齐 */
export function loadAiConfig(): AiConfig {
  const fallback = DEFAULT_AI_CONFIG
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...fallback }
    const saved = JSON.parse(raw) as Partial<AiConfig> & { tuningVersion?: number }
    // 没有版本号 / 版本对不上：这组参数还是旧的写死默认，整组换成新推荐值
    const tuning: TuningFields =
      saved.tuningVersion === TUNING_VERSION
        ? {
            thinking: saved.thinking === true,
            reasoningEffort:
              saved.reasoningEffort === 'low' || saved.reasoningEffort === 'high'
                ? saved.reasoningEffort
                : 'medium',
            temperature: pickNumber(saved.temperature, fallback.temperature),
            maxTokens: pickNumber(saved.maxTokens, fallback.maxTokens),
            timeoutMs: pickNumber(saved.timeoutMs, fallback.timeoutMs),
            jsonMode: saved.jsonMode !== false,
            planOnStart: saved.planOnStart !== false,
            toolRounds: pickNumber(saved.toolRounds, fallback.toolRounds),
            skillBudget: pickNumber(saved.skillBudget, fallback.skillBudget),
          }
        : { ...RECOMMENDED_TUNING }

    return {
      enabled: saved.enabled === true,
      protocol: saved.protocol === 'anthropic' ? 'anthropic' : 'openai',
      baseUrl: pickText(saved.baseUrl, fallback.baseUrl),
      apiKey: pickText(saved.apiKey, fallback.apiKey),
      model: pickText(saved.model, fallback.model),
      ...tuning,
    }
  } catch {
    return { ...fallback }
  }
}

export function saveAiConfig(config: AiConfig) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...config, tuningVersion: TUNING_VERSION }))
  } catch {
    // 隐私模式下 localStorage 可能直接抛，配置只在本次会话生效
  }
}

/** 有 key 且模型名不为空才算填完了 */
export function isAiReady(config: AiConfig): boolean {
  return Boolean(config.apiKey.trim() && config.model.trim())
}

/** 总开关打开 + 连接信息填完，才允许代打 / AI 生成 skill 包 */
export function isAiActive(config: AiConfig): boolean {
  return config.enabled && isAiReady(config)
}

/** 打码后的 key，界面上只显示首尾 */
export function maskedKey(key: string): string {
  const text = key.trim()
  if (!text) return ''
  if (text.length <= 10) return `${text.slice(0, 2)}****`
  return `${text.slice(0, 5)}****${text.slice(-4)}`
}
