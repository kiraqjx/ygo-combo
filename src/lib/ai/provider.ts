import type { AiConfig } from './config'

/**
 * OpenAI 兼容的 Chat Completions 客户端。
 *
 * 只实现 DeepSeek / 自建网关共用的那部分：messages + tools + response_format。
 * 面向决策的请求都走非流式——一次决策只要一个 JSON，流式反而要自己拼碎片。
 */

export interface AiToolCall {
  id: string
  name: string
  arguments: string
}

export type AiMessage =
  | { role: 'system' | 'user'; content: string }
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

function endpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (!base) throw new Error('模型接口地址为空')
  // 允许用户把完整地址填进来（有些网关直接给 .../v1/chat/completions）
  if (/\/chat\/completions$/.test(base)) return base
  return `${base}/chat/completions`
}

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

export async function chat(
  config: AiConfig,
  messages: AiMessage[],
  options: ChatOptions = {},
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

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)
  const onAbort = () => controller.abort()
  options.signal?.addEventListener('abort', onAbort)

  const send = () =>
    fetch(endpoint(config.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

  let response: Response
  try {
    response = await send()
    // 自家网关 / 第三方兼容层可能不认 thinking 字段：400 且点名它时摘掉重发一次
    if (response.status === 400 && 'thinking' in body) {
      const detail = (await response.text().catch(() => '')).slice(0, 400)
      if (/thinking|reasoning_effort|unknown|unrecognized|unsupported/i.test(detail)) {
        delete body.thinking
        delete body.reasoning_effort
        response = await send()
        if (!response.ok) {
          throw new AiHttpError(response.status, (await response.text().catch(() => '')).slice(0, 300))
        }
      } else {
        throw new AiHttpError(400, detail)
      }
    }
  } catch (error) {
    if (error instanceof AiHttpError) throw error
    if (controller.signal.aborted) throw new Error(`模型请求超时（${config.timeoutMs}ms）`)
    throw error instanceof Error ? error : new Error(String(error))
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300)
    throw new AiHttpError(response.status, detail)
  }

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
