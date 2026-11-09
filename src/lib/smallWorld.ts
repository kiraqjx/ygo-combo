import type { CardData } from '@/types'

/** 小世界现象比较的五项：种族、属性、等级、攻击力、守备力 */
export type PropertyKind = 'race' | 'attribute' | 'level' | 'atk' | 'def'

export const PROPERTY_LABELS: Record<PropertyKind, string> = {
  race: '种族',
  attribute: '属性',
  level: '等级',
  atk: '攻击力',
  def: '守备力',
}

export interface PropertyMatch {
  kind: PropertyKind
  value: string
}

/** 小世界现象只会涉及怪兽 */
export function isSmallWorldMonster(card: CardData | null | undefined): card is CardData {
  return Boolean(card && card.frame === 'monster')
}

/** 两只怪兽在种族 / 属性 / 等级 / 攻击力 / 守备力中重合的全部项 */
export function matchProperties(a: CardData, b: CardData): PropertyMatch[] {
  const out: PropertyMatch[] = []
  if (a.race && b.race && a.race === b.race) {
    out.push({ kind: 'race', value: b.race })
  }
  if (a.attribute && b.attribute && a.attribute === b.attribute) {
    out.push({ kind: 'attribute', value: b.attribute })
  }
  if (a.level != null && b.level != null && a.level === b.level) {
    out.push({ kind: 'level', value: `${b.level}` })
  }
  if (a.atk != null && b.atk != null && a.atk === b.atk) {
    out.push({ kind: 'atk', value: `${b.atk}` })
  }
  if (a.def != null && b.def != null && a.def === b.def) {
    out.push({ kind: 'def', value: `${b.def}` })
  }
  return out
}

/**
 * 小世界现象的判定：五项中「只有 1 项」相同才算成立。
 * 返回那唯一相同的项，不成立返回 null。
 */
export function exactOneMatch(a: CardData, b: CardData): PropertyMatch | null {
  const matches = matchProperties(a, b)
  return matches.length === 1 ? matches[0] : null
}

/** 单个重合项，如「属性「光」」 */
export function formatMatch(match: PropertyMatch): string {
  return `${PROPERTY_LABELS[match.kind]}「${match.value}」`
}
