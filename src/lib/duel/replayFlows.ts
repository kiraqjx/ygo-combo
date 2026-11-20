import type { DuelSignal } from './types'

/**
 * 录像事件流 → 「哪张卡把哪张卡挪到了哪」。
 *
 * `move` 信号只带「被移动的卡 + 起止区域 + reason」，没有「是谁干的」。
 * 归因按录像里真实的时序处理，三条路：
 *
 * 1. **效果处理中**（`solving` 正指向某条连锁）→ 归给那条连锁的发动卡；
 * 2. **发动前支付的费用**（reason 带 COST，早于 CHAINING 消息）→ 先缓存，
 *    等紧接着的发动来认领；
 * 3. **召唤素材 / 解放**（reason 带 MATERIAL / RELEASE，早于 SPSUMMONING）→
 *    先缓存，等紧接着的召唤宣言来认领。
 *
 * 拿不到归因的移动直接丢掉：没有「从哪张卡来」，就画不出卡与卡之间的线。
 */

/** ygopro 区域位掩码（与 ocgcore 的 OcgLocation 一致） */
const LOC = {
  DECK: 0x01,
  HAND: 0x02,
  MZONE: 0x04,
  SZONE: 0x08,
  GRAVE: 0x10,
  REMOVED: 0x20,
  EXTRA: 0x40,
} as const

/** 卡移动原因位掩码，取值见 duel-assets/scripts/constant.lua 的 REASON_* */
const REASON = {
  RELEASE: 0x2,
  MATERIAL: 0x8,
  EFFECT: 0x40,
  COST: 0x80,
  RULE: 0x400,
} as const

/**
 * 归因规则版本。改判定（比如现在排除随机抽卡 / 随机堆墓）必须 +1：
 * `flows` 跟着解析结果缓存在 IndexedDB 里，版本对不上要重放一次。
 */
export const FLOW_VERSION = 4

export type FlowZone = 'deck' | 'hand' | 'monster' | 'spell' | 'grave' | 'removed' | 'extra' | ''

/** 区域位 → 语义 key（一张卡同一时刻只在一个区域，按顺序取第一个命中的位） */
export function zoneKeyOf(location: number | undefined): FlowZone {
  if (!location) return ''
  if (location & LOC.DECK) return 'deck'
  if (location & LOC.HAND) return 'hand'
  if (location & LOC.MZONE) return 'monster'
  if (location & LOC.SZONE) return 'spell'
  if (location & LOC.GRAVE) return 'grave'
  if (location & LOC.REMOVED) return 'removed'
  if (location & LOC.EXTRA) return 'extra'
  return ''
}

export const ZONE_LABELS: Record<string, string> = {
  deck: '卡组',
  hand: '手卡',
  monster: '怪兽区',
  spell: '魔陷区',
  grave: '墓地',
  removed: '除外',
  extra: '额外',
}

export interface ReplayFlow {
  /** 效果来源（发动 / 召唤的那张卡） */
  source: string
  /** 被移动的卡 */
  target: string
  /** 起始区域位（OcgLocation 掩码） */
  from: number
  to: number
  /** 这份录像里出现几次 */
  count: number
}

export interface FlowPick {
  /** 这条选卡回答出现时，事件流里已经有多少条 signal */
  index: number
  /** 玩家选中的卡名（一次选多张就多条） */
  names: string[]
}

export interface FlowOptions {
  /**
   * 玩家明确选过卡的记录（带信号位置）。
   *
   * 内核只在「从候选里挑卡」时提问；随机 / 全量行为不会：
   * 抽卡、割草式随机堆墓、强贪式随机除外、「双方手卡全部回到卡组再抽回来」…
   * 这些移动只是恰好落在某张卡上，画成「A 检索 B」会骗人。
   * 所以只有「移动的目标正好是刚被选中的那张」才算确定性关系。
   */
  picks?: FlowPick[]
}

interface PendingMove {
  target: string
  from: number
  to: number
}

export function analyzeCardFlows(signals: DuelSignal[], options: FlowOptions = {}): ReplayFlow[] {
  const bucket = new Map<string, ReplayFlow>()
  const picks = options.picks

  const add = (source: string, target: string, from: number, to: number) => {
    if (!source || !target || source === target) return
    const key = `${source}|${target}|${from}|${to}`
    const exist = bucket.get(key)
    if (exist) exist.count += 1
    else bucket.set(key, { source, target, from, to, count: 1 })
  }

  /** 连锁号 → 发动这张卡的名称（结算里的移动都算它的效果） */
  const chainSource = new Map<number, string>()
  let solving = 0
  /** 发动前支付的费用：等下一次发动认领 */
  let pendingCost: PendingMove[] = []
  /** 召唤用的素材 / 解放：等召唤宣言认领 */
  let pendingMaterial: PendingMove[] = []

  /**
   * 还没被用掉的选卡：[卡名, 选卡时正在结算的连锁号]。
   * 一条选卡只能认领一次移动，避免「选过一次就把它之后所有的移动都算上」；
   * 带段号是为了不让别的连锁里的选卡认领本段结算 —— 连锁是后进先出，
   * c2 结算中选的卡会跑到 c1 的结算里，把 c1 的随机抽回手卡当成「检索」。
   * 段号 0 = 发动时选的卡（还没进入结算），它对哪一段都算数。
   */
  const available: { name: string; seg: number }[] = []
  let pickCursor = 0
  let lastTurn = -1

  const mergePicks = (index: number) => {
    if (!picks) return
    while (pickCursor < picks.length && picks[pickCursor].index <= index) {
      for (const name of picks[pickCursor].names) available.push({ name, seg: solving })
      pickCursor += 1
    }
  }

  /** 这张卡是不是玩家刚选的；是就消耗一次配额 */
  const takePick = (name: string): boolean => {
    // 没传选卡记录时保持旧行为
    if (!picks) return true
    const at = available.findIndex((item) => item.name === name && (item.seg === 0 || item.seg === solving))
    if (at < 0) return false
    available.splice(at, 1)
    return true
  }

  for (let index = 0; index < signals.length; index += 1) {
    const signal = signals[index]
    if (signal.turn !== lastTurn) {
      lastTurn = signal.turn
      available.length = 0
    }
    mergePicks(index)
    switch (signal.kind) {
      case 'chain': {
        // 连锁号回到 1 = 上一条连锁结束，归因表跟着清掉
        if (signal.chainSize === 1) chainSource.clear()
        chainSource.set(signal.chainSize, signal.name)
        if (signal.player === 0) {
          for (const move of pendingCost) add(signal.name, move.target, move.from, move.to)
        }
        pendingCost = []
        pendingMaterial = []
        // 上一条连锁没用完的选卡作废：别让 A 效果的选卡认领到 B 效果的移动
        available.length = 0
        break
      }
      case 'solving':
        solving = signal.chainSize
        break
      case 'solved':
      case 'negated':
        chainSource.delete(signal.chainSize)
        if (solving === signal.chainSize) solving = 0
        break
      case 'summon':
      case 'spsummon':
      case 'flip': {
        if (signal.player === 0) {
          for (const move of pendingMaterial) add(signal.name, move.target, move.from, move.to)
        }
        pendingCost = []
        pendingMaterial = []
        break
      }
      case 'move': {
        // 对手的卡进进出出和这套构筑的检索网络无关
        if (signal.player !== 0) break
        const from = signal.from?.location ?? 0
        const to = signal.to?.location ?? 0
        const fromKey = zoneKeyOf(from)
        const toKey = zoneKeyOf(to)
        if (!fromKey || !toKey || fromKey === toKey) break

        const reason = signal.reason ?? 0
        // 纯规则移动（洗牌、额外卡组回表侧之类）不是任何卡造成的
        if ((reason & REASON.RULE) !== 0 && (reason & (REASON.EFFECT | REASON.COST)) === 0) break

        const source = solving ? chainSource.get(solving) : undefined
        if (source) {
          // 随机抽卡 / 随机堆墓 / 「手卡全部回卡组」这类没有选卡提问，不算关系
          if (!takePick(signal.name)) break
          add(source, signal.name, from, to)
          break
        }
        if ((reason & REASON.COST) !== 0) {
          if (!takePick(signal.name)) break
          pendingCost.push({ target: signal.name, from, to })
          break
        }
        if ((reason & (REASON.MATERIAL | REASON.RELEASE)) !== 0) {
          if (!takePick(signal.name)) break
          pendingMaterial.push({ target: signal.name, from, to })
        }
        break
      }
      default:
        break
    }
  }

  return [...bucket.values()].sort((a, b) => b.count - a.count)
}
