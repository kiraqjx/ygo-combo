import {
  OcgLocation,
  OcgMessageType,
  OcgResponseType,
  SelectBattleCMDAction,
  SelectIdleCMDAction,
  ocgPositionParse,
  type OcgPosition,
  type OcgResponse,
} from 'ocgcore-wasm'
import type { DuelQuestion } from '@/lib/duel/types'
import { positionLabel, zoneLabel } from '@/lib/duel/labels'

/**
 * 把内核提问翻译成「带编号的候选动作」。
 *
 * 编号是给模型看的，从 1 开始；`response` 才是交给内核的对象。
 * 模型只回编号，编号 → response 的映射是确定性的。
 *
 * 多选类（选卡 / 解放 / 数值）没法枚举全部组合，所以候选只是「可选的单张卡」，
 * 真正的响应由 `buildAnswerResponse` 按模型给的编号集合组装。
 */
export interface Candidate {
  id: number
  text: string
  /** 单选类可以直接提交；多选类只用它作为占位 */
  response: OcgResponse
  /** 多选 / 排序时这张卡在提问内的下标 */
  pick?: number
  /** 这张卡当前所在区域：用来区分「从卡组取牌」与「弃手卡」这类不同的决策 */
  location?: number
}

export interface EnumerateContext {
  nameOf: (code: number) => string
  describe: (descriptionId: number) => string
  /** 卡库里的效果摘要（选卡/检索需要知道选的是哪张卡） */
  summary?: (code: number) => string
}

/** 回答形态：单选 / 多选 / 排序 */
export type AnswerMode = 'single' | 'multi' | 'order'

export interface AnswerPlan {
  mode: AnswerMode
  min: number
  max: number
  cancel: boolean
}

/**
 * 哪些提问交给模型。
 *
 * `place`（放置格位）与 `sort`（排列顺序）故意不问：格位可用集合由内核掩码给出、
 * 选错会被判非法，而它对结果几乎没有影响；SORT_CHAIN 的响应编码在既有实现里
 * 本来就走 SORT_CARD 兜底，交给模型只会放大风险。两者继续用确定性策略。
 */
export function answerPlan(question: DuelQuestion): AnswerPlan | null {
  switch (question.kind) {
    case 'idle':
    case 'battle':
    case 'chain':
    case 'yesno':
    case 'option':
    case 'position':
      return { mode: 'single', min: 1, max: 1, cancel: false }
    case 'card':
    case 'tribute': {
      const message = question.message
      return {
        mode: 'multi',
        min: Math.max(1, message.min),
        max: Math.max(1, message.max || message.min),
        cancel: message.can_cancel,
      }
    }
    case 'sum': {
      const message = question.message
      return {
        mode: 'multi',
        min: Math.max(1, message.min),
        max: Math.max(1, message.max || message.min),
        cancel: false,
      }
    }
    default:
      return null
  }
}

export function enumerateCandidates(question: DuelQuestion, ctx: EnumerateContext): Candidate[] {
  const list: Candidate[] = []
  const push = (
    text: string,
    response: OcgResponse,
    extra?: { pick?: number; location?: number },
  ) => {
    list.push({ id: list.length + 1, text, response, ...extra })
  }

  switch (question.kind) {
    case 'idle': {
      const message = question.message
      // 「结束回合 / 进战阶」刻意排在最后：它们编号靠前时，模型明显更容易提前收工
      message.activates.forEach((card, index) => {
        push(`发动「${ctx.nameOf(card.code)}」${abilityText(ctx, card.description)}`, {
          type: OcgResponseType.SELECT_IDLECMD,
          action: SelectIdleCMDAction.SELECT_ACTIVATE,
          index,
        })
      })
      message.special_summons.forEach((card, index) => {
        const where = card.location === OcgLocation.EXTRA ? '额外卡组特召' : '特殊召唤'
        push(`${where}「${ctx.nameOf(card.code)}」（${zoneLabel(card.location, card.sequence)}）`, {
          type: OcgResponseType.SELECT_IDLECMD,
          action: SelectIdleCMDAction.SELECT_SPECIAL_SUMMON,
          index,
        })
      })
      message.summons.forEach((card, index) => {
        push(`召唤「${ctx.nameOf(card.code)}」`, {
          type: OcgResponseType.SELECT_IDLECMD,
          action: SelectIdleCMDAction.SELECT_SUMMON,
          index,
        })
      })
      message.spell_sets.forEach((card, index) => {
        push(`盖放「${ctx.nameOf(card.code)}」到魔陷区`, {
          type: OcgResponseType.SELECT_IDLECMD,
          action: SelectIdleCMDAction.SELECT_SPELL_SET,
          index,
        })
      })
      message.monster_sets.forEach((card, index) => {
        push(`盖放「${ctx.nameOf(card.code)}」到怪兽区`, {
          type: OcgResponseType.SELECT_IDLECMD,
          action: SelectIdleCMDAction.SELECT_MONSTER_SET,
          index,
        })
      })
      message.pos_changes.forEach((card, index) => {
        push(`变更「${ctx.nameOf(card.code)}」表示形式`, {
          type: OcgResponseType.SELECT_IDLECMD,
          action: SelectIdleCMDAction.SELECT_POS_CHANGE,
          index,
        })
      })
      if (message.to_bp) {
        push('进入战斗阶段', {
          type: OcgResponseType.SELECT_IDLECMD,
          action: SelectIdleCMDAction.TO_BP,
          index: null,
        })
      }
      if (message.to_ep) {
        push('结束回合', {
          type: OcgResponseType.SELECT_IDLECMD,
          action: SelectIdleCMDAction.TO_EP,
          index: null,
        })
      }
      return list
    }
    case 'battle': {
      const message = question.message
      message.chains.forEach((card, index) => {
        push(`发动「${ctx.nameOf(card.code)}」${abilityText(ctx, card.description)}`, {
          type: OcgResponseType.SELECT_BATTLECMD,
          action: SelectBattleCMDAction.SELECT_CHAIN,
          index,
        })
      })
      message.attacks.forEach((card, index) => {
        const suffix = card.can_direct ? '（可直接攻击）' : ''
        push(`用「${ctx.nameOf(card.code)}」攻击${suffix}`, {
          type: OcgResponseType.SELECT_BATTLECMD,
          action: SelectBattleCMDAction.SELECT_BATTLE,
          index,
        })
      })
      if (message.to_m2) {
        push('进入主要阶段 2', {
          type: OcgResponseType.SELECT_BATTLECMD,
          action: SelectBattleCMDAction.TO_M2,
          index: null,
        })
      }
      if (message.to_ep) {
        push('结束回合', {
          type: OcgResponseType.SELECT_BATTLECMD,
          action: SelectBattleCMDAction.TO_EP,
          index: null,
        })
      }
      return list
    }
    case 'chain': {
      const message = question.message
      message.selects.forEach((card, index) => {
        push(`连锁发动「${ctx.nameOf(card.code)}」${abilityText(ctx, card.description)}`, {
          type: OcgResponseType.SELECT_CHAIN,
          index,
        })
      })
      if (!message.forced) {
        push('不发动（放弃这个响应窗口）', { type: OcgResponseType.SELECT_CHAIN, index: null })
      }
      return list
    }
    case 'yesno': {
      const isEffect = question.message.type === OcgMessageType.SELECT_EFFECTYN
      push(
        '是',
        isEffect
          ? { type: OcgResponseType.SELECT_EFFECTYN, yes: true }
          : { type: OcgResponseType.SELECT_YESNO, yes: true },
      )
      push(
        '否',
        isEffect
          ? { type: OcgResponseType.SELECT_EFFECTYN, yes: false }
          : { type: OcgResponseType.SELECT_YESNO, yes: false },
      )
      return list
    }
    case 'option': {
      question.message.options.forEach((id, index) => {
        push(ctx.describe(Number(id)) || `选项 ${index + 1}`, {
          type: OcgResponseType.SELECT_OPTION,
          index,
        })
      })
      return list
    }
    case 'card':
    case 'tribute': {
      const message = question.message
      const type =
        question.kind === 'card' ? OcgResponseType.SELECT_CARD : OcgResponseType.SELECT_TRIBUTE
      message.selects.forEach((card, index) => {
        push(cardText(ctx, card), { type, indicies: [index] }, { pick: index, location: card.location })
      })
      if (message.can_cancel) {
        push('取消（不选卡）', { type, indicies: null })
      }
      return list
    }
    case 'sum': {
      question.message.selects.forEach((card, index) => {
        push(
          `${cardText(ctx, card)}（数值 ${card.amount}）`,
          { type: OcgResponseType.SELECT_SUM, indicies: [index] },
          { pick: index, location: card.location },
        )
      })
      return list
    }
    case 'position': {
      const message = question.message
      ocgPositionParse(message.positions).forEach((position) => {
        push(`「${ctx.nameOf(message.code)}」改为${positionLabel(position)}表示`, {
          type: OcgResponseType.SELECT_POSITION,
          position: position as OcgPosition,
        })
      })
      return list
    }
    default:
      return []
  }
}

/** 选卡类的文本：区域 + 卡名 + 效果摘要。检索时全靠它判断选哪张 */
function cardText(
  ctx: EnumerateContext,
  card: { code: number; controller: number; location: number; sequence: number },
): string {
  const who = card.controller === 0 ? '我方' : '对手'
  const zone = zoneLabel(card.location, card.sequence)
  const summary = ctx.summary?.(card.code)
  const tail = summary ? `｜${summary.replace(/\s+/g, ' ').trim().slice(0, 60)}` : ''
  return `${who}${zone}「${ctx.nameOf(card.code)}」${tail}`
}

function abilityText(ctx: EnumerateContext, descriptionId: bigint): string {
  const text = ctx.describe(Number(descriptionId))
  if (!text) return ''
  return `（${text.replace(/\s+/g, ' ').trim().slice(0, 90)}）`
}

/**
 * 按模型给的编号组装最终响应。
 *
 * 返回 null 表示这组编号不合法（越界 / 数量不满足 min-max），调用方应当重试或降级。
 */
export function buildAnswerResponse(
  question: DuelQuestion,
  candidates: Candidate[],
  ids: number[],
): OcgResponse | null {
  const plan = answerPlan(question)
  if (!plan || !ids.length) return null
  const chosen = ids.map((id) => candidates.find((item) => item.id === id))
  if (chosen.some((item) => !item)) return null
  const picked = chosen as Candidate[]

  if (plan.mode === 'single') {
    return picked.length === 1 ? picked[0].response : null
  }

  // 多选里的「取消」：只有一张且没有 pick，表示 indicies = null
  if (picked.length === 1 && picked[0].pick === undefined) {
    return picked[0].response
  }
  if (picked.length < plan.min || picked.length > plan.max) return null

  const indices = picked.map((item) => item.pick).filter((value): value is number => typeof value === 'number')
  if (indices.length !== picked.length) return null
  const unique = new Set(indices)
  if (unique.size !== indices.length) return null

  switch (question.kind) {
    case 'card':
      return { type: OcgResponseType.SELECT_CARD, indicies: indices }
    case 'tribute':
      return { type: OcgResponseType.SELECT_TRIBUTE, indicies: indices }
    case 'sum':
      return { type: OcgResponseType.SELECT_SUM, indicies: indices }
    default:
      return null
  }
}

/** 提问类型 → 人话，写进 prompt 让模型知道现在在做什么 */
export function questionLabel(question: DuelQuestion): string {
  switch (question.kind) {
    case 'idle':
      return '主要阶段操作'
    case 'battle':
      return '战斗阶段操作'
    case 'chain':
      return question.message.forced ? '必须连锁（强制）' : '连锁响应'
    case 'yesno':
      return question.message.type === OcgMessageType.SELECT_EFFECTYN ? '是否发动效果' : '是否确认'
    case 'option':
      return '选择效果分支'
    case 'card':
      return '从候选卡片中选择'
    case 'tribute':
      return '选择解放的卡片'
    case 'sum':
      return '选择卡片凑够合计数值'
    case 'position':
      return '选择表示形式'
    default:
      return '选择'
  }
}
