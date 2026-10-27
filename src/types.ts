export type FrameType = 'monster' | 'spell' | 'trap'

export interface CardData {
  id: number
  name: string
  scName?: string
  jpName?: string
  enName?: string
  typeLine: string
  desc: string
  pendDesc?: string
  kinds: string[]
  race?: string
  attribute?: string
  rankLabel: '' | '★' | 'RANK' | 'LINK'
  level?: number
  atk?: number | null
  def?: number | null
  scale?: number | null
  linkMarkers?: string[]
  frame: FrameType
  /** 小写检索串：中/日/英卡名 + 效果文本 */
  blob: string
  ot?: number
}

/* ------------------------------------------------------------------ */
/* 区域                                                                 */
/* ------------------------------------------------------------------ */

export type ZoneId = 'hand' | 'deck' | 'extra' | 'gy' | 'banish' | 'field' | 'st'

export const ZONE_LABELS: Record<ZoneId, string> = {
  hand: '手卡',
  deck: '卡组',
  extra: '额外卡组',
  gy: '墓地',
  banish: '除外',
  field: '场上',
  st: '魔陷区',
}

/** 展示顺序：从最"可见"到最"隐藏" */
export const ZONE_ORDER: ZoneId[] = ['hand', 'field', 'st', 'gy', 'banish', 'extra', 'deck']

/** 会被"某张卡从哪来"校验的区域 */
export const TRACKED_ZONES: ZoneId[] = ['hand', 'field', 'st', 'gy', 'banish']

/** 未知卡片在账本里的占位名 */
export const UNKNOWN_CARD = '未知卡片'

/** 怪兽区 / 魔陷区的格位数（1-5 号位） */
export const SLOT_COUNT = 5

/** 目前只记录我方操作 */

/* ------------------------------------------------------------------ */
/* 操作                                                                 */
/* ------------------------------------------------------------------ */

/** 牌手操作（召唤 / 盖放 / 发动卡片）与卡片操作（卡片效果 / cost） */
export const OPERATION_DEFS = [
  { id: 'normalSummon', label: '通常召唤', short: '通召', tone: 'summon', kind: 'player' },
  { id: 'tributeSummon', label: '上级召唤', short: '上级', tone: 'summon', kind: 'player' },
  { id: 'specialSummon', label: '特殊召唤', short: '特召', tone: 'summon', kind: 'player' },
  { id: 'set', label: '盖放卡片', short: '盖放', tone: 'set', kind: 'player' },
  { id: 'activate', label: '发动卡片', short: '发动', tone: 'effect', kind: 'player' },
  { id: 'activateEffect', label: '发动卡片效果', short: '效果', tone: 'effect', kind: 'card' },
  { id: 'cost', label: '支付 cost', short: 'cost', tone: 'neutral', kind: 'card' },
  { id: 'draw', label: '抽卡', short: '抽卡', tone: 'draw', kind: 'player' },
  { id: 'other', label: '其他操作', short: '其他', tone: 'neutral', kind: 'player' },
] as const

export type OperationKind = (typeof OPERATION_DEFS)[number]['id']

/** cost：发动代价（必定成功）；effect：效果处理（可无效）；auto：规则处理（发动置放 / 结算后送墓） */
export type MovePhase = 'cost' | 'effect' | 'auto'

/**
 * 一次卡片移动 = 一条潜在链路。
 * - `phase: 'cost'` 的移动必定成功，不吃任何手坑；
 * - `phase: 'effect'` 的移动会被记录在 `handtraps` 里的手坑无效。
 */
export interface CardMove {
  id: string
  cardName: string
  /** 未知卡片（抽到但不知道具体是什么 / 不知道丢的是哪张） */
  unknown?: boolean
  count?: number
  from: ZoneId
  to: ZoneId
  phase: MovePhase
  /** 落到怪兽区 / 魔陷区时指定的格位（1-5），留空则自动顺排空位 */
  slot?: number
  /** 由规则自动生成（切换操作 / 区域 / 卡片时会重新计算，不会动用户手写的段） */
  auto?: boolean
  /** 这一段可被哪些手坑阻止（cost 段不使用） */
  handtraps?: string[]
  note?: string
}

/** 同一时点、2 速以上才能发动的连锁操作（我方） */
export interface ChainEntry {
  id: string
  /** C2、C3……（C1 为时序本身的操作） */
  link: number
  cardName: string
  /** 卡库 id（用于按卡种判断规则处理） */
  cardId?: number
  /** 这张卡从哪个区域发动（手卡 / 墓地 / 场上 / 魔陷区） */
  from?: ZoneId
  /** 该连锁是否以"无效前一个连锁"为目的 */
  negates?: boolean
  /** 发动处理：手卡 / 卡组 → 魔陷区（规则处理，必定发生） */
  setup: CardMove[]
  cost: CardMove[]
  effect: CardMove[]
  /** 结算后：魔陷区 → 墓地 / 额外，或留场（规则处理） */
  settle: CardMove[]
  note?: string
}

/** 手动声明的依赖：本时序用到的卡来自上游时序的哪一段移动 */
export interface ManualLink {
  id: string
  fromTimingId: string
  /** 上游那次移动的 id */
  fromMoveId: string
}

/**
 * 一个时序 = 一个时点。
 * 里面按 C1（牌手 / 卡片操作）→ C2 → C3… 的顺序记录连锁。
 */
export interface Timing {
  id: string
  /** 展示标题，留空则用操作 + 卡名 */
  label?: string
  /** 卡库 id（用于缩略图） */
  cardId?: number
  operation: OperationKind
  cardName: string
  /** 主卡所在的区域（手卡 / 墓地 / 场上 / 魔陷区） */
  from?: ZoneId
  /** 发动处理：手卡 → 魔陷区（规则处理，必定发生） */
  setup: CardMove[]
  cost: CardMove[]
  effect: CardMove[]
  /** 结算后：魔陷区 → 墓地 / 额外（规则处理，必定发生） */
  settle: CardMove[]
  chains: ChainEntry[]
  /** 手动指定的上游依赖（卡名对不上时用来补链） */
  manualLinks?: ManualLink[]
  /** 时序级别的响应（G、陨石这类不通过某个效果产出的手坑） */
  handtraps?: string[]
  note?: string
}

/* ------------------------------------------------------------------ */
/* 展开                                                                 */
/* ------------------------------------------------------------------ */

export interface OpeningCard {
  id: number
  name: string
}

export interface DeckEntry {
  id: number
  name: string
  count: number
}

export interface Combo {
  id: string
  name: string
  deckName: string
  handSize: number
  goal: string
  opening: OpeningCard[]
  deck: DeckEntry[]
  timings: Timing[]
  updatedAt: number
}

/* ------------------------------------------------------------------ */
/* 推演结果                                                             */
/* ------------------------------------------------------------------ */

export interface ZoneCard {
  name: string
  count: number
}

export interface ZoneSnapshot {
  hand: ZoneCard[]
  field: ZoneCard[]
  st: ZoneCard[]
  /** 怪兽区按格位摆放（下标 = 格位 - 1），决斗盘按格位渲染 */
  fieldSlots: (ZoneCard | null)[]
  /** 魔陷区按格位摆放（下标 = 格位 - 1） */
  stSlots: (ZoneCard | null)[]
  gy: ZoneCard[]
  banish: ZoneCard[]
  extra: ZoneCard[]
  deck: ZoneCard[]
  /** 截至该时序结束的累计召唤次数 */
  summons: number
}

export type TimingStatus = 'ok' | 'partial' | 'negated' | 'broken'

/** 上游把卡送给下游的方式 */
export type LinkKind = 'search' | 'send' | 'summon' | 'recover' | 'banish' | 'other'

export const LINK_KIND_LABELS: Record<LinkKind, string> = {
  search: '检索',
  send: '堆墓',
  summon: '特召',
  recover: '回收',
  banish: '除外',
  other: '衔接',
}

/** 两个时序之间的链：上游产出 → 下游使用 */
export interface TimingLink {
  id: string
  fromTimingId: string
  toTimingId: string
  fromIndex: number
  toIndex: number
  /** 产出这张卡的移动段 id（用于判断被哪一段手坑打断） */
  fromMoveId: string
  /** 下游使用这张卡的那一段（为空表示下游主卡本身） */
  toMoveId?: string
  cardName: string
  /** 这条链把卡送到了哪里 */
  to: ZoneId
  /** 上游是用什么方式把卡送过来的 */
  kind: LinkKind
  /** 该链可被哪些手坑打断（来自上游那一段效果） */
  handtraps: string[]
  broken: boolean
}

export interface TimingState {
  timingId: string
  index: number
  status: TimingStatus
  reasons: string[]
  /** 发动前的区域状态 */
  before: ZoneSnapshot
  /** 发动后（主卡效果与连锁都已处理完，尚未送墓 / 回额外）的区域状态 */
  activated: ZoneSnapshot
  /** 结算后的区域状态 */
  after: ZoneSnapshot
  summonsAfter: number
}

export interface Interrupt {
  timingId: string
  handtrapId: string
}

/* ------------------------------------------------------------------ */
/* 动态演示                                                             */
/* ------------------------------------------------------------------ */

/** 一个时序内部的阶段：发动 → cost → 连锁发动 → 连锁结算 → 效果 → 送墓 */
export type PlaybackPhase =
  | 'setup'
  | 'cost'
  | 'chainActivate'
  | 'chainResolve'
  | 'effect'
  | 'settle'

/** 一个阶段里同时发生的全部移动 + 处理后的场面，动态演示按帧播放 */
export interface PlaybackFrame {
  id: string
  timingId: string
  timingIndex: number
  phase: PlaybackPhase
  /** 阶段标题，如「支付 cost」「C2 结算」 */
  label: string
  /** 本帧同时处理的移动（同一阶段内不分先后） */
  moves: CardMove[]
  /** 本帧涉及的 C2 以上连锁，演示时在对应卡片上打角标 */
  chains?: { link: number; name: string }[]
  /** 本帧结束时的区域状态 */
  snapshot: ZoneSnapshot
}

export interface HandtrapReport {
  id: string
  /** 命中该手坑的时序下标 */
  sites: number[]
  effective: boolean
  /** 是否为"无效 / 封锁"类（会断链） */
  negates: boolean
  deadAt: number | null
  /** 应用该手坑后被波及的时序下标 */
  broken: number[]
  /** 抽牌型手坑的抽牌数 */
  draws: number
  headline: string
  verdict: 'safe' | 'warning' | 'danger' | 'lethal' | 'inactive'
}

export interface TimelineAnalysis {
  states: TimingState[]
  /** 逐动作帧：动态演示用，比 states 更细 */
  frames: PlaybackFrame[]
  links: TimingLink[]
  totalSummons: number
  /** timingId → 该时序可插入的手坑 */
  responses: Record<string, string[]>
  /** 被手坑封锁的效果段：moveId → handtrapId */
  canceledMoves: Record<string, string>
}
