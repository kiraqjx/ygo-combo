/**
 * AI 代打的模型配置。
 *
 * 只存 localStorage，不进 skill 包、不写进对局记录。
 * `baseUrl` 默认指向本站的 `/api/llm` 反代：浏览器直连 api.deepseek.com
 * 会因为缺少 CORS 头被拦，而且密钥走同源请求更容易在部署侧统一加来源限制。
 * 想接自建网关的话，把 baseUrl 改成自己的地址即可（同样走 /chat/completions）。
 */

export interface AiConfig {
  enabled: boolean
  /** OpenAI 兼容端点根地址，例如 `/api/llm` 或 `https://api.deepseek.com` */
  baseUrl: string
  apiKey: string
  /** 默认 deepseek-flash（快速决策够用） */
  model: string
  /** 是否开启思考模式；决策类任务默认关，起手规划时再打开 */
  thinking: boolean
  reasoningEffort: 'low' | 'medium' | 'high'
  temperature: number
  maxTokens: number
  timeoutMs: number
  /**
   * 用 `response_format: json_object`。
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

const STORAGE_KEY = 'ygo-ai-config'

export const DEFAULT_AI_CONFIG: AiConfig = {
  enabled: false,
  baseUrl: '/api/llm',
  apiKey: '',
  model: 'deepseek-flash',
  thinking: false,
  reasoningEffort: 'medium',
  temperature: 0.2,
  maxTokens: 512,
  timeoutMs: 45000,
  jsonMode: true,
  planOnStart: true,
  toolRounds: 2,
  skillBudget: 24000,
}

function pickNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function pickText(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

/** 读取配置；localStorage 里的残缺字段用默认值补齐（老版本没有新字段时会用到） */
export function loadAiConfig(): AiConfig {
  const fallback = DEFAULT_AI_CONFIG
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...fallback }
    const saved = JSON.parse(raw) as Partial<AiConfig>
    return {
      enabled: saved.enabled === true,
      baseUrl: pickText(saved.baseUrl, fallback.baseUrl),
      apiKey: pickText(saved.apiKey, fallback.apiKey),
      model: pickText(saved.model, fallback.model),
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
  } catch {
    return { ...fallback }
  }
}

export function saveAiConfig(config: AiConfig) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
  } catch {
    // 隐私模式下 localStorage 可能直接抛，配置只在本次会话生效
  }
}

/** 有 key 且模型名不为空才算可用 */
export function isAiReady(config: AiConfig): boolean {
  return Boolean(config.apiKey.trim() && config.model.trim())
}

/** 打码后的 key，界面上只显示首尾 */
export function maskedKey(key: string): string {
  const text = key.trim()
  if (!text) return ''
  if (text.length <= 10) return `${text.slice(0, 2)}****`
  return `${text.slice(0, 5)}****${text.slice(-4)}`
}
