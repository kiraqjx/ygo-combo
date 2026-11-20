import type { ReplayAnalysis } from './duel/replay'
import type { DrawHandtrapTurn } from './duel/drawHandtraps'
import { actionableSteps } from './replayPoster'

/**
 * 手坑报告：把录像里的潜在手坑命中点汇总成两个维度。
 *
 * - **单份录像**：这条展开一共几步、哪几步会吃手坑。
 * - **卡组维度**：同一套卡组的全部录像合并，看每个手坑总共能卡住几步、
 *   占全部展开步数的比例、最早能在第几步出现。
 *
 * 命中点来自 `ReplayAnalysis.handtrapHitsAll`（全量，不限步数）：
 * skill 包只关心前 20 步，但报告要看完整展开。
 * 「步数」与展开图一致（`actionableSteps()`，已滤掉系统行与常规抽牌），
 * 所以报告里的「第 N 步」和展开图上的第 N 个节点是同一个位置。
 */

export interface HandtrapReportSource {
  id: string
  name: string
  analysis: ReplayAnalysis | null | undefined
}

/** 卡组维度：一个手坑的汇总 */
export interface HandtrapTally {
  id: string
  name: string
  /** 命中过这个手坑的录像份数 */
  replays: number
  /** 命中步数（每份录像内按 step 去重后累加） */
  steps: number
  /** 命中点总数（含被自排连锁规避的） */
  hits: number
  /** 被自排连锁盖住、对手其实够不到的点 */
  dodged: number
  /** 所有录像里最早的一次出现在第几步 */
  firstStep: number | null
  /** 命中步数 / 全部步数 */
  rate: number
}

/** 单份录像：一行 */
export interface HandtrapReplayRow {
  id: string
  name: string
  /** 展开步数 */
  steps: number
  /** 会被手坑打断的步数（同一步只算一次） */
  hitSteps: number
  hits: number
  /** 手坑 → 命中步数，按步数降序 */
  byHandtrap: {
    id: string
    name: string
    steps: number
    hits: number
    dodged: number
    firstStep: number
  }[]
}

export interface HandtrapReport {
  replays: number
  /** 所有录像的展开步数之和 */
  steps: number
  averageSteps: number
  /** 单份维度，按命中步数降序 */
  rows: HandtrapReplayRow[]
  /** 卡组维度，按命中步数降序 */
  handtraps: HandtrapTally[]
}

/**
 * 报告里不统计的手坑。
 *
 * 尼比鲁是「累计第 5 次召唤」的固定计数、锁鸟只在第一次检索后生效，
 * 它们跟「这套卡组的检索链走得顺不顺」关系很弱：报出来的步数基本等于
 * 召唤次数 / 检索次数，读不出有用信息。判定本身照旧（skill 包、录像列表里的
 * 手坑点仍然包含它们），只是报告不展示。
 */
const REPORT_SKIP = new Set(['nibiru', 'lock-bird'])

export function buildHandtrapReport(sources: HandtrapReportSource[]): HandtrapReport {
  const rows: HandtrapReplayRow[] = []
  const tallies = new Map<string, HandtrapTally>()

  for (const source of sources) {
    const analysis = source.analysis
    if (!analysis?.ok) continue

    const steps = actionableSteps(analysis.steps).length
    const hits = (analysis.handtrapHitsAll ?? analysis.handtrapHits ?? []).filter(
      (hit) => !REPORT_SKIP.has(hit.id),
    )
    const perTrap = new Map<
      string,
      { name: string; stepSet: Set<number>; hits: number; dodged: number; firstStep: number }
    >()

    for (const hit of hits) {
      const entry =
        perTrap.get(hit.id) ?? { name: hit.name, stepSet: new Set<number>(), hits: 0, dodged: 0, firstStep: hit.step }
      entry.stepSet.add(hit.step)
      entry.hits += 1
      if (hit.dodged) entry.dodged += 1
      if (hit.step < entry.firstStep) entry.firstStep = hit.step
      perTrap.set(hit.id, entry)

      const tally: HandtrapTally =
        tallies.get(hit.id) ??
        ({
          id: hit.id,
          name: hit.name,
          replays: 0,
          steps: 0,
          hits: 0,
          dodged: 0,
          firstStep: null,
          rate: 0,
        } satisfies HandtrapTally)
      tally.hits += 1
      if (hit.dodged) tally.dodged += 1
      if (tally.firstStep === null || hit.step < tally.firstStep) tally.firstStep = hit.step
      tallies.set(hit.id, tally)
    }

    // 一份录像里同一个手坑命中同一步只算一步（多张同名卡打在同一步上）
    for (const [id, entry] of perTrap) {
      const tally = tallies.get(id)
      if (!tally) continue
      tally.steps += entry.stepSet.size
      tally.replays += 1
    }

    rows.push({
      id: source.id,
      name: source.name,
      steps,
      // 同一步可能同时吃两种手坑，这里要跨手坑去重：报的是「哪几步不安全」
      hitSteps: new Set(hits.map((hit) => hit.step)).size,
      hits: hits.length,
      byHandtrap: [...perTrap.entries()]
        .map(([id, entry]) => ({
          id,
          name: entry.name,
          steps: entry.stepSet.size,
          hits: entry.hits,
          dodged: entry.dodged,
          firstStep: entry.firstStep,
        }))
        .sort((a, b) => b.steps - a.steps),
    })
  }

  rows.sort((a, b) => b.hitSteps - a.hitSteps || a.steps - b.steps)
  const totalSteps = rows.reduce((sum, row) => sum + row.steps, 0)
  const handtraps = [...tallies.values()]
    .map((tally) => ({
      id: tally.id,
      name: tally.name,
      replays: tally.replays,
      steps: tally.steps,
      hits: tally.hits,
      dodged: tally.dodged,
      firstStep: tally.firstStep,
      rate: totalSteps ? tally.steps / totalSteps : 0,
    }))
    .sort((a, b) => b.steps - a.steps || b.replays - a.replays)

  return {
    replays: rows.length,
    steps: totalSteps,
    averageSteps: rows.length ? Math.round(totalSteps / rows.length) : 0,
    rows,
    handtraps,
  }
}

/** 导出成 Markdown：卡组维度（单份明细在各自的弹窗里导出） */
export function handtrapReportMarkdown(title: string, report: HandtrapReport): string {
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`
  const lines: string[] = [
    `# 手坑报告 · ${title || '未命名卡组'}`,
    '',
    `- 录像：${report.replays} 份`,
    `- 总步数：${report.steps} 步（平均 ${report.averageSteps} 步/份）`,
    '',
  ]

  if (report.rows.length) {
    lines.push('| 录像 | 展开步数 | 会被手坑打断 |', '| --- | --- | --- |')
    for (const row of report.rows) lines.push(`| ${row.name} | ${row.steps} 步 | ${row.hitSteps} 步 |`)
    lines.push('')
  }

  lines.push(
    '| 手坑 | 命中录像 | 命中步数 | 占总步数 | 最早一步 | 被自排连锁规避 |',
    '| --- | --- | --- | --- | --- | --- |',
  )
  if (!report.handtraps.length) lines.push('| — | — | — | — | — | — |')
  for (const item of report.handtraps) {
    lines.push(
      `| ${item.name} | ${item.replays} 份 | ${item.steps} 步 | ${percent(item.rate)} | ${item.firstStep ?? '—'} | ${item.dodged} |`,
    )
  }

  return `${lines.join('\n')}\n`
}

/** 导出单份录像的手坑报告（含抽卡型手坑那一段） */
export function replayHandtrapReportMarkdown(
  title: string,
  row: HandtrapReplayRow,
  drawTurns: DrawHandtrapTurn[] = [],
): string {
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`
  const lines: string[] = [
    `# 手坑报告 · ${row.name}`,
    '',
    `- 卡组：${title || '未命名卡组'}`,
    `- 展开步数：${row.steps} 步`,
    `- 会被手坑打断：${row.hitSteps} 步（${percent(row.steps ? row.hitSteps / row.steps : 0)}）`,
    '',
    '| 手坑 | 命中步数 | 占本展开 | 最早一步 | 被自排连锁规避 |',
    '| --- | --- | --- | --- | --- |',
  ]

  if (!row.byHandtrap.length) lines.push('| — | — | — | — | — |')
  for (const item of row.byHandtrap) {
    lines.push(
      `| ${item.name} | ${item.steps} 步 | ${percent(row.steps ? item.steps / row.steps : 0)} | ${item.firstStep} | ${item.dodged} |`,
    )
  }

  if (drawTurns.length) {
    lines.push(
      '',
      '## 抽卡型手坑（假设对手持有）',
      '',
      '不打断展开，只统计「对手在这一刻发动，这回合还能抽几张」。',
      '',
      '| 回合 | 手坑 | 对手抽几张 |',
      '| --- | --- | --- |',
    )
    for (const turn of drawTurns) {
      for (const stat of turn.stats) {
        lines.push(`| 第 ${turn.turn} 回合 | ${stat.name} | ${stat.draws} 张 |`)
      }
    }
  }

  return `${lines.join('\n')}\n`
}
