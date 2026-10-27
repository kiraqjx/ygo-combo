import type { CardMove, Combo, OperationKind, Timing, ZoneId } from '@/types'
import { uid } from '@/lib/infer'

interface MoveSeed {
  count?: number
  handtraps?: string[]
  note?: string
}

function mv(
  cardName: string,
  from: ZoneId,
  to: ZoneId,
  phase: CardMove['phase'] = 'effect',
  seed: MoveSeed = {},
): CardMove {
  return { id: uid(), cardName, from, to, phase, ...seed }
}

type TimingSeed = Partial<Timing> & {
  operation: OperationKind
  cardName: string
}

function timing(seed: TimingSeed): Timing {
  return {
    id: uid(),
    label: '',
    from: undefined,
    setup: [],
    cost: [],
    effect: [],
    settle: [],
    chains: [],
    handtraps: [],
    note: '',
    ...seed,
  }
}

/** 仅用于缩略图展示 */
const CARD_IDS: Record<string, number> = {
  增援: 32807846,
  英雄到来: 8949584,
  '元素英雄 影雾女郎': 50720316,
  '元素英雄 天空侠': 40044918,
  假面变化: 21143940,
  '假面英雄 暗爪': 58481572,
  栗球兽卫: 97462632,
  两颗心灵: 24749710,
  '混沌之魔王-骸骨恶魔': 24088928,
  '光与暗的仪式': 33599853,
  '黑色混沌之魔术师 黑混沌': 44001993,
}

/* ------------------------------------------------------------------ */
/* 示例 1：英雄假面轴                                                   */
/* ------------------------------------------------------------------ */

export const HERO_COMBO_ID = 'demo-hero-mask-v2'

export function createDemoCombo(): Combo {
  const timings: Timing[] = [
    timing({
      operation: 'activate',
      cardName: '增援',
      from: 'hand',
      label: '发动「增援」',
      setup: [mv('增援', 'hand', 'st', 'auto', { note: '发动时置入魔陷区' })],
      settle: [mv('增援', 'st', 'gy', 'auto', { note: '通常魔法结算后送墓' })],
      effect: [mv('元素英雄 天空侠', 'deck', 'hand', 'effect', { handtraps: ['ash', 'droll'] })],
      note: '检索天空侠。检索段是灰流丽 / 锁鸟的响应点。',
    }),
    timing({
      operation: 'activate',
      cardName: '英雄到来',
      from: 'hand',
      label: '发动「英雄到来」',
      setup: [mv('英雄到来', 'hand', 'st', 'auto', { note: '发动时置入魔陷区' })],
      settle: [mv('英雄到来', 'st', 'gy', 'auto', { note: '通常魔法结算后送墓' })],
      effect: [
        mv('元素英雄 影雾女郎', 'deck', 'field', 'effect', {
          handtraps: ['ash', 'maxx', 'fuwalos'],
          note: '从卡组特殊召唤',
        }),
      ],
      note: '卡组特召：灰流丽 / 山雀 / 增殖的G 都能响应。',
    }),
    timing({
      operation: 'activateEffect',
      cardName: '元素英雄 影雾女郎',
      from: 'field',
      label: '影雾女郎 ① 检索',
      effect: [
        mv('假面变化', 'deck', 'hand', 'effect', {
          handtraps: ['ash', 'droll', 'veiler', 'imperm', 'ogre'],
        }),
      ],
      note: '影雾女郎特殊召唤成功时检索「假面变化」。',
    }),
    timing({
      operation: 'normalSummon',
      cardName: '元素英雄 天空侠',
      from: 'hand',
      label: '通召天空侠',
      effect: [
        mv('元素英雄 天空侠', 'hand', 'field', 'effect', {
          handtraps: ['maxx', 'purulia'],
          note: '通常召唤',
        }),
      ],
      note: '用的正是第 1 时序检索上来的那张天空侠。',
    }),
    timing({
      operation: 'activateEffect',
      cardName: '元素英雄 天空侠',
      from: 'field',
      label: '天空侠 ② 检索',
      effect: [
        mv('元素英雄 影雾女郎', 'deck', 'hand', 'effect', {
          handtraps: ['ash', 'droll', 'veiler', 'imperm', 'ogre'],
        }),
      ],
      note: '场上的怪兽效果：遮蒙 / 泡影 / 幽鬼兔 都可响应。',
    }),
    timing({
      operation: 'activate',
      cardName: '假面变化',
      from: 'hand',
      setup: [mv('假面变化', 'hand', 'st', 'auto', { note: '发动时置入魔陷区' })],
      settle: [mv('假面变化', 'st', 'gy', 'auto', { note: '速攻魔法结算后送墓' })],
      cost: [mv('元素英雄 影雾女郎', 'field', 'gy', 'cost', { note: '作为素材送去墓地' })],
      effect: [
        mv('假面英雄 暗爪', 'extra', 'field', 'effect', {
          handtraps: ['maxx', 'fuwalos', 'nibiru'],
          note: '从额外卡组特殊召唤',
        }),
      ],
      note: '素材是 cost：先结算送墓，再特召暗爪。',
    }),
    timing({
      operation: 'activateEffect',
      cardName: '元素英雄 影雾女郎',
      from: 'gy',
      label: '影雾女郎 ② 墓地检索',
      effect: [
        mv('元素英雄 天空侠', 'deck', 'hand', 'effect', {
          handtraps: ['ash', 'droll'],
          note: '从卡组加入手卡',
        }),
      ],
      note: '墓地发动：遮蒙 / 泡影打不到，只有灰流丽 / 锁鸟 / 屋敷童这类能响应。',
    }),
  ].map((item) => ({ ...item, cardId: CARD_IDS[item.cardName] }))

  return {
    id: HERO_COMBO_ID,
    name: '英雄假面 · 暗爪标准线（时序）',
    deckName: 'HERO',
    handSize: 5,
    goal: '暗爪 + 天空侠 + 手卡资源',
    opening: [
      { id: 32807846, name: '增援' },
      { id: 8949584, name: '英雄到来' },
    ],
    deck: [
      { id: 32807846, name: '增援', count: 1 },
      { id: 8949584, name: '英雄到来', count: 1 },
      { id: 50720316, name: '元素英雄 影雾女郎', count: 3 },
      { id: 40044918, name: '元素英雄 天空侠', count: 2 },
      { id: 21143940, name: '假面变化', count: 2 },
      { id: 58481572, name: '假面英雄 暗爪', count: 1 },
      { id: 23434538, name: '增殖的G', count: 3 },
      { id: 14558127, name: '灰流丽', count: 3 },
      { id: 10045474, name: '无限泡影', count: 2 },
    ],
    timings,
    updatedAt: Date.now(),
  }
}

/* ------------------------------------------------------------------ */
/* 示例 2：光与暗自锁 · 混沌之魔王                                       */
/* ------------------------------------------------------------------ */

export const CHAOS_COMBO_ID = 'demo-chaos-lock-v2'

export function createChaosCombo(): Combo {
  const timings: Timing[] = [
    timing({
      operation: 'set',
      cardName: '栗球兽卫',
      from: 'hand',
      label: '栗球兽卫 → 盖放「两颗心灵」',
      cost: [mv('栗球兽卫', 'hand', 'gy', 'cost', { note: '丢弃自身是 cost' })],
      effect: [
        mv('两颗心灵', 'deck', 'st', 'effect', { note: '从卡组盖放，盖放回合即可发动' }),
      ],
      note: 'cost 必定成功；从卡组盖放不属于灰流丽的三类处理。',
    }),
    timing({
      operation: 'activate',
      cardName: '两颗心灵',
      from: 'st',
      settle: [mv('两颗心灵', 'st', 'gy', 'auto', { note: '通常陷阱结算后送墓' })],
      label: '发动「两颗心灵」',
      effect: [
        mv('混沌之魔王-骸骨恶魔', 'deck', 'hand', 'effect', {
          handtraps: ['ash', 'droll'],
          note: '检索',
        }),
        mv('混沌之魔王-骸骨恶魔', 'hand', 'gy', 'effect', {
          handtraps: ['ash'],
          note: '那之后丢弃同一张卡',
        }),
      ],
      note: '灰流丽无效整段效果；锁鸟只封检索段，丢弃与堆墓照常。',
    }),
    timing({
      operation: 'activateEffect',
      cardName: '混沌之魔王-骸骨恶魔',
      from: 'gy',
      label: '混沌之魔王 ② 墓地发动',
      effect: [
        mv('光与暗的仪式', 'deck', 'gy', 'effect', { handtraps: ['ash'], note: '从卡组送去墓地' }),
        mv('黑色混沌之魔术师 黑混沌', 'deck', 'hand', 'effect', {
          handtraps: ['ash', 'droll'],
          note: '检索',
        }),
      ],
      note: '被第 2 时序丢弃后，在墓地触发。',
    }),
    timing({
      operation: 'activateEffect',
      cardName: '光与暗的仪式',
      from: 'gy',
      label: '光与暗的仪式 ② 回收',
      effect: [
        mv('光与暗的仪式', 'gy', 'hand', 'effect', { handtraps: ['belle'] }),
        mv('混沌之魔王-骸骨恶魔', 'gy', 'hand', 'effect', { handtraps: ['belle'] }),
      ],
      note: '墓地取牌：屋敷童可响应，灰流丽打不到。',
    }),
    timing({
      operation: 'activate',
      cardName: '光与暗的仪式',
      from: 'hand',
      label: '仪式召唤「黑混沌」',
      setup: [mv('光与暗的仪式', 'hand', 'st', 'auto', { note: '发动时置入魔陷区' })],
      settle: [mv('光与暗的仪式', 'st', 'gy', 'auto', { note: '仪式魔法结算后送墓' })],
      effect: [
        mv('黑色混沌之魔术师 黑混沌', 'hand', 'field', 'effect', {
          handtraps: ['maxx', 'purulia'],
          note: '从手卡仪式召唤',
        }),
      ],
      note: '用的黑混沌来自第 3 时序的检索，以及第 4 时序的墓地回收。',
    }),
  ].map((item) => ({ ...item, cardId: CARD_IDS[item.cardName] }))

  return {
    id: CHAOS_COMBO_ID,
    name: '光与暗自锁 · 混沌之魔王（时序）',
    deckName: '光与暗',
    handSize: 5,
    goal: '黑混沌之魔术师 + 墓地三件套',
    opening: [{ id: 97462632, name: '栗球兽卫' }],
    deck: [
      { id: 97462632, name: '栗球兽卫', count: 1 },
      { id: 24749710, name: '两颗心灵', count: 1 },
      { id: 24088928, name: '混沌之魔王-骸骨恶魔', count: 1 },
      { id: 33599853, name: '光与暗的仪式', count: 2 },
      { id: 44001993, name: '黑色混沌之魔术师 黑混沌', count: 1 },
      { id: 23434538, name: '增殖的G', count: 3 },
      { id: 14558127, name: '灰流丽', count: 3 },
      { id: 10045474, name: '无限泡影', count: 2 },
    ],
    timings,
    updatedAt: Date.now(),
  }
}

export function createExampleCombo(kind: 'hero' | 'chaos'): Combo {
  return kind === 'chaos' ? createChaosCombo() : createDemoCombo()
}
