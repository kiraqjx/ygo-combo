import type { CardData, DeckEntry } from '@/types'
import type { ReplayAnalysis } from '@/lib/duel/replay'
import type { HandtrapDef } from '@/lib/handtraps'
import type { RatePlan } from '@/lib/rates'
import { HANDTRAP_FOOTNOTE, hitConsequenceText, hitNameText, hitPositionText } from '@/lib/duel/replayHandtraps'
import { buildSampleReport, type SampleReport } from '@/lib/skillSamples'

/**
 * 把「卡组 + 启动率配置 + 绑定的录像」写成一份 AI 能直接读懂的 skill 文档。
 *
 * 路线唯一来源是录像回放（combo 工坊已废弃）：起手、每步操作、手坑命中点与终局盘面
 * 都从信号流还原，不再支持手工编排的展开链。
 *
 * 自动层（不需要人工标注）：
 *   卡片资料（完整卡效）→ 起手样本与概率 → 录像路线 → 阻抗时机 → 选项语义 → 覆盖度。
 *
 * 标注层（本层不做）：分支原因、妥协标准、先后攻、换备、对手交互。
 */

export interface SkillBindingInput {
  id: string
  name: string
  createdAt: number
  error?: string
  analysis: ReplayAnalysis | null
}

export interface SkillInput {
  deckName: string
  main: DeckEntry[]
  extra: DeckEntry[]
  side: DeckEntry[]
  nameOf: (code: number) => string
  bindings: SkillBindingInput[]
  /** 卡库查询：用于完整卡效；缺省时只输出卡名 */
  cardOf?: (code: number) => CardData | undefined
  /** 启动率配置：起手分类与概率 */
  plan?: RatePlan | null
  /** 卡组页的简易启动组（plan.starters 为空时兜底） */
  starterGroups?: { id: string; cards: number[] }[]
  /** 手坑定义：手坑起手与阻抗时机 */
  handtraps?: HandtrapDef[]
}

export interface CoverageItem {
  id: string
  label: string
  state: 'ok' | 'partial' | 'missing'
  detail: string
  /** 怎么补 */
  hint?: string
}

const MAX_DESC_LENGTH = 1200

export function buildSkillMarkdown(input: SkillInput): string {
  const { deckName, nameOf } = input
  const usable = input.bindings.filter((item) => item.analysis?.ok)
  const failed = input.bindings.filter((item) => !item.analysis?.ok)
  const samples = buildSampleReport({
    main: input.main,
    plan: input.plan,
    starterGroups: input.starterGroups,
    handtraps: input.handtraps,
    nameOf,
  })
  const coverage = buildSkillCoverage(input, samples)
  const lines: string[] = []

  lines.push(`# 卡组展开 Skill：${deckName}`, '')
  lines.push(
    `> 由「combo 推演」绑定的 ${input.bindings.length} 份录像自动生成（${formatDate(Date.now())}）。`,
    '> 路线、每步操作与手坑命中点都来自录像回放，卡片资料与起手概率来自卡库 / 启动率配置；',
    '> 标注项（分支原因、妥协标准、先后攻、换备、对手交互）留空，等人工补齐。',
    '',
  )

  pushUsage(lines)
  pushOverview(lines, input, coverage)
  pushDeckSection(lines, '主卡组', input.main, input.nameOf)
  pushDeckSection(lines, '额外卡组', input.extra, input.nameOf)
  if (input.side.length) pushDeckSection(lines, '副卡组', input.side, input.nameOf)
  pushCards(lines, input)
  pushSamples(lines, samples, nameOf)
  pushReplays(lines, input, usable, failed)
  pushSummary(lines, input, usable)
  pushSemantics(lines)
  pushCoverage(lines, coverage)

  lines.push('## 结构化数据', '')
  lines.push('```json')
  lines.push(buildSkillJson(input))
  lines.push('```', '')
  return lines.join('\n')
}

export function buildSkillJson(input: SkillInput): string {
  const samples = buildSampleReport({
    main: input.main,
    plan: input.plan,
    starterGroups: input.starterGroups,
    handtraps: input.handtraps,
    nameOf: input.nameOf,
  })
  const coverage = buildSkillCoverage(input, samples)
  const nameOf = input.nameOf

  const deck = {
    name: input.deckName,
    main: input.main.map((entry) => ({ code: entry.id, name: entry.name, count: entry.count })),
    extra: input.extra.map((entry) => ({ code: entry.id, name: entry.name, count: entry.count })),
    side: input.side.map((entry) => ({ code: entry.id, name: entry.name, count: entry.count })),
  }

  const cards = [...input.main, ...input.extra, ...input.side].map((entry) => {
    const card = input.cardOf?.(entry.id)
    return {
      code: entry.id,
      name: card?.name || nameOf(entry.id) || entry.name,
      count: entry.count,
      typeLine: card?.typeLine || '',
      kinds: card?.kinds || [],
      desc: card?.desc || '',
      pendDesc: card?.pendDesc || '',
    }
  })

  const sampleJson = {
    available: samples.available,
    handSize: samples.handSize,
    secondHandSize: samples.secondHandSize,
    deckSize: samples.deckSize,
    groups: samples.groups.map((group) => ({
      kind: group.kind,
      label: group.label,
      chance: round(group.chance),
      note: group.note || '',
      samples: group.samples.map((sample) => ({
        hand: sample.hand.map((code) => ({ code, name: nameOf(code) || `#${code}` })),
        clause: sample.clause,
        chance: round(sample.chance),
      })),
    })),
    notes: samples.notes,
  }

  const replays = input.bindings.map((binding) => {
    const analysis = binding.analysis
    if (!analysis?.ok) {
      return { name: binding.name, error: analysis?.error || binding.error || '无法解析' }
    }
    return {
      name: binding.name,
      seed: analysis.seed,
      startingHand: analysis.startingHand,
      openingHand: analysis.openingHand.map((code) => ({ code, name: nameOf(code) })),
      turns: analysis.turns,
      incomplete: analysis.incomplete,
      steps: analysis.steps.map((step) => ({
        turn: step.turn,
        phase: step.phase,
        actor: step.player === 0 ? 'self' : 'system',
        action: step.text,
      })),
      decisions: analysis.decisions.map((decision) => ({
        turn: decision.turn,
        phase: decision.phase,
        choice: decision.text,
      })),
      handtrapHits: analysis.handtrapHits ?? [],
    }
  })

  return JSON.stringify(
    {
      // 3：路线不再来自工作坊展开，全部由 replays 推导
      schemaVersion: 3,
      deck,
      cards,
      samples: sampleJson,
      coverage,
      replays,
    },
    null,
    2,
  )
}

/** 生成 skill 的默认文件名（卡组名里的非法字符换成下划线） */
export function skillFileName(deckName: string, extension: 'md' | 'json'): string {
  const safe = deckName.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '') || 'deck'
  return `${safe}-skill.${extension}`
}

export function buildSkillCoverage(input: SkillInput, samples: SampleReport): CoverageItem[] {
  const items: CoverageItem[] = []
  const usable = input.bindings.filter((item) => item.analysis?.ok)
  const finished = usable.filter((item) => !item.analysis?.incomplete)

  const cards = [...input.main, ...input.extra, ...input.side]
  const withText = cards.filter((entry) => {
    const desc = input.cardOf?.(entry.id)?.desc
    return Boolean(desc && desc.trim())
  }).length
  items.push({
    id: 'cards',
    label: '完整卡效文本',
    state: cards.length && withText === cards.length ? 'ok' : withText ? 'partial' : 'missing',
    detail: `${withText}/${cards.length}`,
    hint: withText === cards.length ? undefined : '卡库未收录 / 自定义卡缺效果文本，可在「卡库」页补录。',
  })

  const kinds = samples.groups.filter((group) => group.chance > 0)
  items.push({
    id: 'samples',
    label: '起手样本',
    state: samples.available ? (kinds.length >= 5 ? 'ok' : kinds.length >= 3 ? 'partial' : 'missing') : 'missing',
    detail: samples.available
      ? `覆盖 ${kinds.length}/5 类（${kinds.map((group) => group.label).join('、') || '无'}）`
      : '未配置启动条件',
    hint: samples.available ? undefined : '在「启动率」页配置启动条件与废件，才能推导起手样本。',
  })

  // 路线只有一个来源：录像。启动点按录像起手自动关联
  const replayHits = usable.reduce(
    (sum, item) => sum + (item.analysis?.handtrapHits ?? []).filter((hit) => !hit.dodged).length,
    0,
  )
  items.push({
    id: 'routes',
    label: '展开路线',
    state: usable.length ? 'ok' : 'missing',
    detail: usable.length ? `${usable.length} 份录像` : '没有可用路线',
    hint: usable.length
      ? undefined
      : '在「combo 推演」里打完一局并「绑定到卡组」，或导入 .yrp；启动点会按录像起手自动关联。',
  })

  items.push({
    id: 'branches',
    label: '分支与风险',
    state: replayHits ? 'ok' : usable.length ? 'partial' : 'missing',
    detail: replayHits ? `录像里 ${replayHits} 个命中点` : '没有可命中的手坑',
    hint: replayHits ? undefined : '导入一份带对手交互的录像后重新解析。',
  })

  items.push({
    id: 'handtraps',
    label: '阻抗时机',
    state: replayHits > 0 ? 'ok' : 'missing',
    detail: `${replayHits} 条手坑命中记录`,
    hint: replayHits > 0 ? undefined : '导入 .yrp 后重新解析（判定规则版本变化也要重解析）。',
  })

  items.push({
    id: 'endBoard',
    label: '终场盘面',
    state: finished.length ? 'ok' : 'missing',
    detail: finished.length ? `${finished.length} 份录像跑到终局` : '没有跑到终局的录像',
    hint: finished.length ? undefined : '打完一局（或托管到终局）再绑定，录像的终局盘面就是终场参考。',
  })

  items.push({
    id: 'replays',
    label: '对局录像',
    state: usable.length && finished.length ? 'ok' : usable.length ? 'partial' : 'missing',
    detail: `${usable.length} 份可解析，${finished.length} 份跑到终局`,
    hint: finished.length ? undefined : '在「combo 推演」里打完一局（或托管到终局）再绑定。',
  })

  items.push({
    id: 'opponent',
    label: '对手交互样本',
    state: usable.length >= 2 ? 'partial' : 'missing',
    detail: usable.length ? '对局只有沙包，缺少真实对手行动' : '没有录像',
    hint: '导入带对手操作的 .yrp，或在标注层手写「对手常见动作 → 我方响应」。',
  })

  items.push({
    id: 'side',
    label: '换备策略',
    state: 'missing',
    detail: input.side.length ? `副卡组 ${input.side.length} 张，未配置换备` : '没有副卡组',
    hint: '标注层补「对哪个卡组、进几张出几张」，自动层无法推导。',
  })

  return items
}

function pushUsage(lines: string[]) {
  lines.push('## 使用方式', '')
  lines.push('把这份文档整段交给 AI，它就能：', '')
  lines.push('- 认出一张 / 两张起手能不能启动，以及这条起手该走哪条路线；')
  lines.push('- 按录像与推演顺序复现展开，知道每一步产出什么、消耗什么；')
  lines.push('- 判断吃哪个手坑会断在哪一步，以及断链后还剩什么场面；')
  lines.push('- 引用卡片原文解释效果与规则处理，不靠猜。', '')
}

function pushOverview(lines: string[], input: SkillInput, coverage: CoverageItem[]) {
  const total = (list: DeckEntry[]) => list.reduce((sum, entry) => sum + entry.count, 0)
  const ok = coverage.filter((item) => item.state === 'ok').length
  const usable = input.bindings.filter((item) => item.analysis?.ok).length
  lines.push('## 概览', '')
  lines.push(
    `- 构筑：主 ${total(input.main)} · 额 ${total(input.extra)} · 副 ${total(input.side)}`,
    `- 录像路线：${usable} 份（共绑定 ${input.bindings.length} 份）；手坑定义：${input.handtraps?.length ?? 0} 个`,
    `- 自动层完整度：${ok}/${coverage.length} 项达标`,
    '',
  )
}

function pushCards(lines: string[], input: SkillInput) {
  const hasText = [...input.main, ...input.extra, ...input.side].some((entry) => input.cardOf?.(entry.id)?.desc)
  if (!hasText) {
    lines.push('## 卡片资料', '')
    lines.push('_卡库还没有就绪，未能写入效果文本。_', '')
    return
  }
  lines.push('## 卡片资料', '')
  pushCardSection(lines, '主卡组', input.main, input)
  pushCardSection(lines, '额外卡组', input.extra, input)
  if (input.side.length) pushCardSection(lines, '副卡组', input.side, input)
}

function pushCardSection(lines: string[], title: string, entries: DeckEntry[], input: SkillInput) {
  if (!entries.length) return
  lines.push(`### ${title}`, '')
  for (const entry of [...entries].sort((a, b) => b.count - a.count)) {
    const card = input.cardOf?.(entry.id)
    const name = card?.name || input.nameOf(entry.id) || entry.name
    const type = card?.typeLine ? `（${card.typeLine}）` : ''
    lines.push(`- **${entry.count} × ${name}**${type}`)
    const desc = (card?.desc || '').replace(/\s*\n+\s*/g, ' ').trim()
    if (desc) lines.push(`  ${truncate(desc)}`)
    const pend = (card?.pendDesc || '').replace(/\s*\n+\s*/g, ' ').trim()
    if (pend) lines.push(`  灵摆：${truncate(pend)}`)
  }
  lines.push('')
}

function pushSamples(lines: string[], samples: SampleReport, nameOf: (code: number) => string) {
  lines.push('## 起手与启动点', '')
  if (!samples.available) {
    for (const note of samples.notes) lines.push(`- ${note}`)
    lines.push('')
    return
  }
  lines.push(
    `- 先攻起手 ${samples.handSize} 张，后攻起手 ${samples.secondHandSize} 张；主卡组 ${samples.deckSize} 张。`,
    '',
    '| 类别 | 概率 | 说明 |',
    '| --- | --- | --- |',
  )
  for (const group of samples.groups) {
    lines.push(`| ${group.label} | ${pct(group.chance)} | ${group.note || '—'} |`)
  }
  lines.push('')

  for (const group of samples.groups) {
    lines.push(`### ${group.label}（${pct(group.chance)}）`, '')
    for (const sample of group.samples) {
      const hand = sample.hand.map((code) => nameOf(code) || `#${code}`).join('、')
      lines.push(`- ${hand}　→　${sample.clause}（${pct(sample.chance)}）`)
    }
    lines.push('')
  }

  for (const note of samples.notes) lines.push(`> ${note}`)
  lines.push('')
}

function pushReplays(
  lines: string[],
  input: SkillInput,
  usable: SkillBindingInput[],
  failed: SkillBindingInput[],
) {
  lines.push('## 对局范例', '')
  if (!usable.length) {
    lines.push('_还没有可用的录像。先在「combo 推演」里打完一局并绑定到这套卡组。_', '')
  }

  usable.forEach((binding, index) => {
    const analysis = binding.analysis!
    lines.push(`### 范例 ${index + 1}：${binding.name}`, '')
    lines.push(
      `- 回合数：${analysis.turns}${analysis.incomplete ? '（录像未跑到终局）' : ''}`,
      `- 起手 ${analysis.startingHand} 张：${listNames(analysis.openingHand, input.nameOf)}`,
      `- 种子：${analysis.seed.join(' · ') || '—'}`,
      '',
    )

    if (analysis.steps.length) {
      lines.push('展开流程：', '')
      analysis.steps.forEach((step, stepIndex) => {
        const where = step.turn ? `T${step.turn}${step.phase ? ` · ${step.phase}` : ''}` : ''
        const who = step.player === 0 ? '我方' : '系统'
        lines.push(`${stepIndex + 1}. 【${where || who}】${step.text}`)
      })
      lines.push('')
    }

    if (analysis.decisions.length) {
      lines.push('关键选择：', '')
      for (const decision of analysis.decisions) {
        const where = decision.turn ? `T${decision.turn}${decision.phase ? ` · ${decision.phase}` : ''}` : ''
        lines.push(`- ${where ? `【${where}】` : ''}${decision.text}`)
      }
      lines.push('')
    }

    const hits = analysis.handtrapHits ?? []
    if (hits.length) {
      lines.push('手坑命中点（按录像事件流反推，假设对手手上正好有这些卡）：', '')
      lines.push('| 位置 | 手坑 | 触发点 | 后果 |')
      lines.push('| --- | --- | --- | --- |')
      for (const hit of hits) {
        lines.push(`| ${hitPositionText(hit)} | ${hitNameText(hit)} | ${hit.trigger} | ${hitConsequenceText(hit)} |`)
      }
      lines.push('')
      if (hits.some((hit) => hit.dodged)) lines.push(`> ${HANDTRAP_FOOTNOTE}`, '')
    }

    if (analysis.kernelError) lines.push(`_内核告警：${analysis.kernelError}_`, '')
  })

  if (failed.length) {
    lines.push('### 无法解析的录像', '')
    for (const item of failed) {
      lines.push(`- ${item.name}：${item.analysis?.error || item.error || '未知原因'}`)
    }
    lines.push('')
  }
}

function pushSemantics(lines: string[]) {
  lines.push('## 表示形式与选项语义', '')
  lines.push('### 操作与区域', '')
  lines.push('| 概念 | 含义 |')
  lines.push('| --- | --- |')
  lines.push('| 通常召唤 | 主阶段 1/2 用手牌怪兽正面表示召唤，每回合 1 次 |')
  lines.push('| 特殊召唤 | 由卡的效果 / 规则从手卡、卡组、额外、墓地、除外特殊召唤 |')
  lines.push('| 盖放 | 里侧放到场上：怪兽进怪兽区，魔法 / 陷阱进魔陷区，盖放当回合不能发动（速攻魔法盖放当回合也不能发动） |')
  lines.push('| 发动 | 把场上 / 手卡 / 墓地的魔法、陷阱或怪兽效果加入连锁并结算 |')
  lines.push('| 变更表示 | 表侧怪兽在攻击 / 守备之间切换（当回合召唤的怪兽不能改） |')
  lines.push('| 怪兽区 1-5 / 额外怪兽区 | 主怪兽区 5 格；连接 / 从额外卡组出场的怪兽可放额外怪兽区 |')
  lines.push('| 魔陷区 1-5 / 场地区 / 灵摆区 | 后场格位；灵摆卡同时占两侧灵摆区 |')
  lines.push('| 表侧攻击 / 表侧守备 / 里侧守备 | 表示形式；里侧守备即盖放 |')
  lines.push('')
  lines.push('### 推演里的四段结构', '')
  lines.push('| 段 | 是否必定发生 | 是否能被手坑阻止 |')
  lines.push('| --- | --- | --- |')
  lines.push('| setup | 是（发动时置入魔陷区的规则处理） | 否 |')
  lines.push('| cost | 是（支付代价） | 否 |')
  lines.push('| effect | 否（效果处理） | 是，取决于卡上标记的手坑 |')
  lines.push('| settle | 是（结算后送墓 / 回额外） | 否 |')
  lines.push('')
  lines.push('### 录像里的决策类型', '')
  lines.push('| kind | 含义 |')
  lines.push('| --- | --- |')
  lines.push('| chain | 是否连锁 / 连锁哪一张（-1 = 不发动） |')
  lines.push('| yesno | 是否发动 / 是否适用（选「是」才处理） |')
  lines.push('| option | 效果分条或选项，按卡面顺序编号 |')
  lines.push('| card / tribute / sum | 选卡 / 解放 / 数量，index 对应内核给出的可选列表 |')
  lines.push('| position | 表示形式（攻击 / 守备 / 里侧） |')
  lines.push('| place | 放置格位 |')
  lines.push('| sort | 排序（卡组顶 / 墓地顺序） |')
  lines.push('')
}

function pushCoverage(lines: string[], coverage: CoverageItem[]) {
  lines.push('## 覆盖度与待补清单', '')
  lines.push('| 项 | 状态 | 详情 |')
  lines.push('| --- | --- | --- |')
  for (const item of coverage) {
    lines.push(`| ${item.label} | ${coverageText(item.state)} | ${item.detail} |`)
  }
  lines.push('')

  const todos = coverage.filter((item) => item.state !== 'ok' && item.hint)
  if (todos.length) {
    lines.push('怎么补：', '')
    for (const item of todos) lines.push(`- **${item.label}**：${item.hint}`)
    lines.push('')
  }
}

function pushSummary(lines: string[], input: SkillInput, usable: SkillBindingInput[]) {
  if (!usable.length) return
  lines.push('## 归纳', '')

  const counts = new Map<number, number>()
  let firstTurnMin = Number.POSITIVE_INFINITY
  let firstTurnMax = 0
  let firstTurnTotal = 0
  let turns = 0

  for (const binding of usable) {
    const analysis = binding.analysis!
    turns += analysis.turns
    for (const code of new Set(analysis.openingHand)) {
      counts.set(code, (counts.get(code) || 0) + 1)
    }
    const firstTurn = analysis.steps.filter((step) => step.turn === 1 && step.player === 0).length
    firstTurnMin = Math.min(firstTurnMin, firstTurn)
    firstTurnMax = Math.max(firstTurnMax, firstTurn)
    firstTurnTotal += firstTurn
  }

  lines.push(
    `- 可用录像：${usable.length} 局${input.bindings.length > usable.length ? `（另有 ${input.bindings.length - usable.length} 局无法解析）` : ''}`,
    `- 平均回合数：${(turns / usable.length).toFixed(1)}`,
    `- 首回合我方操作数：平均 ${(firstTurnTotal / usable.length).toFixed(1)}（${firstTurnMin} ~ ${firstTurnMax}）`,
  )

  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
  if (top.length) {
    lines.push(
      `- 起手常见卡：${top
        .map(([code, count]) => `${input.nameOf(code)}（${count}/${usable.length}）`)
        .join('、')}`,
    )
  }
  lines.push('')
}

function pushDeckSection(
  lines: string[],
  title: string,
  entries: DeckEntry[],
  nameOf: (code: number) => string,
) {
  if (!entries.length) return
  lines.push(`### ${title}`, '')
  for (const entry of entries) {
    lines.push(`- ${entry.count} × ${nameOf(entry.id) || entry.name}`)
  }
  lines.push('')
}

function coverageText(state: CoverageItem['state']): string {
  if (state === 'ok') return '达标'
  if (state === 'partial') return '部分'
  return '缺失'
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000
}

function truncate(text: string): string {
  return text.length > MAX_DESC_LENGTH ? `${text.slice(0, MAX_DESC_LENGTH)}…` : text
}

function listNames(codes: number[], nameOf: (code: number) => string): string {
  if (!codes.length) return '—'
  return codes.map((code) => nameOf(code) || `#${code}`).join('、')
}

function formatDate(time: number): string {
  const date = new Date(time)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
