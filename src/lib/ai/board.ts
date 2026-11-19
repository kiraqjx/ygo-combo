import type { DuelCardView, DuelStateView } from '@/lib/duel/types'
import { PHASE_LABELS } from '@/lib/duel/labels'

/**
 * 局面 → 文本。
 *
 * 只写判断需要的：能动的资源、场面、资源差、当前连锁。
 * 卡片数用 handCount 而不是 hand.length：对手手卡是隐藏的。
 */

function cardName(card: DuelCardView | null): string {
  if (!card) return ''
  if (card.hidden) return '里侧卡片'
  const suffix = card.materials > 0 ? `（素材 ${card.materials}）` : ''
  return `「${card.name}」${suffix}`
}

function zoneLine(label: string, cards: (DuelCardView | null)[]): string {
  const parts = cards
    .map((card, index) => (card ? `${index + 1}:${card.hidden ? '里侧' : card.name}` : ''))
    .filter(Boolean)
  return parts.length ? `  ${label}：${parts.join('，')}` : ''
}

export function renderBoard(state: DuelStateView): string {
  const lines: string[] = []
  const phase = PHASE_LABELS[state.phase] ?? `阶段 ${state.phase}`
  lines.push(`第 ${state.turn} 回合 · ${state.turnPlayer === 0 ? '我方' : '对手'}回合 · ${phase}`)

  for (const player of [0, 1] as const) {
    const view = state.players[player]
    const who = player === 0 ? '我方' : '对手'
    lines.push(
      `${who}：LP ${view.lp}｜手卡 ${view.handCount}｜卡组 ${view.deckCount}｜额外 ${view.extraCount}｜墓地 ${view.gy.length}｜除外 ${view.banished.length}`,
    )
    if (player === 0 && view.hand.length) {
      lines.push(`  手卡：${view.hand.map((card) => cardName(card)).join('、')}`)
    }
    const monsters = zoneLine('怪兽区', view.monsters)
    if (monsters) lines.push(monsters)
    const spells = zoneLine('魔陷区', view.spells)
    if (spells) lines.push(spells)
    if (view.fieldZone) lines.push(`  场地区：${cardName(view.fieldZone)}`)
    if (view.gy.length) {
      lines.push(`  墓地：${view.gy.slice(0, 10).map((card) => cardName(card)).join('、')}`)
    }
  }

  if (state.chain.length) {
    const chainText = state.chain.map((item) => `C${item.link}「${item.name}」`).join(' → ')
    lines.push(`当前连锁：${chainText}`)
  }
  return lines.join('\n')
}
