import { DuelSession } from './session'
import { parseReplay, type ParsedReplay } from './yrp'
import {
  analyzeHandtrapHits,
  HANDTRAP_ANALYSIS_VERSION,
  HANDTRAP_MAX_STEP,
  type ReplayHandtrapHit,
} from './replayHandtraps'
import { analyzeCardFlows, FLOW_VERSION, type FlowPick, type ReplayFlow } from './replayFlows'
import { analyzeDrawHandtraps, type DrawHandtrapTurn } from './drawHandtraps'
import type { DuelCapture } from './types'

/**
 * 录像 → 操作序列。
 *
 * .yrp 里存的只有「内核问什么 → 玩家答什么」的原始字节，没有可读文本。
 * 内核是确定性的：同卡组 + 同响应序列重放一遍，就能拿回当时的全部消息
 * （召唤 / 发动 / 抽卡 / 确认 …），这些消息就是展开逻辑的原始素材。
 *
 * 回放本身不参与界面交互：DuelSession 的 rawResponses 模式直接把字节喂回内核。
 */

/** 和 session 里的阶段编号一致 */
const PHASE_LABELS: Record<number, string> = {
  1: '抽卡阶段',
  2: '准备阶段',
  4: '主要阶段 1',
  8: '战斗阶段',
  16: '主要阶段 2',
  32: '结束阶段',
}

export interface ReplayStep {
  turn: number
  phase: string
  /** 0 我方 / -1 系统（阶段、连锁结算等） */
  player: number
  text: string
  /** 对应的事件流下标；展开图靠它把手坑命中点贴到正确的那一步 */
  signal?: number
}

export interface ReplayDecision {
  turn: number
  phase: string
  player: number
  kind: string
  text: string
}

export interface ReplayAnalysis {
  ok: boolean
  error?: string
  /** 4 × 64 位种子（十六进制）；和录像里记录的卡组一起可复现 */
  seed: string[]
  names: [string, string]
  startingHand: number
  drawCount: number
  /** 起手（录像里卡组顶的 startingHand 张） */
  openingHand: number[]
  turns: number
  steps: ReplayStep[]
  decisions: ReplayDecision[]
  /** 潜在的手坑命中点（按事件流反推，不是录像里实际发生的）；只含前 `HANDTRAP_MAX_STEP` 步 */
  handtrapHits?: ReplayHandtrapHit[]
  /**
   * 同一份判定的**全量**命中点（不限步数）。
   * skill 包与录像列表仍用 `handtrapHits`（前 20 步就够判断「展开被拦」），
   * 展开图与手坑报告要看完整展开，所以单独存一份，避免为此重放内核。
   */
  handtrapHitsAll?: ReplayHandtrapHit[]
  /**
   * 抽卡型手坑（增殖的 G / 欢聚友伴）的收益：按回合列出「若对手在这一刻发动，
   * 这回合还能抽几张」。它们不打断展开，所以单独统计，只给单份录像用。
   */
  drawHandtraps?: DrawHandtrapTurn[]
  /**
   * 「哪张卡把哪张卡挪到了哪」：卡与卡之间的区域转移（检索 / 堆墓 / 弃手卡 / 回收…）。
   * 只记录确定性关系：随机抽卡 / 随机堆墓 / 随机除外不连成卡与卡。
   * 旧缓存没有这一项、或 `flowVersion` 对不上时，检索图会按需重放一次补上。
   */
  flows?: ReplayFlow[]
  /** 生成 flows 时的归因规则版本 */
  flowVersion?: number
  /** 生成 handtrapHits 时的判定规则版本；和当前版本不一致就要重新解析 */
  analysisVersion?: number
  /** 录像没跑到结束（响应不够 / 内核报错） */
  incomplete: boolean
  /** 内核给的最后一条错误 */
  kernelError?: string
}

const FAIL = (error: string): ReplayAnalysis => ({
  ok: false,
  error,
  seed: [],
  names: ['', ''],
  startingHand: 0,
  drawCount: 0,
  openingHand: [],
  turns: 0,
  steps: [],
  decisions: [],
  incomplete: true,
})

export async function analyzeReplay(
  bytes: Uint8Array,
  resolveName: (code: number) => string,
): Promise<ReplayAnalysis> {
  let parsed: ParsedReplay
  try {
    parsed = parseReplay(bytes)
  } catch (error) {
    return FAIL(error instanceof Error ? error.message : String(error))
  }

  const session = new DuelSession(
    {
      playerDeck: parsed.playerDeck,
      opponentDeck: parsed.opponentDeck,
      // 卡组已经是录像里记录的实际顺序，别再洗一次
      prebuiltDecks: { player: parsed.playerDeck, opponent: parsed.opponentDeck },
      seed: parsed.seed,
      startingLP: parsed.startingLP,
      startingHand: parsed.startingHand,
      drawCount: parsed.drawCount,
      names: parsed.names,
      rawResponses: parsed.responses,
      // 一局完整日志远超默认的 300 条
      logLimit: 5000,
    },
    resolveName,
  )

  let error: string | undefined
  try {
    await session.start()
    await session.waitForEnd()
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  }

  const snapshot = session.snapshot()
  session.stop()

  if (error) return { ...FAIL(error), seed: parsed.seed.map((value) => value.toString(16)) }

  const openingHand = parsed.playerDeck.main.slice(0, Math.max(0, parsed.startingHand))
  const steps: ReplayStep[] = []
  const decisions: ReplayDecision[] = []
  let turn = 1
  let phase = '开局'

  for (const entry of snapshot.logs) {
    const turnHit = /^第 (\d+) 回合/.exec(entry.text)
    if (turnHit) {
      turn = Number(turnHit[1])
      phase = '回合开始'
      continue
    }
    const phaseHit = /^进入(.+)$/.exec(entry.text)
    if (phaseHit) {
      phase = phaseHit[1]
      // 回合 / 阶段标记只用来给后面的操作定位，不单独占一行
      continue
    }
    if (entry.text === '决斗开始') continue
    // 对手是沙包，它的抽卡 / 结束回合对理解本卡组没有价值
    if (entry.player === 1) continue
    if (entry.text.startsWith('内核：')) continue
    steps.push({ turn, phase, player: entry.player, text: entry.text, signal: entry.signal })
  }

  for (const capture of session.captures) {
    // 对手是沙包，只保留我方决定
    if (capture.player !== 0) continue
    const text = choiceText(capture)
    if (!text) continue
    decisions.push({
      turn: capture.turn,
      phase: PHASE_LABELS[capture.phase] ?? '',
      player: capture.player,
      kind: capture.kind,
      text,
    })
  }

  const kernelError = snapshot.logs.find((entry) => entry.kernel)?.kernel
  // 判定只跑一次：skill 包要前 20 步，展开图 / 手坑报告要全量
  const allHits = analyzeHandtrapHits(session.signals)
  return {
    ok: true,
    seed: parsed.seed.map((value) => value.toString(16)),
    names: parsed.names,
    startingHand: parsed.startingHand,
    drawCount: parsed.drawCount,
    openingHand,
    turns: Math.max(turn, snapshot.state.turn),
    steps,
    decisions,
    handtrapHits: allHits.filter((hit) => hit.step <= HANDTRAP_MAX_STEP),
    handtrapHitsAll: allHits,
    drawHandtraps: analyzeDrawHandtraps(session.signals),
    flows: analyzeCardFlows(session.signals, { picks: collectFlowPicks(session.captures) }),
    flowVersion: FLOW_VERSION,
    analysisVersion: HANDTRAP_ANALYSIS_VERSION,
    incomplete: !snapshot.state.finished,
    kernelError,
  }
}

/**
 * 玩家明确选过哪些卡，以及这条选卡在事件流里的位置。
 *
 * 内核只在「要从候选里挑卡」时发选卡提问；随机抽卡 / 随机堆墓 / 随机除外、
 * 「双方手卡全部回到卡组」这类由内核自己决定，不会产生提问。
 * 检索图用这张表区分「效果检索了这张」和「只是恰好落到这张」。
 */
function collectFlowPicks(captures: DuelCapture[]): FlowPick[] {
  const picks: FlowPick[] = []
  for (const capture of captures) {
    if (capture.player !== 0) continue
    if (capture.kind !== 'card' && capture.kind !== 'tribute' && capture.kind !== 'sum') continue
    // 旧缓存的 capture 没有信号位置，只能跳过
    if (typeof capture.signalIndex !== 'number') continue
    const indexes = pickedIndexes(capture)
    if (!indexes.length) continue
    const names: string[] = []
    for (const index of indexes) {
      const name = capture.labels[index]
      if (name) names.push(name)
    }
    if (names.length) picks.push({ index: capture.signalIndex, names })
  }
  return picks
}

/** card / tribute / sum 的响应布局：[0][张数][下标…]，首项 -1 表示取消 */
function pickedIndexes(capture: DuelCapture): number[] {
  const bytes = capture.response
  if (bytes.byteLength < 8) return []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getInt32(0, true) === -1) return []
  const count = view.getInt32(4, true)
  const picks: number[] = []
  for (let index = 0; index < count; index += 1) {
    const offset = 8 + index * 4
    if (offset + 4 > bytes.byteLength) break
    picks.push(view.getInt32(offset, true))
  }
  return picks
}

/** 把「提问 + 原始响应字节」翻译成一句人话 */
function choiceText(capture: DuelCapture): string {
  const bytes = capture.response
  if (!bytes.byteLength) return ''
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const first = bytes.byteLength >= 4 ? view.getInt32(0, true) : bytes[0]

  switch (capture.kind) {
    case 'chain':
      // SELECT_CHAIN：-1 = 不发动，否则是 selects 的下标
      return first < 0 ? '不发动' : labelAt(capture, first, '发动')
    case 'yesno':
      return first ? '是' : '否'
    case 'option':
      return labelAt(capture, first, '选项')
    case 'card':
    case 'tribute':
    case 'sum': {
      // 布局：[0][张数][下标…]，第一项为 -1 表示取消
      if (first === -1) return '取消'
      const count = bytes.byteLength >= 8 ? view.getInt32(4, true) : 0
      const names: string[] = []
      for (let index = 0; index < count; index += 1) {
        const offset = 8 + index * 4
        if (offset + 4 > bytes.byteLength) break
        const pick = view.getInt32(offset, true)
        const name = capture.labels[pick]
        if (name) names.push(name)
      }
      return names.length ? `选择「${names.join('」「')}」` : ''
    }
    case 'position':
      return `表示形式 ${first}`
    default:
      return ''
  }
}

function labelAt(capture: DuelCapture, index: number, verb: string): string {
  const label = capture.labels[index]
  return label ? `${verb}「${label}」` : `${verb}第 ${index + 1} 项`
}
