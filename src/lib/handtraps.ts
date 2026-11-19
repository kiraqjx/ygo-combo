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
    counting: 'all',
  },
  {
    id: 'fuwalos',
    name: '山雀',
    alias: '茸茸长尾山雀',
    cardId: 42141493,
    category: 'draw',
    tone: '#71b7ff',
    counting: 'deckExtra',
  },
  {
    id: 'purulia',
    name: '水母',
    alias: '抖抖海月水母',
    cardId: 84192580,
    category: 'draw',
    tone: '#7ea8ff',
    counting: 'hand',
  },
  {
    id: 'meowls',
    name: '猫',
    alias: '喵喵豹猫',
    cardId: 87126721,
    category: 'draw',
    tone: '#a371f7',
    counting: 'gyBanish',
  },
  {
    id: 'droll',
    name: '锁鸟',
    alias: '小丑与锁鸟',
    cardId: 94145021,
    category: 'lock',
    tone: '#ff9b57',
  },
  {
    id: 'ash',
    name: '灰流丽',
    alias: '灰',
    cardId: 14558127,
    category: 'negate',
    tone: '#ff6a69',
  },
  {
    id: 'veiler',
    name: '效果遮蒙者',
    alias: '遮蒙',
    cardId: 97268402,
    category: 'negate',
    tone: '#f0b72f',
  },
  {
    id: 'imperm',
    name: '无限泡影',
    alias: '泡影',
    cardId: 10045474,
    category: 'negate',
    tone: '#ff7bd5',
  },
  {
    id: 'nibiru',
    name: '原始生命态 尼比鲁',
    alias: '陨石',
    cardId: 27204311,
    category: 'nuke',
    tone: '#ff8f6b',
  },
  {
    id: 'shifter',
    name: '次元吸引者',
    alias: '次元',
    cardId: 91800273,
    category: 'zone',
    tone: '#9ea7b3',
  },
  {
    id: 'belle',
    name: '屋敷童',
    alias: '屋敷',
    cardId: 73642296,
    category: 'negate',
    tone: '#56d364',
  },
  {
    id: 'ogre',
    name: '幽鬼兔',
    alias: '兔',
    cardId: 59438930,
    category: 'negate',
    tone: '#39c5cf',
  },
]

export const CATEGORY_LABEL: Record<TrapCategory, string> = {
  draw: '抽牌型',
  lock: '封锁型',
  negate: '无效型',
  nuke: '清场型',
  zone: '区域封锁',
}
