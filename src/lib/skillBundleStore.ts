import type { SkillBundle } from './skillBundle'

/**
 * 生成好的 skill 包的本地存档。
 *
 * 以前 `bundle` 只是页面里的一个 ref：切到别的 tab 再回来就没了，AI 生成的版本
 * 和手工改过的文件都留不住。现在按卡组 id 存进 localStorage——「持久显示、
 * 除非再次点击生成才覆盖」就是靠它实现的。
 *
 * 只存文本，几份录像的包通常在 50~300 KB，localStorage 够用；超配额时退化成
 * 只保留当前卡组，再不行就静默丢弃（页面里的数据还在，只是刷新后丢失）。
 */

/** 这份包是怎么来的：本地推导 / AI 生成 */
export type SkillBundleSource = 'local' | 'ai'

export interface SavedSkillBundle extends SkillBundle {
  deckId: string
  source: SkillBundleSource
  updatedAt: number
  /** 「全量文档」页签的内容，和分片包一起存 */
  fullText: string
}

const STORAGE_KEY = 'ygo-skill-bundles'
/** 最多保留几套卡组的包（卡组删掉后存档不会自动清） */
const MAX_DECKS = 8

interface StoredMap {
  [deckId: string]: SavedSkillBundle
}

function readAll(): StoredMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as StoredMap
  } catch {
    return {}
  }
}

export function loadSkillBundle(deckId: string): SavedSkillBundle | null {
  if (!deckId) return null
  const saved = readAll()[deckId]
  return saved && isUsable(saved) ? saved : null
}

export function saveSkillBundle(
  deckId: string,
  bundle: SkillBundle,
  source: SkillBundleSource,
  fullText: string,
): SavedSkillBundle | null {
  if (!deckId) return null
  const record: SavedSkillBundle = {
    ...bundle,
    deckId,
    source,
    updatedAt: Date.now(),
    fullText,
  }
  const all = readAll()
  all[deckId] = record
  prune(all)
  write(all, deckId)
  return record
}

export function clearSkillBundle(deckId: string) {
  const all = readAll()
  if (!(deckId in all)) return
  delete all[deckId]
  write(all, '')
}

/** 只保留最近更新的 MAX_DECKS 套 */
function prune(all: StoredMap) {
  const ids = Object.keys(all)
  if (ids.length <= MAX_DECKS) return
  ids
    .sort((a, b) => (all[a]?.updatedAt ?? 0) - (all[b]?.updatedAt ?? 0))
    .slice(0, ids.length - MAX_DECKS)
    .forEach((id) => delete all[id])
}

function write(all: StoredMap, keep: string) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
  } catch {
    // 配额满了：退化成只留当前卡组再试一次
    if (!keep) return
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ [keep]: all[keep] }))
    } catch {
      // 还是放不下就不存了（改动仍在本页生效）
    }
  }
}

function isUsable(value: SavedSkillBundle): boolean {
  if (!value || typeof value !== 'object') return false
  if (typeof value.dir !== 'string' || !value.dir) return false
  if (typeof value.zipName !== 'string') return false
  if (!value.files || typeof value.files !== 'object' || Array.isArray(value.files)) return false
  const entries = Object.entries(value.files)
  if (!entries.length) return false
  if (entries.some(([, text]) => typeof text !== 'string')) return false
  return Boolean(value.manifest && typeof value.manifest === 'object')
}
