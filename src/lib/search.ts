import type { CardData } from '@/types'

export interface CardFilters {
  keyword: string
  searchIn: 'all' | 'name' | 'text'
  frame: 'all' | 'monster' | 'spell' | 'trap'
  kinds: string[]
  races: string[]
  attributes: string[]
  rankLabel: 'all' | '★' | 'RANK' | 'LINK'
  levelMin: number | null
  levelMax: number | null
  atkMin: number | null
  atkMax: number | null
  defMin: number | null
  defMax: number | null
  scaleMin: number | null
  scaleMax: number | null
  sort: 'name' | 'atk' | 'def' | 'level' | 'id'
  desc: boolean
}

export function createFilters(): CardFilters {
  return {
    keyword: '',
    searchIn: 'all',
    frame: 'all',
    kinds: [],
    races: [],
    attributes: [],
    rankLabel: 'all',
    levelMin: null,
    levelMax: null,
    atkMin: null,
    atkMax: null,
    defMin: null,
    defMax: null,
    scaleMin: null,
    scaleMax: null,
    sort: 'name',
    desc: false,
  }
}

export const MONSTER_KINDS = ['通常', '效果', '仪式', '融合', '同调', '超量', '连接', '灵摆', '调整', '反转', '灵魂', '特殊召唤']
export const SPELL_KINDS = ['通常', '速攻', '永续', '装备', '场地', '仪式']
export const TRAP_KINDS = ['通常', '永续', '反击']

function inRange(value: number | null | undefined, min: number | null, max: number | null): boolean {
  if (min === null && max === null) return true
  if (value === null || value === undefined) return false
  if (min !== null && value < min) return false
  if (max !== null && value > max) return false
  return true
}

export interface SearchResult {
  items: CardData[]
  total: number
}

export function searchCards(cards: CardData[], f: CardFilters, limit = 60, offset = 0): SearchResult {
  const tokens = f.keyword.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const nameOnly = f.searchIn === 'name'
  const textOnly = f.searchIn === 'text'

  const out: CardData[] = []
  for (const c of cards) {
    if (f.frame !== 'all' && c.frame !== f.frame) continue
    if (f.rankLabel !== 'all' && c.rankLabel !== f.rankLabel) continue
    if (f.kinds.length) {
      const pool = c.frame === 'monster' ? MONSTER_KINDS : c.frame === 'spell' ? SPELL_KINDS : TRAP_KINDS
      const selected = f.kinds.filter((k) => pool.includes(k))
      if (selected.length && !selected.every((k) => c.kinds.includes(k))) continue
    }
    if (f.races.length && (!c.race || !f.races.includes(c.race))) continue
    if (f.attributes.length && (!c.attribute || !f.attributes.includes(c.attribute))) continue
    if (!inRange(c.level ?? null, f.levelMin, f.levelMax)) continue
    if (!inRange(c.atk, f.atkMin, f.atkMax)) continue
    if (!inRange(c.def, f.defMin, f.defMax)) continue
    if (f.scaleMin !== null || f.scaleMax !== null) {
      if (!inRange(c.scale ?? null, f.scaleMin, f.scaleMax)) continue
    }
    if (tokens.length) {
      const lane = nameOnly
        ? `${c.name} ${c.enName || ''} ${c.jpName || ''}`.toLowerCase()
        : textOnly
          ? c.desc.toLowerCase()
          : c.blob
      if (!tokens.every((t) => lane.includes(t))) continue
    }
    out.push(c)
  }

  const dir = f.desc ? -1 : 1
  out.sort((a, b) => {
    let r = 0
    if (f.sort === 'name') r = a.name.localeCompare(b.name, 'zh-Hans-CN')
    else if (f.sort === 'atk') r = (a.atk ?? -1) - (b.atk ?? -1)
    else if (f.sort === 'def') r = (a.def ?? -1) - (b.def ?? -1)
    else if (f.sort === 'level') r = (a.level ?? -1) - (b.level ?? -1)
    else r = a.id - b.id
    return r * dir
  })

  return { items: out.slice(offset, offset + limit), total: out.length }
}

export function collectFacets(cards: CardData[]): { races: string[]; attributes: string[] } {
  const races = new Set<string>()
  const attributes = new Set<string>()
  for (const c of cards) {
    if (c.race) races.add(c.race)
    if (c.attribute) attributes.add(c.attribute)
  }
  return {
    races: [...races].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')),
    attributes: [...attributes].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')),
  }
}

export function countActiveFilters(f: CardFilters): number {
  let n = 0
  if (f.keyword.trim()) n++
  if (f.frame !== 'all') n++
  if (f.rankLabel !== 'all') n++
  if (f.kinds.length) n++
  if (f.races.length) n++
  if (f.attributes.length) n++
  if (f.levelMin !== null || f.levelMax !== null) n++
  if (f.atkMin !== null || f.atkMax !== null) n++
  if (f.defMin !== null || f.defMax !== null) n++
  if (f.scaleMin !== null || f.scaleMax !== null) n++
  return n
}
