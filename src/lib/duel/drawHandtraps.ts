import type { DuelSignal } from './types'

/**
 * 抽卡型手坑（增殖的 G / 欢聚友伴系列）的收益估算。
 *
 * 这类手坑和灰流丽那些不一样：它们**不打断**，只是对手每做一次「登场 / 检索」
 * 就抽一张，所以判断依据不是「能不能响应」，而是「这条展开还会喂给对手几张」。
 *
 * 数据来源只有事件流里的 `move`：我方把怪兽放进怪兽区、且 `reason` 表明是召唤 / 特召。
 * 被无效的特召不会产生这条移动，所以不用另外确认。来源区域从 `from.location` 取：
 *   - 手卡  → 噗露莉娅（含通常召唤）
 *   - 卡组 / 额外 → 浮华洛丝（只算特殊召唤）
 *   - 墓地 / 除外 → 喵露丝（只算特殊召唤）
 *   - 增殖的 G：所有特殊召唤
 *
 * 「对手会抽几张」直接取该回合这类动作的次数（按能抽到的上限算）。
 */

/** ygopro 区域位掩码（与 ocgcore 的 OcgLocation 取值一致） */
const LOC = {
  DECK: 0x01,
  HAND: 0x02,
  MZONE: 0x04,
  SZONE: 0x08,
  GRAVE: 0x10,
  REMOVED: 0x20,
  EXTRA: 0x40,
} as const

/** 移动原因位（见 duel-assets/scripts/constant.lua） */
const REASON = {
  SUMMON: 0x10,
  SPSUMMON: 0x800,
} as const

export interface DrawHandtrapStat {
  /** maxx-c / purulia / fuwalos / meowls */
  id: string
  name: string
  /** 若对手在这一刻发动，到回合结束能抽几张 */
  draws: number
}

export interface DrawHandtrapTurn {
  turn: number
  /** 这一回合我方登场的总次数（含通常召唤） */
  spawns: number
  stats: DrawHandtrapStat[]
}

interface Spawn {
  turn: number
  from: number
  special: boolean
}

export function analyzeDrawHandtraps(signals: DuelSignal[]): DrawHandtrapTurn[] {
  const spawns: Spawn[] = []

  for (const signal of signals) {
    if (signal.kind !== 'move') continue
    if (signal.player !== 0) continue
    if (!((signal.to?.location ?? 0) & LOC.MZONE)) continue
    const reason = signal.reason ?? 0
    const special = (reason & REASON.SPSUMMON) !== 0
    const normal = (reason & REASON.SUMMON) !== 0
    // 效果放置 / 里侧盖放不是「登场」，不喂抽卡手坑
    if (!special && !normal) continue
    spawns.push({ turn: signal.turn, from: signal.from?.location ?? 0, special })
  }

  const byTurn = new Map<number, Spawn[]>()
  for (const spawn of spawns) {
    const list = byTurn.get(spawn.turn)
    if (list) list.push(spawn)
    else byTurn.set(spawn.turn, [spawn])
  }

  const turns: DrawHandtrapTurn[] = []
  for (const [turn, list] of [...byTurn.entries()].sort((a, b) => a[0] - b[0])) {
    const stats: DrawHandtrapStat[] = []
    const record = (id: string, name: string, pool: Spawn[]) => {
      if (!pool.length) return
      stats.push({ id, name, draws: pool.length })
    }

    record(
      'maxx-c',
      '增殖的 G',
      list.filter((spawn) => spawn.special),
    )
    record(
      'purulia',
      '欢聚友伴·噗露莉娅',
      list.filter((spawn) => (spawn.from & LOC.HAND) !== 0),
    )
    record(
      'fuwalos',
      '欢聚友伴·浮华洛丝',
      list.filter((spawn) => spawn.special && (spawn.from & (LOC.DECK | LOC.EXTRA)) !== 0),
    )
    record(
      'meowls',
      '欢聚友伴·喵露丝',
      list.filter((spawn) => spawn.special && (spawn.from & (LOC.GRAVE | LOC.REMOVED)) !== 0),
    )

    if (stats.length) turns.push({ turn, spawns: list.length, stats })
  }

  return turns
}
