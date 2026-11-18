import type { CardMove, ComboLine, Timing, TimingState, ZoneCard, ZoneSnapshot } from '@/types'
import { LINK_KIND_LABELS, POSITION_LABELS, ZONE_LABELS } from '@/types'
import { HANDTRAP_MAP } from './handtraps'
import { analyzeCombo, analyzeTimeline, timingTitle } from './timeline'

/**
 * 展开路线推导（AI Skill 自动层）。
 *
 * 把推演内核的结构化结果整理成「决策树 + 资源曲线 + 终场」：
 *
 *   - 每一步 = 一个节点，带状态、cost / 效果移动、链路来源、资源余量；
 *   - 每个手坑可命中的时点 = 一个分支，条件与风险自动填写，
 *     「改走哪条路线」留给标注（自动层只给出断链位置）；
 *   - 终场 = 最后一步结算后的盘面；
 *   - 妥协盘面 = 被最伤的手坑打断后、仍能拿到的盘面。
 */
export interface EndBoard {
  monsters: string[]
  spells: string[]
  hand: string[]
  gy: string[]
  banish: string[]
  summons: number
}

export interface RouteResources {
  hand: number
  field: number
  st: number
  gy: number
  banish: number
  summons: number
}

export interface RouteStep {
  index: number
  title: string
  status: TimingState['status']
  reasons: string[]
  chains: string[]
  moves: string[]
  /** 上游链路：这张卡是第几步用什么方式送来的 */
  links: string[]
  resources: RouteResources
}

export interface RouteBranch {
  step: number
  kind: 'handtrap'
  condition: string
  alternative: string
  risk: string
}

export interface RouteHandtrap {
  id: string
  name: string
  category: string
  verdict: string
  verdictLabel: string
  headline: string
  sites: number[]
  deadAt: number | null
  effective: boolean
}

export interface CompromiseBoard {
  handtrap: string
  headline: string
  endBoard: EndBoard
}

export interface RouteReport {
  comboName: string
  lineName: string
  goal: string
  handSize: number
  timings: number
  totalSummons: number
  steps: RouteStep[]
  branches: RouteBranch[]
  endBoard: EndBoard
  handtraps: RouteHandtrap[]
  compromises: CompromiseBoard[]
  warnings: string[]
}

const VERDICT_LABEL: Record<string, string> = {
  safe: '安全',
  warning: '警告',
  danger: '危险',
  lethal: '致命',
  inactive: '无效',
}

const VERDICT_WEIGHT: Record<string, number> = { lethal: 4, danger: 3, warning: 2, safe: 1, inactive: 0 }

const MAX_BRANCH_SITES = 2
const MAX_COMPROMISES = 3

export function buildRouteReport(comboName: string, line: ComboLine): RouteReport {
  const analysis = analyzeCombo(line)
  const stateById = new Map(analysis.states.map((state) => [state.timingId, state]))
  const incoming = new Map<string, string[]>()
  for (const link of analysis.links) {
    const label = `${link.cardName}（${LINK_KIND_LABELS[link.kind]} → ${ZONE_LABELS[link.to]}）`
    const list = incoming.get(link.toTimingId) || []
    list.push(link.broken ? `${label}【已断】` : label)
    incoming.set(link.toTimingId, list)
  }

  const steps: RouteStep[] = line.timings.map((timing, index) => {
    const state = stateById.get(timing.id)
    return {
      index,
      title: timingTitle(timing),
      status: state?.status ?? 'ok',
      reasons: state?.reasons ?? [],
      chains: timing.chains.map((chain) => `C${chain.link} ${chain.cardName}`),
      moves: describeMoves(timing),
      links: incoming.get(timing.id) || [],
      resources: resourcesOf(state?.after),
    }
  })

  const warnings: string[] = []
  if (!line.timings.length) warnings.push('这条展开链还没有时序，无法推导路线。')
  if (!line.goal.trim()) warnings.push('没有填写终场目标（goal），下文只有推演出来的实际盘面。')
  if (steps.some((step) => step.status !== 'ok')) {
    warnings.push('推演里有断链 / 被无效的步骤，主线不是干净的完整展开。')
  }
  const missing = line.opening.filter((card) => !line.deck.some((entry) => entry.name === card.name))
  if (missing.length) {
    warnings.push(`起手有 ${missing.length} 张卡不在卡表里：${missing.map((card) => card.name).join('、')}。`)
  }

  const handtraps: RouteHandtrap[] = analysis.reports.map((report) => ({
    id: report.id,
    name: HANDTRAP_MAP[report.id]?.name || report.id,
    category: HANDTRAP_MAP[report.id]?.category || '',
    verdict: report.verdict,
    verdictLabel: VERDICT_LABEL[report.verdict] || report.verdict,
    headline: report.headline,
    sites: report.sites,
    deadAt: report.deadAt,
    effective: report.effective,
  }))

  const branches: RouteBranch[] = []
  for (const report of analysis.reports) {
    if (!report.effective) continue
    for (const index of report.sites.slice(0, MAX_BRANCH_SITES)) {
      const timing = line.timings[index]
      if (!timing) continue
      const name = HANDTRAP_MAP[report.id]?.name || report.id
      branches.push({
        step: index,
        kind: 'handtrap',
        condition: `对手持有「${name}」，在第 ${index + 1} 步（${timingTitle(timing)}）发动`,
        alternative:
          report.deadAt !== null
            ? `第 ${report.deadAt + 1} 步起链路断开，改走妥协路线（待标注）`
            : '这一步被无效，后续步骤按剩余资源继续（待标注）',
        risk: `${VERDICT_LABEL[report.verdict] || report.verdict}：${report.headline}`,
      })
    }
  }
  branches.sort((a, b) => a.step - b.step)

  const endBoard = endBoardOf(analysis.states.at(-1)?.after)
  const compromises: CompromiseBoard[] = []
  const ranked = analysis.reports
    .filter((report) => report.effective && report.deadAt !== null)
    .sort((a, b) => (VERDICT_WEIGHT[b.verdict] || 0) - (VERDICT_WEIGHT[a.verdict] || 0))
    .slice(0, MAX_COMPROMISES)

  for (const report of ranked) {
    let worst: { broken: number; board: EndBoard } | null = null
    for (const index of report.sites) {
      const timing = line.timings[index]
      if (!timing) continue
      const sim = analyzeTimeline(line, [{ timingId: timing.id, handtrapId: report.id }])
      const broken = sim.states.filter((state) => state.status === 'broken').length
      if (!broken) continue
      const board = endBoardOf(sim.states.at(-1)?.after)
      if (!worst || broken > worst.broken) worst = { broken, board }
    }
    if (worst) {
      compromises.push({
        handtrap: HANDTRAP_MAP[report.id]?.name || report.id,
        headline: report.headline,
        endBoard: worst.board,
      })
    }
  }

  return {
    comboName,
    lineName: line.name,
    goal: line.goal,
    handSize: line.handSize,
    timings: line.timings.length,
    totalSummons: analysis.totalSummons,
    steps,
    branches,
    endBoard,
    handtraps,
    compromises,
    warnings,
  }
}

function describeMoves(timing: Timing): string[] {
  const rows: string[] = []
  const push = (phase: string, list: CardMove[]) => {
    for (const move of list) {
      const count = move.count && move.count > 1 ? `×${move.count}` : ''
      const guard = move.handtraps?.length
        ? `（可被 ${move.handtraps.map((id) => HANDTRAP_MAP[id]?.name || id).join('、')} 阻止）`
        : ''
      rows.push(`${phase}：${move.cardName}${count} ${ZONE_LABELS[move.from]} → ${ZONE_LABELS[move.to]}${guard}`)
    }
  }
  push('发动', timing.setup)
  push('cost', timing.cost)
  push('效果', timing.effect)
  push('结算', timing.settle)
  return rows
}

function resourcesOf(snapshot?: ZoneSnapshot): RouteResources {
  if (!snapshot) return { hand: 0, field: 0, st: 0, gy: 0, banish: 0, summons: 0 }
  return {
    hand: sumZone(snapshot.hand),
    field: sumZone(snapshot.field),
    st: sumZone(snapshot.st),
    gy: sumZone(snapshot.gy),
    banish: sumZone(snapshot.banish),
    summons: snapshot.summons,
  }
}

export function endBoardOf(snapshot?: ZoneSnapshot): EndBoard {
  if (!snapshot) return { monsters: [], spells: [], hand: [], gy: [], banish: [], summons: 0 }
  return {
    monsters: snapshot.fieldSlots.flatMap((slot) => (slot ? [monsterLabel(slot)] : [])),
    spells: snapshot.stSlots.flatMap((slot) => (slot ? [cardLabel(slot)] : [])),
    hand: snapshot.hand.map(cardLabel),
    gy: snapshot.gy.map(cardLabel),
    banish: snapshot.banish.map(cardLabel),
    summons: snapshot.summons,
  }
}

function monsterLabel(card: ZoneCard): string {
  const position = card.position ? POSITION_LABELS[card.position] : ''
  const materials = card.materials?.length ? `（素材 ${card.materials.join('、')}）` : ''
  return `${cardLabel(card)}${position ? ` · ${position}` : ''}${materials}`
}

function cardLabel(card: ZoneCard): string {
  return card.count > 1 ? `${card.name}×${card.count}` : card.name
}

function sumZone(list: ZoneCard[]): number {
  return list.reduce((sum, card) => sum + card.count, 0)
}
