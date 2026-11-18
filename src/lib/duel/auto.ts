import {
  OcgAttribute,
  OcgLocation,
  OcgMessageType,
  OcgResponseType,
  ocgPositionParse,
  SelectBattleCMDAction,
  SelectIdleCMDAction,
  type OcgPosition,
  type OcgResponse,
} from 'ocgcore-wasm'
import type { DuelQuestion } from './types'

export interface AutoRespondOptions {
  /**
   * 宽容模式：上一次的"取消"被内核拒绝（MSG_RETRY）时，
   * 改成能推进流程的最小选择，避免同一问题反复重试卡死。
   */
  lenient?: boolean
}

/**
 * 沙包（对手）的自动应答。
 *
 * 第一版刻意做成"完全被动"：不召唤、不发动、不连锁、不加手坑，
 * 每回合直接结束回合，让玩家可以安心打完自己的 combo。
 */
export function autoRespond(question: DuelQuestion, options: AutoRespondOptions = {}): OcgResponse {
  const message = question.message
  const lenient = options.lenient === true

  switch (question.kind) {
    case 'idle': {
      const idle = question.message
      // 能结束回合就结束；某些时点（比如必须处理的效果）不允许，就退到战阶再退主阶
      if (idle.to_ep) return { type: OcgResponseType.SELECT_IDLECMD, action: SelectIdleCMDAction.TO_EP, index: null }
      if (idle.to_bp) return { type: OcgResponseType.SELECT_IDLECMD, action: SelectIdleCMDAction.TO_BP, index: null }
      return { type: OcgResponseType.SELECT_IDLECMD, action: SelectIdleCMDAction.TO_EP, index: null }
    }
    case 'battle':
      if (question.message.to_ep) {
        return { type: OcgResponseType.SELECT_BATTLECMD, action: SelectBattleCMDAction.TO_EP, index: null }
      }
      return { type: OcgResponseType.SELECT_BATTLECMD, action: SelectBattleCMDAction.TO_M2, index: null }
    case 'chain': {
      const chain = question.message
      // 必须连锁时不能取消，否则内核会返回 RETRY
      if (chain.forced && chain.selects.length) return { type: OcgResponseType.SELECT_CHAIN, index: 0 }
      return { type: OcgResponseType.SELECT_CHAIN, index: null }
    }
    case 'yesno':
      return question.message.type === OcgMessageType.SELECT_EFFECTYN
        ? { type: OcgResponseType.SELECT_EFFECTYN, yes: false }
        : { type: OcgResponseType.SELECT_YESNO, yes: false }
    case 'option':
      return { type: OcgResponseType.SELECT_OPTION, index: 0 }
    case 'card': {
      const { can_cancel, min, selects } = question.message
      if (can_cancel && !lenient) return { type: OcgResponseType.SELECT_CARD, indicies: null }
      return { type: OcgResponseType.SELECT_CARD, indicies: takeFirst(selects.length, min) }
    }
    case 'tribute': {
      const { can_cancel, min, selects } = question.message
      if (can_cancel && !lenient) return { type: OcgResponseType.SELECT_TRIBUTE, indicies: null }
      return { type: OcgResponseType.SELECT_TRIBUTE, indicies: takeFirst(selects.length, min) }
    }
    case 'sum': {
      const { min, selects } = question.message
      return { type: OcgResponseType.SELECT_SUM, indicies: takeFirst(selects.length, min) }
    }
    case 'unselect': {
      const unselect = question.message
      if (unselect.can_cancel && !lenient) return { type: OcgResponseType.SELECT_UNSELECT_CARD, index: null }
      return { type: OcgResponseType.SELECT_UNSELECT_CARD, index: 0 }
    }
    case 'place': {
      const { count, field_mask } = question.message
      const places = placesFromMask(field_mask).slice(0, Math.max(1, count))
      const isDisfield = question.message.type === OcgMessageType.SELECT_DISFIELD
      return { type: isDisfield ? OcgResponseType.SELECT_DISFIELD : OcgResponseType.SELECT_PLACE, places }
    }
    case 'position': {
      const positions = ocgPositionParse(question.message.positions)
      const first = (positions[0] ?? 1) as OcgPosition
      return { type: OcgResponseType.SELECT_POSITION, position: first }
    }
    case 'sort':
      return { type: OcgResponseType.SORT_CARD, order: question.message.cards.map((_, index) => index) }
    default:
      break
  }

  switch (message.type) {
    case OcgMessageType.ANNOUNCE_RACE:
      return { type: OcgResponseType.ANNOUNCE_RACE, races: [lowestBit(message.available) as never] }
    case OcgMessageType.ANNOUNCE_ATTRIB:
      return { type: OcgResponseType.ANNOUNCE_ATTRIB, attributes: [lowestNumberBit(message.available) as OcgAttribute] }
    case OcgMessageType.ANNOUNCE_NUMBER:
      return { type: OcgResponseType.ANNOUNCE_NUMBER, value: Number(message.options[0] ?? 1n) }
    case OcgMessageType.ANNOUNCE_CARD:
      return { type: OcgResponseType.ANNOUNCE_CARD, card: 0 }
    case OcgMessageType.ROCK_PAPER_SCISSORS:
      return { type: OcgResponseType.ROCK_PAPER_SCISSORS, value: 1 }
    default:
      // 兜底：给一个空的选择，避免内核卡死
      return { type: OcgResponseType.SELECT_YESNO, yes: false }
  }
}

function takeFirst(available: number, min: number): number[] {
  const count = Math.max(1, Math.min(available, min || 1))
  return Array.from({ length: count }, (_, index) => index)
}

function lowestBit(value: bigint): bigint {
  if (value <= 0n) return 1n
  for (let shift = 0n; shift < 64n; shift += 1n) {
    const bit = 1n << shift
    if (value & bit) return bit
  }
  return 1n
}

function lowestNumberBit(value: number): number {
  if (value <= 0) return 1
  for (let shift = 0; shift < 32; shift += 1) {
    const bit = 1 << shift
    if (value & bit) return bit
  }
  return 1
}

export interface FieldPlace {
  player: number
  location: OcgLocation
  sequence: number
}

/**
 * field_mask 的每个玩家 16 位对应的格子表（位序由实测反推）：
 *
 *   0-6   怪兽区 0-6（5、6 是额外怪兽区）
 *   7     场地区
 *   8-12  魔陷区 0-4
 *   13-14 灵摆区 0-1
 *   15    未使用
 *
 * 注意语义是 **1 = 不可用**（已被占用 / 该操作不能放这里），0 才是可选。
 * 例：盖放魔陷时我方掩码为 0xe0ff —— 低 8 位全 1（怪兽区与场地区不可用），
 * 高 8 位只有 13-15 为 1，于是魔陷区 0-4 全部可选；每盖一张，对应位变 1。
 */
const PLACE_SLOTS: { location: OcgLocation; sequence: number }[] = [
  { location: OcgLocation.MZONE, sequence: 0 },
  { location: OcgLocation.MZONE, sequence: 1 },
  { location: OcgLocation.MZONE, sequence: 2 },
  { location: OcgLocation.MZONE, sequence: 3 },
  { location: OcgLocation.MZONE, sequence: 4 },
  { location: OcgLocation.MZONE, sequence: 5 },
  { location: OcgLocation.MZONE, sequence: 6 },
  { location: OcgLocation.FZONE, sequence: 0 },
  { location: OcgLocation.SZONE, sequence: 0 },
  { location: OcgLocation.SZONE, sequence: 1 },
  { location: OcgLocation.SZONE, sequence: 2 },
  { location: OcgLocation.SZONE, sequence: 3 },
  { location: OcgLocation.SZONE, sequence: 4 },
  { location: OcgLocation.PZONE, sequence: 0 },
  { location: OcgLocation.PZONE, sequence: 1 },
]

/** 解析 select_place / select_disfield 的 field_mask */
export function placesFromMask(mask: number): FieldPlace[] {
  const places: FieldPlace[] = []
  for (let player = 0; player < 2; player += 1) {
    const group = Math.floor(mask / 2 ** (16 * player)) % 0x10000
    PLACE_SLOTS.forEach((slot, bit) => {
      if (group & (1 << bit)) return
      places.push({ player, location: slot.location, sequence: slot.sequence })
    })
  }
  return places
}
