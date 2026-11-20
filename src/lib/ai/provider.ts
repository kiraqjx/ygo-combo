import type { AiConfig } from './config'

/**
 * 模型接口客户端。
 *
 * 两套协议共用同一份导出：
 *   - `openai`    OpenAI 兼容的 `/chat/completions`（DeepSeek / 自建网关）
 *   - `anthropic` Anthropic 的 `/v1/messages`（Claude / 兼容网关）
 *
 * 只实现决策需要的那部分：messages + tools + JSON 输出。
 * 面向决策的请求都走非流式——一次决策只要一个 JSON，流式反而要自己拼碎片。
 */

export interface AiToolCall {
  id: string
  name: string
  arguments: string
}

export type AiMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: AiToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string }

export interface AiTool {
  name: string
  description: string
  /** JSON Schema 的 parameters 段 */
  parameters: Record<string, unknown>
}

export interface AiUsage {
  promptTokens: number
  completionTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
}

export interface ChatResult {
  content: string
  toolCalls: AiToolCall[]
  /** 可直接追加回 messages 的助手消息 */
  assistant: AiMessage
  usage: AiUsage
  finishReason: string
}

export interface ChatOptions {
  tools?: AiTool[]
  json?: boolean
  temperature?: number
  maxTokens?: number
  thinking?: boolean
  reasoningEffort?: 'low' | 'medium' | 'high'
  /** 单次请求的超时覆盖（生成 skill 包这类长任务需要比决策宽松） */
  timeoutMs?: number
  signal?: AbortSignal
}

/** 服务端返回的 content 是空白（JSON 模式非法输出会被替换成空格） */
export class EmptyContentError extends Error {
  constructor(readonly finishReason: string) {
    super(`模型返回空白内容（finish_reason=${finishReason || 'unknown'}）`)
    this.name = 'EmptyContentError'
  }
}

export class AiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`模型接口返回 ${status}${detail ? `：${detail}` : ''}`)
    this.name = 'AiHttpError'
  }
}

interface ChatCompletionPayload {
  choices?: {
    finish_reason?: string
    message?: {
      content?: string | null
      /** DeepSeek 思考模式：正文为空时思考内容仍可能在这里 */
      reasoning_content?: string | null
      tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[]
    }
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_cache_hit_tokens?: number
    prompt_cache_miss_tokens?: number
  }
}

/* ---------------------------------------------------------------- */
/* 端点拼接                                                          */
/* ---------------------------------------------------------------- */

/**
 * 拆出 query，只对路径部分做「补全后缀」。
 *
 * 有的网关（Azure OpenAI 一类）把版本号放在 query 里：
 * `.../openai/deployments/x/chat/completions?api-version=2024-06-01`。
 * 直接调 `replace(/\/+$/, '')` + 拼后缀会把这段 query 弄成路径的一部分。
 */
function splitUrl(baseUrl: string): { base: string; query: string } {
  const trimmed = baseUrl.trim()
  const index = trimmed.indexOf('?')
  const raw = index >= 0 ? trimmed.slice(0, index) : trimmed
  const query = index >= 0 ? trimmed.slice(index) : ''
  return { base: raw.replace(/\/+$/, ''), query }
}

function openAiEndpoint(baseUrl: string): string {
  const { base, query } = splitUrl(baseUrl)
  if (!base) throw new Error('模型接口地址为空')
  // 允许用户把完整地址填进来（有些网关直接给 .../v1/chat/completions）
  if (/\/chat\/completions$/.test(base)) return `${base}${query}`
  return `${base}/chat/completions${query}`
}

function anthropicEndpoint(baseUrl: string): string {
  const { base, query } = splitUrl(baseUrl)
  if (!base) throw new Error('模型接口地址为空')
  // 三种写法都接受：完整 .../v1/messages、根地址、只到 /v1
  if (/\/messages$/.test(base)) return `${base}${query}`
  if (/\/v1$/.test(base)) return `${base}/messages${query}`
  return `${base}/v1/messages${query}`
}

/**
 * 一次请求的超时 + 外部取消。
 *
 * 返回 `send` 是为了兼容「400 报不认识某字段 → 摘掉重发一次」的逃生逻辑：
 * 重发要复用同一个 AbortController，超时才不会被重置。
 */
function createSender(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  config: AiConfig,
  options: ChatOptions,
) {
  const timeoutMs = options.timeoutMs ?? config.timeoutMs
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = () => controller.abort()
  options.signal?.addEventListener('abort', onAbort)

  return {
    controller,
    timeoutMs,
    send: () =>
      fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      }),
    dispose: () => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    },
  }
}

/** 把 fetch 层的异常统一成可读文案（超时 / 网络） */
function normalizeFetchError(
  error: unknown,
  timeoutMs: number,
  controller: AbortController,
): Error {
  if (error instanceof AiHttpError) return error
  if (controller.signal.aborted) return new Error(`模型请求超时（${timeoutMs}ms）`)
  return error instanceof Error ? error : new Error(String(error))
}

async function readDetail(response: Response, limit = 300): Promise<string> {
  const text = await response.text().catch(() => '')
  const trimmed = text.trim()
  // Anthropic 的错误体是 { type: 'error', error: { message } }
  try {
    const parsed = JSON.parse(trimmed) as { error?: { message?: string } }
    const message = parsed?.error?.message
    if (message) return message.slice(0, limit)
  } catch {
    // 不是 JSON，直接截断原文
  }
  return trimmed.slice(0, limit)
}

/* ---------------------------------------------------------------- */
/* OpenAI 兼容                                                       */
/* ---------------------------------------------------------------- */

function toWireMessages(messages: AiMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === 'assistant') {
      const wire: Record<string, unknown> = { role: 'assistant', content: message.content ?? '' }
      if (message.tool_calls?.length) {
        wire.tool_calls = message.tool_calls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        }))
      }
      return wire
    }
    if (message.role === 'tool') {
      return { role: 'tool', content: message.content, tool_call_id: message.tool_call_id }
    }
    return { role: message.role, content: message.content }
  })
}

async function chatOpenAi(
  config: AiConfig,
  messages: AiMessage[],
  options: ChatOptions,
): Promise<ChatResult> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages: toWireMessages(messages),
    temperature: options.temperature ?? config.temperature,
    max_tokens: options.maxTokens ?? config.maxTokens,
    stream: false,
  }
  if (options.json) body.response_format = { type: 'json_object' }
  if (options.tools?.length) {
    body.tools = options.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }))
  }
  // 思考模式是 DeepSeek 的非标准参数，而且**必须显式关掉**：
  // 不传时服务端默认可能开着，思考 token 会把 max_tokens 吃光，正文只剩空白。
  const wantThinking = options.thinking ?? config.thinking
  body.thinking = { type: wantThinking ? 'enabled' : 'disabled' }
  if (wantThinking) {
    body.reasoning_effort = options.reasoningEffort ?? config.reasoningEffort
  }

  const sender = createSender(
    openAiEndpoint(config.baseUrl),
    {
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey}`,
    },
    body,
    config,
    options,
  )

  let response: Response
  try {
    response = await sender.send()
    // 自家网关 / 第三方兼容层可能不认 thinking 字段：400 且点名它时摘掉重发一次
    if (response.status === 400 && 'thinking' in body) {
      const detail = await readDetail(response, 400)
      if (/thinking|reasoning_effort|unknown|unrecognized|unsupported/i.test(detail)) {
        delete body.thinking
        delete body.reasoning_effort
        response = await sender.send()
      } else {
        throw new AiHttpError(400, detail)
      }
    }
  } catch (error) {
    throw normalizeFetchError(error, sender.timeoutMs, sender.controller)
  } finally {
    sender.dispose()
  }

  if (!response.ok) throw new AiHttpError(response.status, await readDetail(response))

  const payload = (await response.json()) as ChatCompletionPayload
  const choice = payload.choices?.[0]
  const rawContent = choice?.message?.content ?? ''
  const finishReason = choice?.finish_reason ?? ''
  // 正文为空时先从思考内容里捞 JSON：截断前模型常常已经把答案写进 reasoning 了
  const content = rawContent.trim() ? rawContent : lastJsonBlock(choice?.message?.reasoning_content ?? '')
  const rawCalls = choice?.message?.tool_calls ?? []
  const toolCalls: AiToolCall[] = rawCalls.map((call, index) => ({
    id: call.id || `call_${index}`,
    name: call.function?.name ?? '',
    arguments: call.function?.arguments ?? '{}',
  }))

  const usage: AiUsage = {
    promptTokens: payload.usage?.prompt_tokens ?? 0,
    completionTokens: payload.usage?.completion_tokens ?? 0,
    cacheHitTokens: payload.usage?.prompt_cache_hit_tokens ?? 0,
    cacheMissTokens: payload.usage?.prompt_cache_miss_tokens ?? 0,
  }

  const assistant: AiMessage = toolCalls.length
    ? { role: 'assistant', content: content || null, tool_calls: toolCalls }
    : { role: 'assistant', content }

  return { content, toolCalls, assistant, usage, finishReason }
}

/* ---------------------------------------------------------------- */
/* Anthropic Messages                                                */
/* ---------------------------------------------------------------- */

interface AnthropicPayload {
  content?: {
    type?: string
    /** type = text */
    text?: string
    /** type = thinking */
    thinking?: string
    /** type = tool_use */
    id?: string
    name?: string
    input?: unknown
  }[]
  stop_reason?: string
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
}

type AnthropicRole = 'user' | 'assistant'
interface AnthropicBlock {
  type: string
  [key: string]: unknown
}

/**
 * 把统一的 messages 转成 Anthropic 的形态：
 *   system 提出来单独传；工具结果变成 user 消息里的 `tool_result` 块；
 *   助手消息里的 tool_calls 变成 `tool_use` 块。
 *
 * Anthropic 要求 user / assistant 严格交替，所以相邻同角色消息要合并
 * （内核工具调用会连着推好几条 tool 消息）。
 */
function toAnthropicMessages(messages: AiMessage[]): {
  system: string
  messages: { role: AnthropicRole; content: AnthropicBlock[] }[]
} {
  const systemParts: string[] = []
  const turns: { role: AnthropicRole; content: AnthropicBlock[] }[] = []

  const push = (role: AnthropicRole, blocks: AnthropicBlock[]) => {
    if (!blocks.length) return
    const last = turns[turns.length - 1]
    if (last && last.role === role) last.content.push(...blocks)
    else turns.push({ role, content: [...blocks] })
  }

  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push(message.content)
      continue
    }
    if (message.role === 'user') {
      push('user', [{ type: 'text', text: message.content }])
      continue
    }
    if (message.role === 'assistant') {
      const blocks: AnthropicBlock[] = []
      if (message.content?.trim()) blocks.push({ type: 'text', text: message.content })
      for (const call of message.tool_calls ?? []) {
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: parseToolArguments(call.arguments),
        })
      }
      push('assistant', blocks)
      continue
    }
    push('user', [
      { type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content },
    ])
  }

  // 首条必须是 user；规划 prompt 一定以 system + user 开头，这里只做兜底
  if (turns.length && turns[0].role === 'assistant') {
    turns.unshift({ role: 'user', content: [{ type: 'text', text: '继续。' }] })
  }

  return { system: systemParts.join('\n\n'), messages: turns }
}

function parseToolArguments(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

async function chatAnthropic(
  config: AiConfig,
  messages: AiMessage[],
  options: ChatOptions,
): Promise<ChatResult> {
  const maxTokens = options.maxTokens ?? config.maxTokens
  const converted = toAnthropicMessages(messages)
  const systemParts = [converted.system].filter(Boolean)
  // Anthropic 没有 response_format，只能在 system 里重申「只输出 JSON」
  if (options.json) {
    systemParts.push('输出必须是单个 JSON 对象：不要 Markdown 代码块，不要任何解释文字。')
  }

  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: maxTokens,
    messages: converted.messages,
  }
  if (systemParts.length) body.system = systemParts.join('\n\n')
  if (options.tools?.length) {
    body.tools = options.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }))
  }
  /**
   * 思考模式：Anthropic 的 extended thinking 要求 `max_tokens > budget_tokens`
   * 且不能与固定 temperature 一起用，预算不够时直接跳过——宁可少想，也不能 400。
   */
  const wantThinking = options.thinking ?? config.thinking
  const budget = Math.min(2048, Math.floor(maxTokens / 2))
  if (wantThinking && budget >= 1024) {
    body.thinking = { type: 'enabled', budget_tokens: budget }
  } else {
    // Anthropic 的温度范围是 0~1（OpenAI 兼容协议允许到 2），这里夹一下防止 400
    body.temperature = Math.min(1, Math.max(0, options.temperature ?? config.temperature))
  }

  const sender = createSender(
    anthropicEndpoint(config.baseUrl),
    {
      'content-type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      // 浏览器直连 api.anthropic.com 时必须显式声明，否则 CORS 预检会被拒
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body,
    config,
    options,
  )

  let response: Response
  try {
    response = await sender.send()
    // 少数兼容网关不认 thinking：400 且点名它时摘掉重发一次
    if (response.status === 400 && 'thinking' in body) {
      const detail = await readDetail(response, 400)
      if (/thinking|budget|unknown|unrecognized|unsupported/i.test(detail)) {
        delete body.thinking
        body.temperature = Math.min(1, Math.max(0, options.temperature ?? config.temperature))
        response = await sender.send()
      } else {
        throw new AiHttpError(400, detail)
      }
    }
  } catch (error) {
    throw normalizeFetchError(error, sender.timeoutMs, sender.controller)
  } finally {
    sender.dispose()
  }

  if (!response.ok) throw new AiHttpError(response.status, await readDetail(response))

  const payload = (await response.json()) as AnthropicPayload
  const blocks = payload.content ?? []
  const textParts: string[] = []
  const thinkingParts: string[] = []
  const toolCalls: AiToolCall[] = []

  for (const block of blocks) {
    if (block.type === 'text' && block.text) textParts.push(block.text)
    else if (block.type === 'thinking' && block.thinking) thinkingParts.push(block.thinking)
    else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id || `call_${toolCalls.length}`,
        name: block.name ?? '',
        arguments: JSON.stringify(block.input ?? {}),
      })
    }
  }

  const rawContent = textParts.join('\n')
  const finishReason = payload.stop_reason ?? ''
  // 截断时正文可能为空，答案常常已经写进 thinking 块里
  const content = rawContent.trim() ? rawContent : lastJsonBlock(thinkingParts.join('\n'))

  const usage: AiUsage = {
    promptTokens: payload.usage?.input_tokens ?? 0,
    completionTokens: payload.usage?.output_tokens ?? 0,
    cacheHitTokens: payload.usage?.cache_read_input_tokens ?? 0,
    cacheMissTokens:
      (payload.usage?.cache_creation_input_tokens ?? 0) +
      Math.max(
        0,
        (payload.usage?.input_tokens ?? 0) - (payload.usage?.cache_read_input_tokens ?? 0),
      ),
  }

  const assistant: AiMessage = toolCalls.length
    ? { role: 'assistant', content: content || null, tool_calls: toolCalls }
    : { role: 'assistant', content }

  return { content, toolCalls, assistant, usage, finishReason }
}

/* ---------------------------------------------------------------- */
/* 入口                                                              */
/* ---------------------------------------------------------------- */

export async function chat(
  config: AiConfig,
  messages: AiMessage[],
  options: ChatOptions = {},
): Promise<ChatResult> {
  return config.protocol === 'anthropic'
    ? chatAnthropic(config, messages, options)
    : chatOpenAi(config, messages, options)
}

/** 从思考内容里取最后一段疑似 JSON 的对象（正文为空时用它兜底） */
function lastJsonBlock(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  const start = trimmed.lastIndexOf('{')
  if (start < 0) return ''
  const end = trimmed.lastIndexOf('}')
  return end > start ? trimmed.slice(start, end + 1) : ''
}

/** 解析模型给的 JSON；容忍 ```json 包裹与前后噪声 */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const candidates = [unfenced, trimmed]
  const start = unfenced.indexOf('{')
  const end = unfenced.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(unfenced.slice(start, end + 1))
  const repaired = repairTruncatedJson(unfenced)
  if (repaired) candidates.push(repaired)
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // 继续尝试下一种切法
    }
  }
  return null
}

/**
 * 救回被 max_tokens 截断的 json。
 *
 * 规划要写十几步，输出超长度时最后一两步会断在半截，`JSON.parse` 直接失败——
 * 之前整条路线因此作废，退化成单步决策，展开就散了。这里退到最后一个
 * 「结构完整」的位置（字符串外、刚结束一个值），再把 `]` / `}` 补齐。
 * 丢掉的是被截断的尾部，前面写好的步骤仍然可用。
 */
function repairTruncatedJson(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  const body = text.slice(start)

  let inString = false
  let escape = false
  let depth = 0
  let lastSafe = -1
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    if (inString) {
      if (escape) escape = false
      else if (char === '\\') escape = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{' || char === '[') {
      depth += 1
      continue
    }
    if (char === '}' || char === ']') {
      depth -= 1
      if (depth <= 0) return body.slice(0, index + 1)
      continue
    }
    // 逗号说明前一个值写完了，是一个安全的截断点
    if (char === ',') lastSafe = index
  }

  if (lastSafe < 0 || inString) {
    // 末尾还在字符串里（例如 `"锁鸟：『巳剑之`）：退到最后一个逗号之前
    if (lastSafe < 0) return null
  }

  const head = body.slice(0, lastSafe)
  const closers: string[] = []
  const stack: string[] = []
  let inHeadString = false
  let headEscape = false
  for (const char of head) {
    if (inHeadString) {
      if (headEscape) headEscape = false
      else if (char === '\\') headEscape = true
      else if (char === '"') inHeadString = false
      continue
    }
    if (char === '"') inHeadString = true
    else if (char === '{') stack.push('}')
    else if (char === '[') stack.push(']')
    else if (char === '}' || char === ']') stack.pop()
  }
  if (inHeadString) return null
  while (stack.length) closers.push(stack.pop() as string)
  const repaired = head + closers.join('')
  return closers.length ? repaired : null
}
