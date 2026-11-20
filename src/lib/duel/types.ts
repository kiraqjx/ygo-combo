import type {
  OcgMessage,
  OcgMessageSelectBattleCMD,
  OcgMessageSelectCard,
  OcgMessageSelectChain,
  OcgMessageSelectDisfield,
  OcgMessageSelectEffectYN,
  OcgMessageSelectIdlecmd,
  OcgMessageSelectOption,
  OcgMessageSelectPlace,
  OcgMessageSelectPosition,
  OcgMessageSelectSum,
  OcgMessageSelectTribute,
  OcgMessageSelectUnselectCard,
  OcgMessageSelectYesno,
  OcgMessageSortCard,
  OcgResponse,
} from 'ocgcore-wasm'

/** 0 = 我方，1 = 对手（沙包） */
export type DuelPlayerId = 0 | 1

export interface DuelDeck {
  main: number[]
  extra: number[]
}

/** 场上一张卡的可视信息；隐藏信息不会带出真实卡号 */
export interface DuelCardView {
  code: number
  name: string
  /** 表示形式掩码（OcgPosition） */
  position: number
  /** 是否对当前玩家隐藏（对手盖卡 / 对手手卡） */
  hidden: boolean
  /** 超量素材数量 */
  materials: number
  /** 超量素材的卡号（点角标查看素材用） */
  overlayCodes?: number[]
  /** 连锁角标 */
  chainLink?: number
}

export interface DuelPlayerView {
  lp: number
  hand: DuelCardView[]
  handCount: number
  deckCount: number
  extraCount: number
  gy: DuelCardView[]
  banished: DuelCardView[]
  /** 怪兽区 0-6（5、6 是额外怪兽区） */
  monsters: (DuelCardView | null)[]
  /** 魔陷区 0-4 + 灵摆区 5-6（由 session 拼在一起） */
  spells: (DuelCardView | null)[]
  fieldZone: DuelCardView | null
  /** 额外卡组（下标即 sequence，用来对应内核给的格位） */
  extra: (DuelCardView | null)[]
}

export interface DuelStateView {
  turn: number
  phase: number
  turnPlayer: DuelPlayerId
  players: [DuelPlayerView, DuelPlayerView]
  chain: { code: number; name: string; link: number }[]
  finished: boolean
  winner: DuelPlayerId | null
}

/** 内核正在等玩家回答的问题 */
export type DuelQuestion =
  | { kind: 'idle'; player: DuelPlayerId; message: OcgMessageSelectIdlecmd }
  | { kind: 'battle'; player: DuelPlayerId; message: OcgMessageSelectBattleCMD }
  | { kind: 'chain'; player: DuelPlayerId; message: OcgMessageSelectChain }
  | { kind: 'yesno'; player: DuelPlayerId; message: OcgMessageSelectYesno | OcgMessageSelectEffectYN }
  | { kind: 'option'; player: DuelPlayerId; message: OcgMessageSelectOption }
  | { kind: 'card'; player: DuelPlayerId; message: OcgMessageSelectCard }
  | { kind: 'tribute'; player: DuelPlayerId; message: OcgMessageSelectTribute }
  | { kind: 'sum'; player: DuelPlayerId; message: OcgMessageSelectSum }
  | { kind: 'unselect'; player: DuelPlayerId; message: OcgMessageSelectUnselectCard }
  | { kind: 'place'; player: DuelPlayerId; message: OcgMessageSelectPlace | OcgMessageSelectDisfield }
  | { kind: 'position'; player: DuelPlayerId; message: OcgMessageSelectPosition }
  | { kind: 'sort'; player: DuelPlayerId; message: OcgMessageSortCard }
  | { kind: 'other'; player: DuelPlayerId; message: OcgMessage }

/** 用于触发界面动画的瞬时事件 */
export interface DuelEvent {
  id: number
  player: number
  code?: number
  amount?: number
  /** 攻击方所在格 */
  controller?: number
  location?: number
  sequence?: number
  /** 被攻击方 */
  targetCode?: number
  targetLocation?: number
  targetSequence?: number
}

export interface DuelLogEntry {
  id: number
  /** 0 我方 / 1 对手 / -1 系统 */
  player: number
  text: string
  /**
   * 这条日志对应的事件流下标（`signals` 里的位置）。
   * 手坑命中点要精确贴到展开图上就用它对齐 —— 同一张卡在场 / 在墓地各发动一次时，
   * 光看卡名分不出是哪一次。
   */
  signal?: number
  /** 内核报错的原文，用于同类报错合并计数 */
  kernel?: string
  repeat?: number
}

/** 录像回放时记录的「内核提问 → 原始响应」对，用来把操作翻译成人话 */
export interface DuelCapture {
  player: DuelPlayerId
  kind: DuelQuestion['kind']
  response: Uint8Array
  /** 该提问在界面上会展示的可选项文案（发动哪张卡 / 选项名 / 是-否） */
  labels: string[]
  /** 提问时的回合 / 阶段，录像分析按它归组 */
  turn: number
  phase: number
  /**
   * 回答这个提问时已经产生了多少条 signal（提问在信号流里的位置）。
   * 用来把「玩家选了哪张卡」和「紧接着哪张卡被移动」对上——
   * 只有真的选过，才算确定性的检索 / 堆墓关系。
   */
  signalIndex?: number
}

/**
 * 回放时记录的结构化事件。
 *
 * 日志只够人读（「发动卡片 · X」），判断「这一步能被哪个手坑打断」
 * 还需要区域与动作类型，所以关键消息单独留一份精简记录：
 * 召唤 / 特召 / 盖放 / 发动 / 结算 / 卡移动 / 抽卡。
 */
export type DuelSignalKind =
  | 'summon'
  | 'spsummon'
  | 'flip'
  | 'set'
  /** 召唤 / 特召 / 反转召唤成功（内核的 SUMMONED / SPSUMMONED / FLIPSUMMONED，没有卡号，用来配对确认） */
  | 'summoned'
  | 'spsummoned'
  | 'flipsummoned'
  /** 表示形式变化（判断一张卡是不是「已经表侧表示」） */
  | 'position'
  /**
   * 连锁响应权（SELECT_CHAIN 提问）：`player` 就是「现在轮到谁决定要不要连锁」。
   * 自排连锁时中间的连锁号没人被问过，因此那些连锁拿不到手坑响应。
   */
  | 'prompt'
  | 'chain'
  | 'solving'
  | 'solved'
  | 'negated'
  | 'move'
  | 'draw'

export interface DuelSignalSpot {
  controller: number
  location: number
  sequence: number
  /** 表示形式（OcgPosition），MOVE / SET / 表示形式变化才有 */
  position?: number
}

export interface DuelSignal {
  turn: number
  phase: number
  /** 0 我方 / 1 对手 / -1 系统 */
  player: number
  kind: DuelSignalKind
  code: number
  name: string
  /** 连锁号（发动 / 结算相关） */
  chainSize: number
  from?: DuelSignalSpot
  to?: DuelSignalSpot
  /** 抽卡张数 */
  count?: number
  /** 卡移动的原因位掩码（效果 / cost / 解放 / 素材…），判断能不能被手坑无效要用 */
  reason?: number
}

export interface DuelStartOptions {
  playerDeck: DuelDeck
  opponentDeck: DuelDeck
  /** xoshiro256** 种子（4 × 64 位），决定洗牌结果 */
  seed: [bigint, bigint, bigint, bigint]
  startingLP?: number
  startingHand?: number
  drawCount?: number
  names?: [string, string]
  /** 自选起手：按顺序放到我方卡组顶（最先抽到的就是这几张） */
  openingHand?: number[]
  /**
   * 暂存恢复：按顺序回放这些玩家响应。
   * 内核是确定性的（同种子 + 同卡组 + 同响应序列 → 同状态），
   * 所以重放等于"自动操作到暂存的那一步"。
   */
  replay?: OcgResponse[]
  /**
   * 录像回放：卡组已经是洗好的最终顺序，跳过洗牌与起手提牌。
   * 和 `rawResponses` 搭配使用，两边的顺序和内核当时收到的完全一致。
   */
  prebuiltDecks?: { player: DuelDeck; opponent: DuelDeck }
  /** 录像回放：按顺序直接喂给内核的原始响应字节（含对手的） */
  rawResponses?: Uint8Array[]
  /** 日志保留条数，录像分析需要完整日志（默认 300） */
  logLimit?: number
}
