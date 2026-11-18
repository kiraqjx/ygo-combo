import {
  OcgLocation,
  SelectBattleCMDAction,
  SelectIdleCMDAction,
  type OcgMessageSelectBattleCMD,
  type OcgMessageSelectIdlecmd,
} from 'ocgcore-wasm'
import type { CardData } from '@/types'
import { placesFromMask } from './auto'
import type { DuelQuestion } from './types'

/** 按卡号查卡库；查不到返回 undefined（卡库未加载 / 未收录） */
export type CardLookup = (code: number) => CardData | undefined

/**
 * 把内核的"提问"翻译成界面可用的交互数据。
 *
 * 关键点：内核给的选择项都带 location + sequence，
 * 所以场上的格子、手卡、墓地都能直接对应到选择项下标——
 * 点击卡片就等于选中那一项，不需要再从右侧列表里找卡名。
 */

/** 格子定位键：玩家 + 区域 + 格位 */
export function slotKey(player: number, location: number, sequence: number): string {
  return `${player}:${location}:${sequence}`
}

export interface DuelCommand {
  family: 'idle' | 'battle'
  /** SelectIdleCMDAction 或 SelectBattleCMDAction */
  action: number
  /** 在该动作数组里的下标 */
  index: number
  code: number
  controller: number
  location: number
  sequence: number
  label: string
}

/**
 * 「当前操作」的展示顺序：特殊召唤 / 发动这类主动操作排前面，
 * 陷阱与速攻魔法的盖放能即时响应，单独提到通常召唤之前；
 * 通常召唤、怪兽盖放、其它魔法陷阱盖放依次排到最后
 * （0 = 其它，保持内核给的顺序）。
 */
const FAST_SET_ORDER = 1

const IDLE_DISPLAY_ORDER: Record<number, number> = {
  [SelectIdleCMDAction.SELECT_SUMMON]: 2,
  [SelectIdleCMDAction.SELECT_MONSTER_SET]: 3,
  [SelectIdleCMDAction.SELECT_SPELL_SET]: 4,
}

/** 盖放后能即时响应的卡：陷阱 / 速攻魔法。查不到卡时按普通魔陷处理 */
function isFastSet(code: number, lookupCard?: CardLookup): boolean {
  const card = lookupCard?.(code)
  if (!card) return false
  if (card.frame === 'trap') return true
  return card.frame === 'spell' && card.kinds.includes('速攻')
}

function displayOrder(command: DuelCommand, lookupCard?: CardLookup): number {
  if (command.action === SelectIdleCMDAction.SELECT_SPELL_SET && isFastSet(command.code, lookupCard)) return FAST_SET_ORDER
  return IDLE_DISPLAY_ORDER[command.action] ?? 0
}

export function idleCommands(message: OcgMessageSelectIdlecmd, lookupCard?: CardLookup): DuelCommand[] {
  const groups: [SelectIdleCMDAction, string, { code: number; controller: number; location: number; sequence: number }[]][] = [
    [SelectIdleCMDAction.SELECT_SUMMON, '召唤', message.summons],
    [SelectIdleCMDAction.SELECT_SPECIAL_SUMMON, '特殊召唤', message.special_summons],
    [SelectIdleCMDAction.SELECT_MONSTER_SET, '盖放', message.monster_sets],
    [SelectIdleCMDAction.SELECT_SPELL_SET, '盖放', message.spell_sets],
    [SelectIdleCMDAction.SELECT_ACTIVATE, '发动', message.activates],
    [SelectIdleCMDAction.SELECT_POS_CHANGE, '变更表示', message.pos_changes],
  ]
  const list: DuelCommand[] = []
  for (const [action, label, items] of groups) {
    items.forEach((card, index) => {
      list.push({ family: 'idle', action, index, label, code: card.code, controller: card.controller, location: card.location, sequence: card.sequence })
    })
  }
  // 稳定排序：同组内保持内核给出的顺序
  return list
    .map((command, index) => ({ command, index }))
    .sort((a, b) => displayOrder(a.command, lookupCard) - displayOrder(b.command, lookupCard) || a.index - b.index)
    .map((entry) => entry.command)
}

/**
 * 额外卡组的特殊召唤（连接 / 超量 / 融合 / 同调 …）。
 *
 * 能出额外的时候内核会把整组可用怪兽都列出来，十几条一键摆在「当前操作」里
 * 会把操作条撑得很高，全屏下棋盘只能跟着缩小。这类操作不放进列表，
 * 改由点额外卡堆里的卡触发（格子提示仍然保留，点卡照样能召唤）。
 */
export function isExtraSummon(command: DuelCommand): boolean {
  return command.action === SelectIdleCMDAction.SELECT_SPECIAL_SUMMON && command.location === OcgLocation.EXTRA
}

export function battleCommands(message: OcgMessageSelectBattleCMD): DuelCommand[] {
  const list: DuelCommand[] = []
  message.chains.forEach((card, index) => {
    list.push({ family: 'battle', action: SelectBattleCMDAction.SELECT_CHAIN, index, label: '发动', code: card.code, controller: card.controller, location: card.location, sequence: card.sequence })
  })
  message.attacks.forEach((card, index) => {
    list.push({ family: 'battle', action: SelectBattleCMDAction.SELECT_BATTLE, index, label: '攻击', code: card.code, controller: card.controller, location: card.location, sequence: card.sequence })
  })
  return list
}

export interface DuelCandidate {
  /** 在 selects 里的下标，也是提交给内核的值（pick 模式除外） */
  index: number
  /** unselect 时：已选中的卡用 index，取消选中用 select_cards.length + 偏移 */
  pick: number
  mode: 'toggle' | 'pick'
  code: number
  controller: number
  location: number
  sequence: number
  /** SELECT_SUM 的数值 */
  amount?: number
}

export function selectCandidates(question: DuelQuestion): DuelCandidate[] {
  if (question.kind === 'card' || question.kind === 'tribute') {
    return question.message.selects.map((card, index) => ({
      index,
      pick: index,
      mode: 'toggle' as const,
      code: card.code,
      controller: card.controller,
      location: card.location,
      sequence: card.sequence,
    }))
  }
  if (question.kind === 'sum') {
    return question.message.selects.map((card, index) => ({
      index,
      pick: index,
      mode: 'toggle' as const,
      code: card.code,
      controller: card.controller,
      location: card.location,
      sequence: card.sequence,
      amount: card.amount,
    }))
  }
  if (question.kind === 'unselect') {
    const selects = question.message.select_cards.map((card, index) => ({
      index,
      pick: index,
      mode: 'pick' as const,
      code: card.code,
      controller: card.controller,
      location: card.location,
      sequence: card.sequence,
    }))
    const unselects = question.message.unselect_cards.map((card, offset) => ({
      index: question.message.select_cards.length + offset,
      pick: question.message.select_cards.length + offset,
      mode: 'pick' as const,
      code: card.code,
      controller: card.controller,
      location: card.location,
      sequence: card.sequence,
    }))
    return [...selects, ...unselects]
  }
  return []
}

export interface PlaceOption {
  player: number
  location: OcgLocation
  sequence: number
}

export function placeOptions(question: DuelQuestion): PlaceOption[] {
  if (question.kind !== 'place') return []
  return placesFromMask(question.message.field_mask)
}

export function selectRange(question: DuelQuestion): { min: number; max: number; cancel: boolean } {
  switch (question.kind) {
    case 'card':
    case 'tribute':
      return { min: question.message.min, max: question.message.max, cancel: question.message.can_cancel }
    case 'sum':
      return { min: question.message.min, max: question.message.max, cancel: false }
    case 'unselect':
      return { min: question.message.min, max: question.message.max, cancel: question.message.can_cancel }
    default:
      return { min: 1, max: 1, cancel: false }
  }
}

/** 场上能点击的格子状态 */
export interface SlotHint {
  commands: DuelCommand[]
  candidates: DuelCandidate[]
  place?: number
  /** 可发动的连锁下标（点卡直接连锁） */
  chain?: number
}

export function buildSlotHints(question: DuelQuestion | null): Map<string, SlotHint> {
  const map = new Map<string, SlotHint>()
  if (!question) return map

  const ensure = (key: string): SlotHint => {
    const hit = map.get(key)
    if (hit) return hit
    const fresh: SlotHint = { commands: [], candidates: [] }
    map.set(key, fresh)
    return fresh
  }

  switch (question.kind) {
    case 'idle':
      for (const command of idleCommands(question.message)) {
        ensure(slotKey(command.controller, command.location, command.sequence)).commands.push(command)
      }
      break
    case 'battle':
      for (const command of battleCommands(question.message)) {
        ensure(slotKey(command.controller, command.location, command.sequence)).commands.push(command)
      }
      break
    case 'card':
    case 'tribute':
    case 'sum':
    case 'unselect':
      for (const candidate of selectCandidates(question)) {
        ensure(slotKey(candidate.controller, candidate.location, candidate.sequence)).candidates.push(candidate)
      }
      break
    case 'chain':
      question.message.selects.forEach((card, index) => {
        ensure(slotKey(card.controller, card.location, card.sequence)).chain = index
      })
      break
    case 'place':
      placeOptions(question).forEach((place, index) => {
        ensure(slotKey(place.player, place.location, place.sequence)).place = index
      })
      break
    default:
      break
  }
  return map
}
