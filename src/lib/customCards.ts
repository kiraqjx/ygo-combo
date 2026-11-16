/**
 * 自定义卡（先行服 / 卡库未收录的卡）。
 *
 * ygocdb 的卡库只包含正式服已经入库的卡，先行服的新卡搜不到。
 * 这里允许用户手动录入：只写名字、种类、可选卡号与效果文本，
 * 存进 localStorage，并在 store 里和下载的卡库合并，因此检索、卡组、
 * 启动率、combo 工坊都能正常使用。
 *
 * 卡号策略：
 *   - 用户知道先行服卡号就直接填（卡图大概率能在 pics 里找到）；
 *   - 不知道就自动分配 900000001 起的本地卡号，避开官方 8 位卡号。
 */
import type { CardData, FrameType } from '@/types'

export type CustomExtraKind = '' | '融合' | '同调' | '超量' | '连接'

export interface CustomCardDraft {
  name: string
  /** 原始输入，允许为空 */
  id: string
  frame: FrameType
  /** 只有怪兽有意义：选了就按额外卡组怪兽处理 */
  extra: CustomExtraKind
  desc: string
}

const STORAGE_KEY = 'ygo-combo:custom-cards-v1'
/** 自动分配卡号的起点，落在官方卡号段之外 */
const ID_BASE = 900_000_001

export function blankCustomDraft(name = ''): CustomCardDraft {
  return { name, id: '', frame: 'monster', extra: '', desc: '' }
}

function isValidCard(value: unknown): value is CardData {
  if (!value || typeof value !== 'object') return false
  const card = value as Partial<CardData>
  return Number(card.id) > 0 && typeof card.name === 'string' && card.name.length > 0
}

export function loadCustomCards(): CardData[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const list = JSON.parse(raw) as unknown
    if (!Array.isArray(list)) return []
    return list.filter(isValidCard).map((card) => ({ ...card, custom: true }))
  } catch {
    return []
  }
}

export function persistCustomCards(list: CardData[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
  } catch {
    /* 隐私模式 / 超出配额：只影响持久化，不影响当前会话 */
  }
}

/** 解析用户填的卡号；空或非法返回 null */
export function parseCardId(text: string): number | null {
  const value = Number(text.trim())
  if (!Number.isInteger(value) || value <= 0) return null
  return value
}

export function nextCustomId(used: Set<number>): number {
  let id = ID_BASE
  while (used.has(id)) id += 1
  return id
}

/** 把草稿变成一张可用的 CardData */
export function buildCustomCard(draft: CustomCardDraft, id: number): CardData {
  const name = draft.name.trim()
  const desc = draft.desc.replace(/\r/g, '').trim()
  const kinds: string[] = []
  if (draft.frame === 'monster') {
    kinds.push('效果')
    if (draft.extra) kinds.push(draft.extra)
  } else {
    kinds.push('通常')
  }
  const frameLabel = draft.frame === 'monster' ? '怪兽' : draft.frame === 'spell' ? '魔法' : '陷阱'
  const kindLabel =
    draft.frame === 'monster'
      ? draft.extra
        ? `${draft.extra}怪兽`
        : '怪兽'
      : draft.frame === 'spell'
        ? '通常魔法'
        : '通常陷阱'

  return {
    id,
    name,
    typeLine: `[${frameLabel}|${kinds.join('|')}] ${kindLabel} · 自定义卡`,
    desc,
    pendDesc: '',
    kinds,
    rankLabel: '',
    frame: draft.frame,
    blob: `${name} ${desc}`.toLowerCase().replace(/\s+/g, ' '),
    custom: true,
  }
}
