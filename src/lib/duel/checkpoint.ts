import type { OcgResponse } from 'ocgcore-wasm'
import type { DuelDeck } from './types'

/**
 * 对局暂存。
 *
 * 内核是确定性的：同种子 + 同卡组 + 同响应序列，必然走到同一个局面。
 * 所以暂存不需要保存整个场地，只要记住开局参数（种子 / 卡组 / 起手）
 * 和我方做过的每一次决定，恢复时重开一局把这些决定再喂一遍即可。
 *
 * 暂存按卡组隔离（`deckId`），并且记住当时的卡表指纹（`deckFingerprint`）：
 * 卡组构成一变，旧档回放必然走到别的局面，读到时就作废。
 */
export interface DuelCheckpoint {
  id: string
  /** 列表里显示的名字，默认是「卡组名 · 第 N 回合」 */
  label: string
  deckId: string
  deckName: string
  /** 开局时卡组的指纹（见 `deckFingerprint`），和当前卡组对不上就作废 */
  deckFingerprint: string
  /** 4 × 64 位种子，BigInt 不能直接进 JSON，存十六进制字符串 */
  seed: [string, string, string, string]
  playerDeck: DuelDeck
  handSize: number
  openingHand: number[]
  /** 我方响应序列：恢复时按顺序回放，回放到头就交还给玩家 */
  steps: OcgResponse[]
  /** 存档时的回合 / 阶段，只用于列表展示 */
  turn: number
  phase: number
  createdAt: number
  /**
   * 只读标记：读取时发现卡表指纹与当前卡组对不上。
   * 不落盘（`normalize` 会丢掉它），卡组改回去就自动恢复可载入。
   */
  stale?: boolean
}

const STORAGE_KEY = 'ygo-duel-checkpoints'
/** 每套卡组保留的暂存条数 */
const LIMIT = 20

/**
 * 卡组指纹：只看卡号与张数，与录入顺序无关。
 * 卡组名、启动率配置不算「卡组变化」——改个名字不该把暂存全废掉。
 */
export function deckFingerprint(deck: DuelDeck): string {
  const encode = (codes: number[]) => {
    const counts = new Map<number, number>()
    for (const code of codes) counts.set(code, (counts.get(code) || 0) + 1)
    return Array.from(counts.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([code, count]) => `${code}x${count}`)
      .join(',')
  }
  return `${encode(deck.main)}|${encode(deck.extra)}`
}

function isSeed(value: unknown): value is [string, string, string, string] {
  return Array.isArray(value) && value.length === 4 && value.every((item) => typeof item === 'string')
}

function isDeck(value: unknown): value is DuelDeck {
  if (!value || typeof value !== 'object') return false
  const deck = value as DuelDeck
  return Array.isArray(deck.main) && Array.isArray(deck.extra)
}

function normalize(raw: unknown): DuelCheckpoint | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as DuelCheckpoint
  if (typeof item.id !== 'string') return null
  if (!isSeed(item.seed) || !isDeck(item.playerDeck)) return null
  if (!Array.isArray(item.steps)) return null
  return {
    ...item,
    steps: reviveSteps(item.steps as unknown[]),
    label: typeof item.label === 'string' ? item.label : '未命名暂存',
    deckId: typeof item.deckId === 'string' ? item.deckId : '',
    deckName: typeof item.deckName === 'string' ? item.deckName : '未知卡组',
    // 老版本没有这个字段：按存档里那套牌现算，一样能判失效
    deckFingerprint:
      typeof item.deckFingerprint === 'string' && item.deckFingerprint
        ? item.deckFingerprint
        : deckFingerprint(item.playerDeck),
    handSize: Number(item.handSize) || 5,
    openingHand: Array.isArray(item.openingHand) ? item.openingHand : [],
    turn: Number(item.turn) || 1,
    phase: Number(item.phase) || 0,
    createdAt: Number(item.createdAt) || Date.now(),
    // 只读标记，永不落盘（万一老数据里带了也丢掉）
    stale: undefined,
  }
}

/** 全部卡组的所有暂存（不清洗有效性，只做去重与排序） */
function readAll(): DuelCheckpoint[] {
  try {
    const text = localStorage.getItem(STORAGE_KEY)
    if (!text) return []
    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed)) return []
    const list = parsed
      .map(normalize)
      .filter((item): item is DuelCheckpoint => Boolean(item))
      .sort((a, b) => b.createdAt - a.createdAt)
    // 旧版本每次暂存都会新建一条，同一局（卡组 + 种子）只保留最新的一份
    const seen = new Set<string>()
    return list.filter((item) => {
      const key = `${item.deckId}-${item.seed.join('-')}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  } catch {
    return []
  }
}

export interface CheckpointFilter {
  deckId: string
  /** 当前卡组的指纹 */
  fingerprint: string
}

/**
 * 读取暂存。带 filter 时只返回当前卡组的档，卡表变过的标记 `stale` 而不是删掉。
 *
 * 以前是「指纹对不上就直接从存储里删」——跨设备恢复时只要指纹差一格
 * （换版本、卡组被规范化过、或者导入后当前卡组不是存档那套），
 * 一打开对战区，暂存就被永久抹掉了，用户只会看到「暂存没了」。
 * 现在留着并标记，卡组改回去或者换个版本还能用，实在不要由用户手删。
 */
export function loadCheckpoints(filter?: CheckpointFilter): DuelCheckpoint[] {
  const all = readAll()
  if (!filter) return all
  return all
    .filter((item) => item.deckId === filter.deckId)
    .map((item) => ({ ...item, stale: item.deckFingerprint !== filter.fingerprint }))
}

/**
 * 宣言类响应（ANNOUNCE_RACE）里是 bigint，直接 JSON.stringify 会抛错，
 * 结果是整条存档静默丢失。这里统一转成十进制字符串，读取时再还原。
 */
function reviveSteps(steps: unknown[]): OcgResponse[] {
  return steps.map((step) => {
    if (!step || typeof step !== 'object') return step as OcgResponse
    const response = step as Record<string, unknown>
    if (!Array.isArray(response.races)) return step as OcgResponse
    return { ...response, races: response.races.map((race) => BigInt(String(race))) } as unknown as OcgResponse
  })
}

function persist(list: DuelCheckpoint[]) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(list, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)),
    )
    return true
  } catch (error) {
    // 超配额 / 隐私模式：暂存只是便利功能，失败不该打断对局，但要在控制台留痕
    console.warn('[duel] 暂存写入失败', error)
    return false
  }
}

/**
 * 存一条，返回这套卡组剩下的暂存（其他卡组的档不受影响）。
 *
 * 只按「同卡组」做条数上限，不再顺手清掉卡表变过的旧档 ——
 * 卡组改回去之后它们还能用，清理交给用户。
 */
export function saveCheckpoint(checkpoint: DuelCheckpoint): DuelCheckpoint[] {
  const all = readAll()
  const sameDeck = [
    checkpoint,
    ...all.filter((item) => item.deckId === checkpoint.deckId && item.id !== checkpoint.id),
  ]
  const kept = sameDeck.slice(0, LIMIT)
  persist([...kept, ...all.filter((item) => item.deckId !== checkpoint.deckId)])
  return kept
}

export function removeCheckpoint(id: string): DuelCheckpoint[] {
  const next = readAll().filter((item) => item.id !== id)
  persist(next)
  return next
}

export function seedToStrings(seed: [bigint, bigint, bigint, bigint]): [string, string, string, string] {
  return seed.map((value) => value.toString(16)) as [string, string, string, string]
}

export function stringsToSeed(seed: [string, string, string, string]): [bigint, bigint, bigint, bigint] {
  return seed.map((value) => BigInt(`0x${value || '0'}`)) as [bigint, bigint, bigint, bigint]
}
