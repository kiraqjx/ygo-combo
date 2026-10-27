export type TrapCategory = 'draw' | 'lock' | 'negate' | 'nuke' | 'zone'
export type Counting = 'all' | 'deckExtra' | 'hand' | 'gyBanish'

export interface HandtrapDef {
  id: string
  name: string
  alias?: string
  /** 卡库 id（自定义手坑可以不填） */
  cardId?: number
  category: TrapCategory
  tone: string
  summary: string
  rule: string
  counting?: Counting
}

/** 内置手坑，作为用户配置的初始值 */
export const BUILTIN_HANDTRAPS: HandtrapDef[] = [
  {
    id: 'maxx',
    name: '增殖的G',
    alias: 'G',
    cardId: 23434538,
    category: 'draw',
    tone: '#26cd4d',
    summary: '每次对方把怪兽特殊召唤，自己抽 1 张。',
    rule: '对方每次特殊召唤（不论从何处）抽 1 张，通常召唤不计数。',
    counting: 'all',
  },
  {
    id: 'fuwalos',
    name: '山雀',
    alias: '茸茸长尾山雀',
    cardId: 42141493,
    category: 'draw',
    tone: '#71b7ff',
    summary: '每次对方从卡组·额外卡组特召怪兽，自己抽 1 张。',
    rule: '只统计「从卡组 / 额外卡组」的特殊召唤；从手卡、墓地、除外区的特召不计数。',
    counting: 'deckExtra',
  },
  {
    id: 'purulia',
    name: '水母',
    alias: '抖抖海月水母',
    cardId: 84192580,
    category: 'draw',
    tone: '#7ea8ff',
    summary: '每次对方从手卡把怪兽召唤·特召，自己抽 1 张。',
    rule: '只统计「从手卡」的召唤与特殊召唤；场上、墓地、卡组来源不计数。',
    counting: 'hand',
  },
  {
    id: 'meowls',
    name: '猫',
    alias: '喵喵豹猫',
    cardId: 87126721,
    category: 'draw',
    tone: '#a371f7',
    summary: '每次对方从墓地·除外状态特召怪兽，自己抽 1 张。',
    rule: '只统计「从墓地 / 除外区」的特殊召唤。',
    counting: 'gyBanish',
  },
  {
    id: 'droll',
    name: '锁鸟',
    alias: '小丑与锁鸟',
    cardId: 94145021,
    category: 'lock',
    tone: '#ff9b57',
    summary: '对方从卡组加入手卡后，本回合双方不能从卡组把卡加入手卡。',
    rule: '检索（卡组→手卡）被全面封锁，依赖检索的后续步骤会连锁失效。',
  },
  {
    id: 'ash',
    name: '灰流丽',
    alias: '灰',
    cardId: 14558127,
    category: 'negate',
    tone: '#ff6a69',
    summary: '无效「卡组加手 / 卡组特召 / 卡组送墓」的效果。',
    rule: '可无效一次包含「从卡组加入手卡」「从卡组特殊召唤」「从卡组送去墓地」的效果。',
  },
  {
    id: 'veiler',
    name: '效果遮蒙者',
    alias: '遮蒙',
    cardId: 97268402,
    category: 'negate',
    tone: '#f0b72f',
    summary: '无效场上 1 只效果怪兽的效果。',
    rule: '只能指定场上表侧表示的效果怪兽，怪兽本身留在场上。',
  },
  {
    id: 'imperm',
    name: '无限泡影',
    alias: '泡影',
    cardId: 10045474,
    category: 'negate',
    tone: '#ff7bd5',
    summary: '无效场上 1 只表侧怪兽的效果（自己场上无卡时可手发）。',
    rule: '等同于遮蒙，但陷阱卡不能被「灰流丽」无效。',
  },
  {
    id: 'nibiru',
    name: '原始生命态 尼比鲁',
    alias: '陨石',
    cardId: 27204311,
    category: 'nuke',
    tone: '#ff8f6b',
    summary: '对方第 5 次以上召唤·特召后，解放双方场上怪兽。',
    rule: '累计召唤·特殊召唤 5 只以上后，场上表侧怪兽被全部解放，需要能空场重建。',
  },
  {
    id: 'shifter',
    name: '次元吸引者',
    alias: '次元',
    cardId: 91800273,
    category: 'zone',
    tone: '#9ea7b3',
    summary: '送去墓地的卡改为除外，墓地资源本回合不可用。',
    rule: '依赖墓地取牌、墓地特召的步骤会失效。',
  },
  {
    id: 'belle',
    name: '屋敷童',
    alias: '屋敷',
    cardId: 73642296,
    category: 'negate',
    tone: '#56d364',
    summary: '无效「墓地加手 / 墓地特召 / 墓地除外」的效果。',
    rule: '只针对与墓地互动的效果，可无效一次。',
  },
  {
    id: 'ogre',
    name: '幽鬼兔',
    alias: '兔',
    cardId: 59438930,
    category: 'negate',
    tone: '#39c5cf',
    summary: '破坏发动效果的场上的卡。',
    rule: '场上的怪兽 / 已表侧表示的魔陷发动效果时，破坏那张卡。',
  },
]

/**
 * 当前生效的手坑列表。
 * 用「原地更新」而不是重新赋值，这样已经有静态 import 的地方（推理内核、时间线）
 * 也能读到用户在配置面板里改过的内容。
 */
export const HANDTRAPS: HandtrapDef[] = [...BUILTIN_HANDTRAPS]
export const HANDTRAP_MAP: Record<string, HandtrapDef> = {}

export function syncHandtrapRegistry(defs: HandtrapDef[]) {
  HANDTRAPS.length = 0
  HANDTRAPS.push(...defs)
  for (const key of Object.keys(HANDTRAP_MAP)) delete HANDTRAP_MAP[key]
  for (const def of defs) HANDTRAP_MAP[def.id] = def
}

syncHandtrapRegistry(BUILTIN_HANDTRAPS)

export const CATEGORY_LABEL: Record<TrapCategory, string> = {
  draw: '抽牌型',
  lock: '封锁型',
  negate: '无效型',
  nuke: '清场型',
  zone: '区域封锁',
}
