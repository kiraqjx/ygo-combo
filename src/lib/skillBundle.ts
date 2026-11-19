import type { CardData, ComboLine, DeckEntry } from '@/types'
import { HANDTRAP_FOOTNOTE, hitConsequenceText, hitNameText, hitPositionText } from './duel/replayHandtraps'
import type { ReplayAnalysis } from './duel/replay'
import { HANDTRAP_MAP } from './handtraps'
import { buildRateModel, openingChance } from './rates'
import { buildSkillCoverage, type CoverageItem, type SkillInput } from './skill'
import { buildRouteReport, type RouteReport } from './skillRoutes'
import { buildSampleReport, listStarterClauses, type SampleReport } from './skillSamples'

/**
 * 分片 skill 包（给 AI 的运行时形态）。
 *
 * 目标：AI 拿到 5 张起手后先只读路由层（2~4 KB），判断
 * 「哪些是启动点 / 手坑 / 废件」，再按路由表加载一条展开 skill（3~8 KB），
 * 需要时才去看单卡完整文本。相比整份大文档，上下文短一个数量级。
 *
 * 产物结构（zip 内）：
 *   <卡组>-skill/manifest.json   机器可读：启动点、手坑、废件、卡号角色
 *   <卡组>-skill/00-router.md    手牌判断 + 路由规则 + 最伤手坑 + 覆盖度
 *   <卡组>-skill/10-line-XX.md   每个启动点一条：路线、分支、手坑、卡效
 *   <卡组>-skill/90-fallback.md  无启动点 / 未录入路线的兜底
 *   <卡组>-skill/cards/<code>.md 被路线引用到的卡（完整效果文本）
 */

export interface BundleStarter {
  code: string
  label: string
  requires: { code: number; name: string }[]
  /** 先攻起手命中概率 */
  chance: number
  /** 后攻（多抽 1 张）命中概率 */
  secondChance: number
  /** 已录入的路线；空数组表示这条启动点还没有展开 */
  file: string | null
  lines: { combo: string; line: string }[]
}

export interface BundleReplay {
  code: string
  file: string
  name: string
  turns: number
  incomplete: boolean
  /** 对手真能打到的手坑命中点数量 */
  hits: number
  /** 被自排连锁规避、实际打不到的命中点数量 */
  dodged: number
}

export interface BundleManifest {
  schemaVersion: number
  deck: { name: string; main: number; extra: number; side: number }
  generatedAt: string
  files: {
    router: string
    fallback: string
    lines: string[]
    replays: string[]
    cards: string
  }
  starters: BundleStarter[]
  replays: BundleReplay[]
  handtraps: { code: number; name: string; category: string }[]
  bricks: { cards: { code: number; name: string }[]; allowance: number; clear: string }[]
  /** 卡号 → 角色（启动点 code / handtrap / brick / flex） */
  roles: Record<string, string[]>
  coverage: CoverageItem[]
}

export interface SkillBundle {
  /** 相对 zip 根目录的文件路径 → 文本内容 */
  files: Record<string, string>
  manifest: BundleManifest
  zipName: string
  dir: string
}

interface RouteEntry {
  comboName: string
  line: ComboLine
  report: RouteReport
  cardIds: Set<number>
}

const MAX_CARD_TEXT = 1600
const CARD_DIR = 'cards'

export function buildSkillBundle(input: SkillInput): SkillBundle {
  const nameOf = input.nameOf
  const entries = [...input.main, ...input.extra, ...input.side]
  const dir = bundleDir(input.deckName)
  const samples = buildSampleReport({
    main: input.main,
    plan: input.plan,
    starterGroups: input.starterGroups,
    handtraps: input.handtraps,
    nameOf,
  })
  const clauses = listStarterClauses({ plan: input.plan, starterGroups: input.starterGroups, nameOf })

  const routes: RouteEntry[] = (input.lines ?? []).map((item) => ({
    comboName: item.comboName,
    line: item.line,
    report: buildRouteReport(item.comboName, item.line),
    cardIds: collectLineCardIds(item.line, entries, nameOf),
  }))
  const coverage = buildSkillCoverage(input, samples, routes.map((item) => item.report))

  const handtrapDefs = (input.handtraps ?? []).filter(
    (def) => def.cardId && input.main.some((entry) => entry.id === def.cardId && entry.count > 0),
  )
  const handtrapIds = new Set(handtrapDefs.map((def) => def.cardId as number))
  const blockers = input.plan?.blockers ?? []
  const brickIds = new Set(blockers.flatMap((blocker) => blocker.cards.map((card) => card.id)))

  // 命中概率与路由层的「无启动点」口径一致：都扣掉废件超限的情况
  const model = buildRateModel(input.main, clauses, blockers)
  const starters: BundleStarter[] = []
  clauses.forEach((clause, index) => {
    const required = clause.slots.filter((slot) => slot.min > 0)
    if (!required.length) return
    const requires = required.map((slot) => ({
      code: slot.cardId,
      name: slot.name || nameOf(slot.cardId) || `#${slot.cardId}`,
    }))
    const requiredIds = requires.map((item) => item.code)
    const linked = routes.filter((item) => requiredIds.every((id) => item.cardIds.has(id)))
    const code = `line-${String(index + 1).padStart(2, '0')}`
    starters.push({
      code,
      label: requires.map((item) => item.name).join(' + '),
      requires,
      chance: openingChance(model, [clause], blockers, samples.handSize),
      secondChance: openingChance(model, [clause], blockers, samples.secondHandSize),
      file: linked.length ? `${code}.md` : null,
      lines: linked.map((item) => ({ combo: item.comboName, line: item.line.name })),
    })
  })

  // 卡号 → 角色
  const roles: Record<string, string[]> = {}
  const roleOf = (code: number): string[] => {
    const list: string[] = []
    for (const starter of starters) {
      if (starter.requires.some((item) => item.code === code)) list.push(starter.code)
    }
    if (handtrapIds.has(code)) list.push('handtrap')
    if (brickIds.has(code)) list.push('brick')
    return list.length ? list : ['flex']
  }
  for (const entry of input.main) roles[String(entry.id)] = roleOf(entry.id)

  // 需要写完整卡效的卡：路线用到的 + 启动卡 + 手坑 + 废件
  const usedCardIds = new Set<number>()
  for (const route of routes) for (const id of route.cardIds) usedCardIds.add(id)
  for (const starter of starters) for (const item of starter.requires) usedCardIds.add(item.code)
  for (const id of handtrapIds) usedCardIds.add(id)
  for (const id of brickIds) usedCardIds.add(id)

  // 录像：每份可解析的 .yrp 一个文件，含展开流程与手坑命中点
  const replays: BundleReplay[] = []
  const replayFiles: Record<string, string> = {}
  input.bindings.forEach((binding, index) => {
    const analysis = binding.analysis
    if (!analysis?.ok) return
    const code = `replay-${String(index + 1).padStart(2, '0')}`
    const file = `20-${code}.md`
    const allHits = analysis.handtrapHits ?? []
    replays.push({
      code,
      file,
      name: binding.name,
      turns: analysis.turns,
      incomplete: analysis.incomplete,
      hits: allHits.filter((hit) => !hit.dodged).length,
      dodged: allHits.filter((hit) => hit.dodged).length,
    })
    replayFiles[file] = replayMarkdown(input, binding.name, analysis, code)
  })

  const manifest: BundleManifest = {
    schemaVersion: 3,
    deck: {
      name: input.deckName,
      main: total(input.main),
      extra: total(input.extra),
      side: total(input.side),
    },
    generatedAt: new Date().toISOString(),
    files: {
      router: '00-router.md',
      fallback: '90-fallback.md',
      lines: starters.filter((starter) => starter.file).map((starter) => starter.file as string),
      replays: replays.map((item) => item.file),
      cards: `${CARD_DIR}/`,
    },
    starters,
    replays,
    handtraps: handtrapDefs.map((def) => ({
      code: def.cardId as number,
      name: def.name,
      category: def.category,
    })),
    bricks: blockers.map((blocker) => ({
      cards: blocker.cards.map((card) => ({ code: card.id, name: card.name })),
      allowance: blocker.allowance,
      clear: blocker.clear,
    })),
    roles,
    coverage,
  }

  const files: Record<string, string> = {}
  files[`${dir}/manifest.json`] = `${JSON.stringify(manifest, null, 2)}\n`

  files[`${dir}/00-router.md`] = routerMarkdown(
    input,
    manifest,
    samples,
    starters,
    handtrapDefs,
    coverage,
    routes,
    replays,
  )

  for (const starter of starters) {
    if (!starter.file) continue
    const linked = routes.filter((item) => starter.lines.some((line) => line.combo === item.comboName && line.line === item.line.name))
    files[`${dir}/${starter.file}`] = lineMarkdown(input, starter, linked, samples)
  }

  for (const [file, text] of Object.entries(replayFiles)) files[`${dir}/${file}`] = text

  files[`${dir}/90-fallback.md`] = fallbackMarkdown(input, starters, samples, coverage)

  for (const entry of entries) {
    if (!usedCardIds.has(entry.id)) continue
    const card = input.cardOf?.(entry.id)
    files[`${dir}/${CARD_DIR}/${entry.id}.md`] = cardMarkdown(entry, card, nameOf)
  }

  return { files, manifest, zipName: `${safeName(input.deckName)}-skill.zip`, dir }
}

export function bundleDir(deckName: string): string {
  return `${safeName(deckName)}-skill`
}

/* ------------------------------------------------------------------ */
/* 路由层                                                              */
/* ------------------------------------------------------------------ */

function routerMarkdown(
  input: SkillInput,
  manifest: BundleManifest,
  samples: SampleReport,
  starters: BundleStarter[],
  handtrapDefs: { id: string; name: string; category: string; cardId?: number }[],
  coverage: CoverageItem[],
  routes: RouteEntry[],
  replays: BundleReplay[],
): string {
  const lines: string[] = []
  const slug = safeName(input.deckName)
  lines.push('---')
  lines.push(`name: "${slug}-router"`)
  lines.push('description: "用起手 5 张判断启动点 / 手坑 / 废件，并路由到对应展开 skill"')
  lines.push(`deck: ${JSON.stringify(input.deckName)}`)
  lines.push('---', '')
  lines.push(`# ${input.deckName} · 起手路由器`, '')
  lines.push('## 怎么用', '')
  lines.push('1. 把起手卡号列出来（先攻 5 张，后攻 6 张）；')
  lines.push('2. 查下面「手牌角色」判断每张卡：启动点 / 手坑 / 废件 / 自由位；')
  lines.push('3. 按「路由规则」挑出能走的启动点，只加载对应文件，不要一次读完所有展开。', '')

  lines.push('## 路由表（机器可读）', '')
  lines.push('```json')
  lines.push(
    JSON.stringify(
      {
        starters: starters.map((starter) => ({
          code: starter.code,
          label: starter.label,
          requires: starter.requires.map((item) => item.code),
          chance: round(starter.chance),
          secondChance: round(starter.secondChance),
          file: starter.file,
          lines: starter.lines,
        })),
        handtraps: handtrapDefs.map((def) => ({ code: def.cardId, name: def.name, category: def.category })),
        bricks: manifest.bricks,
        roles: manifest.roles,
      },
      null,
      2,
    ),
  )
  lines.push('```', '')

  lines.push('## 启动点', '')
  if (!starters.length) {
    lines.push('_没有配置启动条件：先在「启动率」页设置启动组 / 启动条件。_', '')
  } else {
    lines.push('| 编号 | 启动点 | 先攻命中 | 后攻命中 | 文件 |')
    lines.push('| --- | --- | --- | --- | --- |')
    for (const starter of starters) {
      lines.push(
        `| ${starter.code} | ${starter.label} | ${pct(starter.chance)} | ${pct(starter.secondChance)} | ${starter.file || '未录入'} |`,
      )
    }
    lines.push('')
  }

  if (samples.groups.length) {
    lines.push('## 代表起手', '')
    for (const group of samples.groups) {
      const sample = group.samples[0]
      if (!sample) continue
      lines.push(`- **${group.label}**（${pct(group.chance)}）：${sample.hand.map(input.nameOf).join('、')}`)
    }
    lines.push('')
  }

  if (replays.length) {
    lines.push('## 对局样本', '')
    lines.push('| 文件 | 录像 | 回合 | 手坑点 | 被自排连锁规避 |')
    lines.push('| --- | --- | --- | --- | --- |')
    for (const replay of replays) {
      lines.push(
        `| ${replay.file} | ${replay.name} | ${replay.turns}${replay.incomplete ? '（未终局）' : ''} | ${replay.hits} | ${replay.dodged} |`,
      )
    }
    lines.push('')
    lines.push('> 展开流程与逐步的手坑命中点在各样本文件里；没有绑定录像时这一节为空。', '')
  }

  lines.push('## 手牌角色', '')
  lines.push('| 卡号 | 卡名 | 角色 |')
  lines.push('| --- | --- | --- |')
  for (const entry of input.main) {
    const list = manifest.roles[String(entry.id)] || ['flex']
    const label = list
      .map((role) => (role === 'handtrap' ? '手坑' : role === 'brick' ? '废件' : role === 'flex' ? '自由位' : role))
      .join('、')
    lines.push(`| ${entry.id} | ${input.nameOf(entry.id) || entry.name} | ${label} |`)
  }
  lines.push('')
  lines.push('> 手坑同时也是启动卡时，按启动点处理；`flex` 是既非启动、非手坑、非废件的普通卡。', '')

  lines.push('## 路由规则', '')
  lines.push('- 没有任何启动点 → 读 `90-fallback.md`；')
  lines.push('- 多个启动点同时成立 → 先加载命中率最高的那个文件，其余只在它被拦断后再看；')
  lines.push('- 抽到手坑 → 不影响启动判定，但要少 1 个展开位，防守优先；')
  lines.push('- 废件超过 allowance：`never` 型直接判定无法启动，`leaveHand` 型视为可丢弃后继续；')
  lines.push('- 只加载需要的 `10-line-*.md`；卡效在 `cards/<卡号>.md`，没遇到就别读。', '')

  const worst = worstHandtraps(routes)
  if (worst.length) {
    lines.push('## 最伤手坑（跨路线）', '')
    for (const item of worst.slice(0, 5)) {
      lines.push(`- 「${item.name}」：${item.lines} 条路线会被打断，最狠的是「${item.headline}」`)
    }
    lines.push('')
  }

  lines.push('## 覆盖度', '')
  lines.push('| 项 | 状态 | 详情 |')
  lines.push('| --- | --- | --- |')
  for (const item of coverage) {
    lines.push(`| ${item.label} | ${coverageText(item.state)} | ${item.detail} |`)
  }
  lines.push('')
  const todos = coverage.filter((item) => item.state !== 'ok' && item.hint)
  if (todos.length) {
    lines.push('待补：', '')
    for (const item of todos) lines.push(`- **${item.label}**：${item.hint}`)
    lines.push('')
  }

  return lines.join('\n')
}

/* ------------------------------------------------------------------ */
/* 展开层                                                              */
/* ------------------------------------------------------------------ */

function lineMarkdown(
  input: SkillInput,
  starter: BundleStarter,
  routes: RouteEntry[],
  samples: SampleReport,
): string {
  const lines: string[] = []
  const slug = safeName(input.deckName)
  lines.push('---')
  lines.push(`name: "${slug}-${starter.code}"`)
  lines.push(`description: ${JSON.stringify(`启动点「${starter.label}」的展开路线：终场、资源曲线、分支、手坑与卡效`)}`)
  lines.push(`starter: "${starter.code}"`)
  lines.push('---', '')
  lines.push(`# 启动点：${starter.label}（${pct(starter.chance)}）`, '')
  lines.push(`- 手牌要求：${starter.requires.map((item) => `${item.name}（${item.code}）`).join(' + ')}`)
  lines.push(`- 先攻 ${samples.handSize} 张命中 ${pct(starter.chance)}；后攻 ${samples.secondHandSize} 张命中 ${pct(starter.secondChance)}`)
  lines.push(`- 已录入路线：${starter.lines.map((item) => `${item.combo} / ${item.line}`).join('；') || '无'}`)
  lines.push('')

  if (!routes.length) {
    lines.push('_这条启动点还没有关联展开，先回 `00-router.md` 看兜底方案。_', '')
    return lines.join('\n')
  }

  for (const route of routes) {
    const report = route.report
    lines.push(`## 路线：${report.comboName} / ${report.lineName}`, '')
    lines.push(`- 终场目标：${report.goal || '（未填写）'}`)
    lines.push(`- 手牌 ${report.handSize} 张 · ${report.timings} 个时序 · 累计召唤 ${report.totalSummons} 次`)
    for (const warning of report.warnings) lines.push(`- 注意：${warning}`)
    lines.push('')

    lines.push('### 终场盘面', '')
    lines.push(...boardLines(report.endBoard))
    lines.push('')

    if (report.steps.length) {
      lines.push('### 资源曲线（每步结算后）', '')
      lines.push('| # | 操作 | 状态 | 手牌 | 前场 | 后场 | 墓地 | 除外 | 召唤 |')
      lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
      for (const step of report.steps) {
        const r = step.resources
        lines.push(
          `| ${step.index + 1} | ${step.title} | ${statusText(step.status)} | ${r.hand} | ${r.field} | ${r.st} | ${r.gy} | ${r.banish} | ${r.summons} |`,
        )
      }
      lines.push('')

      lines.push('### 逐步操作', '')
      for (const step of report.steps) {
        lines.push(`#### 第 ${step.index + 1} 步 · ${step.title}`, '')
        if (step.chains.length) lines.push(`- 连锁：${step.chains.join(' / ')}`)
        if (step.links.length) lines.push(`- 上游链路：${step.links.join('；')}`)
        for (const move of step.moves) lines.push(`- ${move}`)
        if (step.reasons.length) lines.push(`- 推演说明：${step.reasons.join('；')}`)
        lines.push('')
      }
    }

    if (report.branches.length) {
      lines.push('### 分支与风险', '')
      lines.push('| 节点 | 条件 | 备选 | 风险 |')
      lines.push('| --- | --- | --- | --- |')
      for (const branch of report.branches) {
        lines.push(`| 第 ${branch.step + 1} 步 | ${branch.condition} | ${branch.alternative} | ${branch.risk} |`)
      }
      lines.push('')
    }

    lines.push('### 这条路线的手坑', '')
    // 只列真能命中的：无效 / 无法命中的手坑对这条路线没有决策价值
    const hittable = report.handtraps.filter((item) => item.effective && item.sites.length > 0)
    if (hittable.length) {
      lines.push('| 手坑 | 判定 | 命中位置 | 影响 |')
      lines.push('| --- | --- | --- | --- |')
      for (const item of hittable) {
        const sites = item.sites.map((index) => `第 ${index + 1} 步`).join('、')
        lines.push(`| ${item.name} | ${item.verdictLabel} | ${sites} | ${item.headline} |`)
      }
    } else {
      lines.push('- 这条路线没有标记可命中的手坑。')
    }
    lines.push('')

    if (report.compromises.length) {
      lines.push('### 吃手坑后的妥协盘面', '')
      for (const compromise of report.compromises) {
        lines.push(
          `- 被「${compromise.handtrap}」（${compromise.headline}）：前场 ${listOrEmpty(compromise.endBoard.monsters)}；后场 ${listOrEmpty(compromise.endBoard.spells)}；手牌 ${listOrEmpty(compromise.endBoard.hand)}`,
        )
      }
      lines.push('')
    }

    lines.push('### 本路线涉及的卡片', '')
    const involved = [...route.cardIds]
    for (const id of involved) {
      const card = input.cardOf?.(id)
      const name = card?.name || input.nameOf(id) || `#${id}`
      const type = card?.typeLine ? `（${card.typeLine}）` : ''
      lines.push(`- **${name}**${type}`)
      const desc = (card?.desc || '').replace(/\s*\n+\s*/g, ' ').trim()
      if (desc) lines.push(`  ${truncate(desc)}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

/* ------------------------------------------------------------------ */
/* 兜底层                                                              */
/* ------------------------------------------------------------------ */

function fallbackMarkdown(
  input: SkillInput,
  starters: BundleStarter[],
  samples: SampleReport,
  coverage: CoverageItem[],
): string {
  const lines: string[] = []
  const slug = safeName(input.deckName)
  lines.push('---')
  lines.push(`name: "${slug}-fallback"`)
  lines.push('description: "起手没有启动点、或对应路线还没录入时的兜底流程"')
  lines.push('---', '')
  lines.push('# 兜底：无启动点 / 路线缺失', '')
  lines.push('## 先确认真的没有启动点', '')
  lines.push('- 逐张核对 `00-router.md` 的手牌角色表：`flex` 卡里可能藏着未登记的启动点；')
  lines.push('- 只有「需要 ≥2 张」的组命中其中 1 张时，不算启动，按单卡路线走；')
  lines.push('- 手坑不算启动点，但如果卡组有「手坑 + 单卡」的两卡组合，按路由表判定。', '')

  const missing = starters.filter((starter) => !starter.file)
  if (missing.length) {
    lines.push('## 能启动但路线未录入', '')
    for (const starter of missing) lines.push(`- ${starter.code}：${starter.label}（命中率 ${pct(starter.chance)}）`)
    lines.push('')
    lines.push('处理方式：按最接近的已录入路线近似，或把这条启动点补进「工作坊」后重新生成 skill。', '')
  }

  if (samples.groups.some((group) => group.kind === 'none')) {
    const none = samples.groups.find((group) => group.kind === 'none')
    if (none) {
      lines.push('## 无启动点', '')
      lines.push(`- 概率：${pct(none.chance)}（按当前启动条件）`)
      lines.push('- 处理：优先用抽滤 / 检索找启动点；没有就转防守，把手坑 / 盖放留到对手回合。')
      lines.push('')
    }
  }

  lines.push('## 断链恢复', '')
  lines.push('- 先看对应 `10-line-*.md` 的「分支与风险」表，确认断在哪一步；')
  lines.push('- 再看「吃手坑后的妥协盘面」，选择仍然成立的后场 / 手牌留场；')
  lines.push('- 若断链发生在 route 的第 N 步，后面的步骤不要按原路线继续执行。', '')

  const todos = coverage.filter((item) => item.state !== 'ok' && item.hint)
  if (todos.length) {
    lines.push('## 还缺什么', '')
    for (const item of todos) lines.push(`- **${item.label}**：${item.hint}`)
    lines.push('')
  }

  return lines.join('\n')
}

/* ------------------------------------------------------------------ */
/* 录像层                                                              */
/* ------------------------------------------------------------------ */

function replayMarkdown(input: SkillInput, name: string, analysis: ReplayAnalysis, code: string): string {
  const slug = safeName(input.deckName)
  const lines: string[] = []
  lines.push('---')
  lines.push(`name: "${slug}-${code}"`)
  lines.push(`description: ${JSON.stringify(`对局录像「${name}」：展开流程与手坑命中点`)}`)
  lines.push('---', '')
  lines.push(`# 对局录像：${name}`, '')
  lines.push(
    `- 回合数：${analysis.turns}${analysis.incomplete ? '（录像未跑到终局）' : ''}`,
    `- 起手 ${analysis.startingHand} 张：${analysis.openingHand.map(input.nameOf).join('、') || '—'}`,
    '',
  )

  if (analysis.steps.length) {
    lines.push('## 展开流程', '')
    analysis.steps.forEach((step, index) => {
      const where = step.turn ? `T${step.turn}${step.phase ? ` · ${step.phase}` : ''}` : ''
      const who = step.player === 0 ? '我方' : '系统'
      lines.push(`${index + 1}. 【${where || who}】${step.text}`)
    })
    lines.push('')
  }

  if (analysis.decisions.length) {
    lines.push('## 关键选择', '')
    for (const decision of analysis.decisions) {
      const where = decision.turn ? `T${decision.turn}${decision.phase ? ` · ${decision.phase}` : ''}` : ''
      lines.push(`- ${where ? `【${where}】` : ''}${decision.text}`)
    }
    lines.push('')
  }

  const hits = analysis.handtrapHits ?? []
  lines.push('## 手坑命中点', '')
  if (hits.length) {
    lines.push('| 位置 | 手坑 | 触发点 | 后果 |')
    lines.push('| --- | --- | --- | --- |')
    for (const hit of hits) {
      lines.push(`| ${hitPositionText(hit)} | ${hitNameText(hit)} | ${hit.trigger} | ${hitConsequenceText(hit)} |`)
    }
    lines.push('')
    lines.push('> 录像里没有对手手牌，以上是「对手手上正好有这张卡」时的潜在命中点。', '')
    if (hits.some((hit) => hit.dodged)) lines.push(`> ${HANDTRAP_FOOTNOTE}`, '')
  } else {
    lines.push('_没有识别到命中点（录像太短，或旧缓存还没重新解析）。_', '')
  }

  return lines.join('\n')
}

/* ------------------------------------------------------------------ */
/* 卡效                                                                */
/* ------------------------------------------------------------------ */

function cardMarkdown(entry: DeckEntry, card: CardData | undefined, nameOf: (code: number) => string): string {
  const name = card?.name || nameOf(entry.id) || entry.name
  const lines: string[] = []
  lines.push(`# ${name}（#${entry.id}）`, '')
  if (card?.typeLine) lines.push(`- 类型：${card.typeLine}`)
  if (card?.kinds.length) lines.push(`- 分类：${card.kinds.join('、')}`)
  if (card?.attribute) lines.push(`- 属性：${card.attribute}`)
  if (card?.race) lines.push(`- 种族：${card.race}`)
  if (typeof card?.level === 'number') lines.push(`- 等级 / 阶级：${card.level}`)
  if (typeof card?.atk === 'number' || card?.atk === null) lines.push(`- ATK：${card?.atk ?? '?'}`)
  if (typeof card?.def === 'number' || card?.def === null) lines.push(`- DEF：${card?.def ?? '?'}`)
  lines.push('')
  const desc = (card?.desc || '').trim()
  lines.push(desc ? `## 效果\n\n${truncate(desc)}` : '## 效果\n\n_卡库没有这张卡的效果文本。_')
  const pend = (card?.pendDesc || '').trim()
  if (pend) lines.push('', `## 灵摆\n\n${truncate(pend)}`)
  return `${lines.join('\n')}\n`
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

/** 一条展开链涉及到的卡号（起手 + 各时序的主卡 / 移动 / 连锁） */
function collectLineCardIds(line: ComboLine, entries: DeckEntry[], nameOf: (code: number) => string): Set<number> {
  const byName = new Map<string, number>()
  for (const entry of entries) {
    byName.set(entry.name.trim(), entry.id)
    const resolved = (nameOf(entry.id) || '').trim()
    if (resolved) byName.set(resolved, entry.id)
  }
  const ids = new Set<number>()
  const addName = (name?: string) => {
    if (!name) return
    const id = byName.get(name.trim())
    if (id) ids.add(id)
  }

  for (const card of line.opening) {
    ids.add(card.id)
    addName(card.name)
  }
  for (const timing of line.timings) {
    if (timing.cardId) ids.add(timing.cardId)
    addName(timing.cardName)
    for (const list of [timing.setup, timing.cost, timing.effect, timing.settle]) {
      for (const move of list) addName(move.cardName)
    }
    for (const chain of timing.chains) {
      if (chain.cardId) ids.add(chain.cardId)
      addName(chain.cardName)
    }
  }
  return ids
}

function worstHandtraps(routes: RouteEntry[]): { name: string; lines: number; headline: string }[] {
  const map = new Map<string, { name: string; lines: number; headline: string; weight: number }>()
  for (const route of routes) {
    for (const item of route.report.handtraps) {
      if (!item.effective || item.verdict === 'safe') continue
      const weight = item.verdict === 'lethal' ? 4 : item.verdict === 'danger' ? 3 : 2
      const hit = map.get(item.id)
      if (hit) {
        hit.lines += 1
        if (weight > hit.weight) {
          hit.weight = weight
          hit.headline = item.headline
        }
      } else {
        map.set(item.id, {
          name: item.name || HANDTRAP_MAP[item.id]?.name || item.id,
          lines: 1,
          headline: item.headline,
          weight,
        })
      }
    }
  }
  return [...map.values()].sort((a, b) => b.weight - a.weight || b.lines - a.lines)
}

function boardLines(board: { monsters: string[]; spells: string[]; hand: string[]; gy: string[]; banish: string[] }): string[] {
  return [
    `- 前场：${listOrEmpty(board.monsters)}`,
    `- 后场：${listOrEmpty(board.spells)}`,
    `- 手牌：${listOrEmpty(board.hand)}`,
    `- 墓地：${listOrEmpty(board.gy)}`,
    ...(board.banish.length ? [`- 除外：${board.banish.join('、')}`] : []),
  ]
}

function statusText(status: string): string {
  if (status === 'ok') return '正常'
  if (status === 'partial') return '部分'
  if (status === 'negated') return '被无效'
  if (status === 'broken') return '断链'
  return status
}

function coverageText(state: CoverageItem['state']): string {
  if (state === 'ok') return '达标'
  if (state === 'partial') return '部分'
  return '缺失'
}

function total(list: DeckEntry[]): number {
  return list.reduce((sum, entry) => sum + Math.max(0, Math.floor(Number(entry.count) || 0)), 0)
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000
}

function truncate(text: string): string {
  return text.length > MAX_CARD_TEXT ? `${text.slice(0, MAX_CARD_TEXT)}…` : text
}

function listOrEmpty(list: string[]): string {
  return list.length ? list.join('、') : '空'
}

function safeName(deckName: string): string {
  return deckName.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '') || 'deck'
}
