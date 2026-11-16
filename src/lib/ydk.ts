import type { DeckEntry } from '@/types'

export interface YdkDeck {
  main: DeckEntry[]
  extra: DeckEntry[]
  side: DeckEntry[]
}

function pushCards(lines: string[], list: DeckEntry[]) {
  for (const entry of list) {
    const count = Math.max(0, Math.floor(entry.count))
    for (let i = 0; i < count; i += 1) lines.push(String(entry.id))
  }
}

/**
 * 导出 YDK 文本（YGOPro / EDOPro 等通用格式）：
 * #main / #extra / !side 三段，每行一张卡的密码，同名卡重复出现。
 */
export function toYdk(deck: YdkDeck): string {
  const lines: string[] = ['#created by ygo-combo', '#main']
  pushCards(lines, deck.main)
  lines.push('#extra')
  pushCards(lines, deck.extra)
  lines.push('!side')
  pushCards(lines, deck.side)
  return `${lines.join('\n')}\n`
}

export interface ParsedYdk {
  /** 展开后的卡号序列，同名卡重复出现 */
  main: number[]
  extra: number[]
  side: number[]
  /** 认不出来的行数（注释以外的脏数据） */
  ignored: number
}

/**
 * 解析 ydk 文本。
 * 兼容几种常见写法：#main / #extra / !side 段标记、#created by 等注释、
 * 出现在段标记之前的数字（按主卡组处理）、CRLF 与 BOM。
 */
export function parseYdk(text: string): ParsedYdk {
  const out: ParsedYdk = { main: [], extra: [], side: [], ignored: 0 }
  let section: 'main' | 'extra' | 'side' = 'main'
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue

    if (line.startsWith('#') || line.startsWith('!')) {
      const tag = line.slice(1).trim().toLowerCase()
      if (tag === 'main') section = 'main'
      else if (tag === 'extra') section = 'extra'
      else if (tag === 'side') section = 'side'
      // 其他（#created by / #comment …）只是注释，不影响当前段
      continue
    }

    if (!/^\d+$/.test(line)) {
      out.ignored += 1
      continue
    }
    const id = Number(line)
    if (!(id > 0)) {
      out.ignored += 1
      continue
    }
    out[section].push(id)
  }

  return out
}

/** 展开的卡号列表 → 去重合并后的卡组条目（保持首次出现的顺序） */
export function groupYdkCards(ids: number[], resolveName: (id: number) => string | undefined): DeckEntry[] {
  const byId = new Map<number, DeckEntry>()
  const out: DeckEntry[] = []
  for (const id of ids) {
    const hit = byId.get(id)
    if (hit) {
      hit.count += 1
      continue
    }
    const entry: DeckEntry = { id, name: resolveName(id) || `#${id}`, count: 1 }
    byId.set(id, entry)
    out.push(entry)
  }
  return out
}
