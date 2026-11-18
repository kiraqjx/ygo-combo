import { OcgLocation, OcgPosition } from 'ocgcore-wasm'

export const PHASE_LABELS: Record<number, string> = {
  1: '抽卡阶段',
  2: '准备阶段',
  4: '主要阶段 1',
  8: '战斗阶段',
  16: '主要阶段 2',
  32: '结束阶段',
}

/** 区域 + 格位 → 中文短标签（手卡 / 怪兽区 2 / 墓地……） */
export function zoneLabel(location: number, sequence = 0): string {
  if (location & OcgLocation.OVERLAY) return '超量素材'
  if (location & OcgLocation.MZONE) return sequence >= 5 ? `额外怪兽区 ${sequence - 4}` : `怪兽区 ${sequence + 1}`
  if (location & OcgLocation.SZONE) return `魔陷区 ${sequence + 1}`
  if (location & OcgLocation.FZONE) return '场地区'
  if (location & OcgLocation.PZONE) return `灵摆区 ${sequence + 1}`
  if (location & OcgLocation.HAND) return '手卡'
  if (location & OcgLocation.DECK) return '卡组'
  if (location & OcgLocation.EXTRA) return '额外卡组'
  if (location & OcgLocation.GRAVE) return '墓地'
  if (location & OcgLocation.REMOVED) return '除外'
  return '未知区域'
}

/** 表示形式掩码 → 中文 */
export function positionLabel(position: number): string {
  if (position & OcgPosition.FACEUP_ATTACK) return '表侧攻击'
  if (position & OcgPosition.FACEUP_DEFENSE) return '表侧守备'
  if (position & OcgPosition.FACEDOWN_DEFENSE) return '里侧守备'
  if (position & OcgPosition.FACEDOWN_ATTACK) return '里侧攻击'
  return '未知'
}

export function isAttackPosition(position: number): boolean {
  return Boolean(position & OcgPosition.ATTACK)
}

/**
 * 里侧（盖放）。场上按规则不能看见卡面，界面要显示卡背，
 * 否则自己盖放的魔陷/怪兽会直接亮出卡图。
 */
export function isFaceDown(position: number): boolean {
  return Boolean(position & OcgPosition.FACEDOWN)
}
