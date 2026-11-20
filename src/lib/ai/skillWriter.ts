import { SKILL_GENERATION_LIMITS, type AiConfig } from './config'
import { chat, parseJsonObject, type AiMessage, type AiUsage } from './provider'
import type { SkillBundle } from '../skillBundle'
import type { SkillInput } from '../skill'
import {
  buildHandtrapReport,
  handtrapReportMarkdown,
  replayHandtrapReportMarkdown,
} from '../handtrapReport'
import { HANDTRAP_ANALYSIS_VERSION } from '../duel/replayHandtraps'

/**
 * 让模型改写 / 补全 skill 包。
 *
 * 本地 `buildSkillBundle()` 已经能推导出「启动点 → 录像路线」的骨架，
 * 但它写不出人类教练的经验：什么时候该收手、被某个手坑打断后走哪条妥协线、
 * 先攻后攻的区别。这里把卡组、录像分片、手坑报告一起交给模型，
 * 只让它输出需要**新增或改写**的文件，其余保留本地版本——
 * 既省输出 token，也不会因为模型漏写某个文件把整包改残。
 */

export interface AiSkillWriterResult {
  /** 归一化后的路径 → 内容（都在 `<dir>/` 下） */
  files: Record<string, string>
  /** 模型自己写的一句话说明 */
  note: string
  usage: AiUsage
}

/** 材料总预算：超了按「卡组 → 录像 → 卡效」的顺序截断 */
const MAX_MATERIAL = 52000
/** 单张卡效果在 prompt 里保留多少字 */
const MAX_CARD_DESC = 360

/** 不参与 AI 生成的手坑规则版本（过期结论会误导模型） */
function usableAnalyses(input: SkillInput) {
  return input.bindings.filter(
    (item) =>
      item.analysis?.ok && item.analysis.analysisVersion === HANDTRAP_ANALYSIS_VERSION,
  )
}

function clip(text: string, max: number): string {
  const value = text.trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function deckMarkdown(input: SkillInput): string {
  const lines: string[] = []
  const section = (label: string, entries: typeof input.main) => {
    if (!entries.length) return
    lines.push(`### ${label}`)
    for (const entry of entries) {
      const card = input.cardOf?.(entry.id)
      const desc = card?.desc ? `：${clip(card.desc.replace(/\s*\n\s*/g, ' '), MAX_CARD_DESC)}` : ''
      lines.push(`- ${entry.count} × ${entry.name}${desc}`)
    }
    lines.push('')
  }
  section('主卡组', input.main)
  section('额外卡组', input.extra)
  section('副卡组', input.side)
  return lines.join('\n').trim()
}

/** 本地推导的分片包：router / 录像路线 / 兜底 */
function bundleMaterial(base: SkillBundle): string {
  const prefix = `${base.dir}/`
  const paths = Object.keys(base.files)
    .filter((path) => path.startsWith(prefix))
    .filter((path) => !path.endsWith('/manifest.json') && !path.startsWith(`${prefix}cards/`))
    .sort((a, b) => {
      const rank = (path: string) =>
        path.endsWith('/00-router.md') ? 0 : path.includes('/20-replay') ? 1 : 2
      return rank(a) - rank(b) || a.localeCompare(b)
    })

  const chunks: string[] = []
  for (const path of paths) {
    chunks.push(`### ${path}\n${base.files[path].trim()}`)
  }
  return chunks.join('\n\n')
}

function handtrapMaterial(input: SkillInput): string {
  const usable = usableAnalyses(input)
  if (!usable.length) return '（没有手坑分析可用的录像）'
  const sources = usable.map((item) => ({ id: item.id, name: item.name, analysis: item.analysis }))
  const report = buildHandtrapReport(sources)
  const parts = [handtrapReportMarkdown(input.deckName, report)]
  for (const row of report.rows) {
    const binding = usable.find((item) => item.id === row.id)
    const draws = binding?.analysis?.drawHandtraps ?? []
    parts.push(replayHandtrapReportMarkdown(input.deckName, row, draws))
  }
  return parts.join('\n\n')
}

function promptFor(input: SkillInput, base: SkillBundle): AiMessage[] {
  const dir = base.dir
  const system = [
    '你是一位游戏王 OCG 构筑教练，负责把「卡组 + 录像 + 手坑报告」整理成分片 skill 包。',
    'skill 包的读者是正在对局中操作的 AI：它先读 00-router.md 判断起手，再按需读单个分片。',
    '写法要求：Markdown，短句，可执行；写清启动条件、步骤顺序、目标终场、被打断后的妥协线、手坑应对。',
    '不要编造录像里没有的卡或步骤；资料不足的地方明确写「待补充」。',
  ].join('\n')

  const material = [
    '## 卡组构筑',
    clip(deckMarkdown(input), 16000) || '（空）',
    '',
    '## 本地推导的分片包（可以改写，也可以新增文件）',
    clip(bundleMaterial(base), MAX_MATERIAL) || '（还没有生成分片包）',
    '',
    '## 手坑报告',
    clip(handtrapMaterial(input), Math.floor(MAX_MATERIAL / 3)),
  ].join('\n')

  const instruction = [
    '## 输出格式',
    '只输出一个 JSON 对象，不要任何解释文字：',
    '{',
    `  "files": { "${dir}/00-router.md": "……", "${dir}/10-matchup.md": "……" },`,
    '  "note": "一句话说明这次改了什么"',
    '}',
    '',
    '规则：',
    `1. 文件路径必须以 "${dir}/" 开头；不写目录时按 "${dir}/" 补齐。`,
    '2. 不要输出或修改 manifest.json（由本地程序生成）。',
    '3. 只输出需要新增或改写的文件；没提到的文件保留本地版本。',
    '4. 每个文件的值是完整 Markdown 文本，不要用代码块包起来。',
    '5. 内容要覆盖：起手判断（哪个起手走哪条路线）、关键步骤、终场目标、被各个手坑打断后的应对、后攻思路。',
  ].join('\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: `${material}\n\n${instruction}` },
  ]
}

/** 把模型给的文件表归一化成 `<dir>/...` 路径；manifest.json 一律丢弃 */
function normalizeFiles(value: unknown, dir: string): Record<string, string> {
  const out: Record<string, string> = {}

  const add = (rawPath: string, content: string) => {
    const path = rawPath.trim().replace(/\\/g, '/').replace(/^\.?\//, '')
    if (!path || path.includes('..')) return
    const full = path.startsWith(`${dir}/`) ? path : `${dir}/${path}`
    if (/\/manifest\.json$/i.test(full)) return
    if (!content.trim()) return
    out[full] = content
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      if (!item || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      const path = record.path ?? record.file ?? record.name
      const content = record.content ?? record.text ?? record.body
      if (typeof path === 'string' && typeof content === 'string') add(path, content)
    }
    return out
  }

  if (value && typeof value === 'object') {
    for (const [path, content] of Object.entries(value as Record<string, unknown>)) {
      if (typeof content === 'string') add(path, content)
    }
  }
  return out
}

export async function generateSkillBundleWithAi(
  input: SkillInput,
  base: SkillBundle,
  config: AiConfig,
): Promise<AiSkillWriterResult> {
  const messages = promptFor(input, base)
  const result = await chat(config, messages, {
    // 生成 skill 要写几千字：输出上限与超时至少抬到推荐下限，否则会被截成半个文件
    maxTokens: Math.max(config.maxTokens, SKILL_GENERATION_LIMITS.maxTokens),
    temperature: config.temperature,
    thinking: false,
    json: true,
    timeoutMs: Math.max(config.timeoutMs, SKILL_GENERATION_LIMITS.timeoutMs),
  })

  const parsed = parseJsonObject(result.content)
  if (!parsed) {
    const preview = result.content.trim().slice(0, 200)
    throw new Error(
      preview
        ? `模型没有返回可解析的 JSON（返回开头：${preview}）`
        : '模型返回空白内容，稍后重试或把「JSON 模式」关掉试试',
    )
  }

  const files = normalizeFiles(parsed.files, base.dir)
  if (!Object.keys(files).length) {
    throw new Error('模型没有给出任何 skill 文件，请重试（或在 AI 设置里换一个模型）')
  }

  return {
    files,
    note: typeof parsed.note === 'string' ? parsed.note.trim() : '',
    usage: result.usage,
  }
}
