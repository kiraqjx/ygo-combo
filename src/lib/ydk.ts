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
