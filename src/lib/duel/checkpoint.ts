import type { OcgResponse } from 'ocgcore-wasm'
import type { DuelDeck } from './types'

/**
 * 对局暂存。
 *
 * 内核是确定性的：同种子 + 同卡组 + 同响应序列，必然走到同一个局面。
 * 所以暂存不需要保存整个场地，只要记住开局参数（种子 / 卡组 / 起手）
 * 和我方做过的每一次决定，恢复时重开一局把这些决定再喂一遍即可。
 */
export interface DuelCheckpoint {
  id: string
  /** 列表里显示的名字，默认是「卡组名 · 第 N 回合」 */
  label: string
  deckId: string
  deckName: string
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
}

const STORAGE_KEY = 'ygo-duel-checkpoints'
const LIMIT = 20

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
    handSize: Number(item.handSize) || 5,
    openingHand: Array.isArray(item.openingHand) ? item.openingHand : [],
    turn: Number(item.turn) || 1,
    phase: Number(item.phase) || 0,
    createdAt: Number(item.createdAt) || Date.now(),
  }
}

export function loadCheckpoints(): DuelCheckpoint[] {
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
      JSON.stringify(list.slice(0, LIMIT), (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    )
    return true
  } catch (error) {
    // 超配额 / 隐私模式：暂存只是便利功能，失败不该打断对局，但要在控制台留痕
    console.warn('[duel] 暂存写入失败', error)
    return false
  }
}

export function saveCheckpoint(checkpoint: DuelCheckpoint): DuelCheckpoint[] {
  const rest = loadCheckpoints().filter((item) => item.id !== checkpoint.id)
  const next = [checkpoint, ...rest].slice(0, LIMIT)
  persist(next)
  return next
}

export function removeCheckpoint(id: string): DuelCheckpoint[] {
  const next = loadCheckpoints().filter((item) => item.id !== id)
  persist(next)
  return next
}

export function seedToStrings(seed: [bigint, bigint, bigint, bigint]): [string, string, string, string] {
  return seed.map((value) => value.toString(16)) as [string, string, string, string]
}

export function stringsToSeed(seed: [string, string, string, string]): [bigint, bigint, bigint, bigint] {
  return seed.map((value) => BigInt(`0x${value || '0'}`)) as [bigint, bigint, bigint, bigint]
}
