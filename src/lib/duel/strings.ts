/**
 * 内核文本资源。
 *
 * strings.conf 的 !system 段：ocgcore 在 MSG_HINT(hint_type = SELECTMSG) 与
 * MSG_SELECT_OPTION 里只给 id（如 501 / 1100），具体文案要查这张表，
 * 否则界面上只能显示"请选择卡片""选项 1"这种废话。
 *
 * descriptions.json 同理：`aux.Stringid(code, n)` 生成 `code << 20 | n`，
 * 是「某张卡效果文本的第 n 条」，选项面板要按它显示真实操作名。
 */
export interface DuelStrings {
  system: Record<number, string>
}

/** 卡号 → 效果分条（下标 0 对应 cards.cdb 的 str1） */
export type DuelDescriptions = Record<number, string[]>

let cache: DuelStrings | null = null
let descriptionCache: DuelDescriptions | null = null

export async function loadDuelStrings(base: string): Promise<DuelStrings> {
  if (cache) return cache
  try {
    const res = await fetch(`${base}strings.json`)
    if (res.ok) {
      const json = (await res.json()) as DuelStrings
      cache = { system: json.system ?? {} }
      return cache
    }
  } catch {
    /* 拿不到就只显示通用文案 */
  }
  cache = { system: {} }
  return cache
}

export async function loadDuelDescriptions(base: string): Promise<DuelDescriptions> {
  if (descriptionCache) return descriptionCache
  try {
    // 重新跑过 assets:duel 后文件名不变，必须每次都校验
    const res = await fetch(`${base}descriptions.json`, { cache: 'no-cache' })
    if (res.ok) {
      const json = (await res.json()) as { descriptions?: DuelDescriptions }
      descriptionCache = json.descriptions ?? {}
      return descriptionCache
    }
  } catch {
    /* 缺这个文件时界面退回卡名 / 整段效果文本 */
  }
  descriptionCache = {}
  return descriptionCache
}
