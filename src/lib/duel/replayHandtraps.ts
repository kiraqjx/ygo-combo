import type { DuelSignal, DuelSignalSpot } from './types'

/**
 * 从录像的结构化事件流里，反推「哪一步会吃到哪些主流手坑」。
 *
 * 录像里只有我方的响应，对手是沙包，所以这里给的是**潜在命中点**：
 * 假设对手手上有这些手坑，他能在第几步、用什么打断。
 *
 * 只覆盖这几张（抽卡型手坑，比如增殖的G / 欢聚友伴系列，不在这里体现）：
 *   - 灰流丽：卡组 → 手卡 / 墓地 / 怪兽区（含从卡组特殊召唤；从卡组解放 / 当素材送墓不算）
 *   - 灵王的波动：效果里含「把怪兽特殊召唤」的发动（整次发动无效）
 *   - 幽鬼兔：已经表侧表示在场的卡发动效果（卡片自身刚发动那一下不行）
 *   - 无限泡影：场上怪兽的效果发动（需要提前盖放）
 *   - 屋敷童：墓地卡的效果 / 墓地取牌 / 墓地特召 / 墓地除外
 *   - 锁鸟：主要阶段里第一次「从卡组把卡加入手卡」之后（封住后续检索）
 *   - 原始生命态 尼比鲁：累计第 5 次召唤 / 特召（被无效的召唤不计数）
 *
 * 只报前 20 步：再往后的步骤已经不是「展开被拦」的范畴了。
 *
 * 自排连锁（同一时点自己把多个效果排成 C1..Cn）时，对手只能在整条连锁排完后响应 Cn，
 * 前面几条吃不到手坑。这些点不会被删掉，而是标成 `dodged` 保留，
 * 用来告诉读者「这一步之所以安全，是因为前面排了自排连锁」。
 */
/** 只看前多少步的手坑点 */
const MAX_STEP = 20

/**
 * 手坑判定规则的版本号。
 * 改动判定逻辑后 +1：存下来的解析结果会因为版本号对不上而自动重跑内核。
 */
export const HANDTRAP_ANALYSIS_VERSION = 11

export interface ReplayHandtrapHit {
  id: string
  name: string
  /** 我方第几次操作 */
  step: number
  turn: number
  phase: number
  /** 触发点：第几步做了什么 */
  trigger: string
  /** 命中后的后果 */
  effect: string
  /** instant = 无效这一次；rest-of-turn = 影响后续整条展开 */
  scope: 'instant' | 'rest-of-turn'
  /**
   * 这一手落在自排连锁的前段：对手只能在整条连锁排完后响应最后一条，
   * 所以对手**实际上够不到这里**。保留下来是为了说明「自排连锁能规避手坑」这件事本身。
   */
  dodged?: boolean
  /** 被规避的原因（哪条连锁挡住了它） */
  dodgeNote?: string
}

/** ygopro 区域位掩码（与 ocgcore 的 OcgLocation 取值一致） */
const LOC = {
  DECK: 0x01,
  HAND: 0x02,
  MZONE: 0x04,
  SZONE: 0x08,
  GRAVE: 0x10,
  REMOVED: 0x20,
  EXTRA: 0x40,
} as const

/** 卡移动原因位掩码，取值见 scripts/constant.lua 的 REASON_* */
const REASON = {
  RELEASE: 0x2,
  MATERIAL: 0x8,
  EFFECT: 0x40,
  COST: 0x80,
  RULE: 0x400,
} as const

/** 这次移动是不是效果处理造成的（能不能被灰流丽 / 屋敷童无效） */
function isEffectMove(reason: number | undefined): boolean {
  // 旧录像没有 reason 时保持原行为，宁可多报也不漏
  if (reason === undefined || reason === 0) return true
  return (reason & REASON.EFFECT) !== 0 && (reason & REASON.COST) === 0
}

/**
 * 「解放 / 当作素材」造成的移动不吃灰流丽：
 * 卡进墓地只是解放（祭品、仪式素材）的结果，效果本身不是「把卡送去墓地」（官方裁定）。
 */
function isMaterialMove(reason: number | undefined): boolean {
  if (reason === undefined) return false
  return (reason & (REASON.RELEASE | REASON.MATERIAL)) !== 0
}

/** 连锁的唯一定位：连锁号在每次组建连锁时都从 1 开始，所以要带上「第几条连锁」 */
type ChainLinkKey = string

const chainKey = (chainId: number, chainSize: number): ChainLinkKey => `${chainId}:${chainSize}`

/**
 * 自排连锁：同一时点里自己排出 C1..Cn，对手只能在整条连锁排完之后响应 Cn。
 *
 * 判断方式看响应权（`prompt` 信号）：某条连锁刚发动、下一条连锁还是同一个人发的，
 * 而中间**没有轮到对手**（player 1）做连锁决定 → 前一条就被「盖住」了，
 * 针对它发动的灰流丽 / 屋敷童 / 幽鬼兔 / 泡影 / 灵王都发不出来。
 *
 * 返回值：被盖住的连锁 → 这批自排连锁里对手真正能响应的连锁号。
 * 这些命中点不丢弃，而是标成 `dodged` 留在结果里，
 * 让读文档的人知道「这一步之所以安全，是因为前面排了自排连锁」。
 */
function sealedChainLinks(signals: DuelSignal[]): Map<ChainLinkKey, number> {
  const sealed = new Map<ChainLinkKey, number>()
  let chainId = 0
  let lastPlayer = -1
  let lastSize = 0
  let opponentWindow = false
  for (const signal of signals) {
    if (signal.kind === 'prompt') {
      if (signal.player === 1) opponentWindow = true
      continue
    }
    if (signal.kind !== 'chain') continue
    // 连锁号回到 1 说明上一条连锁已经结束，这是新的一条
    if (signal.chainSize === 1) chainId += 1
    if (lastSize > 0 && signal.chainSize === lastSize + 1 && signal.player === lastPlayer && !opponentWindow) {
      sealed.set(chainKey(chainId, lastSize), signal.chainSize)
    }
    lastPlayer = signal.player
    lastSize = signal.chainSize
    opponentWindow = false
  }
  return sealed
}

const PHASE_LABELS: Record<number, string> = {
  1: '抽卡阶段',
  2: '准备阶段',
  4: '主要阶段 1',
  8: '战斗阶段',
  16: '主要阶段 2',
  32: '结束阶段',
}

const HANDTRAPS = {
  ash: { id: 'ash', name: '灰流丽' },
  impulse: { id: 'dominus-impulse', name: '灵王的波动' },
  imperm: { id: 'imperm', name: '无限泡影' },
  ghostBelle: { id: 'ghost-belle', name: '屋敷童' },
  ghostRabbit: { id: 'ghost-rabbit', name: '幽鬼兔' },
  lockBird: { id: 'lock-bird', name: '锁鸟' },
  nibiru: { id: 'nibiru', name: '原始生命态 尼比鲁' },
} as const

/** 表示形式位（OcgPosition）：1 / 4 是表侧，2 / 8 是里侧 */
const POS_FACEDOWN = 0xa

export function analyzeHandtrapHits(signals: DuelSignal[]): ReplayHandtrapHit[] {
  const hits: ReplayHandtrapHit[] = []
  const seen = new Set<string>()
  /** 自排连锁里被盖住、拿不到响应权的连锁 */
  const sealed = sealedChainLinks(signals)
  /** 现在的连锁是第几条（连锁号每次组连锁都从 1 重来，所以要和它一起定位） */
  let chainId = 0
  /** 连锁号 → 发动该连锁的卡、步号与所属连锁（把结算里的移动归因到「哪个效果」） */
  const chainSource = new Map<number, { signal: DuelSignal; step: number; chainId: number }>()
  /** 场上卡的表侧状态：`控制者:区域:位置` → 变成表侧时的信号下标 */
  const faceUp = new Map<string, number>()
  let solving = 0
  let step = 0
  /** 信号下标，用来判断「表侧状态是不是这次发动才刚成立」 */
  let index = -1
  let summons = 0
  let lockBirdSeen = false
  /** 等待 SUMMONED / SPSUMMONED / FLIPSUMMONED 确认的召唤（被无效就没有确认消息） */
  let pending: DuelSignal | null = null
  let pendingStep = 0

  const spotKey = (spot?: DuelSignalSpot) =>
    spot ? `${spot.controller}:${spot.location}:${spot.sequence}` : ''
  const isFaceDown = (position?: number) => position !== undefined && (position & POS_FACEDOWN) !== 0
  /** 记一笔「这张卡现在是表侧在场」；已经在表侧就不刷新时间 */
  const markFaceUp = (spot?: DuelSignalSpot) => {
    const key = spotKey(spot)
    if (!key) return
    if (isFaceDown(spot?.position)) faceUp.delete(key)
    else if (!faceUp.has(key)) faceUp.set(key, index)
  }
  /**
   * 幽鬼兔只能炸「已经表侧表示在场」的卡：
   * 卡片自身发动的那一下（手卡 / 卡组置入魔陷区、里侧盖卡翻开）还不算表侧，炸不了。
   */
  const isSettledFaceUp = (spot?: DuelSignalSpot) => {
    const since = faceUp.get(spotKey(spot))
    return since !== undefined && index - since >= 2
  }

  const push = (
    handtrap: { id: string; name: string },
    signal: DuelSignal,
    trigger: string,
    effect: string,
    scope: ReplayHandtrapHit['scope'],
    at = step,
    /** 这次手坑是针对哪一条连锁发动的（空 = 不是连锁响应，比如尼比鲁 / 锁鸟） */
    link: ChainLinkKey = '',
  ) => {
    const key = `${handtrap.id}:${at}`
    if (seen.has(key)) return
    seen.add(key)
    // 自排连锁里被盖住的连锁：整条连锁排完之前没人能响应。
    // 不删掉这条，只标成「已规避」，这样文档还能告诉读者「自排连锁就是为了这个」。
    const sealedTo = link ? sealed.get(link) : undefined
    const chainSize = link ? Number(link.split(':')[1]) : 0
    hits.push({
      id: handtrap.id,
      name: handtrap.name,
      step: at,
      turn: signal.turn,
      phase: signal.phase,
      trigger,
      effect,
      scope,
      ...(sealedTo === undefined
        ? {}
        : {
            dodged: true,
            dodgeNote: `自排连锁：这一步是 C${chainSize}，对手只能在整条连锁排完后响应 C${sealedTo}，所以对手实际够不到这里（自排连锁的意义就在于此）`,
          }),
    })
  }

  const maybeLockBird = (signal: DuelSignal, trigger: string, at: number) => {
    if (lockBirdSeen) return
    // 锁鸟只能在主要阶段发动
    if (signal.phase !== 4 && signal.phase !== 16) return
    lockBirdSeen = true
    push(
      HANDTRAPS.lockBird,
      signal,
      trigger,
      '锁鸟生效后，本回合双方都不能再从卡组把卡加入手卡（抽卡除外）：后续检索全部落空',
      'rest-of-turn',
      at,
    )
  }

  const maybeNibiru = (signal: DuelSignal, at: number) => {
    if (summons !== 5) return
    push(
      HANDTRAPS.nibiru,
      signal,
      `第 ${at} 步：累计第 5 次召唤 / 特殊召唤「${signal.name}」`,
      '解放全场怪兽，特召尼比鲁：此前铺开的场面全部清空。' +
        '注意：尼比鲁是「怪兽效果」，场上已有怪兽效果康（三色康 / 怪兽发动的无效）或手上留着灵王的波动这类手段时，' +
        '可以在它落地时直接康掉，这一手就等于不用管',
      'instant',
      at,
    )
  }

  for (const signal of signals) {
    index += 1
    switch (signal.kind) {
      case 'summon':
      case 'flip':
      case 'spsummon': {
        step += 1
        // 先只记「即将召唤」：等内核发 SUMMONED / SPSUMMONED 才算成功，
        // 被神字辈无效的特召不会再计数（否则陨石时点会提前）
        pending = signal
        pendingStep = step
        break
      }
      case 'summoned':
      case 'spsummoned':
      case 'flipsummoned': {
        const source = pending
        pending = null
        if (!source) break
        // 只有双方是我方的召唤才算数：这里分析的是我方展开会吃到什么手坑
        if (source.player !== 0) break
        summons += 1
        maybeNibiru(source, pendingStep)
        break
      }
      case 'set': {
        step += 1
        // 盖放 = 里侧，不满足幽鬼兔「已经表侧表示」的条件
        const key = spotKey(signal.to)
        if (key) faceUp.delete(key)
        break
      }
      case 'position': {
        // 里侧翻开 → 从现在开始算表侧
        markFaceUp(signal.to)
        break
      }
      case 'chain': {
        step += 1
        // 连锁号回到 1 = 上一条连锁已经结束
        if (signal.chainSize === 1) chainId += 1
        chainSource.set(signal.chainSize, { signal, step, chainId })
        if (signal.player !== 0) break
        const link = chainKey(chainId, signal.chainSize)
        const location = signal.from?.location ?? 0
        // 墓地发动的效果不看发动位置：灰流丽 / 屋敷童取决于它到底动了哪些卡，
        // 那部分判断放在结算时的 move 分支里
        // 表侧在场且不是这次才刚翻开的卡，才能被幽鬼兔炸
        const ogreAble = isSettledFaceUp(signal.from)
        if (location & LOC.MZONE) {
          push(
            HANDTRAPS.imperm,
            signal,
            `第 ${step} 步：场上怪兽「${signal.name}」发动效果`,
            `若对手提前盖放了泡影，可无效「${signal.name}」（当回合盖放的泡影不能发动）`,
            'instant',
            step,
            link,
          )
          if (ogreAble) {
            push(
              HANDTRAPS.ghostRabbit,
              signal,
              `第 ${step} 步：场上怪兽「${signal.name}」发动效果`,
              `无效该发动并破坏「${signal.name}」`,
              'instant',
              step,
              link,
            )
          }
        } else if (location & LOC.SZONE) {
          // 魔陷只认「已经表侧表示」的效果发动：刚发动 / 刚翻开的卡片炸不了
          if (ogreAble) {
            push(
              HANDTRAPS.ghostRabbit,
              signal,
              `第 ${step} 步：场上魔陷「${signal.name}」发动效果`,
              `无效该发动并破坏「${signal.name}」`,
              'instant',
              step,
              link,
            )
          }
        }
        break
      }
      case 'solving':
        solving = signal.chainSize
        break
      case 'solved':
      case 'negated':
        chainSource.delete(signal.chainSize)
        if (solving === signal.chainSize) solving = 0
        break
      case 'move': {
        // 区域账本：离场的卡摘掉表侧记录，进场的卡按表示形式登记
        const fromKey = spotKey(signal.from)
        if (fromKey) faceUp.delete(fromKey)
        if (signal.to && (signal.to.location & (LOC.MZONE | LOC.SZONE)) !== 0) markFaceUp(signal.to)
        if (signal.player !== 0) break
        const from = signal.from?.location ?? 0
        const to = signal.to?.location ?? 0
        const activation = chainSource.get(solving)
        const source = activation?.signal.name || '效果结算'
        // 这次结算对应哪一条连锁（被自排连锁盖住的话，针对它的手坑都发不出来）
        const link = activation ? chainKey(activation.chainId, solving) : ''
        // cost / 解放 / 素材不算「效果处理」，灰流丽与屋敷童都无效不了
        const effectMove = isEffectMove(signal.reason)
        if (effectMove && from & LOC.DECK) {
          if (to & LOC.HAND) {
            push(
              HANDTRAPS.ash,
              signal,
              `第 ${step} 步：「${source}」从卡组检索「${signal.name}」`,
              `「${signal.name}」留在卡组，后续依赖它的展开全部落空`,
              'instant',
              step,
              link,
            )
            maybeLockBird(signal, `第 ${step} 步：「${source}」从卡组检索「${signal.name}」之后`, step)
          } else if ((to & LOC.GRAVE) && !isMaterialMove(signal.reason)) {
            push(
              HANDTRAPS.ash,
              signal,
              `第 ${step} 步：「${source}」把「${signal.name}」从卡组送去墓地`,
              `这次堆墓被无效，「${signal.name}」不进墓地`,
              'instant',
              step,
              link,
            )
          } else if (to & LOC.MZONE) {
            push(
              HANDTRAPS.ash,
              signal,
              `第 ${step} 步：「${source}」从卡组特殊召唤「${signal.name}」`,
              `这次特殊召唤被无效，「${signal.name}」留在卡组`,
              'instant',
              step,
              link,
            )
          }
        }
        // 灵王的波动：效果里只要含「把怪兽特殊召唤」就能无效整次发动。
        // 这里不看 reason：仪式 / 融合这些召唤的移动往往带 MATERIAL / SPSUMMON 位，
        // 只要它发生在某个连锁发动的结算里，就说明这次发动「含特召」
        if (to & LOC.MZONE && !(from & (LOC.MZONE | LOC.SZONE)) && activation) {
          push(
            HANDTRAPS.impulse,
            activation.signal,
            `第 ${activation.step} 步：「${activation.signal.name}」的效果特殊召唤「${signal.name}」`,
            '灵王的波动 无效整次发动：这次特殊召唤不会发生。若对手是从手卡发动的，代价是**对手自己**这次决斗中不能发动光·地·风属性怪兽的效果（对我方没有限制）',
            'instant',
            activation.step,
            link,
          )
        }
        // 屋敷童只管「墓地里的卡被拿走 / 被除外」，
        // 墓地发动的效果去卡组找牌是灰流丽的活（上面 DECK 分支），不能按发动位置判
        if (effectMove && from & LOC.GRAVE && (to & (LOC.HAND | LOC.DECK | LOC.MZONE))) {
          const action = to & LOC.HAND ? '回收' : to & LOC.DECK ? '回到卡组' : '特殊召唤'
          push(
            HANDTRAPS.ghostBelle,
            signal,
            `第 ${step} 步：「${source}」把墓地的「${signal.name}」${action}`,
            `这次墓地${action}被无效`,
            'instant',
            step,
            link,
          )
        }
        if (effectMove && from & LOC.GRAVE && to & LOC.REMOVED) {
          push(
            HANDTRAPS.ghostBelle,
            signal,
            `第 ${step} 步：「${source}」把墓地的「${signal.name}」除外`,
            `这次除外被无效，「${signal.name}」留在墓地`,
            'instant',
            step,
            link,
          )
        }
        break
      }
      case 'draw':
        // 抽卡不算「从卡组把卡加入手卡」，锁鸟管不到
        break
    }
  }

  // 只保留前 MAX_STEP 步：再往后的步骤已经不算「展开被拦」了
  return hits
    .filter((hit) => hit.step <= MAX_STEP)
    .sort((a, b) => a.step - b.step || a.turn - b.turn)
}

/** 手坑名；被自排连锁规避的会在名字上标出来 */
export function hitNameText(hit: ReplayHandtrapHit): string {
  return hit.dodged ? `${hit.name}（已规避）` : hit.name
}

/** 「后果」一栏；被规避的写清原因，并保留原本会被打掉的东西 */
export function hitConsequenceText(hit: ReplayHandtrapHit): string {
  if (!hit.dodged) return hit.effect
  return `${hit.dodgeNote ?? '自排连锁规避'}。假如没有这条自排连锁：${hit.effect}`
}

/** 命中点表下方的固定说明 */
export const HANDTRAP_FOOTNOTE =
  '标「已规避」的命中点位于自排连锁（同一时点自己把多个效果排成 C1..Cn）的前段：' +
  '对手只能在整条连锁排完后响应最后一条，所以这些位置其实吃不到手坑——自排连锁正是用来规避手坑的。'

/** 命中点的人类可读定位（回合 / 阶段 / 第几步） */
export function hitPositionText(hit: ReplayHandtrapHit): string {
  const phase = PHASE_LABELS[hit.phase] ?? ''
  const where = [`T${hit.turn}`, phase, `第 ${hit.step} 步`].filter(Boolean).join(' · ')
  return where
}
